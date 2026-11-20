import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { InboxDelivery } from "./inbox.ts";
import { markExitKnown, markWaiting, writeResult } from "./outbox.ts";
import { inboxDir, openAliveFifo, updateMetadata, writeMetadata, type RunMetadata, type RunState } from "./shared.ts";
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
	// `new-session` succeeds, so a queued run starts; `has-session` fails, as for a child that has not run yet.
	writeFileSync(join(root, "bin", "tmux"), `#!/bin/sh\necho "$*" >> "${join(root, "tmux-calls")}"\n[ "$1" = new-session ]\n`, { mode: 0o755 });
	path = process.env.PATH;
	process.env.PATH = `${join(root, "bin")}:${path}`;
	process.env.PI_SUBAGENT_LIMIT = "1";
	mock.timers.enable({ apis: ["setInterval"] });
});

afterEach(() => {
	for (const tick of ticks.splice(0)) tick.stop();
	mock.timers.reset();
	process.env.PATH = path;
	delete process.env.PI_SUBAGENT_LIMIT;
	for (const child of children.splice(0)) child.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
});

function tmuxCalls(): string[] {
	const file = join(root, "tmux-calls");
	return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

/** A run of the parent session whose child is a live process that holds the run's FIFO, as a child Pi does. */
function liveRun(handle: string, patch: Partial<RunMetadata> = {}): { run: RunMetadata; child: ChildProcess } {
	const runDir = join(process.env.PI_CODING_AGENT_DIR as string, "subagents", handle);
	mkdirSync(runDir, { recursive: true });
	const fifo = openAliveFifo(runDir);
	const child = spawn("sleep", ["60"], { stdio: ["ignore", "ignore", "ignore", fifo] });
	closeSync(fifo);
	children.push(child);
	const now = new Date().toISOString();
	const run = {
		version: 1,
		handle,
		tmuxSession: `pi-subagent-${handle}`,
		runDir,
		sessionFile: join(runDir, "session.jsonl"),
		parentSessionId: "parent",
		cwd: root,
		state: "busy",
		hasStarted: true,
		childPid: child.pid,
		createdAt: now,
		updatedAt: now,
		...patch,
	} as RunMetadata;
	writeMetadata(run);
	return { run, child };
}

/** A run that waits for a free slot; it has no process yet. */
function queuedRun(handle: string): RunMetadata {
	const { run, child } = liveRun(handle, { state: "queued", childPid: undefined });
	child.kill("SIGKILL");
	return run;
}

const started = () => tmuxCalls().filter((call) => call.startsWith("new-session")).map((call) => call.split(" ")[3]);

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

test("ticks while the child changes its metadata under the lock start no program", () => {
	const { tick, shown } = parentTick();
	// No recorded start time: the tick has no reason of its own to run `ps` (#33 removes that one).
	const { run } = liveRun("aaa111", { childStarted: undefined });
	// After `liveRun`, which reads the start time: a `ps` that records each call, then answers as the real one.
	writeFileSync(join(root, "bin", "ps"), `#!/bin/sh\necho "$*" >> "${join(root, "ps-calls")}"\nexec /bin/ps "$@"\n`, { mode: 0o755 });
	tick.wake();

	for (const state of ["idle", "busy", "idle"] as const) {
		updateMetadata(run.runDir, { state });
		mock.timers.tick(1000);
	}

	assert.deepEqual(shown.at(-1), [{ handle: "aaa111", state: "idle" }]);
	assert.deepEqual(tmuxCalls(), []);
	assert.equal(existsSync(join(root, "ps-calls")), false);
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

test("a result held by a cancelled wait keeps the tick, and arrives when the wait's claim expires", async () => {
	const { tick, sent } = parentTick();
	const { run, child } = liveRun("aaa111");
	await kill(child);
	markExitKnown(run.runDir);
	mkdirSync(join(run.runDir, "outbox"));
	writeFileSync(join(run.runDir, "outbox", "1.txt"), "Subagent aaa111 finished\n\nthe answer");
	markWaiting(run.runDir);

	tick.wake();
	assert.deepEqual(sent, [], "a running wait prints it");
	// The wait was cancelled: its claim is no longer renewed and expires.
	const stale = new Date(Date.now() - 5000);
	utimesSync(join(run.runDir, "waiting"), stale, stale);
	mock.timers.tick(1000);

	assert.match(sent.join(), /the answer/);
});

test("a child past its time limit is stopped by the tick and reported as timed out", () => {
	const { tick, sent } = parentTick();
	liveRun("aaa111", { deadline: new Date(Date.now() - 1000).toISOString() });

	tick.wake();

	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
	assert.match(sent.join(), /^Subagent aaa111 timed out\n/);
});

test("with results off, a child past its time limit is still stopped by the tick", () => {
	const tick = new SessionTick({ sessionId: () => "parent", show: () => {} });
	ticks.push(tick);
	liveRun("aaa111", { deadline: new Date(Date.now() - 1000).toISOString() });

	tick.wake();

	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
});

test("while Pi cannot take a message, a child past its time limit is still stopped by the tick", () => {
	const { tick } = parentTick(() => false);
	liveRun("aaa111", { deadline: new Date(Date.now() - 1000).toISOString() });

	tick.wake();

	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
});

test("a child that answers and goes idle before its 2 s limit is never stopped: one finished message, no timed out", () => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	const { tick, sent } = parentTick();
	const { run } = liveRun("aaa111", { state: "idle", timeout: "2s", deadline: new Date(Date.now() + 2000).toISOString() });
	writeResult(run, "finished", "the answer");

	tick.wake();
	mock.timers.tick(5000);

	assert.deepEqual(tmuxCalls(), []);
	assert.deepEqual(sent, ["Subagent aaa111 finished\n\nthe answer"]);
});

test("a child that gets a new message after its deadline is stopped by the limit counted from that turn", () => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	const { tick, sent } = parentTick();
	const { run } = liveRun("aaa111", { state: "idle", timeout: "2s", deadline: new Date(Date.now() - 60_000).toISOString() });
	mkdirSync(inboxDir(run.runDir));
	writeFileSync(join(inboxDir(run.runDir), "1.json"), JSON.stringify({ message: "more", delivery: "auto" }));

	// The child takes the message: a new turn starts, and it stays busy.
	new InboxDelivery(run.runDir).deliver({ isIdle: () => true, send: () => {}, abort: () => {} });
	tick.wake();
	mock.timers.tick(1000);
	assert.deepEqual(tmuxCalls(), [], "the old deadline does not stop the new turn");

	mock.timers.tick(2000);
	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
	assert.match(sent.join(), /^Subagent aaa111 timed out\n/);
});

test("a queued child keeps the tick, and starts when the last live child ends", async () => {
	const { tick, shown } = parentTick();
	const { child } = liveRun("aaa111");
	queuedRun("bbb222");
	tick.wake();

	mock.timers.tick(3000);
	assert.deepEqual(started(), []);
	assert.deepEqual(shown.at(-1), [
		{ handle: "aaa111", state: "busy" },
		{ handle: "bbb222", state: "queued" },
	]);

	await kill(child);
	mock.timers.tick(1000);
	assert.deepEqual(started(), ["pi-subagent-bbb222"]);
});

test("a queued child alone starts on wake", () => {
	const { tick } = parentTick(() => false);
	queuedRun("bbb222");

	tick.wake();

	assert.deepEqual(started(), ["pi-subagent-bbb222"]);
});

test("a queued child that fails to start gives the parent one message with the error, and the tick stops", () => {
	writeFileSync(join(root, "bin", "tmux"), `#!/bin/sh\necho "$*" >> "${join(root, "tmux-calls")}"\necho 'test launch failure' >&2\nexit 1\n`);
	const { tick, shown, sent } = parentTick();
	queuedRun("bbb222");

	tick.wake();
	mock.timers.tick(5000);

	assert.deepEqual(sent, ["Subagent bbb222 failed to start\n\ntest launch failure"]);
	assert.deepEqual(shown, [[]]);
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
