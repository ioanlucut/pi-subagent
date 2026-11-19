import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { processStartTime, writeMetadata, type RunMetadata, type RunState } from "./shared.ts";
import { SessionTick } from "./tick.ts";

let root: string;
let path: string | undefined;
const children: ChildProcess[] = [];
const ticks: SessionTick[] = [];

// Fake timers: a test moves time on by hand. A fake `tmux` first on PATH records each call.
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psa-tick-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin", "tmux"), `#!/bin/sh\necho "$*" >> "${join(root, "tmux-calls")}"\nexit 1\n`, { mode: 0o755 });
	path = process.env.PATH;
	process.env.PATH = `${join(root, "bin")}:${path}`;
	mock.timers.enable({ apis: ["setInterval"] });
});

afterEach(() => {
	for (const tick of ticks.splice(0)) tick.stop();
	mock.timers.reset();
	process.env.PATH = path;
	for (const child of children.splice(0)) child.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
});

function tmuxCalls(): string[] {
	const file = join(root, "tmux-calls");
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

/** A run of the parent session whose child is a live process. */
function liveRun(handle: string): { run: RunMetadata; child: ChildProcess } {
	const child = spawn("sleep", ["60"], { stdio: "ignore" });
	children.push(child);
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
		childPid: child.pid,
		childStarted: processStartTime(child.pid!),
		createdAt: now,
		updatedAt: now,
	} as RunMetadata;
	writeMetadata(run);
	return { run, child };
}

/** A parent's tick that records what it shows and what it sends. */
function parentTick(ready = () => true) {
	const shown: { handle: string; state: RunState }[][] = [];
	const sent: string[] = [];
	const tick = new SessionTick({
		sessionId: () => "parent",
		show: (rows) => shown.push(rows.map(({ run, state }) => ({ handle: run.handle, state }))),
		deliver: { ready, send: (text) => sent.push(text) },
	});
	ticks.push(tick);
	return { tick, shown, sent };
}

async function kill(child: ChildProcess): Promise<void> {
	child.kill("SIGKILL");
	await once(child, "exit");
}

test("a session with no children runs no tick: a run written later is not seen in 5 s, and no program starts", () => {
	const { tick, shown, sent } = parentTick();
	tick.wake();
	liveRun("aaa111");

	mock.timers.tick(5000);

	assert.deepEqual(shown, [[]]);
	assert.deepEqual(sent, []);
	assert.deepEqual(tmuxCalls(), []);
});

test("a child starts the tick: its row shows each second, with no program started", () => {
	const { tick, shown } = parentTick();
	tick.wake();
	liveRun("aaa111");
	tick.wake();

	mock.timers.tick(3000);

	assert.deepEqual(shown.slice(1), Array(4).fill([{ handle: "aaa111", state: "busy" }]));
	assert.deepEqual(tmuxCalls(), []);
});

test("when the last child ends, its exit arrives as a message, the rows clear, and the tick stops", async () => {
	const { tick, shown, sent } = parentTick();
	const first = liveRun("aaa111");
	liveRun("bbb222");
	tick.wake();

	await kill(first.child);
	mock.timers.tick(1000);
	assert.deepEqual(shown.at(-1), [{ handle: "bbb222", state: "busy" }]);
	assert.match(sent.join(), /^Subagent aaa111 exited\n/);

	await kill(children[1]);
	mock.timers.tick(1000);
	assert.deepEqual(shown.at(-1), []);
	assert.equal(sent.length, 2);
	assert.match(sent[1], /^Subagent bbb222 exited\n/);

	const count = shown.length;
	liveRun("ccc333");
	mock.timers.tick(5000);
	assert.equal(shown.length, count);
});

test("a result that cannot be sent yet keeps the tick until it is sent", async () => {
	let ready = false;
	const { tick, shown, sent } = parentTick(() => ready);
	const { child, run } = liveRun("aaa111");
	tick.wake();

	await kill(child);
	mock.timers.tick(3000);
	assert.deepEqual(sent, []);

	ready = true;
	mock.timers.tick(1000);
	assert.match(sent.join(), /^Subagent aaa111 exited\n/);
	assert.deepEqual(readdirSync(join(run.runDir, "outbox")), []);
	const count = shown.length;
	mock.timers.tick(5000);
	assert.equal(shown.length, count);
});

test("wake while the tick runs starts no second timer", () => {
	const { tick, shown } = parentTick();
	liveRun("aaa111");
	tick.wake();
	tick.wake();
	tick.wake();

	mock.timers.tick(1000);

	assert.equal(shown.length, 2);
});
