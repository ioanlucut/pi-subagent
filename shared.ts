import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
	/** Process ID of the child pi, written by the child when its session starts. */
	childPid?: number;
	/** Start time of the child pi (`ps -o lstart`), so a reused process ID does not count as the child. */
	childStarted?: string;
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
const processState = globalThis as { piSubagentRunDir?: string };

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

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
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
 * Remove a run. A transcript with an answer is first copied into Pi's sessions for the child's working
 * directory, named as Pi names it, so `pi --resume` there lists it. Returns that path.
 */
export function removeRunDir(runDir: string): string | undefined {
	let kept: string | undefined;
	const metadata = readMetadata(runDir);
	try {
		const [header] = readFileSync(metadata?.sessionFile ?? "", "utf8").split("\n", 1);
		const session = JSON.parse(header) as { type?: unknown; id?: unknown; timestamp?: unknown; cwd?: unknown };
		if (metadata && readLatestAssistant(metadata.sessionFile) && session.type === "session" && typeof session.id === "string" && typeof session.cwd === "string" && typeof session.timestamp === "string") {
			const dir = sessionDirFor(session.cwd);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const target = join(dir, `${session.timestamp.replace(/[:.]/g, "-")}_${session.id}.jsonl`);
			copyFileSync(metadata.sessionFile, target);
			kept = target;
		}
	} catch {
		// No transcript or no header: nothing to keep.
	}
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

/** Start the child pi process for a run in its tmux session. `initialArgs` are only passed on first spawn. */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): void {
	prepareLaunch(metadata, initialArgs);
	startLaunch(metadata);
}

/**
 * Save the launch of a run without starting it, for a queued run: the parent tick starts it later
 * with `startLaunch`, and the child still gets the environment of the `spawn` caller.
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

/** Start the tmux session of a run whose launch `prepareLaunch` saved. */
export function startLaunch(metadata: RunMetadata): void {
	// The limit counts from each launch, so a resumed or queued child is not stopped for the time it did not run.
	// Written before tmux starts the child, which writes this file too.
	const limit = metadata.timeout === undefined ? undefined : parseDuration(metadata.timeout);
	if (limit !== undefined) updateMetadata(metadata.runDir, { deadline: new Date(Date.now() + limit).toISOString() });
	const launchFile = join(metadata.runDir, "launch.json");
	const result = spawnSync(
		"tmux",
		[
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
			launchFile,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		rmSync(launchFile, { force: true });
		throw new Error(result.stderr.trim() || "Failed to create tmux session");
	}
}

/** Verdicts on (process ID, start time) pairs, so `ps` runs once per child and not on each tick. */
const checkedChildren = new Map<string, boolean>();

/**
 * Whether the run's child process runs, with no program started in the normal case: the widget and
 * result ticks call this each second on Pi's UI thread, where one `tmux` call can take 2 s on a busy
 * machine. A process ID can be reused, so the start time is checked once with `ps`; an ID once found
 * dead stays dead. Runs from before the child recorded its process ID still ask tmux.
 */
function childIsAlive(metadata: RunMetadata): boolean {
	const pid = metadata.childPid;
	if (pid === undefined) return tmuxSessionExists(metadata.tmuxSession);
	const key = `${pid} ${metadata.childStarted}`;
	if (checkedChildren.get(key) === false || !processExists(pid)) {
		checkedChildren.set(key, false);
		return false;
	}
	const known = checkedChildren.get(key);
	if (known !== undefined || metadata.childStarted === undefined) return known ?? true;
	const started = processStartTime(pid);
	// Unknown start time: keep the child, as for the parent, and ask again next tick.
	if (started === undefined) return true;
	checkedChildren.set(key, started === metadata.childStarted);
	return started === metadata.childStarted;
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!childIsAlive(metadata)
	) {
		return "exited";
	}
	return metadata.state;
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
		updateMetadata(run.runDir, { suspended: true, suspendedAt: new Date().toISOString() });
		spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
	}
	// Wait for all at once: the parent can be killed while it waits, and every child must be stopped first.
	await Promise.all(runs.map((run) => waitForRunShutdown(run.runDir)));
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

/** Children that may run at once in one parent session: `PI_SUBAGENT_LIMIT`, default 4. */
export function runLimit(): number {
	const limit = Number(process.env.PI_SUBAGENT_LIMIT);
	return Number.isInteger(limit) && limit > 0 ? limit : 4;
}

/** Whether a new child of these runs must queue: the limit is reached, or older children wait. */
export function mustQueue(runs: RunMetadata[]): boolean {
	return runs.some((run) => run.state === "queued") || liveRunCount(runs) >= runLimit();
}

/** Children that hold a slot: started, and their process not known to have ended. */
function liveRunCount(runs: RunMetadata[]): number {
	return runs.filter((run) => ["starting", "busy", "idle"].includes(effectiveRunState(run))).length;
}

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
		const starting = updateMetadata(run.runDir, { state: "starting", parentPid: process.pid, parentStarted: processStartTime(process.pid) });
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
			// The old process is gone; until the new one records its ID, tmux tells whether it runs.
			childPid: undefined,
			childStarted: undefined,
		}) ?? run;
	prepareLaunch(queued);
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
