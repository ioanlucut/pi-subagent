import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assistantText,
	effectiveRunState,
	inboxHasMessages,
	readLatestAssistant,
	readMetadata,
	runDisplayName,
	turnOutcome,
	type RunMetadata,
} from "./shared.ts";

/** tmux starts just after the metadata is written; a run this young with no tmux session has not died. */
const STARTING_GRACE_MS = 30_000;
/** `wait` renews its claim each 500 ms; an older claim is from a `wait` that was killed. */
const WAITING_MS = 2_000;

const outboxDir = (runDir: string): string => join(runDir, "outbox");
const exitKnownPath = (runDir: string): string => join(runDir, "exit-known");
const waitingPath = (runDir: string): string => join(runDir, "waiting");

/** Queue one result for the parent. Never creates the run directory: `stop` may have removed it. */
function writeResult(run: RunMetadata, outcome: string, body: string): void {
	const dir = outboxDir(run.runDir);
	try {
		if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
		const target = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
		writeFileSync(`${target}.tmp`, `Subagent ${runDisplayName(run)} ${outcome}\n\n${body}`, { mode: 0o600 });
		renameSync(`${target}.tmp`, target);
	} catch {
		// The run is gone.
	}
}

/** The child calls this when its turn ends: the parent session gets the answer as a message. */
export function reportSettledTurn(runDir: string): void {
	const run = readMetadata(runDir);
	// No parent session: nobody reads the outbox. A queued `send`: the next turn has the result.
	if (!run?.parentSessionId || inboxHasMessages(runDir)) return;
	// The parent ended this turn itself (suspend, `stop`): the abort is no news to it.
	if (run.suspended || existsSync(exitKnownPath(runDir))) return;
	const message = readLatestAssistant(run.sessionFile);
	if (message) writeResult(run, turnOutcome(message), assistantText(message));
}

/** `stop` calls this before it ends the child, so the end is not reported as a surprise. */
export function markExitKnown(runDir: string): void {
	try {
		writeFileSync(exitKnownPath(runDir), "");
	} catch {
		// The run is gone.
	}
}

/** The parent calls this for its runs: a child whose process ended by itself is reported, once. */
export function reportExitedRuns(runs: RunMetadata[]): void {
	for (const run of runs) {
		if (run.suspended || existsSync(exitKnownPath(run.runDir)) || effectiveRunState(run) !== "exited") continue;
		if (run.state === "starting" && Date.now() - Date.parse(run.updatedAt) < STARTING_GRACE_MS) continue;
		markExitKnown(run.runDir);
		writeResult(run, "exited", "Its process ended and nobody stopped it. Spawn the task again if you still need the result.");
	}
}

/** `wait` calls this on each poll: it prints the result itself, so the parent must not get it as a message too. */
export function markWaiting(runDir: string): void {
	try {
		writeFileSync(waitingPath(runDir), "");
	} catch {
		// The run is gone.
	}
}

function hasWaiter(runDir: string): boolean {
	try {
		return Date.now() - statSync(waitingPath(runDir)).mtimeMs < WAITING_MS;
	} catch {
		return false;
	}
}

/** The queued results of these runs as one message, with the files to delete after it is sent. */
export function pendingResults(runs: RunMetadata[]): { text: string; files: string[] } | undefined {
	const texts: string[] = [];
	const files: string[] = [];
	for (const run of runs) {
		const dir = outboxDir(run.runDir);
		if (!existsSync(dir) || hasWaiter(run.runDir)) continue;
		for (const name of readdirSync(dir)
			.filter((entry) => entry.endsWith(".txt"))
			.sort()) {
			const file = join(dir, name);
			try {
				texts.push(readFileSync(file, "utf8"));
				files.push(file);
			} catch {
				// Removed since the listing.
			}
		}
	}
	return files.length > 0 ? { text: texts.join("\n\n---\n\n"), files } : undefined;
}

/** `wait` calls this after it printed the result. */
export function clearResults(runDir: string): void {
	rmSync(outboxDir(runDir), { recursive: true, force: true });
	rmSync(waitingPath(runDir), { force: true });
}
