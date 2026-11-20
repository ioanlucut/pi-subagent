import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	assistantText,
	effectiveRunState,
	inboxHasMessages,
	inStartingGrace,
	keptTranscriptPath,
	listRuns,
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
/** The suffix of a result that the parent tick or `stop` took to send. */
const TAKEN = ".taken";

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
	const outcome = turnOutcome(message);
	const text = summarize(run, assistantText(message));
	writeResult(run, outcome, outcome === "finished" && hasQueuedRun(run.parentSessionId) ? `${text}\n\n${stopHint(run)}` : text);
}

/**
 * An idle child holds its slot until it is stopped: while another child waits for a slot, the parent must
 * hear it with the result, or it waits for the queued child for ever.
 */
function stopHint(run: RunMetadata): string {
	return `stop ${run.handle} when you need no follow-up; it holds a slot until then.`;
}

function hasQueuedRun(sessionId: string): boolean {
	return listRuns(sessionId).some((other) => other.state === "queued");
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

/** A suspended run queued again: its new launch is news to the parent. */
export function clearExitKnown(runDir: string): void {
	rmSync(exitKnownPath(runDir), { force: true });
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

/** The queued result files of these runs, oldest first; those of a run a `wait` will print only when `waited`. */
function resultFiles(runs: RunMetadata[], waited: boolean): string[] {
	return runs.flatMap((run) => {
		const dir = outboxDir(run.runDir);
		if (!existsSync(dir) || (!waited && hasWaiter(run.runDir))) return [];
		return readdirSync(dir)
			.filter((entry) => entry.endsWith(".txt"))
			.sort()
			.map((name) => join(dir, name));
	});
}

/** The queued results of these runs as one message, left in place. */
export function pendingResults(runs: RunMetadata[]): { text: string; files: string[] } | undefined {
	return joined(resultFiles(runs, false).flatMap((file) => readOrSkip(file, file)));
}

/**
 * Take the queued results of these runs as one message, with the files to delete after it is sent. The parent
 * tick and `stop` run in two processes: each takes a result by renaming its file, read before, and only one
 * rename of it succeeds, so the parent gets a result once, never from both. `waited`: also the results a `wait` holds.
 */
export function takeResults(runs: RunMetadata[], { waited = false } = {}): { text: string; files: string[] } | undefined {
	const taken: { text: string; file: string }[] = [];
	for (const file of resultFiles(runs, waited)) {
		const [result] = readOrSkip(file, `${file}${TAKEN}`);
		if (!result) continue;
		try {
			renameSync(file, result.file);
			taken.push(result);
		} catch {
			// The other process took it.
		}
	}
	return joined(taken);
}

/** A file's text; nothing when it was removed since the listing. */
function readOrSkip(file: string, name: string): { text: string; file: string }[] {
	try {
		return [{ text: readFileSync(file, "utf8"), file: name }];
	} catch {
		return [];
	}
}

function joined(results: { text: string; file: string }[]): { text: string; files: string[] } | undefined {
	if (results.length === 0) return undefined;
	return { text: results.map((result) => result.text).join("\n\n---\n\n"), files: results.map((result) => result.file) };
}

/** Results taken but not sent: they wait for the next try. */
export function returnResults(files: string[]): void {
	for (const file of files) {
		try {
			renameSync(file, file.slice(0, -TAKEN.length));
		} catch {
			// The run is gone.
		}
	}
}

/**
 * Whether a result of these runs is still to be sent, also one a `wait` holds: a `wait` that was cancelled
 * stops renewing its claim, and the parent must still be there to send the result when the claim expires.
 */
export function hasResults(runs: RunMetadata[]): boolean {
	return runs.some((run) => existsSync(outboxDir(run.runDir)) && readdirSync(outboxDir(run.runDir)).some((entry) => entry.endsWith(".txt")));
}

/** `wait` calls this after it printed the result. */
export function clearResults(runDir: string): void {
	rmSync(outboxDir(runDir), { recursive: true, force: true });
	rmSync(waitingPath(runDir), { force: true });
}
