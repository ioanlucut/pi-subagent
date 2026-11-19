import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pendingResults, reportExitedRuns } from "./outbox.ts";
import { effectiveRunState, listRuns, processStartTime, writeMetadata, type RunMetadata } from "./shared.ts";

let root: string;
let path: string | undefined;
const children: ChildProcess[] = [];

// A fake `tmux` first on PATH records each call, so a test sees whether the liveness check started it.
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psa-live-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "bin"));
	path = process.env.PATH;
	process.env.PATH = `${join(root, "bin")}:${path}`;
	fakeTmux(1);
});

afterEach(() => {
	process.env.PATH = path;
	for (const child of children.splice(0)) child.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
});

/** A `tmux` that appends its arguments to `tmux-calls` and exits with `status`. */
function fakeTmux(status: number): void {
	writeFileSync(join(root, "bin", "tmux"), `#!/bin/sh\necho "$*" >> "${join(root, "tmux-calls")}"\nexit ${status}\n`, { mode: 0o755 });
}

function tmuxCalls(): string[] {
	const file = join(root, "tmux-calls");
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

/** A busy run of the parent session, with `patch` for its child process. */
function storedRun(handle: string, patch: Partial<RunMetadata> = {}): RunMetadata {
	const runDir = join(process.env.PI_CODING_AGENT_DIR as string, "subagents", handle);
	const now = new Date().toISOString();
	const run = {
		version: 1,
		handle,
		tmuxSession: `pi-subagent-${handle}`,
		runDir,
		sessionFile: join(runDir, "session.jsonl"),
		parentSessionId: "parent",
		state: "busy",
		hasStarted: true,
		createdAt: now,
		updatedAt: now,
		...patch,
	} as RunMetadata;
	writeMetadata(run);
	return run;
}

/** A run whose child is a live process, with the process ID and start time a child records. */
function liveRun(handle: string): RunMetadata {
	const child = spawn("sleep", ["60"], { stdio: "ignore" });
	children.push(child);
	return storedRun(handle, { childPid: child.pid, childStarted: processStartTime(child.pid!) });
}

/** A process ID that no process uses: a child that has already exited. */
function deadPid(): number {
	return Number(spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim());
}

/** What the widget tick and the result tick do with the session's runs. */
function tick(): { states: string[]; results?: string } {
	const runs = listRuns("parent");
	const states = runs.map((run) => effectiveRunState(run));
	reportExitedRuns(runs);
	return { states, results: pendingResults(runs)?.text };
}

test("a parent with 3 live children runs 10 widget and result ticks and starts no tmux", () => {
	liveRun("aaa111");
	liveRun("bbb222");
	liveRun("ccc333");

	for (let i = 0; i < 10; i++) assert.deepEqual(tick(), { states: ["busy", "busy", "busy"], results: undefined });

	assert.deepEqual(tmuxCalls(), []);
});

test("a dead child, and a child whose process ID now belongs to another process, are reported as exited in one tick", () => {
	storedRun("ddd444", { childPid: deadPid(), childStarted: "Thu Jan  1 00:00:00 1970" });
	// This test process is alive, but it started at another time than the child that recorded the ID.
	storedRun("eee555", { childPid: process.pid, childStarted: "Thu Jan  1 00:00:00 1970" });

	const { states, results } = tick();

	assert.deepEqual(states, ["exited", "exited"]);
	assert.match(results ?? "", /^Subagent ddd444 exited\n(.|\n)*Subagent eee555 exited\n/);
	assert.deepEqual(tmuxCalls(), []);
});

test("a parent with 2 starting children runs 10 widget and result ticks and starts no tmux", () => {
	// `spawn` and resume write `childPid: null` until the new child records its ID.
	storedRun("ggg777", { state: "starting", childPid: null });
	storedRun("hhh888", { state: "starting", childPid: null });

	for (let i = 0; i < 10; i++) assert.deepEqual(tick(), { states: ["starting", "starting"], results: undefined });

	assert.deepEqual(tmuxCalls(), []);
});

test("a starting child that records no process ID within its grace time is reported as exited, with no tmux", () => {
	const longAgo = new Date(Date.now() - 31_000).toISOString();
	storedRun("iii999", { state: "starting", childPid: null, updatedAt: longAgo });

	const { states, results } = tick();

	assert.deepEqual(states, ["exited"]);
	assert.match(results ?? "", /^Subagent iii999 exited\n/);
	assert.deepEqual(tmuxCalls(), []);
});

test("a run from before the child recorded its process ID still asks tmux", () => {
	const old = storedRun("fff666");

	fakeTmux(0);
	assert.equal(effectiveRunState(old), "busy");
	fakeTmux(1);
	assert.equal(effectiveRunState(old), "exited");
	assert.deepEqual(tmuxCalls(), ["has-session -t pi-subagent-fff666", "has-session -t pi-subagent-fff666"]);
});
