#!/usr/bin/env node
// End-to-end check of spec #14: real parent and child Pi processes in real tmux sessions, driven by a
// local fake model, so it needs no login and costs nothing. Run: npm run verify:e2e
// Each step prints `ok` or `FAIL`; the exit code is the number of failures.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = import.meta.dirname;
const started = Date.now();
const root = realpathSync(mkdtempSync(join(tmpdir(), "psa-e2e-")));
const [agentDir, bin, project, worktrees, sessions] = ["agent", "bin", "project", "worktrees", "sessions"].map((name) => join(root, name));
for (const dir of [agentDir, bin, project, worktrees, sessions]) mkdirSync(dir);
const runsDir = join(agentDir, "subagents");

// The fake model. From the last message: a tool result → `ACK <output>`; a message with
// `CALL {"name", "arguments"}` → that tool call; anything else → `DONE <its start>`.
const requestedModels: string[] = [];
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		if (!req.url?.endsWith("/chat/completions")) return void res.writeHead(404).end();
		const request = JSON.parse(body);
		requestedModels.push(request.model);
		const last = request.messages.at(-1);
		const text = typeof last.content === "string" ? last.content : (last.content ?? []).map((part: { text?: string }) => part.text ?? "").join("");
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: object, finish: string | null = null) =>
			res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
		const call = last.role === "tool" ? undefined : /CALL (\{.*\})/s.exec(text);
		if (last.role === "tool") {
			chunk({ role: "assistant", content: `ACK ${text.trim().slice(0, 60)}` });
			chunk({}, "stop");
		} else if (call) {
			const { name, arguments: args } = JSON.parse(call[1]);
			const id = `call_${Math.random().toString(36).slice(2)}`;
			chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
			chunk({}, "tool_calls");
		} else {
			chunk({ role: "assistant", content: `DONE ${text.replace(/\s+/g, " ").slice(0, 40)}` });
			chunk({}, "stop");
		}
		res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: request.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const models = [{ id: "fake", contextWindow: 100_000, maxTokens: 1000 }, { id: "fake-agent", contextWindow: 100_000, maxTokens: 1000 }];
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "x", models } } }));
// Children load this checkout from Pi's packages, as an installed package would. One child at a time.
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [repo], subagentLimit: 1 }));

// A tmux that logs the calling process and its arguments, then runs the real one.
const tmuxLog = join(root, "tmux-calls");
const realTmux = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "$PPID $*" >> "${tmuxLog}"\nexec ${realTmux || "false"} "$@"\n`, { mode: 0o755 });

const env: NodeJS.ProcessEnv = {
	...process.env,
	PATH: `${bin}:${process.env.PATH}`,
	PI_CODING_AGENT_DIR: agentDir,
	// A private tmux server, as `npm test` uses.
	TMUX_TMPDIR: root,
	PI_SUBAGENT_WORKTREE_ROOT: worktrees,
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
};
// Started from a Pi, in tmux, or in Herdr: this check must touch no real session, server, or pane.
for (const name of Object.keys(env)) {
	if (/^(PI_(SUBAGENT_|SESSION_)|HERDR_)/.test(name) || ["TMUX", "TMUX_PANE", "PI_SESSION_ID", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"].includes(name)) delete env[name];
}
env.PI_SUBAGENT_WORKTREE_ROOT = worktrees;

// A Git repository as the parent's project, with one role in its agent files.
const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", ...args], { cwd: project, encoding: "utf8" });
git("init", "-q", "-b", "main");
writeFileSync(join(project, "README.md"), "e2e\n");
git("add", ".");
git("commit", "-q", "-m", "init");
mkdirSync(join(project, ".pi", "agents"), { recursive: true });
writeFileSync(join(project, ".pi", "agents", "role.md"), "---\nname: role\ndescription: e2e role\nmodel: fake/fake-agent\n---\nYou are the e2e role.\n");

let failures = 0;
const check = (ok: boolean, text: string, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${text}${detail && !ok ? `  (${detail})` : ""}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const runs = () => (existsSync(runsDir) ? readdirSync(runsDir) : []).map((handle) => readJson(join(runsDir, handle, "metadata.json"))).filter(Boolean);
const byName = (name: string) => runs().find((run) => run.name === name);
function readJson(file: string) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}
const tmuxCalls = () => (existsSync(tmuxLog) ? readFileSync(tmuxLog, "utf8").trim().split("\n").filter(Boolean) : []);
const alive = (pid: unknown) => typeof pid === "number" && spawnSync("kill", ["-0", String(pid)]).status === 0;
/** The process in the session's tmux pane: the launcher becomes `pi` with the same process ID. */
const panePid = (session: string) => Number(spawnSync(realTmux, ["list-panes", "-t", session, "-F", "#{pane_pid}"], { env, encoding: "utf8" }).stdout.trim());

/** Wait until `test` returns a value, or give up after `ms`. */
async function until<T>(test: () => T | undefined | false, ms = 60_000): Promise<T | undefined> {
	for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(250)) {
		const value = test();
		if (value) return value;
	}
	return undefined;
}

/** A real parent Pi in RPC mode, with this checkout's extension and the fake model. */
class Parent {
	readonly process: ChildProcessWithoutNullStreams;
	/** Records from stdout, in order. */
	readonly records: Record<string, any>[] = [];
	private busy = false;
	private buffer = "";

	constructor(sessionArgs: string[] = []) {
		this.process = spawn(
			"pi",
			["--mode", "rpc", "--no-extensions", "--extension", join(repo, "index.ts"), "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "fake", "--model", "fake", "--session-dir", sessions, ...sessionArgs],
			{ cwd: project, env },
		);
		this.process.stderr.on("data", () => {});
		this.process.stdout.on("data", (chunk) => {
			this.buffer += chunk;
			for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
				const line = this.buffer.slice(0, end);
				this.buffer = this.buffer.slice(end + 1);
				try {
					const record = JSON.parse(line);
					if (record.type === "agent_start") this.busy = true;
					if (record.type === "agent_settled") this.busy = false;
					this.records.push(record);
				} catch {
					// Not a protocol record.
				}
			}
		});
	}

	get pid(): number {
		return this.process.pid as number;
	}

	private request(command: object): Promise<Record<string, any>> {
		const id = Math.random().toString(36).slice(2);
		const from = this.records.length;
		this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return until(() => this.records.slice(from).find((record) => record.type === "response" && record.id === id), 30_000).then((record) => record ?? {});
	}

	async state(): Promise<{ sessionId: string; sessionFile: string }> {
		return (await this.request({ type: "get_state" })).data;
	}

	/** Have the fake model call the `subagent` tool; returns the text the tool printed. */
	async tool(args: object): Promise<string> {
		for (;;) {
			await until(() => !this.busy, 60_000);
			const from = this.records.length;
			const response = await this.request({ type: "prompt", message: `CALL ${JSON.stringify({ name: "subagent", arguments: args })}` });
			// A result message started a turn first: try again when it settles.
			if (!response.success) continue;
			const end = await until(() => this.records.slice(from).find((record) => record.type === "tool_execution_end" && record.toolName === "subagent"));
			return (end?.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("");
		}
	}

	/** The texts of the `subagent-result` messages so far. */
	results(): string[] {
		return this.records
			.filter((record) => record.type === "message_end" && record.message?.customType === "subagent-result")
			.map((record) => {
				const content = record.message.content;
				return typeof content === "string" ? content : content.map((part: { text?: string }) => part.text ?? "").join("");
			});
	}

	/** Each widget update of the subagents widget, as plain rows; an empty list clears it. */
	widgets(): string[][] {
		return this.records
			.filter((record) => record.method === "setWidget" && record.widgetKey === "subagents")
			.map((record) => (record.widgetLines ?? []).map(stripAnsi));
	}

	/** Close stdin, as a user quits, and wait for the exit. */
	async quit(): Promise<void> {
		if (this.process.exitCode !== null) return;
		const exited = new Promise((resolve) => this.process.on("exit", resolve));
		this.process.stdin.end();
		await Promise.race([exited, sleep(20_000)]);
		this.process.kill("SIGKILL");
	}
}

const child = (name: string, prompt: string, extra: object = {}) => ({ action: "spawn", name, prompt, ...extra });
const busyPrompt = (seconds: number, word: string) => `CALL ${JSON.stringify({ name: "bash", arguments: { command: `sleep ${seconds}; echo ${word}` } })}`;
const resultOf = (parent: Parent, name: string, outcome: string) => () => parent.results().find((text) => text.startsWith(`Subagent ${name} (`) && text.includes(`) ${outcome}`));

let parent = new Parent();
try {
	// 1. A session with no children: no widget, and no tick work after its start.
	const { sessionId, sessionFile } = await parent.state();
	const callsAtStart = tmuxCalls().length;
	await sleep(3000);
	const noWidget = parent.widgets().every((rows) => rows.length === 0);
	const idleCalls = tmuxCalls().slice(callsAtStart);
	check(Boolean(sessionId) && noWidget && idleCalls.length === 0, "a session with no children shows no subagent widget and starts no program", `widget ${noWidget ? "none" : "shown"}, ${idleCalls.length} tmux calls`);

	// 2. The tool spawns a real child Pi in tmux, which records its own process ID.
	const spawned = await parent.tool(child("one", busyPrompt(8, "one-done")));
	const markCalls = tmuxCalls().length;
	const one = await until(() => (alive(byName("one")?.childPid) ? byName("one") : undefined), 30_000);
	const pane = one ? panePid(one.tmuxSession) : undefined;
	check(
		/^Spawned one \(\w+\)\nState: busy/.test(spawned) && Boolean(one) && pane === one?.childPid,
		"the subagent tool spawns a real child Pi in tmux, and its metadata gets its real childPid",
		`tool: ${spawned.slice(0, 80)}; childPid ${one?.childPid}; pane pid ${pane}`,
	);

	// 3. While it works: a widget row, and no `tmux has-session` from the parent's ticks.
	const row = await until(() => parent.widgets().flat().find((line) => /⟳ one\b.*bash sleep 8/.test(line)), 20_000);
	// 4 (queue): a second child past the limit of 1 waits.
	const second = await parent.tool(child("two", "Say hi."));
	const queuedRow = await until(() => parent.widgets().flat().find((line) => /\btwo\b.*queued/.test(line)), 10_000);
	check(/\nState: queued, starts when fewer than 1 children run\n/.test(second) && byName("two")?.state === "queued" && Boolean(queuedRow), "with subagentLimit 1, a second spawn shows queued", `tool: ${second.slice(0, 80)}; row ${queuedRow}`);

	// 5. The answer reaches the parent as a message, with the path of a file that holds it whole.
	const oneResult = await until(resultOf(parent, "one", "finished"), 60_000);
	const hasSession = tmuxCalls()
		.slice(markCalls)
		.filter((call) => call.startsWith(`${parent.pid} has-session`));
	check(Boolean(row) && hasSession.length === 0, "while the child works, the widget shows its row and the parent's ticks run no tmux has-session", `row ${row ?? "none"}; ${hasSession.length} has-session calls`);
	const answerFile = /\[The whole answer: (\S+)\]/.exec(oneResult ?? "")?.[1];
	const answer = answerFile && existsSync(answerFile) ? readFileSync(answerFile, "utf8") : "";
	check(Boolean(oneResult) && answer.startsWith("ACK one-done") && (oneResult ?? "").includes(answer), "the child's answer reaches the parent as a subagent-result message, with the path of a file that holds it whole", `result ${oneResult?.slice(0, 100)}; file ${answerFile}`);

	// The first child ends: the queued one starts by itself and answers.
	await parent.tool({ action: "stop", handle: one?.handle });
	const twoResult = await until(resultOf(parent, "two", "finished"), 60_000);
	check(Boolean(twoResult) && alive(byName("two")?.childPid), "the queued child starts by itself when the first child ends", `result ${twoResult?.slice(0, 80)}; state ${byName("two")?.state}`);
	await parent.tool({ action: "stop", handle: byName("two")?.handle });

	// 6. A busy child past its time limit.
	await parent.tool(child("slow", busyPrompt(60, "late"), { timeout: "3s" }));
	const slowResult = await until(resultOf(parent, "slow", "timed out"), 45_000);
	const slow = byName("slow");
	check(Boolean(slowResult) && slow?.timedOut === true && !alive(slow?.childPid), "a child with a 3s time limit that stays busy is stopped by the parent and reported timed out", `result ${slowResult?.slice(0, 80)}; timedOut ${slow?.timedOut}`);
	await parent.tool({ action: "stop", handle: slow?.handle });

	// 7. A role from an agent file, in a new worktree.
	const roleOut = await parent.tool(child("roled", "Say hi.", { agent: "role", worktree: "e2e-topic", base: "main" }));
	const roleResult = await until(resultOf(parent, "roled", "finished"), 60_000);
	const roled = byName("roled");
	const worktree = join(worktrees, "project", "e2e-topic");
	// The child's session header names the directory it runs in.
	const childCwd = roled ? JSON.parse(readFileSync(roled.sessionFile, "utf8").split("\n", 1)[0] || "{}").cwd : undefined;
	const branch = spawnSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8" }).stdout.trim();
	check(
		Boolean(roleResult) && roled?.model === "fake-agent" && requestedModels.includes("fake-agent") && childCwd === worktree && branch === "e2e-topic",
		"spawn --agent and --worktree start a real child with the agent file's model, in the new worktree",
		`tool: ${roleOut.slice(0, 80)}; model ${roled?.model}; cwd ${childCwd}; branch ${branch}`,
	);
	await parent.tool({ action: "stop", handle: roled?.handle });

	// 8. Quit suspends a running child and keeps a queued one; a new parent on the session resumes them through the queue.
	await parent.tool(child("sleeper", busyPrompt(60, "never")));
	await parent.tool(child("waiter", "Say hi."));
	const sleeperPid = (await until(() => (alive(byName("sleeper")?.childPid) ? byName("sleeper") : undefined), 30_000))?.childPid;
	await parent.quit();
	const suspended = byName("sleeper");
	const waiter = byName("waiter");
	const suspendedOk = suspended?.suspended === true && !alive(sleeperPid) && waiter?.suspended === true;
	parent = new Parent(["--session", sessionFile]);
	const resumed = await until(() => {
		const run = byName("sleeper");
		return alive(run?.childPid) && run.childPid !== sleeperPid ? run : undefined;
	}, 45_000);
	const waiterAfter = byName("waiter");
	const waiterQueued = waiterAfter?.state === "queued";
	if (resumed) await parent.tool({ action: "stop", handle: resumed.handle });
	const waiterResult = await until(resultOf(parent, "waiter", "finished"), 60_000);
	check(
		suspendedOk && Boolean(resumed) && waiterQueued && Boolean(waiterResult),
		"parent quit suspends a running child; a new parent on the session resumes it, and the queued one after it",
		`suspended ${suspendedOk}; resumed pid ${resumed?.childPid}; waiter ${waiterAfter ? waiterAfter.state : "gone"}; waiter result ${Boolean(waiterResult)}`,
	);
} catch (error) {
	check(false, "the check ran to the end", error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
	for (const run of runs()) spawnSync(process.execPath, [join(repo, "subagent.ts"), "stop", run.handle], { env, stdio: "ignore" });
	await parent.quit();
	spawnSync(realTmux, ["kill-server"], { env, stdio: "ignore" });
	server.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

console.log(failures === 0 ? `\nspec #14 verified end to end in ${Math.round((Date.now() - started) / 1000)} s` : `\n${failures} step(s) failed`);
process.exit(failures);
