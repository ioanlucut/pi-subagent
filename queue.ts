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

/** Whether a new child of these runs must queue: the limit is reached, or older children wait. */
export function mustQueue(runs: RunMetadata[]): boolean {
	return runs.some((run) => run.state === "queued") || liveRunCount(runs) >= runLimit();
}

function liveRunCount(runs: RunMetadata[]): number {
	return runs.filter((run) => isLive(effectiveRunState(run))).length;
}

/** This Pi's start time, read once: `ps` costs a program start on the UI thread. */
let ownStartTime: string | undefined;

/** The parent tick: start the session's queued runs, oldest first, while fewer than the limit run. */
export function startQueuedRuns(sessionId: string, onError: (run: RunMetadata, message: string) => void): void {
	const runs = listRuns(sessionId);
	// No queued run: no liveness check, so the tick costs only the listing.
	if (!runs.some((run) => run.state === "queued")) return;
	let free = runLimit() - liveRunCount(runs);
	for (const run of runs) {
		if (free <= 0) return;
		if (run.state !== "queued") continue;
		// A run can wait past the Pi that spawned it: this Pi starts it, so it is the parent for the orphan sweep.
		ownStartTime ??= processStartTime(process.pid);
		const starting = updateMetadata(run.runDir, { state: "starting", parentPid: process.pid, parentStarted: ownStartTime });
		// `stop` removed the run since the listing.
		if (!starting) continue;
		free--;
		try {
			startLaunch(starting);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateMetadata(run.runDir, { state: "error", error: message });
			onError(run, message);
		}
	}
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
		if (!existsSync(run.sessionFile)) {
			removeRunDir(run.runDir);
			continue;
		}
		if (Date.now() - Date.parse(run.suspendedAt ?? run.updatedAt) > RESUME_WINDOW_MS) continue;
		queueSuspendedRun(run);
	}
	startQueuedRuns(sessionId, onError);
}

/**
 * The parent tick and `wait` call this: a child still running past its deadline is stopped and reported
 * once as `timed out`. The run directory stays, so its transcript can show where the child was stuck.
 */
export function stopTimedOutRuns(runs: RunMetadata[]): void {
	for (const run of runs) {
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
