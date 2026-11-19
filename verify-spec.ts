#!/usr/bin/env node
// Proves the claims of spec #14 on this machine, with no model and no login. Run: npm run verify:spec
// It uses a temporary agent directory and real `sleep` processes as children, so it touches no real run.
// Each line is `ok` or `FAIL`; the exit code is the number of failures.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	const child = spawn("sleep", ["120"], { stdio: "ignore" });
	children.push(child);
	const runDir = join(process.env.PI_CODING_AGENT_DIR as string, "subagents", handle);
	const now = new Date().toISOString();
	const metadata = {
		version: 1, handle, tmuxSession: `psa-verify-${handle}`, runDir, sessionFile: join(runDir, "session.jsonl"),
		parentSessionId: "verify", cwd: root, provider: "x", model: "y", thinking: "low", state: "busy", hasStarted: true,
		childPid: child.pid, childStarted: shared.processStartTime(child.pid), createdAt: now, updatedAt: now, ...patch,
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
	const reused = run("ddd444", { childStarted: "Thu Jan  1 00:00:00 1970" }).metadata;
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

// 4. The behaviour tickets: each has acceptance tests in the suite. Run them by ticket.
const suites: [string, string, string][] = [
	["#16", "subagent.test.ts", "extensions|no-mcp|guard|light child"],
	["#17", "subagent.test.ts", "worktree"],
	["#18", "outbox.test.ts|subagent.test.ts", "answer|summary"],
	["#20", "subagent.test.ts|widget.test.ts|tick.test.ts", "queue|limit"],
	["#21", "subagent.test.ts|tick.test.ts", "time limit|timeout|timed out"],
	["#22", "subagent.test.ts", "resume|suspended"],
	["#23", "subagent.test.ts", "agent"],
	["#24", "subagent.test.ts", "tool"],
];
for (const [ticket, files, pattern] of suites) {
	const result = spawnSync(process.execPath, ["--test", "--test-name-pattern", pattern, ...files.split("|")], {
		cwd: repo,
		encoding: "utf8",
	});
	const count = (name: string) => Number(result.stdout.match(new RegExp(`^ℹ ${name} (\\d+)`, "m"))?.[1] ?? 0);
	const pass = count("pass");
	const fail = count("fail");
	check(result.status === 0 && pass > 0 && fail === 0, `${ticket} acceptance tests pass`, `${pass} pass, ${fail} fail`);
}

console.log(failures === 0 ? "\nspec #14 verified" : `\n${failures} check(s) failed`);
process.exit(failures);
