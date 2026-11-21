import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LockBusyError, TICK_LOCK_WAIT_MS, waitingAtMost } from "./lock.ts";
import { clearExitKnown, isExitKnown, markExitKnown, writeResult } from "./outbox.ts";
import {
	effectiveRunState,
	getAgentDir,
	inStartingGrace,
	isLive,
	listRuns,
	nextDeadline,
	ownStartTime,
	prepareLaunch,
	readMetadata,
	removeRunDir,
	resumeArgs,
	runDisplayName,
	type RunMetadata,
	skippingBusyRun,
	startLaunch,
	startLaunchAsync,
	tmuxSessionExists,
	updateMetadata,
	withSessionLock,
	writeMetadata,
} from "./shared.ts";

/** Children that may run at once in one parent session: `PI_SUBAGENT_LIMIT`, else `subagentLimit` in Pi's settings, else 4. */
export function runLimit(): number {
	const valid = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
	const fromEnv = Number(process.env.PI_SUBAGENT_LIMIT);
	if (valid(fromEnv)) return fromEnv;
	try {
		const { subagentLimit } = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as { subagentLimit?: unknown };
		if (valid(subagentLimit)) return subagentLimit as number;
	} catch {
		// No settings: the default.
	}
	return 4;
}

/**
 * Whether a new child of `sessionId` must queue: the limit is reached, or older children wait. Only a parent
 * Pi whose tick starts queued runs sets PI_SUBAGENT_QUEUE; elsewhere nothing would start them.
 */
export function mustQueue(sessionId: string | undefined, sessionExists = tmuxSessionExists): boolean {
	if (process.env.PI_SUBAGENT_QUEUE !== "1" || sessionId === undefined) return false;
	const runs = listRuns(sessionId);
	return runs.some((run) => run.state === "queued") || liveRunCount(runs, sessionExists) >= runLimit();
}

/**
 * Write a new run as `queued` when it must queue, else `starting`, and return whether it queued. The count
 * and the write hold the session lock: two `spawn` at once must not both see the last free slot. A
 * `starting` run holds its slot from this write, so its slow tmux start can follow outside the lock.
 */
export function writeNewRun(run: RunMetadata): boolean {
	return countedWrite(run.parentSessionId, (queued) => {
		writeMetadata({ ...run, state: queued ? "queued" : "starting" });
		return queued;
	});
}

/**
 * `subagent resume`: claim a suspended run, `queued` when `mayQueue` and it must queue, else `starting` for
 * `startRun`. The count and the claim hold the session lock, as for `spawn`: two resumes at once must not
 * both see the last free slot. Undefined when another resume claimed the run first.
 */
export function resumeRun(run: RunMetadata, mayQueue: boolean, patch: Partial<RunMetadata> = {}): RunMetadata | undefined {
	return countedWrite(run.parentSessionId, (queued) => claimSuspendedRun(run, mayQueue && queued ? "queued" : "starting", patch));
}

/**
 * Run `write` with whether a new live run of `sessionId` must queue, under the session lock.
 */
function countedWrite<T>(sessionId: string | undefined, write: (queued: boolean) => T): T {
	if (sessionId === undefined) return write(mustQueue(sessionId));
	// Only `mustQueue` with PI_SUBAGENT_QUEUE counts: no tmux call for a caller that never queues.
	const runs = process.env.PI_SUBAGENT_QUEUE === "1" ? listRuns(sessionId) : [];
	return countedUnderLock(sessionId, runs, (sessionExists) => write(mustQueue(sessionId, sessionExists)));
}

/**
 * Run `fn` under the session lock, with a liveness answer for runs that only tmux can tell alive.
 *
 * The lock holds for milliseconds and starts no program: a run of an older version among `runs` is asked
 * before it. A run that appears in between counts as live, which can only queue.
 */
function countedUnderLock<T>(sessionId: string, runs: RunMetadata[], fn: (sessionExists: (session: string) => boolean) => T): T {
	const sessions = new Map<string, boolean>();
	for (const other of runs) {
		effectiveRunState(other, (session) => {
			sessions.set(session, tmuxSessionExists(session));
			return sessions.get(session) as boolean;
		});
	}
	return withSessionLock(sessionId, () => fn((session) => sessions.get(session) ?? true));
}

/**
 * The `State:` line that `spawn` and `resume` print. A queued one names the idle children of `sessionId`: an
 * idle child holds its slot until it is stopped, so a model that waits for the queue can wait for ever.
 */
export function stateLine(queued: boolean, sessionId: string | undefined): string {
	// Only a run of a parent session queues.
	if (!queued || sessionId === undefined) return "State: busy";
	const line = `State: queued, starts when fewer than ${runLimit()} children run`;
	// A new child reports `idle` once at startup, before its first turn; it has not answered yet.
	const idle = listRuns(sessionId).filter((run) => effectiveRunState(run) === "idle" && run.hasStarted);
	if (idle.length === 0) return line;
	const holders = idle.map(runDisplayName).join(", ");
	const count = idle.length === 1 ? "1 idle child holds a slot" : `${idle.length} idle children hold slots`;
	return `${line}. ${count}: ${holders}. Stop the ones you need no more to free a slot.`;
}

/**
 * Start a run whose launch is saved: mark it `starting`, with `patch`, and start its tmux session. A launch
 * that fails leaves the run `error` and throws. Returns the run as it is after the start, or undefined when
 * `stop` removed it.
 */
export function startRun(run: RunMetadata, patch: Partial<RunMetadata> = {}): RunMetadata | undefined {
	const claim = claimRun(run, patch);
	if (!claim.claimed) return claim.run;
	try {
		startLaunch(claim.run);
	} catch (error) {
		launchFailed(claim, error);
		throw error;
	}
	// Read again: the launch wrote a new deadline.
	return readMetadata(run.runDir) ?? claim.run;
}

type Claim = { claimed: false; run: RunMetadata | undefined } | { claimed: true; run: RunMetadata; suspended: boolean | undefined };

/**
 * Mark a run `starting`, with `patch`, if it is still in the state the caller read. A resumed run is no longer
 * `suspended` from here: the time limit skips suspended runs, so a child that is slow to start, or never
 * starts, would otherwise pass its deadline unseen.
 *
 * Under its lock: two parents, or a tick and `subagent resume`, can both read one run as `queued`. The one
 * that loses starts nothing and gets the run as the winner left it; a second launch would fail on the tmux
 * session and mark the live run `error`.
 */
function claimRun(run: RunMetadata, patch: Partial<RunMetadata>): Claim {
	let claimed = false;
	let suspended: boolean | undefined;
	const starting = updateMetadata(run.runDir, (current) => {
		claimed = current.state === run.state;
		if (!claimed) return undefined;
		suspended = current.suspended;
		// The limit counts from each launch, so a resumed or queued child is not stopped for the time it did
		// not run. In the claim, so no second lock wait follows it.
		return { ...patch, state: "starting", suspended: undefined, deadline: nextDeadline(current) };
	});
	return starting && claimed ? { claimed, run: starting, suspended } : { claimed: false, run: starting };
}

/** A claimed run whose launch failed: `error`, and still suspended, so the next resume tries it again. */
function launchFailed(claim: Extract<Claim, { claimed: true }>, error: unknown): void {
	updateMetadata(claim.run.runDir, { state: "error", suspended: claim.suspended, error: errorText(error) });
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** tmux calls of the parent that have not ended: `settleTmuxCalls` waits for them. */
const pendingTmuxCalls = new Set<Promise<void>>();

/** Keep `call` until it ends. An error is logged: a rejection nobody handles would end Pi. */
export function track(call: Promise<void>): void {
	const settled = call
		.catch((error: unknown) => console.error(`pi-subagent: a tmux call failed: ${error instanceof Error ? error.stack : String(error)}`))
		.finally(() => pendingTmuxCalls.delete(settled));
	pendingTmuxCalls.add(settled);
}

/** Wait until the tmux calls the parent started have ended and their results are written. */
export async function settleTmuxCalls(): Promise<void> {
	while (pendingTmuxCalls.size > 0) await Promise.all(pendingTmuxCalls);
}

function liveRunCount(runs: RunMetadata[], sessionExists = tmuxSessionExists): number {
	return runs.filter((run) => isLive(effectiveRunState(run, sessionExists))).length;
}

/**
 * The parent tick: start the queued ones of the session's `runs`, oldest first, while fewer than the limit
 * run. Returns the runs as they are after the claims, so the tick lists the run directory once.
 *
 * The count and the claims hold the session lock, as for `spawn` and `resume`: two parents of one session
 * (two Pi, or a Pi and a resumed one) must not both see the last free slot. So the count is made again on
 * the runs as they are under the lock. The tmux start follows outside the lock, in a child process, as on a
 * busy machine it takes a second or more and the tick runs on Pi's UI thread. A start that fails is reported
 * once when tmux ends; `settleTmuxCalls` waits for it.
 */
export function startQueuedRuns(runs: RunMetadata[], onError: (run: RunMetadata, message: string) => void): RunMetadata[] {
	// No queued run: no liveness check, so the tick costs only the listing.
	const sessionId = runs.find((run) => run.state === "queued")?.parentSessionId;
	if (sessionId === undefined) return runs;
	let result: { runs: RunMetadata[]; claimed: Extract<Claim, { claimed: true }>[] };
	try {
		result = countedUnderLock(sessionId, runs, (sessionExists) => claimQueuedRuns(listRuns(sessionId), sessionExists));
	} catch (error) {
		// The session lock is held, by a stalled process: nothing changed, the next tick tries again.
		if (error instanceof LockBusyError) return runs;
		throw error;
	}
	for (const claimed of result.claimed) {
		track(
			startLaunchAsync(claimed.run).catch((error: unknown) => {
				// Known first, so neither the tick nor the time limit reports it again.
				markExitKnown(claimed.run.runDir);
				try {
					waitingAtMost(TICK_LOCK_WAIT_MS, () => launchFailed(claimed, error));
				} catch (failure) {
					// A stalled process holds the lock: the run stays `starting` until its grace time ends; known, it is not reported as exited.
					if (!(failure instanceof LockBusyError)) throw failure;
				}
				writeResult(claimed.run, "failed to start", errorText(error));
				onError(claimed.run, errorText(error));
			}),
		);
	}
	return result.runs;
}

/** Under the session lock: claim the queued ones of `runs` while a slot is free. Starts no program. */
function claimQueuedRuns(runs: RunMetadata[], sessionExists: (session: string) => boolean) {
	let free = runLimit() - liveRunCount(runs, sessionExists);
	const claimed: Extract<Claim, { claimed: true }>[] = [];
	const after = runs.flatMap((run) => {
		if (free <= 0 || run.state !== "queued") return [run];
		// Its `spawn` or `resume` has not saved the launch yet: tmux would start nothing. A later tick starts it.
		if (!existsSync(join(run.runDir, "launch.json"))) return [run];
		let claim: Claim;
		try {
			// A run can wait past the Pi that spawned it: this Pi starts it, so it is the parent for the orphan sweep.
			claim = claimRun(run, { parentPid: process.pid, parentStarted: ownStartTime() });
		} catch (error) {
			// Its lock is held, by a stalled process: nothing changed, the next tick tries again.
			if (error instanceof LockBusyError) return [run];
			throw error;
		}
		// `stop` removed the run since the listing.
		if (!claim.run) return [];
		if (!claim.claimed) return [claim.run];
		free--;
		claimed.push(claim);
		return [claim.run];
	});
	return { runs: after, claimed };
}

const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Claim a suspended run for a launch, with the caller's `patch`: `queued` for the tick, or `starting` for
 * `startRun`. It stays `suspended` until `startRun` launches it, so a launch that fails is tried again on
 * the next resume. Undefined when another resume, of a parent or of `subagent resume`, claimed it first: a
 * second launch would fail on the tmux session and mark the live run `error`.
 */
export function claimSuspendedRun(run: RunMetadata, state: "queued" | "starting", patch: Partial<RunMetadata> = {}): RunMetadata | undefined {
	// A child that never started still has the launch `spawn` saved, with its first prompt. A started one gets
	// the work its suspend cut. The launch first: from the `queued` write on, a parent tick can start the run.
	if (!existsSync(join(run.runDir, "launch.json"))) prepareLaunch(run, resumeArgs(run));
	let claimed = false;
	const next = updateMetadata(run.runDir, (current) => {
		// Claimed: `queued`, or `starting` with no process yet. Past the grace time, its claimer died before the launch.
		const taken = current.state === "queued" || (current.childPid === null && inStartingGrace(current));
		claimed = current.suspended === true && !taken;
		if (!claimed) return undefined;
		return {
			...patch,
			state,
			error: undefined,
			// The old process is gone; until the new one records its ID, the grace time tells whether it runs.
			childPid: null,
			// The new process reports its own start.
			sessionStartedAt: undefined,
			promptAccepted: undefined,
			waitsForTrust: undefined,
			trustReported: undefined,
			failedToStart: undefined,
		};
	});
	if (!next || !claimed) return undefined;
	// An earlier launch that failed was reported; the results of this one must be.
	clearExitKnown(run.runDir);
	return next;
}

/**
 * Queue the session's children suspended in the last 24 h, then start as many as the limit allows: resuming
 * a session with 6 children must not start 6 Pi at once. Older ones stay suspended; `subagent resume` starts
 * one by hand. `onError` gets each run that could not start.
 */
export function resumeSuspendedRuns(sessionId: string, onError: (run: RunMetadata, message: string) => void): void {
	for (const run of listRuns(sessionId)) {
		if (!run.suspended || run.state === "queued" || tmuxSessionExists(run.tmuxSession)) continue;
		// A run whose lock a stalled process holds is reported once and skipped; the others still resume.
		skippingBusyRun(
			() => {
				// A run that never started has no transcript, but its saved launch still holds its task.
				if (!existsSync(run.sessionFile) && !existsSync(join(run.runDir, "launch.json"))) removeRunDir(run.runDir);
				else if (Date.now() - Date.parse(run.suspendedAt ?? run.updatedAt) <= RESUME_WINDOW_MS) claimSuspendedRun(run, "queued");
			},
			(message) => onError(run, message),
		);
	}
	startQueuedRuns(listRuns(sessionId), onError);
}

/**
 * The parent tick and `wait` call this: a child that has not answered yet (`starting`, `busy`, or `idle`
 * before its first turn) past its deadline is stopped and reported once as `timed out`. An idle child that
 * answered stays; a prompt that starts its next turn sets a new deadline. The run directory stays, so its
 * transcript can show where the child was stuck.
 *
 * A child that has not recorded its process ID past its grace time was reported `exited`, but its Pi can
 * still run in tmux (a slow start): it is ended too, with no second message.
 *
 * `runs` can be older than the run: a child can go idle after the listing. So the listing only picks the
 * candidates; the decision is made again on the run as it is under its lock.
 */
export function stopTimedOutRuns(runs: RunMetadata[]): void {
	for (const listed of runs) {
		if (!isPastLimit(listed)) continue;
		// Its process ended: nothing to stop. One with no process ID yet can still run in tmux.
		if (listed.childPid !== null && effectiveRunState(listed) === "exited") continue;
		// Already reported (`exited`, `failed to start`): it is ended with no second message.
		const reported = isExitKnown(listed.runDir);
		let stopped = false;
		let run: RunMetadata | undefined;
		try {
			run = updateMetadata(listed.runDir, (current) => {
				stopped = isPastLimit(current);
				return stopped ? { timedOut: true } : undefined;
			});
		} catch (error) {
			// Its lock is held, by a stalled process: nothing changed, the next tick tries again.
			if (error instanceof LockBusyError) continue;
			throw error;
		}
		if (!run || !stopped) continue;
		// Before the kill, so the aborted turn and the ended process are not reported as well.
		markExitKnown(run.runDir);
		// In a child process, as the tick runs on Pi's UI thread. The result is written now: `wait` prints and
		// clears it at once, and a result written after that would reach the parent a second time.
		track(new Promise((resolveKill) => execFile("tmux", ["kill-session", "-t", run.tmuxSession], () => resolveKill())));
		if (!reported) writeResult(run, "timed out", timedOutText(run));
	}
}

/** Has not answered yet (`starting`, `busy`, or `idle` before its first turn) past its deadline, and not yet stopped or suspended. */
function isPastLimit(run: RunMetadata): boolean {
	if (!hasNotAnswered(run)) return false;
	return !!run.deadline && !run.timedOut && !run.suspended && Date.now() >= Date.parse(run.deadline);
}

function hasNotAnswered(run: RunMetadata): boolean {
	return run.state === "starting" || run.state === "busy" || (run.state === "idle" && !run.hasStarted);
}

/**
 * Whether the tick must stay for the time limit of `run`: it has not recorded its process ID, so past its
 * grace time it is reported `exited` and shown nowhere, but its Pi can still run in tmux until its deadline.
 */
export function awaitsDeadline(run: RunMetadata): boolean {
	return run.state === "starting" && run.childPid === null && !!run.deadline && !run.timedOut && !run.suspended;
}

export function timedOutText(run: RunMetadata): string {
	return `It passed its time limit of ${run.timeout} and was stopped. Transcript: ${run.sessionFile}`;
}
