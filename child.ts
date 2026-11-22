import { forgetSavedMessages } from "./inbox.ts";
import { reportSettledTurn } from "./outbox.ts";
import { awaitsLaunchTurn, dropFirstPrompt, holdAliveFifo, nextDeadline, ownLaunchId, readMetadata, type RunMetadata, updateMetadata, withRunLock } from "./shared.ts";

/** The child Pi's session, as its `session_start` sees it. */
export interface ChildSession {
	id: string;
	file: string | undefined;
	idle: boolean;
}

/**
 * The child's side of its run: what its Pi's events write to the run. A quit kills the child, but its Pi runs on
 * for seconds, and its handlers still fire. So each one changes the run, under its lock, only while the run is
 * this process's: not suspended, and of this launch. Else a late `session_start` would clear the suspension, a
 * late `agent_start` the work the suspend cut, and an aborted turn the saved first prompt, and the task would be
 * lost; once a resume launched the next child, the old one would write over it.
 */
export class ChildRun {
	private readonly runDir: string;
	/** Whether this launch recorded that Pi works on its prompt, so the 250 ms poll takes no lock after that. */
	private promptNoted = false;

	constructor(runDir: string) {
		this.runDir = runDir;
	}

	/** `session_start`: record this process, its session, and its state. */
	sessionStarted(session: ChildSession): void {
		this.promptNoted = false;
		if (!this.isOwn()) return;
		// The parent checks this FIFO each tick to find out, with no program started, whether this child runs. Before
		// the lock: it can start `mkfifo`.
		holdAliveFifo(this.runDir);
		this.changeOwn((current) => ({
			childSessionId: session.id,
			childPid: process.pid,
			sessionStartedAt: new Date().toISOString(),
			promptAccepted: undefined,
			waitsForTrust: undefined,
			trustReported: undefined,
			sessionFile: session.file ?? current.sessionFile,
			state: session.idle ? "idle" : "busy",
			error: undefined,
		}));
	}

	/** Whether the run is this process's now; the inbox hands no message to a child the quit killed. */
	isOwn(): boolean {
		const current = readMetadata(this.runDir);
		return !!current && this.isMine(current);
	}

	/**
	 * Each 250 ms, with whether Pi is idle. Pi turns busy when it starts the prompt's run, after it checked the model
	 * and its login, and before `before_agent_start`; another extension's handler there can hold the turn's start.
	 */
	poll(idle: boolean): void {
		if (!idle && !this.promptNoted) this.promptRunning();
	}

	/** `before_agent_start`, or Pi busy before it: Pi accepted the prompt of this launch. */
	promptRunning(): void {
		this.promptNoted = true;
		this.changeOwn((current) => (!awaitsLaunchTurn(current) || current.promptAccepted ? undefined : { promptAccepted: true }));
	}

	/** `agent_start`. */
	turnStarted(): void {
		// A turn from idle that the inbox did not start (typed in the pane): its time limit counts from now.
		this.changeOwn((current) => {
			const deadline = current.state === "idle" ? nextDeadline(current) : undefined;
			// The work a suspend cut is begun again, so a later suspend judges the turn by itself.
			return { state: "busy", hasStarted: true, error: undefined, cutWork: undefined, ...(deadline && { deadline }) };
		});
	}

	/** `agent_settled` with Pi idle. */
	turnSettled(): void {
		withRunLock(this.runDir, () => {
			const current = readMetadata(this.runDir);
			if (!current || !this.isMine(current)) return;
			// The result first: a `stop` that sees `idle` then finds it, and prints it.
			reportSettledTurn(this.runDir);
			dropFirstPrompt(this.runDir);
			forgetSavedMessages(this.runDir, current.sessionFile);
		});
		this.changeOwn(() => ({ state: "idle" }));
	}

	/** `session_shutdown`. A suspended child still says it ended: the parent's quit waits for that. */
	sessionEnded(reason: string): void {
		if (reason !== "quit") return;
		updateMetadata(this.runDir, (current) => (this.isOfLaunch(current) ? { state: "exited" } : undefined));
	}

	private isMine(run: RunMetadata): boolean {
		return !run.suspended && this.isOfLaunch(run);
	}

	/** A run of an older version has no launch ID: its child is the only one. */
	private isOfLaunch(run: RunMetadata): boolean {
		return run.launchId === undefined || run.launchId === ownLaunchId();
	}

	private changeOwn(patch: (current: RunMetadata) => Partial<RunMetadata> | undefined): void {
		updateMetadata(this.runDir, (current) => (this.isMine(current) ? patch(current) : undefined));
	}
}
