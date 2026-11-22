import { TICK_LOCK_WAIT_MS, waitingAtMost } from "./lock.ts";
import { forgetDeliveredResults, hasResults, isExitKnown, reportExitedRuns, takeResultsToSend } from "./outbox.ts";
import { awaitsDeadline, startQueuedRuns, stopTimedOutRuns } from "./queue.ts";
import { actsAsParent, effectiveRunState, guarded, listRuns, type RunMetadata, type RunState } from "./shared.ts";
import { reportStuckStarts } from "./start-check.ts";

export interface SessionTickOptions {
	sessionId: () => string;
	/** Show the session's children that have not exited: the widget rows and the Herdr panes. */
	show?: (rows: { run: RunMetadata; state: RunState }[]) => void;
	/**
	 * Put the children's results into the chat. `ready`: Pi is idle, so `send` starts a turn with the message,
	 * not a queued follow-up that Escape or a quit drops. `send` gets the names of its results, and `delivered`
	 * gives the names of the results in the session; a result stays on disk until it is there.
	 */
	deliver?: { ready: () => boolean; send: (text: string, results: string[]) => void; delivered: () => ReadonlySet<string> };
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
		const ready = deliver.ready();
		// Another Pi on the session shows its runs, but only the run's owner sends their results.
		const owned = runs.filter((run) => actsAsParent(run, { exact: false }));
		// Before the resend: a result sent before a quit and found in the session is not sent again, however old.
		forgetDeliveredResults(owned, deliver.delivered);
		let inGrace = false;
		if (ready) {
			inGrace = reportExitedRuns(owned);
			const results = takeResultsToSend(owned);
			if (results) {
				deliver.send(results.text, results.results);
				forgetDeliveredResults(owned, deliver.delivered);
			}
		}
		// Results that wait for Pi keep the tick until they are in the session.
		if (!ready) return runs.length > 0;
		return rows.length > 0 || inGrace || deadlines || hasResults(owned);
	}
}
