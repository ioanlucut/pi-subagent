import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LockBusyError } from "./lock.ts";
import { clearExitKnown, isExitKnown, markExitKnown, writeResult } from "./outbox.ts";
import {
	effectiveRunState,
	getAgentDir,
	isLive,
	listRuns,
	nextDeadline,
	ownStartTime,
	prepareLaunch,
	readMetadata,
	removeRunDir,
	type RunMetadata,
	startLaunch,
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
 *
 * The lock holds for milliseconds and starts no program: a run of an older version, which only tmux can
 * tell alive, is asked before it. A run that appears in between counts as live, which can only queue.
 */
export function writeNewRun(run: RunMetadata): boolean {
	const sessions = new Map<string, boolean>();
	if (run.parentSessionId !== undefined && process.env.PI_SUBAGENT_QUEUE === "1") {
		for (const other of listRuns(run.parentSessionId)) {
			effectiveRunState(other, (session) => {
				sessions.set(session, tmuxSessionExists(session));
				return sessions.get(session) as boolean;
			});
		}
	}
	const write = () => {
		const queued = mustQueue(run.parentSessionId, (session) => sessions.get(session) ?? true);
		writeMetadata({ ...run, state: queued ? "queued" : "starting" });
		return queued;
	};
	return run.parentSessionId === undefined ? write() : withSessionLock(run.parentSessionId, write);
}

/** The `State:` line that `spawn` and `resume` print. */
export function stateLine(queued: boolean): string {
	return `State: ${queued ? `queued, starts when fewer than ${runLimit()} children run` : "busy"}`;
}

/**
 * Start a run whose launch is saved: mark it `starting`, with `patch`, and start its tmux session. A launch
 * that fails leaves the run `error` and throws. Returns the run as it is after the start, or undefined when
 * `stop` removed it.
 *
 * A resumed run is no longer `suspended` from here: the time limit skips suspended runs, so a child that is
 * slow to start, or never starts, would otherwise pass its deadline unseen.
 *
 * Only a run still in the state the caller read is claimed, under its lock: two parents, or a tick and
 * `subagent resume`, can both read one run as `queued`. The one that loses starts nothing and gets the run
 * as the winner left it; a second launch would fail on the tmux session and mark the live run `error`.
 */
export function startRun(run: RunMetadata, patch: Partial<RunMetadata> = {}): RunMetadata | undefined {
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
	if (!starting || !claimed) return starting;
	try {
		startLaunch(starting);
	} catch (error) {
		// Still suspended, so the next resume tries it again.
		updateMetadata(run.runDir, { state: "error", suspended, error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
	// Read again: the launch wrote a new deadline.
	return readMetadata(run.runDir) ?? starting;
}

function liveRunCount(runs: RunMetadata[], sessionExists = tmuxSessionExists): number {
	return runs.filter((run) => isLive(effectiveRunState(run, sessionExists))).length;
}

/**
 * The parent tick: start the queued ones of the session's `runs`, oldest first, while fewer than the limit
 * run. Returns the runs as they are after it, so the tick lists the run directory once.
 */
export function startQueuedRuns(runs: RunMetadata[], onError: (run: RunMetadata, message: string) => void): RunMetadata[] {
	// No queued run: no liveness check, so the tick costs only the listing.
	if (!runs.some((run) => run.state === "queued")) return runs;
	let free = runLimit() - liveRunCount(runs);
	return runs.flatMap((run) => {
		if (free <= 0 || run.state !== "queued") return [run];
		// A run can wait past the Pi that spawned it: this Pi starts it, so it is the parent for the orphan sweep.
		try {
			const started = startRun(run, { parentPid: process.pid, parentStarted: ownStartTime() });
			// `stop` removed the run since the listing.
			if (!started) return [];
			free--;
			return [started];
		} catch (error) {
			// Its lock is held, by a stalled process: nothing changed, the next tick tries again.
			if (error instanceof LockBusyError) return [run];
			free--;
			const message = error instanceof Error ? error.message : String(error);
			// Reported once here; known, so the tick neither keeps it nor reports it again (time limit included).
			markExitKnown(run.runDir);
			writeResult(run, "failed to start", message);
			onError(run, message);
			return [readMetadata(run.runDir) ?? run];
		}
	});
}

const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Put a suspended run in the queue, with the caller's environment for its launch. It stays `suspended`
 * until `startRun` launches it, so a launch that fails is tried again on the next resume.
 */
export function queueSuspendedRun(run: RunMetadata, patch: Partial<RunMetadata> = {}): RunMetadata {
	const queued =
		updateMetadata(run.runDir, {
			...patch,
			state: "queued",
			error: undefined,
			// The old process is gone; until the new one records its ID, the grace time tells whether it runs.
			childPid: null,
		}) ?? run;
	// An earlier launch that failed was reported; the results of this one must be.
	clearExitKnown(run.runDir);
	// A child that never started still has the launch `spawn` saved, with its first prompt.
	if (!existsSync(join(run.runDir, "launch.json"))) prepareLaunch(queued);
	return queued;
}

/**
 * Queue the session's children suspended in the last 24 h, then start as many as the limit allows: resuming
 * a session with 6 children must not start 6 Pi at once. Older ones stay suspended; `subagent resume` starts
 * one by hand. `onError` gets each run that could not start.
 */
export function resumeSuspendedRuns(sessionId: string, onError: (run: RunMetadata, message: string) => void): void {
	for (const run of listRuns(sessionId)) {
		if (!run.suspended || run.state === "queued" || tmuxSessionExists(run.tmuxSession)) continue;
		// A run that never started has no transcript, but its saved launch still holds its task.
		if (!existsSync(run.sessionFile) && !existsSync(join(run.runDir, "launch.json"))) {
			removeRunDir(run.runDir);
			continue;
		}
		if (Date.now() - Date.parse(run.suspendedAt ?? run.updatedAt) > RESUME_WINDOW_MS) continue;
		queueSuspendedRun(run);
	}
	startQueuedRuns(listRuns(sessionId), onError);
}

/**
 * The parent tick and `wait` call this: a child still working (`starting` or `busy`) past its deadline is
 * stopped and reported once as `timed out`. An idle child has answered, so it stays; a prompt that starts
 * its next turn sets a new deadline. The run directory stays, so its transcript can show where the child was stuck.
 *
 * `runs` can be older than the run: a child can go idle after the listing. So the listing only picks the
 * candidates; the decision is made again on the run as it is under its lock.
 */
export function stopTimedOutRuns(runs: RunMetadata[]): void {
	for (const listed of runs) {
		if (!isPastLimit(listed)) continue;
		if (isExitKnown(listed.runDir) || effectiveRunState(listed) === "exited") continue;
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
		spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
		writeResult(run, "timed out", timedOutText(run));
	}
}

/** Still working (`starting` or `busy`) past its deadline, and not yet stopped or suspended. */
function isPastLimit(run: RunMetadata): boolean {
	if (run.state !== "starting" && run.state !== "busy") return false;
	return !!run.deadline && !run.timedOut && !run.suspended && Date.now() >= Date.parse(run.deadline);
}

export function timedOutText(run: RunMetadata): string {
	return `It passed its time limit of ${run.timeout} and was stopped. Transcript: ${run.sessionFile}`;
}
