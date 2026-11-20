import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pendingResults, reportExitedRuns } from "./outbox.ts";
import { effectiveRunState, listRuns, openAliveFifo, writeMetadata, type RunMetadata } from "./shared.ts";

let root: string;
let path: string | undefined;
const children: ChildProcess[] = [];

// A fake `tmux` and a fake `ps` first on PATH record each call, so a test sees whether the liveness check started them.
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psa-live-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "bin"));
	path = process.env.PATH;
	process.env.PATH = `${join(root, "bin")}:${path}`;
	fakeTmux(1);
	writeFileSync(join(root, "bin", "ps"), `#!/bin/sh\necho "$*" >> "${join(root, "ps-calls")}"\nexec /bin/ps "$@"\n`, { mode: 0o755 });
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

function calls(program: "tmux" | "ps"): string[] {
	const file = join(root, `${program}-calls`);
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

const tmuxCalls = () => calls("tmux");

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

/** A run whose child is a live process that holds the run's FIFO open, as a child Pi does, and its process ID. */
function liveRun(handle: string, command = ["sleep", "60"]): { run: RunMetadata; child: ChildProcess } {
	const run = storedRun(handle);
	const fifo = openAliveFifo(run.runDir);
	const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "ignore", "ignore", fifo] });
	closeSync(fifo);
	children.push(child);
	return { run: storedRun(handle, { childPid: child.pid }), child };
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

test("a parent with 3 live children runs 10 widget and result ticks and starts no tmux and no ps", () => {
	liveRun("aaa111");
	liveRun("bbb222");
	liveRun("ccc333");

	for (let i = 0; i < 10; i++) assert.deepEqual(tick(), { states: ["busy", "busy", "busy"], results: undefined });

	assert.deepEqual(tmuxCalls(), []);
	assert.deepEqual(calls("ps"), []);
});

test("a dead child, and a child whose process ID now belongs to another process, are reported as exited in one tick", () => {
	const dead = storedRun("ddd444");
	closeSync(openAliveFifo(dead.runDir));
	storedRun("ddd444", { childPid: deadPid() });
	// This test process is alive, but it is not the child: it does not hold the child's FIFO.
	const reused = storedRun("eee555");
	closeSync(openAliveFifo(reused.runDir));
	storedRun("eee555", { childPid: process.pid });

	const { states, results } = tick();

	assert.deepEqual(states, ["exited", "exited"]);
	assert.match(results ?? "", /^Subagent ddd444 exited\n(.|\n)*Subagent eee555 exited\n/);
	assert.deepEqual(tmuxCalls(), []);
});

test("a child whose process ID passes to another process after good ticks is exited at the next tick", async () => {
	// The shell holds the FIFO, then on a line from the test closes it and stays: the same process ID, no longer the child.
	const marker = join(root, "closed");
	const { run, child } = liveRun("jjj000", ["/bin/sh", "-c", 'read line; exec 3<&-; : > "$0"; exec sleep 60', marker]);
	assert.deepEqual(tick().states, ["busy"]);
	assert.deepEqual(tick().states, ["busy"]);

	child.stdin!.write("\n");
	while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 20));

	assert.equal(process.kill(run.childPid!, 0), true);
	assert.deepEqual(tick().states, ["exited"]);
	assert.deepEqual(calls("ps"), []);
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

test("a child from before the FIFO, with a process ID and a start time but no FIFO, still asks tmux", () => {
	const old = storedRun("kkk111", { childPid: process.pid, childStarted: "Thu Jan  1 00:00:00 1970" } as Partial<RunMetadata>);

	fakeTmux(0);
	assert.equal(effectiveRunState(old), "busy");
	assert.deepEqual(tmuxCalls(), ["has-session -t pi-subagent-kkk111"]);
});
