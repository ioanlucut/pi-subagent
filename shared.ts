import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "launcher.ts");

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

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
	tmuxSession: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
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

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}
	const launchFile = writeLaunchFile(
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

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!tmuxSessionExists(metadata.tmuxSession)
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
		updateMetadata(run.runDir, { suspended: true });
		spawnSync("tmux", ["kill-session", "-t", run.tmuxSession], { stdio: "ignore" });
	}
	// Wait for all at once: the parent can be killed while it waits, and every child must be stopped first.
	await Promise.all(runs.map((run) => waitForRunShutdown(run.runDir)));
}

/** Suspend running children whose parent process died without its shutdown handler (crash, kill -9, lost terminal). */
export async function suspendOrphanedRuns(): Promise<void> {
	await suspendRuns(listRuns().filter((run) => parentIsGone(run) && tmuxSessionExists(run.tmuxSession)));
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

/** Relaunch the session's children that were suspended. `onError` gets each run that could not start. */
export function resumeSuspendedRuns(sessionId: string, onError: (run: RunMetadata, message: string) => void): void {
	for (const run of listRuns(sessionId)) {
		if (!run.suspended || tmuxSessionExists(run.tmuxSession)) continue;
		if (!existsSync(run.sessionFile)) {
			removeRunDir(run.runDir);
			continue;
		}
		const starting =
			updateMetadata(run.runDir, {
				state: "starting",
				error: undefined,
				parentPid: process.pid,
				parentStarted: processStartTime(process.pid),
			}) ?? run;
		try {
			launchRun(starting);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			updateMetadata(run.runDir, { state: "error", error: message });
			onError(run, message);
		}
	}
}
