import { rmSync } from "node:fs";
import { TICK_LOCK_WAIT_MS, waitingAtMost } from "./lock.ts";
import { hasResults, isExitKnown, reportExitedRuns, returnResults, takeResults } from "./outbox.ts";
import { awaitsDeadline, startQueuedRuns, stopTimedOutRuns } from "./queue.ts";
import { effectiveRunState, guarded, listRuns, type RunMetadata, type RunState } from "./shared.ts";
import { reportStuckStarts } from "./start-check.ts";

export interface SessionTickOptions {
	sessionId: () => string;
	/** Show the session's children that have not exited: the widget rows and the Herdr panes. */
	show?: (rows: { run: RunMetadata; state: RunState }[]) => void;
	/** Put the children's results into the chat. `ready` is false when Pi would reject a message now. */
	deliver?: { ready: () => boolean; send: (text: string) => void };
	/** A queued child that could not start. */
	onStartError?: (run: RunMetadata, message: string) => void;
}

/**
 * The parent's one-second work, run only while the session has children, queued ones included: a Pi
 * with no children reads no file and starts no program each second. It starts queued children when a
 * slot is free. `wake` runs it at once and keeps it running while a child
 * lives or a result waits; call it when a child may have started (session start, after a tool call).
 */
export class SessionTick {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly options: SessionTickOptions;
	// An error keeps the timer, so the next tick tries again.
	// A lock held by a stalled process makes a tick give up its work on that run, not block Pi's UI thread.
	private readonly tick = guarded("subagent tick", () => {
		if (!waitingAtMost(TICK_LOCK_WAIT_MS, () => this.run())) this.stop();
	});

	constructor(options: SessionTickOptions) {
		this.options = options;
	}

	wake(): void {
		if (this.timer) return;
		this.timer = setInterval(this.tick, 1000);
		this.timer.unref();
		this.tick();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One tick. Returns whether there is work for the next one. */
	private run(): boolean {
		const { sessionId, show, deliver, onStartError } = this.options;
		const runs = startQueuedRuns(listRuns(sessionId()), onStartError ?? (() => {}));
		// Before the delivery guard: a time limit holds with results off and while Pi cannot take a message.
		stopTimedOutRuns(runs);
		reportStuckStarts(runs);
		// A launch that failed was reported, and no child runs: its row would keep the tick for nothing.
		const rows = runs
			.map((run) => ({ run, state: effectiveRunState(run) }))
			.filter(({ run, state }) => state !== "exited" && !(state === "error" && isExitKnown(run.runDir)));
		show?.(rows);
		// A child reported `exited` that may still run in tmux keeps the tick for its time limit.
		const deadlines = runs.some(awaitsDeadline);
		if (!deliver) return rows.length > 0 || deadlines;
		// Results that wait for Pi keep the tick until they are sent.
		if (!deliver.ready()) return runs.length > 0;
		const inGrace = reportExitedRuns(runs);
		const taken = takeResults(runs);
		if (taken) {
			try {
				deliver.send(taken.text);
			} catch (error) {
				returnResults(taken.files);
				throw error;
			}
			for (const file of taken.files) rmSync(file, { force: true });
		}
		return rows.length > 0 || inGrace || deadlines || hasResults(runs);
	}
}
