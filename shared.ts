import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LockBusyError, TICK_LOCK_WAIT_MS, waitingAtMost, withLock } from "./lock.ts";

const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "launcher.ts");

/** `queued`: written by `spawn` past the limit; the parent tick starts it when a slot is free. */
export type RunState = "queued" | "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	/** Process ID of the parent pi, so a later parent can find children whose parent died. */
	parentPid?: number;
	/** Start time of the parent pi (`ps -o lstart`), so a reused process ID does not count as the parent. */
	parentStarted?: string;
	childSessionId?: string;
	/**
	 * Process ID of the child pi, written by the child when its session starts. `null` until then; a run
	 * with no field at all is from a version before this one, and only tmux knows whether it runs.
	 */
	childPid?: number | null;
	tmuxSession: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Time limit as given to `spawn --timeout`, such as `10m`. */
	timeout?: string;
	/** When the time limit ends, set each time the child is launched; the parent then stops the child. */
	deadline?: string;
	/** Set when the parent stopped the child at its deadline. */
	timedOut?: boolean;
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	/** When the parent suspended the child; resume leaves a child suspended longer than a day. */
	suspendedAt?: string;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	/** `interrupt`: end the current turn, like Escape in the child. */
	delivery: "auto" | "followUp" | "interrupt";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

const DURATION_UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** Milliseconds in a duration such as `90s`, `10m`, or `1h`; undefined when it is not one. */
export function parseDuration(value: string): number | undefined {
	const match = /^([1-9]\d*)([smh])$/.exec(value);
	return match ? Number(match[1]) * DURATION_UNITS[match[2]] : undefined;
}

/** Survives `/reload`, which loads this module again in the same process. */
const processState = globalThis as { piSubagentRunDir?: string; piSubagentAliveFd?: number; piSubagentOwnStarted?: string };

/**
 * The run this process is the child of. The child takes PI_SUBAGENT_RUN_DIR out of its environment, so a
 * Pi that its tools start (a test, a script) does not act as the child: read its inbox, rewrite its
 * metadata, mark it exited. Such a process inherits PI_SUBAGENT_NESTED, which turns the extension and
 * `spawn` off.
 */
export function claimRunDir(): string | undefined {
	const inherited = process.env.PI_SUBAGENT_RUN_DIR;
	if (inherited) {
		processState.piSubagentRunDir = inherited;
		delete process.env.PI_SUBAGENT_RUN_DIR;
		process.env.PI_SUBAGENT_NESTED = "1";
	}
	return processState.piSubagentRunDir;
}

/**
 * A timer callback that cannot end Pi: an error thrown in a timer is an uncaught exception, and Pi
 * exits on one. The error is logged once; the next tick runs again.
 */
export function guarded(name: string, callback: () => void): () => void {
	let reported = false;
	return () => {
		try {
			callback();
		} catch (error) {
			if (reported) return;
			reported = true;
			console.error(`pi-subagent: ${name} failed, retrying each tick: ${error instanceof Error ? error.stack : String(error)}`);
		}
	};
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

/** Whether a result waits for the parent; the outbox module reads and sends it. */
function hasOutbox(runDir: string): boolean {
	const dir = join(runDir, "outbox");
	return existsSync(dir) && readdirSync(dir).some((file) => file.endsWith(".txt"));
}

/** Whether a `send` is queued that the child has not taken yet. */
export function inboxHasMessages(runDir: string): boolean {
	const dir = inboxDir(runDir);
	return existsSync(dir) && readdirSync(dir).some((file) => file.endsWith(".json"));
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.tmuxSession !== "string" ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

/** Write a whole run, as `spawn` does for a new one; a change to a run goes through `updateMetadata`. */
export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	withRunLock(metadata.runDir, () => replaceMetadata(metadata));
}

function replaceMetadata(metadata: RunMetadata): void {
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

/**
 * Run `fn` while this process holds the lock of the run: the parent tick, the CLI, and the child each
 * change the run's metadata, and a write from an older read drops another's change. Undefined, with
 * `fn` not run, when the run is gone.
 */
export function withRunLock<T>(runDir: string, fn: () => T): T | undefined {
	return withLock(join(runDir, "metadata.lock"), fn);
}

/**
 * Run `fn` while this process holds the lock of the parent session `sessionId`, for a change that reads
 * several of its runs, such as the count against the limit.
 */
export function withSessionLock<T>(sessionId: string, fn: () => T): T {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	// A hash: the ID comes from the caller's environment and must not name a path.
	const name = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
	return withLock(join(getRunsDir(), `session-${name}.lock`), fn) as T;
}

/**
 * Change a run under its lock: read, apply `patch`, write. A function `patch` gets the run as it is under
 * the lock, for a change that depends on it; when it returns undefined, the run stays as it is. Undefined
 * when the run is gone; it is not created again.
 */
export function updateMetadata(
	runDir: string,
	patch: Partial<RunMetadata> | ((current: RunMetadata) => Partial<RunMetadata> | undefined),
): RunMetadata | undefined {
	return withRunLock(runDir, () => {
		const current = readMetadata(runDir);
		if (!current) return undefined;
		const change = typeof patch === "function" ? patch(current) : patch;
		if (!change) return current;
		const next: RunMetadata = {
			...current,
			...change,
			version: 1,
			handle: current.handle,
			runDir: current.runDir,
			updatedAt: new Date().toISOString(),
		};
		replaceMetadata(next);
		return next;
	});
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

/** Where Pi keeps the sessions of `cwd`, the same path `pi --resume` reads there. */
function sessionDirFor(cwd: string): string {
	return join(getAgentDir(), "sessions", `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

/**
 * Where a transcript is kept when its run is removed: Pi's sessions for the child's working directory, named
 * as Pi names it, so `pi --resume` there lists it. Undefined when the transcript has no session header yet.
 */
export function keptTranscriptPath(sessionFile: string): string | undefined {
	try {
		const [header] = readFileSync(sessionFile, "utf8").split("\n", 1);
		const session = JSON.parse(header) as { type?: unknown; id?: unknown; timestamp?: unknown; cwd?: unknown };
		if (session.type !== "session" || typeof session.id !== "string" || typeof session.cwd !== "string" || typeof session.timestamp !== "string") return undefined;
		return join(sessionDirFor(session.cwd), `${session.timestamp.replace(/[:.]/g, "-")}_${session.id}.jsonl`);
	} catch {
		return undefined;
	}
}

/** Remove a run. A transcript with an answer is first copied to `keptTranscriptPath`. Returns that path. */
export function removeRunDir(runDir: string): string | undefined {
	let kept: string | undefined;
	const metadata = readMetadata(runDir);
	const target = metadata && keptTranscriptPath(metadata.sessionFile);
	if (metadata && target && readLatestAssistant(metadata.sessionFile)) {
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		copyFileSync(metadata.sessionFile, target);
		kept = target;
	}
	// Under the lock, so no update in flight writes the run again.
	withRunLock(runDir, () => rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
	return kept;
}

export function tmuxSessionExists(session: string): boolean {
	return spawnSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }).status === 0;
}

/** Variables tmux sets for each pane. They describe the child's terminal, so they win over the caller's. */
export const TMUX_PANE_VARIABLES = ["TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TMUX", "TMUX_PANE"];

/**
 * Save the caller's environment and the command for `launcher.ts`. tmux would otherwise give a new
 * session the environment of the process that started the tmux server. The file sits in the
 * private run dir and keeps values out of process arguments; the launcher deletes it on start.
 */
function writeLaunchFile(runDir: string, env: NodeJS.ProcessEnv, command: string[]): string {
	const file = join(runDir, "launch.json");
	writeFileSync(file, JSON.stringify({ env, command }), { encoding: "utf8", mode: 0o600 });
	return file;
}

/**
 * Save the launch of a run for `startLaunch`, now or, for a queued run, later from the parent tick: the
 * child still gets the environment of the `spawn` caller. `initialArgs` are only passed on first spawn.
 */
export function prepareLaunch(metadata: RunMetadata, initialArgs: string[] = []): void {
	// A file in the working directory must not choose the program: a cloned repository could.
	const launcher = process.env.PI_SUBAGENT_PI || "pi";
	writeLaunchFile(
		metadata.runDir,
		{ ...process.env, PWD: metadata.cwd, PI_SUBAGENT_RUN_DIR: metadata.runDir },
		[
			launcher,
			"--session",
			metadata.sessionFile,
			"--provider",
			metadata.provider,
			"--model",
			metadata.model,
			"--thinking",
			metadata.thinking,
			...(metadata.launchArgs ?? []),
			...initialArgs,
		],
	);
}

/** When the time limit of a run that starts work now ends; undefined for a run with no limit. */
export function nextDeadline(metadata: RunMetadata): string | undefined {
	const limit = metadata.timeout === undefined ? undefined : parseDuration(metadata.timeout);
	return limit === undefined ? undefined : new Date(Date.now() + limit).toISOString();
}

/** Start the tmux session of a run whose launch `prepareLaunch` saved. Throws when tmux fails. */
export function startLaunch(metadata: RunMetadata): void {
	const result = spawnSync("tmux", newSessionArgs(metadata), { encoding: "utf8" });
	if (result.status !== 0) launchFailed(metadata, result.stderr);
}

/**
 * `startLaunch` for the parent tick, which runs on Pi's UI thread: tmux runs as a child process, so a slow
 * program start does not block the tick. Rejects when tmux fails.
 */
export function startLaunchAsync(metadata: RunMetadata): Promise<void> {
	return new Promise((resolveLaunch, rejectLaunch) => {
		execFile("tmux", newSessionArgs(metadata), { encoding: "utf8" }, (error, _stdout, stderr) => {
			try {
				if (error) launchFailed(metadata, stderr);
				resolveLaunch();
			} catch (failure) {
				rejectLaunch(failure);
			}
		});
	});
}

function newSessionArgs(metadata: RunMetadata): string[] {
	return [
		"new-session",
		"-d",
		"-s",
		metadata.tmuxSession,
		"-x",
		"120",
		"-y",
		"40",
		"-c",
		metadata.cwd,
		"--",
		// Start the launcher with only tmux's pane variables: server values such as NODE_OPTIONS could break node.
		"/bin/sh",
		"-c",
		`exec /usr/bin/env -i ${TMUX_PANE_VARIABLES.map((name) => `${name}="$${name}"`).join(" ")} "$@"`,
		"launch",
		process.execPath,
		launcherPath,
		join(metadata.runDir, "launch.json"),
	];
}

function launchFailed(metadata: RunMetadata, stderr: string | undefined): never {
	rmSync(join(metadata.runDir, "launch.json"), { force: true });
	throw new Error(stderr?.trim() || "Failed to create tmux session");
}

/** tmux starts just after the metadata is written; a run this young whose child has not recorded its ID has not died. */
export const STARTING_GRACE_MS = 30_000;

/** Whether a `starting` run is still in its grace time, so a child with no process ID yet is not dead. */
export function inStartingGrace(metadata: RunMetadata): boolean {
	return metadata.state === "starting" && Date.now() - Date.parse(metadata.updatedAt) < STARTING_GRACE_MS;
}

const aliveFifoPath = (runDir: string): string => join(runDir, "alive");

/**
 * Open the read end of the run's FIFO, created on first use, and return its descriptor. The child holds it
 * open for its whole life; the kernel closes it when the child ends, also on `kill -9`. Node opens files with
 * close-on-exec, so programs the child starts do not hold it.
 */
export function openAliveFifo(runDir: string): number {
	const path = aliveFifoPath(runDir);
	// Node has no mkfifo. The child runs this once at its start, never the parent's tick.
	if (!existsSync(path)) spawnSync("mkfifo", ["-m", "600", path], { stdio: "ignore" });
	return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
}

/** The child calls this before it records its process ID, so the parent never sees an ID with no FIFO holder. */
export function holdAliveFifo(runDir: string): void {
	try {
		processState.piSubagentAliveFd ??= openAliveFifo(runDir);
	} catch {
		// No FIFO (no `mkfifo`): the parent asks tmux, as for a child of an older version.
	}
}

/**
 * Whether the run's child process runs, with no program started: the widget and result ticks call this
 * each second on Pi's UI thread, where one program start can take 2 s on a busy machine. A process ID can
 * be reused, and on macOS only a program (`ps`) can read another process's start time, so the parent does
 * not check the ID: it opens the run's FIFO for writing without blocking, which fails with ENXIO when no
 * process holds the read end. A process that got the child's ID later does not hold it. A child that has
 * not recorded its ID yet lives while it is in its grace time. Only a run from an older version, with no
 * `childPid` field or no FIFO, asks tmux.
 */
function childIsAlive(metadata: RunMetadata, sessionExists: (session: string) => boolean): boolean {
	if (metadata.childPid === undefined) return sessionExists(metadata.tmuxSession);
	if (metadata.childPid === null) return inStartingGrace(metadata);
	try {
		closeSync(openSync(aliveFifoPath(metadata.runDir), constants.O_WRONLY | constants.O_NONBLOCK));
		return true;
	} catch (error) {
		// ENXIO: no process holds it. ENOENT: a child of an older version, which made no FIFO.
		return (error as NodeJS.ErrnoException).code === "ENOENT" && sessionExists(metadata.tmuxSession);
	}
}

/** Whether a run in this state holds a slot: started, and not known to have ended. */
export function isLive(state: RunState): boolean {
	return state === "starting" || state === "busy" || state === "idle";
}

/** `sessionExists` answers for a run of an older version, which only tmux can tell: by default, it asks tmux. */
export function effectiveRunState(metadata: RunMetadata, sessionExists = tmuxSessionExists): RunState {
	return isLive(metadata.state) && !childIsAlive(metadata, sessionExists) ? "exited" : metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

/** How a turn ended, as `wait` and the result message say it. A failed turn is no result. */
export function turnOutcome(message: AssistantMessage): "finished" | "failed (error)" | "failed (aborted)" {
	return message.stopReason === "error" || message.stopReason === "aborted" ? `failed (${message.stopReason})` : "finished";
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}

/** Stop running children but keep transcript and metadata, so resuming the parent session relaunches them. */
export async function suspendRuns(runs: RunMetadata[]): Promise<void> {
	for (const run of runs) {
		// A child that has not recorded its process ID never writes `exited`: the parent marks it, so it is not alive in its grace time.
		skippingBusyRun(() =>
			updateMetadata(run.runDir, (current) => ({
				suspended: true,
				suspendedAt: new Date().toISOString(),
				...(current.childPid === null && { state: "exited" as const }),
			})),
		);
		// Also when its lock is busy: no child may outlive the quit.
		spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
	}
	// Wait for all at once: the parent can be killed while it waits, and every child must be stopped first.
	await Promise.all(runs.map((run) => waitForRunShutdown(run.runDir)));
}

/**
 * The parent quits or leaves the session: suspend its running and queued children, so resuming the session
 * starts them again within 24 h; remove those that already exited on their own. An exited child whose result
 * the parent has not sent yet stays as it is, so the tick sends it after resume and the next quit removes it.
 */
export async function suspendSessionRuns(sessionId: string): Promise<void> {
	const running: RunMetadata[] = [];
	for (const run of listRuns(sessionId)) {
		if (run.state === "queued") {
			// Never started: its saved launch keeps the first prompt for resume.
			skippingBusyRun(() => updateMetadata(run.runDir, { state: "exited", suspended: true, suspendedAt: new Date().toISOString() }));
		} else if (tmuxSessionExists(run.tmuxSession)) running.push(run);
		else if (!run.suspended && !hasOutbox(run.runDir)) skippingBusyRun(() => removeRunDir(run.runDir));
	}
	await suspendRuns(running);
}

/**
 * Run `fn`, the work on one run of a loop over many, such as the quit path. A lock that names a live process which
 * is not its holder (a holder killed and its process ID reused, or a stopped one) is never taken over: that
 * run is reported once and skipped, so the other runs are still handled. Its lock waits are as short as a
 * tick's, as a real hold takes a few ms: a quit must not wait 6 s for each such run.
 */
export function skippingBusyRun(fn: () => void, onBusy = (message: string) => console.error(message)): void {
	try {
		waitingAtMost(TICK_LOCK_WAIT_MS, fn);
	} catch (error) {
		if (!(error instanceof LockBusyError)) throw error;
		onBusy(error.message);
	}
}

/** Suspend running children whose parent process died without its shutdown handler (crash, kill -9, lost terminal). */
export async function suspendOrphanedRuns(): Promise<void> {
	await suspendRuns(listRuns().filter((run) => parentIsGone(run) && tmuxSessionExists(run.tmuxSession)));
	endSessionsWithoutRun();
}

/**
 * End child tmux sessions of this agent dir whose run directory is gone, for example after a crash
 * between `stop` and the tmux kill. Nothing can send to, wait for, or stop such a child.
 */
function endSessionsWithoutRun(): void {
	const list = spawnSync("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_start_command}"], { encoding: "utf8" });
	if (list.status !== 0) return;
	const runsDir = getRunsDir();
	for (const line of list.stdout.split("\n")) {
		const [session, command = ""] = line.split("\t");
		if (!/^pi-subagent-[a-z0-9]+$/.test(session)) continue;
		// The last argument of the pane command is the launch file in the run directory. Another agent dir: not ours.
		const runDir = dirname(command.trim().split(/\s+/).at(-1) ?? "");
		if (dirname(runDir) !== runsDir || existsSync(runDir)) continue;
		spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
	}
}

function parentIsGone(run: RunMetadata): boolean {
	if (run.parentPid === undefined) return false;
	if (!processExists(run.parentPid)) return true;
	// Same process ID, other start time: the ID now belongs to another process. Unknown start time: keep the child.
	const started = processStartTime(run.parentPid);
	return started !== undefined && run.parentStarted !== undefined && started !== run.parentStarted;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** This Pi's start time, read once: the extension calls this at load, so the tick that starts queued runs starts no `ps`. */
export function ownStartTime(): string | undefined {
	return (processState.piSubagentOwnStarted ??= processStartTime(process.pid) ?? "") || undefined;
}

/** Start time of a process, or undefined when it cannot be read. Together with the PID it names one process. */
export function processStartTime(pid: number): string | undefined {
	// Fixed locale and time zone, so every Pi gets the same text for the same process.
	const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
	});
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

const STALE_RUN_MS = 14 * 24 * 60 * 60 * 1000;

/** Remove runs of any session that have no live child and were last updated more than 14 days ago. */
export function pruneStaleRuns(): void {
	const cutoff = Date.now() - STALE_RUN_MS;
	for (const run of listRuns()) {
		if (Date.parse(run.updatedAt) < cutoff && !tmuxSessionExists(run.tmuxSession)) removeRunDir(run.runDir);
	}
}
