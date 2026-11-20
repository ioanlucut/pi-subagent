import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isExitKnown, markExitKnown, writeResult } from "./outbox.ts";
import {
	effectiveRunState,
	getAgentDir,
	isLive,
	listRuns,
	prepareLaunch,
	processStartTime,
	readMetadata,
	removeRunDir,
	type RunMetadata,
	startLaunch,
	tmuxSessionExists,
	updateMetadata,
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
export function mustQueue(sessionId: string | undefined): boolean {
	if (process.env.PI_SUBAGENT_QUEUE !== "1" || sessionId === undefined) return false;
	const runs = listRuns(sessionId);
	return runs.some((run) => run.state === "queued") || liveRunCount(runs) >= runLimit();
}

/** The `State:` line that `spawn` and `resume` print. */
export function stateLine(queued: boolean): string {
	return `State: ${queued ? `queued, starts when fewer than ${runLimit()} children run` : "busy"}`;
}

/**
 * Start a run whose launch is saved: mark it `starting`, with `patch`, and start its tmux session. A launch
 * that fails leaves the run `error` and throws. Returns the run as it is after the start, or undefined when
 * `stop` removed it.
 */
export function startRun(run: RunMetadata, patch: Partial<RunMetadata> = {}): RunMetadata | undefined {
	const starting = updateMetadata(run.runDir, { ...patch, state: "starting" });
	if (!starting) return undefined;
	try {
		startLaunch(starting);
	} catch (error) {
		updateMetadata(run.runDir, { state: "error", error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
	// Read again: the launch wrote a new deadline.
	return readMetadata(run.runDir) ?? starting;
}

function liveRunCount(runs: RunMetadata[]): number {
	return runs.filter((run) => isLive(effectiveRunState(run))).length;
}

/** This Pi's start time, read once: `ps` costs a program start on the UI thread. */
let ownStartTime: string | undefined;

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
		ownStartTime ??= processStartTime(process.pid);
		try {
			const started = startRun(run, { parentPid: process.pid, parentStarted: ownStartTime });
			// `stop` removed the run since the listing.
			if (!started) return [];
			free--;
			return [started];
		} catch (error) {
			free--;
			onError(run, error instanceof Error ? error.message : String(error));
			return [readMetadata(run.runDir) ?? run];
		}
	});
}

const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Put a suspended run in the queue, with the caller's environment for its launch. It stays `suspended`
 * until its child starts, so a launch that fails is tried again on the next resume.
 */
export function queueSuspendedRun(run: RunMetadata, patch: Partial<RunMetadata> = {}): RunMetadata {
	const queued =
		updateMetadata(run.runDir, {
			...patch,
			state: "queued",
			error: undefined,
			// The old process is gone; until the new one records its ID, the grace time tells whether it runs.
			childPid: null,
			childStarted: undefined,
		}) ?? run;
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
 */
export function stopTimedOutRuns(runs: RunMetadata[]): void {
	for (const run of runs) {
		if (run.state !== "starting" && run.state !== "busy") continue;
		if (!run.deadline || run.timedOut || run.suspended || Date.now() < Date.parse(run.deadline)) continue;
		if (isExitKnown(run.runDir) || effectiveRunState(run) === "exited") continue;
		// First, so the aborted turn and the ended process are not reported as well.
		markExitKnown(run.runDir);
		updateMetadata(run.runDir, { timedOut: true });
		spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
		writeResult(run, "timed out", timedOutText(run));
	}
}

export function timedOutText(run: RunMetadata): string {
	return `It passed its time limit of ${run.timeout} and was stopped. Transcript: ${run.sessionFile}`;
}
