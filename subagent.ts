#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findAgent, listAgents } from "./agents.ts";
import { clearResults, isExitKnown, markExitKnown, markWaiting, takeResults } from "./outbox.ts";
import { resumeRun, startRun, stateLine, stopTimedOutRuns, timedOutText, writeNewRun } from "./queue.ts";
import {
	assistantText,
	getAgentDir,
	effectiveRunState,
	getRunsDir,
	inboxDir,
	inboxHasMessages,
	listRuns,
	prepareLaunch,
	parseDuration,
	readLatestAssistant,
	readMetadata,
	removeRunDir,
	runDisplayName,
	isValidRunName,
	type InboxMessage,
	type RunMetadata,
	tmuxSessionExists,
	turnOutcome,
	updateMetadata,
	waitForRunShutdown,
} from "./shared.ts";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const GUARD = "cc-safety-net";

/** Where Pi keeps a package of its `settings.json`, after Pi's package manager: npm, git, or a local path. */
function packagePath(source: string): string {
	const agentDir = getAgentDir();
	if (source.startsWith("npm:")) {
		const spec = source.slice(4).trim();
		const at = spec.indexOf("@", 1);
		return join(agentDir, "npm", "node_modules", at === -1 ? spec : spec.slice(0, at));
	}
	const git = /^(?:git:|[a-z+]+:\/\/|git@)(?:[^@/]+@)?([^/:]+)[/:]([^@]+?)(?:\.git)?(?:@.*)?$/.exec(source);
	if (git) return join(agentDir, "git", git[1], git[2]);
	return resolve(agentDir, source.replace(/^~(?=\/|$)/, homedir()));
}

/**
 * The command guard where Pi installed it from its `packages`. A light child loads it unless the list
 * names `-cc-safety-net`, so `--extensions` cannot drop it by mistake. Not installed: a warning, no guard.
 */
function guardExtension(): string[] {
	let packages: unknown = [];
	try {
		packages = (JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as { packages?: unknown }).packages;
	} catch {
		// No settings: no packages.
	}
	for (const entry of Array.isArray(packages) ? packages : []) {
		const source: unknown = typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
		if (typeof source !== "string") continue;
		const path = packagePath(source);
		if (basename(path) === GUARD && existsSync(path)) return [path];
	}
	process.stderr.write(`Warning: the command guard ${GUARD} is not installed in Pi's packages; the child runs without it\n`);
	return [];
}

/** Pi flags for a light child: this extension, the guard, then the listed ones. A local path is resolved here, not in `--cwd`. */
function lightExtensionArgs(list: string): string[] {
	const names = list.split(",").map((name) => name.trim()).filter(Boolean);
	if (names.length === 0) fail("--extensions requires at least one extension");
	const guard = names.includes(`-${GUARD}`) ? [] : guardExtension();
	const listed = names.filter((name) => name !== `-${GUARD}`).map((name) => (/^[a-z]+:/.test(name) ? name : resolve(name)));
	return ["--no-extensions", ...[extensionPath, ...guard, ...listed].flatMap((path) => ["--extension", path])];
}

function fail(message: string): never {
	throw new Error(message);
}

function usage(): never {
	fail(`Usage:
  subagent spawn [--agent <name>] [--name <name>] [--provider <provider>] [--model <model>] [--thinking <level>]
    [--cwd <dir>] [--worktree <topic> [--base <branch>]] [--tools <names>]
    [--no-extensions | --extensions <list>] [--no-mcp] [--no-skills]
    [--no-prompt-templates] [--no-context-files] [--timeout <duration>]
    (--prompt <text> | --prompt=<text> | --file <path>)...
  subagent status <handle>
  subagent rename <handle> <name>
  subagent send <handle> [--follow-up] [--] <message>
  subagent wait <handle> [--timeout <seconds>]
  subagent last <handle>
  subagent interrupt <handle>
  subagent stop <handle>
  subagent resume <handle>
  subagent list
  subagent agents`);
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
	return value;
}

function normalizeRunName(value: string): string {
	const name = value.trim();
	if (!isValidRunName(name)) fail("Subagent name must be a single line of 1 to 64 characters");
	return name;
}

function runDirForHandle(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) fail(`Invalid subagent handle: ${handle}`);
	return join(getRunsDir(), handle);
}

function getRun(handle: string): RunMetadata {
	const metadata = readMetadata(runDirForHandle(handle));
	if (!metadata) fail(`Unknown subagent: ${handle}`);
	return metadata;
}

function generateHandle(): string {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = randomBytes(3).toString("hex");
		if (!existsSync(runDirForHandle(handle))) return handle;
	}
	fail("Could not allocate a unique subagent handle");
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) fail(`git ${args.join(" ")} failed in ${cwd}: ${(result.stderr || String(result.error)).trim()}`);
	return result.stdout.trim();
}

/**
 * The worktree `<root>/<repo>/<topic>` on branch `<topic>`, made from `base`. The root is
 * `PI_SUBAGENT_WORKTREE_ROOT`, else `~/WORK/dev/.worktrees`, as the spec asks.
 * An existing path is reused only when it is a clean worktree of that branch, so no work is lost.
 * An existing branch `<topic>` (a merger's integration branch, a re-spawn) gets the worktree as it is,
 * unless another worktree has it checked out: Git allows a branch in one worktree only.
 */
function prepareWorktree(repoDir: string, topic: string, base: string | undefined): string {
	// The topic is one path segment; `git worktree add -b` rejects what is not a valid branch name.
	if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(topic)) fail(`Invalid worktree topic: ${topic}`);
	// The common Git directory sits in the main checkout, so every worktree of a repository maps to one <repo>.
	const commonDir = git(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const worktreeRoot = process.env.PI_SUBAGENT_WORKTREE_ROOT || join(homedir(), "WORK", "dev", ".worktrees");
	const path = join(resolve(worktreeRoot), basename(dirname(commonDir)), topic);
	if (existsSync(path)) {
		const check = (args: string[]) => spawnSync("git", args, { cwd: path, encoding: "utf8" }).stdout?.trim();
		const reusable =
			check(["rev-parse", "--show-toplevel"]) === realpathSync(path) &&
			check(["rev-parse", "--path-format=absolute", "--git-common-dir"]) === commonDir &&
			check(["branch", "--show-current"]) === topic &&
			check(["status", "--porcelain"]) === "";
		if (!reusable) fail(`${path} exists and has other work; it is not a clean worktree of branch ${topic}`);
		return path;
	}
	mkdirSync(dirname(path), { recursive: true });
	if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${topic}`], { cwd: repoDir }).status === 0) {
		const entries = git(repoDir, ["worktree", "list", "--porcelain"]).split("\n\n");
		const holder = entries.find((entry) => entry.split("\n").includes(`branch refs/heads/${topic}`));
		if (holder) fail(`branch ${topic} is checked out in ${holder.split("\n")[0].replace(/^worktree /, "")}; use --cwd there, or free the branch`);
		if (base !== undefined) process.stderr.write(`Note: branch ${topic} exists; --base ${base} is ignored\n`);
		git(repoDir, ["worktree", "add", path, topic]);
		return path;
	}
	git(repoDir, ["worktree", "add", "--no-track", "-b", topic, path, base ?? "HEAD"]);
	return path;
}

/**
 * The role's flags go first, so a flag the caller gives wins. The caller's `--no-extensions` or
 * `--extensions` replaces the role's extensions instead of clashing with them.
 */
function applyAgent(args: string[]): { args: string[]; instructions?: string } {
	const index = args.indexOf("--agent");
	if (index === -1) return { args };
	const name = valueAfter(args, index, "--agent");
	const agent = findAgent(process.cwd(), name);
	if (!agent) {
		const known = listAgents(process.cwd()).map((each) => each.name);
		fail(`Unknown agent: ${name} (known: ${known.length ? known.join(", ") : "none"}; see \`subagent agents\`)`);
	}
	if (agent.ignoredExtensions) {
		process.stderr.write(
			`Warning: ignored the extensions of the project agent file ${agent.file}; only a global agent file or --extensions on spawn can load extensions\n`,
		);
	}
	const rest = args.filter((_arg, i) => i !== index && i !== index + 1);
	const ownExtensions = rest.includes("--no-extensions") || rest.includes("--extensions");
	const roleArgs = agent.spawnArgs.filter((arg, i, all) => !ownExtensions || (arg !== "--extensions" && all[i - 1] !== "--extensions"));
	return { args: [...roleArgs, ...rest], instructions: agent.body || undefined };
}

function spawnSubagent(callerArgs: string[]): void {
	if (process.env.PI_SUBAGENT_RUN_DIR || process.env.PI_SUBAGENT_NESTED) fail("Nested subagents are disabled");
	const { args, instructions } = applyAgent(callerArgs);
	let name: string | undefined;
	let provider = process.env.PI_PROVIDER;
	let model = process.env.PI_MODEL;
	let thinking = process.env.PI_REASONING_LEVEL || "medium";
	let cwd = process.cwd();
	let worktree: string | undefined;
	let base: string | undefined;
	let tools: string | undefined;
	let noExtensions = false;
	let extensions: string | undefined;
	let noMcp = false;
	let noSkills = false;
	let noPromptTemplates = false;
	let noContextFiles = false;
	let timeout: string | undefined;
	const prompts: string[] = [];
	const files: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--name":
				name = normalizeRunName(valueAfter(args, i, arg));
				i++;
				break;
			case "--provider":
				provider = valueAfter(args, i, arg);
				i++;
				break;
			case "--model":
				model = valueAfter(args, i, arg);
				i++;
				break;
			case "--thinking":
				thinking = valueAfter(args, i, arg);
				i++;
				break;
			case "--cwd":
				cwd = resolve(valueAfter(args, i, arg));
				i++;
				break;
			case "--worktree":
				worktree = valueAfter(args, i, arg);
				i++;
				break;
			case "--base":
				base = valueAfter(args, i, arg);
				i++;
				break;
			case "--tools":
				tools = valueAfter(args, i, arg);
				i++;
				break;
			case "--no-extensions":
				noExtensions = true;
				break;
			case "--extensions":
				extensions = valueAfter(args, i, arg);
				i++;
				break;
			case "--no-mcp":
				noMcp = true;
				break;
			case "--no-skills":
				noSkills = true;
				break;
			case "--no-prompt-templates":
				noPromptTemplates = true;
				break;
			case "--no-context-files":
				noContextFiles = true;
				break;
			case "--timeout":
				timeout = valueAfter(args, i, arg);
				if (parseDuration(timeout) === undefined) fail("--timeout must be a duration such as 90s, 10m, or 1h");
				i++;
				break;
			case "--prompt":
				prompts.push(valueAfter(args, i, arg));
				i++;
				break;
			case "--file": {
				const file = resolve(valueAfter(args, i, arg));
				if (!existsSync(file)) fail(`File not found: ${file}`);
				files.push(file);
				i++;
				break;
			}
			default:
				// `--prompt=<text>` takes text that starts with `--`, which `--prompt <text>` refuses as a missing value.
				if (arg.startsWith("--prompt=")) prompts.push(arg.slice("--prompt=".length));
				else fail(`Unknown spawn argument: ${arg}`);
		}
	}

	if (!provider) fail("No provider specified and PI_PROVIDER is not set");
	if (!model) fail("No model specified and PI_MODEL is not set");
	if (!VALID_THINKING_LEVELS.has(thinking)) fail(`Invalid thinking level: ${thinking}`);
	if (tools !== undefined && !tools.split(",").some((name) => name.trim()))
		fail("--tools requires at least one tool name");
	if (noExtensions && extensions !== undefined) fail("Use --no-extensions or --extensions, not both");
	const lightArgs = extensions === undefined ? [] : lightExtensionArgs(extensions);
	if (prompts.length === 0 && files.length === 0) fail("spawn requires at least one --prompt or --file");
	if (!existsSync(cwd)) fail(`Working directory not found: ${cwd}`);
	if (base !== undefined && worktree === undefined) fail("--base requires --worktree");
	if (worktree !== undefined) cwd = prepareWorktree(cwd, worktree, base);

	const handle = generateHandle();
	const runDir = runDirForHandle(handle);
	const sessionFile = join(runDir, "session.jsonl");
	const tmuxSession = `pi-subagent-${handle}`;
	mkdirSync(inboxDir(runDir), { recursive: true, mode: 0o700 });
	writeFileSync(sessionFile, "", { mode: 0o600 });

	const launchArgs: string[] = [];
	if (tools) launchArgs.push("--tools", tools);
	if (noExtensions) launchArgs.push("--no-extensions", "--extension", extensionPath);
	launchArgs.push(...lightArgs);
	if (noMcp) launchArgs.push("--no-mcp");
	if (noSkills) launchArgs.push("--no-skills");
	if (noPromptTemplates) launchArgs.push("--no-prompt-templates");
	if (noContextFiles) launchArgs.push("--no-context-files");

	const parentSessionId = process.env.PI_SESSION_ID || undefined;
	const now = new Date().toISOString();
	const metadata: RunMetadata = {
		version: 1,
		handle,
		name,
		parentSessionId,
		parentSessionFile: process.env.PI_SESSION_FILE || undefined,
		parentPid: Number(process.env.PI_SUBAGENT_PARENT_PID) || undefined,
		parentStarted: process.env.PI_SUBAGENT_PARENT_STARTED || undefined,
		childPid: null,
		tmuxSession,
		runDir,
		sessionFile,
		cwd,
		provider,
		model,
		thinking,
		launchArgs,
		timeout,
		state: "starting",
		hasStarted: false,
		createdAt: now,
		updatedAt: now,
	};
	const initialArgs = files.map((file) => `@${file}`);
	const task = prompts.length > 0 ? `Task:\n${prompts.join("\n\n")}` : undefined;
	const firstPrompt = [instructions, task].filter(Boolean).join("\n\n");
	if (firstPrompt) initialArgs.push(firstPrompt);
	let queued = false;
	try {
		// The launch first: from the metadata write on, a parent tick can start a queued run.
		prepareLaunch(metadata, initialArgs);
		queued = writeNewRun(metadata);
		metadata.state = queued ? "queued" : "starting";
		if (!queued) startRun(metadata);
	} catch (error) {
		removeRunDir(runDir);
		throw error;
	}

	// The parent Pi sets PI_SUBAGENT_NOTIFY when it delivers results; without a parent session nobody gets them.
	const result =
		process.env.PI_SUBAGENT_NOTIFY === "1" && metadata.parentSessionId
			? "Result: arrives as a message when the turn ends. Do not run `subagent wait`.\n"
			: "";
	const worktreeLine = worktree ? `Worktree: ${cwd} (branch ${worktree})\n` : "";
	process.stdout.write(
		`Spawned ${runDisplayName(metadata)}\n${stateLine(queued, metadata.parentSessionId)}\nAttach: tmux attach -t ${tmuxSession}\n${worktreeLine}${result}`,
	);
}

/** The state `list` and `status` print: a suspended child is not dead, it waits for its session or `resume`. */
function shownState(metadata: RunMetadata): string {
	const state = effectiveRunState(metadata);
	return metadata.suspended && state === "exited" ? "suspended" : state;
}

function statusSubagent(args: string[]): void {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	process.stdout.write(
		`${runDisplayName(metadata)}: ${shownState(metadata)} (${metadata.provider}/${metadata.model}, ${metadata.thinking})\nAttach: tmux attach -t ${metadata.tmuxSession}\n`,
	);
}

function renameSubagent(args: string[]): void {
	if (args.length !== 2) usage();
	const metadata = getRun(args[0]);
	const name = normalizeRunName(args[1]);
	const updated = updateMetadata(metadata.runDir, { name });
	if (!updated) fail(`Could not rename subagent: ${metadata.handle}`);
	process.stdout.write(`Renamed ${runDisplayName(updated)}\n`);
}

/** Put a message in the child's inbox; the child takes it within 250 ms. */
function queueMessage(metadata: RunMetadata, payload: InboxMessage): void {
	const queueDir = inboxDir(metadata.runDir);
	mkdirSync(queueDir, { recursive: true, mode: 0o700 });
	const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
	const target = join(queueDir, `${id}.json`);
	const temporary = `${target}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

function sendSubagent(args: string[]): void {
	const handle = args.shift();
	if (!handle) usage();
	let followUp = false;
	const messageParts: string[] = [];
	for (const [i, arg] of args.entries()) {
		// After `--` all is message, so a message can start with `--`.
		if (arg === "--") {
			messageParts.push(...args.slice(i + 1));
			break;
		}
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`Unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}
	const message = messageParts.join(" ").trim();
	if (!message) fail("send requires a message");
	const metadata = getRun(handle);
	if (!tmuxSessionExists(metadata.tmuxSession)) fail(`${handle} is not running`);

	queueMessage(metadata, { message, delivery: followUp ? "followUp" : "auto" });

	const state = effectiveRunState(metadata);
	const verb = followUp && state === "busy" ? "Queued follow-up for" : state === "idle" ? "Prompted" : "Steered";
	process.stdout.write(`${verb} ${runDisplayName(metadata)}\n`);
}

function parseTimeout(args: string[]): number {
	if (args.length === 0) return 1800;
	if (args.length !== 2 || args[0] !== "--timeout") usage();
	const timeout = Number(args[1]);
	if (!Number.isInteger(timeout) || timeout <= 0) fail("--timeout must be a positive integer");
	return timeout;
}

async function waitSubagent(args: string[]): Promise<void> {
	const handle = args.shift();
	if (!handle) usage();
	const timeoutSeconds = parseTimeout(args);
	const deadline = Date.now() + timeoutSeconds * 1000;

	while (Date.now() < deadline) {
		let metadata = getRun(handle);
		markWaiting(metadata.runDir);
		// Outside a Pi parent no tick enforces the limit, so `wait` does.
		stopTimedOutRuns([metadata]);
		metadata = getRun(handle);
		if (metadata.timedOut) {
			process.stdout.write(`${handle} timed out\n\n${timedOutText(metadata)}\n`);
			process.exitCode = 1;
			clearResults(metadata.runDir);
			return;
		}
		const pending = inboxHasMessages(metadata.runDir);
		const state = effectiveRunState(metadata);
		// A queued launch that failed: the tick sent it as a result, which this prints instead.
		if (state === "error" && isExitKnown(metadata.runDir)) {
			process.stdout.write(`${handle} failed to start\n\n${metadata.error ?? ""}\n`);
			process.exitCode = 1;
			clearResults(metadata.runDir);
			return;
		}
		if (state === "error") fail(metadata.error || `${handle} failed`);
		if (state === "exited") fail(`${handle} exited before finishing`);
		if (metadata.hasStarted && state === "idle" && !pending) {
			const message = readLatestAssistant(metadata.sessionFile);
			if (!message) fail(`${handle} finished without an assistant response`);
			const outcome = turnOutcome(message);
			process.stdout.write(`${handle} ${outcome}\n\n${assistantText(message)}\n`);
			if (outcome !== "finished") process.exitCode = 1;
			clearResults(metadata.runDir);
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}

async function stopSubagent(args: string[]): Promise<void> {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	const wasRunning = tmuxSessionExists(metadata.tmuxSession);
	markExitKnown(metadata.runDir);
	spawnSync("tmux", ["kill-session", "-t", metadata.tmuxSession], { stdio: "ignore" });
	if (wasRunning) await waitForRunShutdown(metadata.runDir);
	// A result the parent has not got yet goes with the run: print it, as `wait` does, so the parent gets it once.
	const results = takeResults([metadata], { waited: true });
	const kept = removeRunDir(metadata.runDir);
	const transcript = kept ? `Transcript: ${kept} (\`pi --resume\` in ${metadata.cwd})\n` : "";
	process.stdout.write(`Stopped ${runDisplayName(metadata)}\n${transcript}${results ? `\n${results.text}\n` : ""}`);
}

/**
 * Start a suspended child by hand, such as one that resume left suspended because it is older than a day.
 * It queues as `spawn` does, behind the limit of the parent session that runs this command.
 */
function resumeSubagent(args: string[]): void {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	if (!metadata.suspended || metadata.state === "queued" || tmuxSessionExists(metadata.tmuxSession)) fail(`${metadata.handle} is not suspended`);
	// Only the tick of the parent session's own Pi starts its queued runs.
	const mayQueue = metadata.parentSessionId === process.env.PI_SESSION_ID;
	// This caller is the parent now, as for `spawn`, so the orphan sweep follows it.
	const prepared = resumeRun(metadata, mayQueue, {
		parentPid: Number(process.env.PI_SUBAGENT_PARENT_PID) || undefined,
		parentStarted: process.env.PI_SUBAGENT_PARENT_STARTED || undefined,
	});
	if (!prepared) fail(`${metadata.handle} is already resumed`);
	const queued = prepared.state === "queued";
	if (!queued) startRun(prepared);
	process.stdout.write(`Resumed ${runDisplayName(metadata)}\n${stateLine(queued, metadata.parentSessionId)}\nAttach: tmux attach -t ${metadata.tmuxSession}\n`);
}

function lastSubagent(args: string[]): void {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	const message = readLatestAssistant(metadata.sessionFile);
	process.stdout.write(`${metadata.handle} ${effectiveRunState(metadata)}\n\n${message ? assistantText(message) : "(no answer yet)"}\n`);
}

function interruptSubagent(args: string[]): void {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	const state = effectiveRunState(metadata);
	if (state !== "busy" && state !== "starting") {
		process.stdout.write(`${metadata.handle} is ${state}: nothing to interrupt\n`);
		return;
	}
	queueMessage(metadata, { message: "", delivery: "interrupt" });
	process.stdout.write(`Interrupting ${runDisplayName(metadata)}. Its turn ends as failed (aborted).\n`);
}

function listAgentFiles(args: string[]): void {
	if (args.length !== 0) usage();
	const agents = listAgents(process.cwd());
	if (agents.length === 0) {
		process.stdout.write("No agents. Add one in .pi/agents/<name>.md or ~/.pi/agent/agents/<name>.md\n");
		return;
	}
	for (const agent of agents) process.stdout.write(`${agent.name}  ${agent.scope}  ${agent.description ?? ""}`.trimEnd() + "\n");
}

function listSubagents(args: string[]): void {
	if (args.length !== 0) usage();
	const runs = listRuns(process.env.PI_SESSION_ID || undefined);
	if (runs.length === 0) {
		process.stdout.write("No subagents\n");
		return;
	}
	for (const metadata of runs) {
		process.stdout.write(
			`${runDisplayName(metadata)}  ${shownState(metadata).padEnd(8)}  ${metadata.provider}/${metadata.model}  ${metadata.thinking}\n`,
		);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args.shift();
	switch (command) {
		case "spawn":
			spawnSubagent(args);
			break;
		case "status":
			statusSubagent(args);
			break;
		case "rename":
			renameSubagent(args);
			break;
		case "send":
			sendSubagent(args);
			break;
		case "wait":
			await waitSubagent(args);
			break;
		case "last":
			lastSubagent(args);
			break;
		case "interrupt":
			interruptSubagent(args);
			break;
		case "stop":
			await stopSubagent(args);
			break;
		case "resume":
			resumeSubagent(args);
			break;
		case "list":
			listSubagents(args);
			break;
		case "agents":
			listAgentFiles(args);
			break;
		default:
			usage();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
