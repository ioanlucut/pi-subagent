import { execFile } from "node:child_process";
import { LockBusyError } from "./lock.ts";
import { isExitKnown, markExitKnown, writeResult } from "./outbox.ts";
import { track } from "./queue.ts";
import { awaitsLaunchTurn, effectiveRunState, forOneRun, hasFirstPrompt, type RunMetadata, updateMetadata } from "./shared.ts";

/** Pi accepts the first prompt right after its session starts; one it has not accepted by then was rejected. */
export const FIRST_PROMPT_MS = 15_000;

/**
 * The parent tick and `wait` call this for children whose start is stuck, so the parent hears of each once:
 *
 * - Idle with the prompt of its launch not accepted 15 s after its session started (Pi rejected it: no login,
 *   no such model). That is the first prompt, or for a resumed child the work its suspend cut. It is stopped,
 *   and reported `failed to start` with the end of its screen, which shows Pi's error. Its slot is free once
 *   it is stopped.
 * - At Pi's trust prompt for 15 s. The user decides trust, so it waits, keeps its slot, and its time limit
 *   holds; the parent is told where to answer.
 *
 * The screen is read and the session ended in child processes, as the tick runs on Pi's UI thread.
 */
export function reportStuckStarts(runs: RunMetadata[], now = Date.now()): void {
	for (const listed of runs) forOneRun(listed, () => checkStart(listed, now), undefined);
}

function checkStart(listed: RunMetadata, now: number): void {
	if (listed.suspended || isExitKnown(listed.runDir) || effectiveRunState(listed) === "exited") return;
	if (isRejectedFirstPrompt(listed, now)) failStart(listed, now);
	else if (isWaitingForTrust(listed, now)) reportTrustWait(listed, now);
}

function isRejectedFirstPrompt(run: RunMetadata, now: number): boolean {
	if (run.state !== "idle" || !awaitsLaunchTurn(run) || run.promptAccepted || run.timedOut || run.failedToStart || !run.sessionStartedAt) return false;
	// A child resumed with no work to do is idle by design.
	return now - Date.parse(run.sessionStartedAt) >= FIRST_PROMPT_MS && (run.cutWork === "continue" || hasFirstPrompt(run.runDir));
}

function isWaitingForTrust(run: RunMetadata, now: number): boolean {
	return run.state === "starting" && !!run.waitsForTrust && !run.trustReported && !run.timedOut && now - Date.parse(run.waitsForTrust.since) >= FIRST_PROMPT_MS;
}

/** Claim the run under its lock, so two parents, or a tick and `wait`, report it once. */
function claim(run: RunMetadata, test: (current: RunMetadata) => boolean, patch: Partial<RunMetadata>): RunMetadata | undefined {
	let claimed = false;
	try {
		const current = updateMetadata(run.runDir, (current) => {
			claimed = test(current);
			return claimed ? patch : undefined;
		});
		return claimed ? current : undefined;
	} catch (error) {
		// Its lock is held, by a stalled process: nothing changed, the next tick tries again.
		if (error instanceof LockBusyError) return undefined;
		throw error;
	}
}

function failStart(listed: RunMetadata, now: number): void {
	const run = claim(listed, (current) => isRejectedFirstPrompt(current, now), { failedToStart: true });
	if (!run) return;
	// Before the kill, so the ended process is not reported as `exited` as well.
	markExitKnown(run.runDir);
	track(
		(async () => {
			const screen = await tmux(["capture-pane", "-p", "-J", "-t", run.tmuxSession]);
			await tmux(["kill-session", "-t", run.tmuxSession]);
			const reason = screenError(screen);
			const work = run.cutWork === "continue" ? "the continue message" : "its first prompt";
			const text = `Its Pi did not start ${work} within ${FIRST_PROMPT_MS / 1000} s, so it was stopped.${reason ? ` Its screen ended with:\n${reason}` : ""}`;
			// The result first: a `wait` that sees `error` prints it and clears it, so the parent gets it once.
			writeResult(run, "failed to start", text);
			updateMetadata(run.runDir, { state: "error", error: text });
		})(),
	);
}

function reportTrustWait(listed: RunMetadata, now: number): void {
	const run = claim(listed, (current) => isWaitingForTrust(current, now), { trustReported: true });
	if (!run?.waitsForTrust) return;
	writeResult(
		run,
		`waits for project trust in ${run.waitsForTrust.cwd}`,
		`Its Pi asks whether to trust the project folder, and has not started. The user decides: attach with \`tmux attach -t ${run.tmuxSession}\` and answer, or stop it. It keeps its slot until then${run.timeout ? `, and its time limit of ${run.timeout} holds` : ""}.`,
	);
}

/** The output of `tmux args`; empty when it fails. */
function tmux(args: string[]): Promise<string> {
	return new Promise((resolveCall) => execFile("tmux", args, { encoding: "utf8" }, (error, stdout) => resolveCall(error ? "" : stdout)));
}

/**
 * Pi's error on a child's screen: the lines above the editor from its last `Error:` line, up to the next notice.
 * With no `Error:` line, the last lines above the editor. Empty when the screen shows nothing.
 */
export function screenError(screen: string): string {
	const lines = screen.split("\n").map((line) => line.trim());
	// The editor's top border ends Pi's messages.
	const border = lines.findIndex((line) => /^─{10,}$/.test(line));
	const messages = (border === -1 ? lines : lines.slice(0, border)).filter(Boolean);
	const error = messages.findLastIndex((line) => line.startsWith("Error:"));
	if (error === -1) return messages.slice(-5).join("\n");
	const end = messages.findIndex((line, i) => i > error && line.startsWith("Warning:"));
	return messages.slice(error, end === -1 ? undefined : end).join("\n");
}
