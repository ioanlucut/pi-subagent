import { rmSync } from "node:fs";
import { pendingResults, reportExitedRuns, stopTimedOutRuns } from "./outbox.ts";
import { effectiveRunState, guarded, listRuns, type RunMetadata, type RunState } from "./shared.ts";

export interface SessionTickOptions {
	sessionId: () => string;
	/** Show the session's children that have not exited: the widget rows and the Herdr panes. */
	show?: (rows: { run: RunMetadata; state: RunState }[]) => void;
	/** Put the children's results into the chat. `ready` is false when Pi would reject a message now. */
	deliver?: { ready: () => boolean; send: (text: string) => void };
}

/**
 * The parent's one-second work, run only while the session has children: a Pi with no children reads
 * no file and starts no program each second. `wake` runs it at once and keeps it running while a child
 * lives or a result waits; call it when a child may have started (session start, after a tool call).
 */
export class SessionTick {
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly options: SessionTickOptions;
	// An error keeps the timer, so the next tick tries again.
	private readonly tick = guarded("subagent tick", () => {
		if (!this.run()) this.stop();
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
		const { sessionId, show, deliver } = this.options;
		const runs = listRuns(sessionId());
		const rows = runs.map((run) => ({ run, state: effectiveRunState(run) })).filter(({ state }) => state !== "exited");
		show?.(rows);
		if (!deliver) return rows.length > 0;
		// Results that wait for Pi keep the tick until they are sent.
		if (!deliver.ready()) return runs.length > 0;
		stopTimedOutRuns(runs);
		const starting = reportExitedRuns(runs);
		const pending = pendingResults(runs);
		if (pending) {
			deliver.send(pending.text);
			for (const file of pending.files) rmSync(file, { force: true });
		}
		return rows.length > 0 || starting;
	}
}
