#!/usr/bin/env node
// Proves the claims of spec #14 on this machine, with no model and no login. Run: npm run verify:spec
// It uses a temporary agent directory and real `sleep` processes as children, so it touches no real run.
// Each line is `ok` or `FAIL`; the exit code is the number of failures.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = import.meta.dirname;
const root = mkdtempSync(join(tmpdir(), "psa-verify-"));
const bin = join(root, "bin");
const calls = join(root, "tmux-calls");
mkdirSync(bin);
// A tmux that records each call, then runs the real one, so the cost of a program start stays real.
const realTmux = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "$*" >> "${calls}"\nexec ${realTmux || "false"} "$@"\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_SUBAGENT_LIMIT = "2";
delete process.env.PI_SUBAGENT_QUEUE;

const shared = await import(join(repo, "shared.ts"));
const { SessionTick } = await import(join(repo, "tick.ts"));

let failures = 0;
const check = (ok: boolean, text: string, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${text}${detail ? `  (${detail})` : ""}`);
};
const tmuxCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);
const resetCalls = () => rmSync(calls, { force: true });
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;

const children: ChildProcess[] = [];
function run(handle: string, patch: Record<string, unknown> = {}) {
	const runDir = join(process.env.PI_CODING_AGENT_DIR as string, "subagents", handle);
	mkdirSync(runDir, { recursive: true });
	// The child holds the run's FIFO, as a child Pi does.
	const fifo = shared.openAliveFifo(runDir);
	const child = spawn("sleep", ["120"], { stdio: ["ignore", "ignore", "ignore", fifo] });
	closeSync(fifo);
	children.push(child);
	const now = new Date().toISOString();
	const metadata = {
		version: 1, handle, tmuxSession: `psa-verify-${handle}`, runDir, sessionFile: join(runDir, "session.jsonl"),
		parentSessionId: "verify", cwd: root, provider: "x", model: "y", thinking: "low", state: "busy", hasStarted: true,
		childPid: child.pid, createdAt: now, updatedAt: now, ...patch,
	};
	shared.writeMetadata(metadata);
	return { metadata, child };
}

try {
	// 0. The machine: the cost the old design paid per child, twice per second.
	const starts: number[] = [];
	for (let i = 0; i < 5; i++) {
		const t = process.hrtime.bigint();
		spawnSync("/usr/bin/true");
		starts.push(ms(t));
	}
	console.log(`info one program start on this machine: ${median(starts).toFixed(0)} ms (median of 5)`);

	// 1. #15 + #19: three live children, ten ticks, no program start, and the cost per tick.
	for (const handle of ["aaa111", "bbb222", "ccc333"]) run(handle);
	resetCalls();
	const shown: number[] = [];
	const tick = new SessionTick({ sessionId: () => "verify", show: (rows: unknown[]) => shown.push(rows.length) });
	const tickTimes: number[] = [];
	for (let i = 0; i < 10; i++) {
		const t = process.hrtime.bigint();
		(tick as unknown as { tick: () => void }).tick();
		tickTimes.push(ms(t));
	}
	tick.stop();
	check(tmuxCalls().length === 0, "#15 10 ticks with 3 live children start no tmux", `${tmuxCalls().length} calls`);
	check(shown.every((n) => n === 3), "#15 each tick still shows the 3 children", `rows ${[...new Set(shown)].join(",")}`);
	const newTick = median(tickTimes);

	// The same three children through the old check: one `tmux has-session` each, as on `main`.
	const oldTimes: number[] = [];
	for (let i = 0; i < 3; i++) {
		const t = process.hrtime.bigint();
		for (const handle of ["aaa111", "bbb222", "ccc333"]) spawnSync("tmux", ["has-session", "-t", `psa-verify-${handle}`], { stdio: "ignore" });
		oldTimes.push(ms(t));
	}
	// `main` ran two timers per second (widget and results), each with this check.
	const oldPerSecond = 2 * median(oldTimes);
	check(newTick < 50, "#15 one tick blocks the UI thread for under 50 ms", `${newTick.toFixed(1)} ms, median of 10`);
	console.log(`info UI thread blocked per second with 3 children: main ≈ ${oldPerSecond.toFixed(0)} ms, now ≈ ${newTick.toFixed(1)} ms`);

	// 2. #15: a dead child, and a child whose process ID now belongs to another process.
	await import("node:events").then(({ once }) => {
		const dead = children[0];
		dead.kill("SIGKILL");
		return once(dead, "exit");
	});
	const deadRun = shared.readMetadata(join(process.env.PI_CODING_AGENT_DIR as string, "subagents", "aaa111"));
	check(shared.effectiveRunState(deadRun) === "exited", "#15 a dead child is exited at the next tick");
	// The ID of a live process that does not hold the run's FIFO: this verifier. The child that held it ended.
	const { metadata: reused, child: ended } = run("ddd444", { childPid: process.pid });
	ended.kill("SIGKILL");
	await import("node:events").then(({ once }) => once(ended, "exit"));
	check(shared.effectiveRunState(reused) === "exited", "#15 a reused process ID counts as exited");

	// 3. #19: a session with no children does no work.
	resetCalls();
	const idle = new SessionTick({ sessionId: () => "nobody", show: () => {} });
	idle.wake();
	const stopped = (idle as unknown as { timer: unknown }).timer === undefined;
	check(stopped && tmuxCalls().length === 0, "#19 a session with no children stops its tick and starts no program");
} finally {
	for (const child of children) child.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
}

// 4. The behaviour tickets: each acceptance criterion has a test in the suite, named here exactly, so a
// renamed or deleted test is a FAIL and not a smaller match.
const suites: [string, string[], string[]][] = [
	["#15", ["liveness.test.ts"], [
		"a parent with 3 live children runs 10 widget and result ticks and starts no tmux and no ps",
		"a dead child, and a child whose process ID now belongs to another process, are reported as exited in one tick",
	]],
	["#16", ["subagent.test.ts"], [
		"spawn --extensions loads only the listed extensions, this extension, and the command guard",
		"spawn --no-mcp starts the child with no MCP servers",
		"a suspended light child relaunches with the same flags",
		"a child with no new flags starts as today: all extensions and MCP servers",
	]],
	["#17", ["subagent.test.ts"], [
		"spawn --worktree creates the worktree on a new branch from --base and starts the child in it",
		"spawn --worktree reuses a clean worktree of the same branch, and refuses one with other work",
		"stop leaves the worktree and its branch",
	]],
	["#18", ["outbox.test.ts", "subagent.test.ts"], [
		"a long answer reaches the parent as a summary with the path of a file that holds it whole",
		"a short answer reaches the parent whole, with the path of a file that holds it",
		"last prints a long answer whole, not the summary the parent got",
		"after stop, the answer file named in the parent's message still exists, beside the kept transcript",
	]],
	["#19", ["tick.test.ts"], [
		"a session with no children runs no tick: a run written later is not seen in 5 s, and no program starts",
		"a child starts the tick: its row shows each second, with no program started",
		"when the last child ends, its exit arrives as a message, the rows clear, and the tick stops",
	]],
	["#20", ["subagent.test.ts", "widget.test.ts", "tick.test.ts"], [
		"with a limit of 2, spawning 3 children starts 2 and queues 1",
		"when a child ends, the next tick starts the queued child with the caller's environment and its prompt",
		"a queued child keeps the tick, and starts when the last live child ends",
		"list and status show a queued child as queued",
		"a queued child gets a row that says it waits for a slot",
		"stop removes a queued child, and it never starts",
		"a spawn with no parent tick starts each child at once, past the limit",
	]],
	["#21", ["subagent.test.ts", "tick.test.ts"], [
		"a child past its time limit is stopped by the parent tick and reported once as timed out",
		"a child past its time limit is stopped by the tick and reported as timed out",
		"wait on a busy child with --timeout 2s reports it timed out after about 2 s, and keeps its transcript",
		"a child that answers and goes idle before its 2 s limit is never stopped: one finished message, no timed out",
		"a child that gets a new message after its deadline is stopped by the limit counted from that turn",
	]],
	["#22", ["subagent.test.ts"], [
		"resuming a session with 6 suspended children and a limit of 2 starts 2 and queues 4",
		"a child suspended 25 hours ago stays suspended after resume, and list shows it as suspended",
		"subagent resume queues a suspended child, and it starts when a slot is free",
	]],
	["#23", ["subagent.test.ts"], [
		"spawn --agent starts the child with the agent file's model, thinking, tools, extensions, and instructions",
		"a flag on spawn overrides the agent file",
		"a project agent file overrides a global one with the same name",
		"agents lists the name, scope, and description of each agent, a project one in place of a global one",
		"a project agent file cannot load extensions or drop the command guard, and spawn warns once naming it",
		"spawn --agent with an unknown name fails and starts nothing",
	]],
	["#24", ["subagent.test.ts"], [
		"the subagent tool spawns a child of the tool's session when the subagent CLI is not on PATH",
		"each subagent tool action prints what the matching CLI command prints",
		"a child spawned with the subagent tool is suspended and resumed like a CLI child",
		"the bundled skill names the subagent tool first and the CLI second",
	]],
];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const [ticket, files, names] of suites) {
	const pattern = `^(${names.map(escape).join("|")})$`;
	const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern", pattern, ...files], {
		cwd: repo,
		encoding: "utf8",
	});
	// TAP: `ok 3 - <name>` or `not ok 3 - <name>` for each test that ran.
	const ran = [...result.stdout.matchAll(/^(not )?ok \d+ - (.*)$/gm)].filter((line) => !/# SKIP/.test(line[2]));
	const passed = new Set(ran.filter((line) => !line[1]).map((line) => line[2]));
	const missing = names.filter((name) => !ran.some((line) => line[2] === name));
	const failed = names.filter((name) => !missing.includes(name) && !passed.has(name));
	const detail = [missing.length ? `missing: ${missing.join("; ")}` : "", failed.length ? `failed: ${failed.join("; ")}` : ""].filter(Boolean).join("  ");
	check(result.status === 0 && missing.length === 0 && failed.length === 0, `${ticket} ${names.length} acceptance tests pass`, detail);
}

console.log(failures === 0 ? "\nspec #14 verified" : `\n${failures} check(s) failed`);
process.exit(failures);
