import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assistantText,
	effectiveRunState,
	inboxHasMessages,
	inStartingGrace,
	keptTranscriptPath,
	readLatestAssistant,
	readMetadata,
	runDisplayName,
	turnOutcome,
	type RunMetadata,
	updateMetadata,
} from "./shared.ts";

/** A longer answer reaches the parent as its start and the path of the whole, so results do not fill the parent's context. */
const SUMMARY_CHARS = 2_000;
/** `wait` renews its claim each 500 ms; an older claim is from a `wait` that was killed. */
const WAITING_MS = 2_000;

const outboxDir = (runDir: string): string => join(runDir, "outbox");
const answersDir = (runDir: string): string => join(runDir, "answers");
const exitKnownPath = (runDir: string): string => join(runDir, "exit-known");
const waitingPath = (runDir: string): string => join(runDir, "waiting");

/**
 * Whether this Pi delivers results. Print and JSON modes end with the turn, so no later message can
 * arrive. The answer goes into the environment for the `spawn` that this Pi's bash tool runs; "0" from
 * the user turns delivery off, and stays.
 */
export function claimResultDelivery(mode: string): boolean {
	const delivers = (mode === "tui" || mode === "rpc") && process.env.PI_SUBAGENT_NOTIFY !== "0";
	process.env.PI_SUBAGENT_NOTIFY = delivers ? "1" : "0";
	return delivers;
}

/** Queue one result for the parent. Never creates the run directory: `stop` may have removed it. */
export function writeResult(run: RunMetadata, outcome: string, body: string): void {
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

/**
 * Save the answer and return the text the parent gets: a long answer as its start, each with the path of the
 * whole. The file sits beside the place the transcript is kept on `stop`, so the path stays valid after it;
 * one file per turn, so an older message keeps pointing at its own answer.
 */
function summarize(run: RunMetadata, text: string): string {
	const kept = keptTranscriptPath(run.sessionFile);
	// No session header yet: the run directory, as nothing else names the transcript.
	const dir = kept ? kept.replace(/\.jsonl$/, ".answers") : answersDir(run.runDir);
	const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
	try {
		// The run directory is never created again: `stop` may have removed it.
		if (!existsSync(dir)) mkdirSync(dir, { recursive: Boolean(kept), mode: 0o700 });
		writeFileSync(file, text, { mode: 0o600 });
	} catch {
		return text; // The run is gone; writeResult drops the message too.
	}
	if (text.length <= SUMMARY_CHARS) return `${text}\n\n[The whole answer: ${file}]`;
	return `${text.slice(0, SUMMARY_CHARS)}\n\n[First ${SUMMARY_CHARS} of ${text.length} characters. The whole answer: ${file}]`;
}

/** The child calls this when its turn ends: the parent session gets the answer as a message. */
export function reportSettledTurn(runDir: string): void {
	const run = readMetadata(runDir);
	// No parent session: nobody reads the outbox. A queued `send`: the next turn has the result.
	if (!run?.parentSessionId || inboxHasMessages(runDir)) return;
	// The parent ended this turn itself (suspend, `stop`): the abort is no news to it.
	if (run.suspended || existsSync(exitKnownPath(runDir))) return;
	const message = readLatestAssistant(run.sessionFile);
	if (!message) return;
	writeResult(run, turnOutcome(message), summarize(run, assistantText(message)));
}

/** Whether `stop` or the parent ended the child, so its end is no news to the parent. */
export function isExitKnown(runDir: string): boolean {
	return existsSync(exitKnownPath(runDir));
}

/** `stop` calls this before it ends the child, so the end is not reported as a surprise. */
export function markExitKnown(runDir: string): void {
	try {
		writeFileSync(exitKnownPath(runDir), "");
	} catch {
		// The run is gone.
	}
}

/**
 * The parent calls this for its runs: a child whose process ended by itself is reported, once. Returns
 * whether a run with no process yet is still in its grace time, so a later call can report it.
 */
export function reportExitedRuns(runs: RunMetadata[]): boolean {
	let waiting = false;
	for (const run of runs) {
		if (run.suspended || existsSync(exitKnownPath(run.runDir)) || effectiveRunState(run) !== "exited") continue;
		if (inStartingGrace(run)) {
			waiting = true;
			continue;
		}
		markExitKnown(run.runDir);
		writeResult(run, "exited", "Its process ended and nobody stopped it. Spawn the task again if you still need the result.");
	}
	return waiting;
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
