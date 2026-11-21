import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { InboxDelivery } from "./inbox.ts";
import { markExitKnown, markWaiting, writeResult } from "./outbox.ts";
import { claimSuspendedRun } from "./queue.ts";
import { settleTmuxCalls, startQueuedRuns, stopTimedOutRuns } from "./queue.ts";
import { inboxDir, listRuns, openAliveFifo, prepareLaunch, readMetadata, saveFirstPrompt, suspendSessionRuns, updateMetadata, writeMetadata, type RunMetadata, type RunState } from "./shared.ts";
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

/** A run that waits for a free slot, with its launch saved as `spawn` does; it has no process yet. */
function queuedRun(handle: string): RunMetadata {
	const { run, child } = liveRun(handle, { state: "queued", childPid: null });
	child.kill("SIGKILL");
	prepareLaunch(run);
	return run;
}

const started = () => tmuxCalls().filter((call) => call.startsWith("new-session")).map((call) => call.split(" ")[3]);

/**
 * A parent's tick that records what it shows and what it sends. Each sent result reaches the session, as in
 * an idle Pi, unless `reaches` says no; `delivered` holds the results the session has.
 */
function parentTick(ready = () => true, { reaches = () => true, delivered = new Set<string>() } = {}) {
	const shown: { handle: string; state: RunState }[][] = [];
	const sent: string[] = [];
	const sentResults: string[] = [];
	const tick = new SessionTick({
		sessionId: () => "parent",
		show: (rows) => shown.push(rows.map(({ run, state }) => ({ handle: run.handle, state }))),
		deliver: {
			ready,
			send: (text, results) => {
				sent.push(text);
				sentResults.push(...results);
				if (reaches()) for (const result of results) delivered.add(result);
			},
			delivered: () => delivered,
		},
	});
	ticks.push(tick);
	return { tick, shown, sent, sentResults };
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
	// A `ps` that records each call, then answers as the real one.
	writeFileSync(join(root, "bin", "ps"), `#!/bin/sh\necho "$*" >> "${join(root, "ps-calls")}"\nexec /bin/ps "$@"\n`, { mode: 0o755 });
	const { tick, shown } = parentTick();
	const { run } = liveRun("aaa111");
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

test("a result taken while the parent is busy is not sent; it is sent once when the parent is idle", () => {
	let idle = false;
	const { tick, sent } = parentTick(() => idle);
	const { run } = liveRun("aaa111", { state: "idle" });
	writeResult(run, "finished", "the answer");
	tick.wake();

	mock.timers.tick(3000);
	assert.deepEqual(sent, [], "a busy Pi would hold it in memory, where Escape or a quit drops it");
	assert.equal(readdirSync(join(run.runDir, "outbox")).length, 1, "it stays on disk");

	idle = true;
	mock.timers.tick(5000);
	assert.deepEqual(sent, ["Subagent aaa111 finished\n\nthe answer"]);
	assert.deepEqual(readdirSync(join(run.runDir, "outbox")), []);
});

/** Move the send time of each result of the run back, as fake timers do not move the clock files use. */
function setMtime(run: RunMetadata, ms: number): void {
	const dir = join(run.runDir, "outbox");
	for (const file of readdirSync(dir)) utimesSync(join(dir, file), new Date(ms), new Date(ms));
}

test("a sent result that never reaches the session is sent again; one that reached it is never sent twice", () => {
	let reaches = false;
	const delivered = new Set<string>();
	const { tick, sent } = parentTick(() => true, { reaches: () => reaches, delivered });
	const { run } = liveRun("aaa111", { state: "idle" });
	writeResult(run, "finished", "the answer");
	tick.wake();
	assert.equal(sent.length, 1);

	// The turn it started was cut, or Pi rejected it: the session has no such message.
	mock.timers.tick(1000);
	assert.equal(sent.length, 1, "not at once: the message may be on its way");
	setMtime(run, Date.now() - 5000);
	mock.timers.tick(1000);
	assert.equal(sent.length, 2, "sent again on the next idle tick");
	assert.equal(sent[1], sent[0]);

	reaches = true;
	setMtime(run, Date.now() - 5000);
	mock.timers.tick(1000);
	assert.equal(sent.length, 3);
	mock.timers.tick(5000);
	assert.equal(sent.length, 3, "in the session: not sent again");
	assert.deepEqual(readdirSync(join(run.runDir, "outbox")), []);
});

test("a result in the session that the parent quit before it could delete is not sent again after resume", () => {
	const first = parentTick(() => true, { reaches: () => false });
	const { run } = liveRun("aaa111", { state: "idle" });
	writeResult(run, "finished", "the answer");
	first.tick.wake();
	assert.equal(first.sent.length, 1);
	// The message reaches the session after the tick; the parent quits before the next tick.
	first.tick.stop();
	assert.equal(readdirSync(join(run.runDir, "outbox")).length, 1);

	// The resumed Pi finds the message in its session.
	const second = parentTick(() => true, { delivered: new Set(first.sentResults) });
	second.tick.wake();
	mock.timers.tick(3000);
	assert.deepEqual(second.sent, []);
	assert.deepEqual(readdirSync(join(run.runDir, "outbox")), []);
});

test("a result of an exited child that the parent quit before sending arrives once after resume", async () => {
	const { run, child } = liveRun("aaa111", { state: "idle" });
	writeResult(run, "finished", "the answer");
	await kill(child);
	updateMetadata(run.runDir, { state: "exited" });

	await suspendSessionRuns("parent");
	const { tick, sent } = parentTick();
	tick.wake();
	mock.timers.tick(3000);

	assert.equal(sent.length, 1);
	assert.equal(sent.join().split("the answer").length, 2, "the answer arrives once");
	assert.match(sent[0], /^Subagent aaa111 finished\n\nthe answer\n\n---\n\nSubagent aaa111 exited\n/);
	await suspendSessionRuns("parent");
	assert.equal(existsSync(run.runDir), false, "the next quit removes the run, as it has nothing left to send");
});

test("two parents of one session: a result reaches only the owner's chat, once", () => {
	// The owner: another live Pi. This process is a second Pi on the same session.
	const owner = spawn("sleep", ["60"], { stdio: "ignore" });
	children.push(owner);
	const { run } = liveRun("aaa111", { state: "idle", parentPid: owner.pid });
	writeResult(run, "finished", "the answer");
	const second = parentTick();
	second.tick.wake();
	mock.timers.tick(3000);
	assert.deepEqual(second.sent, [], "the second Pi shows the run but does not send its result");
	assert.deepEqual(second.shown.at(-1), [{ handle: "aaa111", state: "idle" }]);

	// The owner's tick, here with this process's ID.
	updateMetadata(run.runDir, { parentPid: process.pid });
	const first = parentTick();
	first.tick.wake();
	mock.timers.tick(3000);
	assert.equal(first.sent.length, 1);
	assert.match(first.sent[0], /^Subagent aaa111 finished\n\nthe answer/);
	assert.deepEqual(second.sent, []);
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

test("a child past its time limit is stopped by the tick and reported as timed out", async () => {
	const { tick, sent } = parentTick();
	liveRun("aaa111", { deadline: new Date(Date.now() - 1000).toISOString() });

	tick.wake();
	await settleTmuxCalls();

	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
	assert.match(sent.join(), /^Subagent aaa111 timed out\n/);
});

test("with results off, a child past its time limit is still stopped by the tick", async () => {
	const tick = new SessionTick({ sessionId: () => "parent", show: () => {} });
	ticks.push(tick);
	liveRun("aaa111", { deadline: new Date(Date.now() - 1000).toISOString() });

	tick.wake();
	await settleTmuxCalls();

	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
});

test("while Pi cannot take a message, a child past its time limit is still stopped by the tick", async () => {
	const { tick } = parentTick(() => false);
	liveRun("aaa111", { deadline: new Date(Date.now() - 1000).toISOString() });

	tick.wake();
	await settleTmuxCalls();

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

test("a child that goes idle after the tick lists it, and before the time limit check, is not stopped", () => {
	const { run } = liveRun("aaa111", { deadline: new Date(Date.now() - 1000).toISOString() });
	const runs = listRuns("parent");

	// The child answers between the listing and the check.
	updateMetadata(run.runDir, { state: "idle" });
	stopTimedOutRuns(runs);

	assert.equal(readMetadata(run.runDir)?.timedOut, undefined);
	assert.deepEqual(tmuxCalls(), []);
});

test("a child that gets a new message after its deadline is stopped by the limit counted from that turn", async () => {
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
	await settleTmuxCalls();
	assert.deepEqual(tmuxCalls(), [], "the old deadline does not stop the new turn");

	mock.timers.tick(2000);
	await settleTmuxCalls();
	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
	assert.match(sent.join(), /^Subagent aaa111 timed out\n/);
});

test("a resumed child that never reports in is stopped at its deadline and reported once as timed out", async () => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	const { tick, sent } = parentTick();
	const { run, child } = liveRun("aaa111", { state: "exited", suspended: true, timeout: "1s" });
	child.kill("SIGKILL");
	prepareLaunch(run);
	claimSuspendedRun(run, "queued");

	// The tick starts it; its child never records its process ID, so it stays `starting`.
	tick.wake();
	await settleTmuxCalls();
	mock.timers.tick(3000);
	await settleTmuxCalls();

	assert.deepEqual(tmuxCalls().slice(1), ["kill-session -t pi-subagent-aaa111"]);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /^Subagent aaa111 timed out\n/);
});

test("a child with --timeout 10s that never starts its first turn is stopped at its deadline and reported timed out", async () => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	const { tick, sent } = parentTick();
	// Pi reports `idle` at its session start; its first prompt never became a turn.
	const now = new Date().toISOString();
	liveRun("aaa111", { state: "idle", hasStarted: false, sessionStartedAt: now, timeout: "10s", deadline: new Date(Date.now() + 10_000).toISOString() });

	tick.wake();
	mock.timers.tick(9000);
	await settleTmuxCalls();
	assert.deepEqual(tmuxCalls(), []);

	mock.timers.tick(2000);
	await settleTmuxCalls();
	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /^Subagent aaa111 timed out\n/);
});

test("a child past its start grace that has not recorded its process ID is still ended at its deadline, with no second message", async () => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	const { tick, sent } = parentTick();
	// Its Pi runs in tmux, but has not come to record its ID: only tmux knows it is there.
	const { child } = liveRun("aaa111", { state: "starting", childPid: null, timeout: "40s", deadline: new Date(Date.now() + 40_000).toISOString() });
	child.kill("SIGKILL");

	tick.wake();
	mock.timers.tick(31_000);
	await settleTmuxCalls();
	assert.match(sent.join(), /^Subagent aaa111 exited\n/, "reported at the end of its grace time, as before");
	assert.deepEqual(tmuxCalls(), []);

	mock.timers.tick(10_000);
	await settleTmuxCalls();
	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
	assert.equal(sent.length, 1, "no second message");
});

/** A fake `tmux` whose `capture-pane` prints `screen`; it records each call, and `new-session` succeeds. */
function screenTmux(screen: string): void {
	writeFileSync(join(root, "screen"), screen);
	writeFileSync(
		join(root, "bin", "tmux"),
		`#!/bin/sh\necho "$*" >> "${join(root, "tmux-calls")}"\n[ "$1" = capture-pane ] && cat "${join(root, "screen")}"\nexit 0\n`,
	);
}

// The screen of a real child Pi whose provider has no login, from `tmux capture-pane -p -J` (paths shortened).
const NO_LOGIN_SCREEN = `[Extensions]
  code


 Error: No API key found for anthropic.

 Use /login to log into a provider via OAuth or API key. See:

 /pi/docs/providers.md

 /pi/docs/models.md

 Warning: tmux extended-keys is off. Modified Enter keys may not work. Add \`set -g extended-keys on\` to ~/.tmux.conf and restart tmux.

────────────────────────────────────────

────────────────────────────────────────
/private/tmp/project (main) • subagent nologin
0.0%/200k (auto)                    claude-opus-4-5 • thinking off
`;

test("a child idle before its first turn 15 s after its session started is stopped, reported failed to start with Pi's error, and frees its slot", async () => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	screenTmux(NO_LOGIN_SCREEN);
	const { tick, shown, sent } = parentTick();
	const { run } = liveRun("aaa111", { state: "idle", hasStarted: false, sessionStartedAt: new Date().toISOString() });
	saveFirstPrompt(run.runDir, ["Task:\nSay hi."]);
	queuedRun("bbb222");

	tick.wake();
	mock.timers.tick(14_000);
	await settleTmuxCalls();
	assert.deepEqual(tmuxCalls(), [], "not before 15 s");

	mock.timers.tick(1000);
	await settleTmuxCalls();
	mock.timers.tick(1000);
	await settleTmuxCalls();
	mock.timers.tick(1000);

	assert.deepEqual(sent, [
		"Subagent aaa111 failed to start\n\nIts Pi did not start its first prompt within 15 s, so it was stopped. Its screen ended with:\n" +
			"Error: No API key found for anthropic.\nUse /login to log into a provider via OAuth or API key. See:\n/pi/docs/providers.md\n/pi/docs/models.md",
	]);
	assert.deepEqual(tmuxCalls().slice(0, 2), ["capture-pane -p -J -t pi-subagent-aaa111", "kill-session -t pi-subagent-aaa111"]);
	assert.deepEqual(started(), ["pi-subagent-bbb222"], "its slot went to the queued child");
	assert.equal(readMetadata(run.runDir)?.state, "error");
	assert.deepEqual(shown.at(-1), [{ handle: "bbb222", state: "starting" }]);
});

test("a resumed child whose continue message never starts a turn is stopped and reported failed to start once, with Pi's error", async () => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	screenTmux(NO_LOGIN_SCREEN);
	const { tick, sent } = parentTick();
	// Resumed after a quit cut its turn: it started a turn in an earlier launch, but not in this one.
	const { run } = liveRun("aaa111", { state: "idle", hasStarted: true, cutWork: "continue", sessionStartedAt: new Date().toISOString() });

	tick.wake();
	mock.timers.tick(14_000);
	await settleTmuxCalls();
	assert.deepEqual(tmuxCalls(), [], "not before 15 s");

	for (let i = 0; i < 5; i++) {
		mock.timers.tick(1000);
		await settleTmuxCalls();
	}

	assert.deepEqual(sent, [
		"Subagent aaa111 failed to start\n\nIts Pi did not start the continue message within 15 s, so it was stopped. Its screen ended with:\n" +
			"Error: No API key found for anthropic.\nUse /login to log into a provider via OAuth or API key. See:\n/pi/docs/providers.md\n/pi/docs/models.md",
	]);
	assert.deepEqual(tmuxCalls(), ["capture-pane -p -J -t pi-subagent-aaa111", "kill-session -t pi-subagent-aaa111"]);
	assert.equal(readMetadata(run.runDir)?.state, "error");
});

test("a resumed child idle before the turn of its launch is stopped at its deadline and reported timed out", async () => {
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	const { tick, sent } = parentTick();
	liveRun("aaa111", { state: "idle", hasStarted: true, cutWork: "continue", sessionStartedAt: new Date().toISOString(), timeout: "10s", deadline: new Date(Date.now() + 10_000).toISOString() });

	tick.wake();
	mock.timers.tick(11_000);
	await settleTmuxCalls();

	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /^Subagent aaa111 timed out\n/);
});

test("a child whose Pi asks whether to trust the project is reported as waiting for trust, not exited, and keeps its slot", async () => {
	const { run } = liveRun("aaa111", { state: "starting", childPid: null });
	children.pop()?.kill("SIGKILL");
	// The child Pi, at its trust prompt: its session has not started.
	const trusting = spawn(
		process.execPath,
		["--input-type=module", "-e", `import { recordTrustPrompt } from ${JSON.stringify(join(import.meta.dirname, "shared.ts"))}; recordTrustPrompt(${JSON.stringify(run.runDir)}, "/work/fresh"); setInterval(() => {}, 1000);`],
		{ stdio: "ignore" },
	);
	children.push(trusting);
	while (typeof readMetadata(run.runDir)?.childPid !== "number") await new Promise((resolve) => setTimeout(resolve, 20));
	queuedRun("bbb222");
	mock.timers.reset();
	mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() + 31_000 });
	const { tick, shown, sent } = parentTick();

	tick.wake();
	mock.timers.tick(5000);
	await settleTmuxCalls();

	assert.equal(sent.length, 1);
	assert.match(sent[0], /^Subagent aaa111 waits for project trust in \/work\/fresh\n\n.*tmux attach -t pi-subagent-aaa111/);
	assert.deepEqual(shown.at(-1), [
		{ handle: "aaa111", state: "starting" },
		{ handle: "bbb222", state: "queued" },
	]);
	assert.deepEqual(started(), [], "it keeps its slot past its start grace");
	assert.deepEqual(tmuxCalls(), []);
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
	await settleTmuxCalls();
	assert.deepEqual(started(), ["pi-subagent-bbb222"]);
});

test("a queued child alone starts on wake", async () => {
	const { tick } = parentTick(() => false);
	queuedRun("bbb222");

	tick.wake();
	await settleTmuxCalls();

	assert.deepEqual(started(), ["pi-subagent-bbb222"]);
});

test("a queued child that fails to start gives the parent one message with the error, and the tick stops", async () => {
	writeFileSync(join(root, "bin", "tmux"), `#!/bin/sh\necho "$*" >> "${join(root, "tmux-calls")}"\necho 'test launch failure' >&2\nexit 1\n`);
	const { tick, shown, sent } = parentTick();
	const run = queuedRun("bbb222");

	tick.wake();
	await settleTmuxCalls();
	mock.timers.tick(5000);

	assert.deepEqual(sent, ["Subagent bbb222 failed to start\n\ntest launch failure"]);
	// The tick that reported it is the last.
	assert.deepEqual(shown, [[{ handle: "bbb222", state: "starting" }], []]);
	assert.equal(readMetadata(run.runDir)?.state, "error");
});

test("two ticks that both list one queued run start it once, and the run stays live", async () => {
	// Like tmux: a second session with the same name fails.
	const made = join(root, "made");
	writeFileSync(join(root, "bin", "tmux"), `#!/bin/sh\necho "$*" >> "${join(root, "tmux-calls")}"\n[ "$1" = new-session ] || exit 1\n[ -e "${made}" ] && { echo 'duplicate session' >&2; exit 1; }\ntouch "${made}"\n`);
	const run = queuedRun("bbb222");
	// Two parents, or a tick and `subagent resume`, list the run before either starts it.
	const first = listRuns("parent");
	const second = listRuns("parent");
	const errors: string[] = [];

	startQueuedRuns(first, (_run, message) => errors.push(message));
	startQueuedRuns(second, (_run, message) => errors.push(message));
	await settleTmuxCalls();

	assert.deepEqual(started(), ["pi-subagent-bbb222"]);
	assert.deepEqual(errors, []);
	assert.equal(readMetadata(run.runDir)?.state, "starting");
});

test("two ticks of one session that list two queued runs at a limit of 1 start exactly one", async () => {
	const first = queuedRun("aaa111");
	const second = queuedRun("bbb222");
	// Two parents of one session list both runs before either starts one.
	const one = listRuns("parent");
	const two = listRuns("parent");
	const errors: string[] = [];

	startQueuedRuns(one, (_run, message) => errors.push(message));
	startQueuedRuns(two, (_run, message) => errors.push(message));
	await settleTmuxCalls();

	assert.deepEqual(started(), ["pi-subagent-aaa111"]);
	assert.deepEqual(errors, []);
	assert.deepEqual([readMetadata(first.runDir)?.state, readMetadata(second.runDir)?.state], ["starting", "queued"]);
});

test("a tick waits about 200 ms for a run lock a stalled process holds, and starts the run on a later tick", async () => {
	const run = queuedRun("bbb222");
	// A live process that holds the run's lock, as a CLI stopped with Ctrl-Z would.
	const lock = join(run.runDir, "metadata.lock");
	const holder = spawn("sleep", ["60"], { stdio: "ignore" });
	children.push(holder);
	writeFileSync(lock, `${holder.pid} stalled`);
	const { tick } = parentTick();

	const before = Date.now();
	tick.wake();
	const blocked = Date.now() - before;

	assert.ok(blocked >= 200 && blocked < 600, `blocked ${blocked} ms`);
	assert.deepEqual(started(), []);
	assert.equal(readMetadata(run.runDir)?.state, "queued", "nothing changed");
	await kill(holder);
	mock.timers.tick(1000);
	await settleTmuxCalls();
	assert.deepEqual(started(), ["pi-subagent-bbb222"]);
	assert.equal(existsSync(lock), false);
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

/** A fake `tmux` that takes `seconds` for each call, then records it and exits with `status`. */
function slowTmux(seconds: number, status = 0): void {
	writeFileSync(
		join(root, "bin", "tmux"),
		`#!/bin/sh\nsleep ${seconds}\necho "$*" >> "${join(root, "tmux-calls")}"\n[ ${status} = 0 ] || { echo 'slow launch failure' >&2; exit ${status}; }\n`,
	);
}

test("with a slow tmux, the tick returns before 4 queued children's new-session ends, and they start", async () => {
	slowTmux(1);
	process.env.PI_SUBAGENT_LIMIT = "4";
	const runs = ["aaa111", "bbb222", "ccc333", "ddd444"].map(queuedRun);
	const { tick, shown } = parentTick();

	const before = Date.now();
	tick.wake();
	const blocked = Date.now() - before;

	assert.ok(blocked < 500, `blocked ${blocked} ms`);
	assert.deepEqual(started(), [], "no new-session has ended yet");
	assert.deepEqual(shown[0].map(({ state }) => state), Array(4).fill("starting"), "each slot is taken at once");
	await settleTmuxCalls();
	assert.deepEqual(started().sort(), runs.map((run) => run.tmuxSession));
	for (const run of runs) assert.equal(readMetadata(run.runDir)?.state, "starting");
});

test("with a slow tmux, a queued child that fails to start is reported once, after the tick returned", async () => {
	slowTmux(1, 1);
	const errors: string[] = [];
	const { shown, sent } = parentTick();
	const tick = new SessionTick({
		sessionId: () => "parent",
		show: (rows) => shown.push(rows.map(({ run, state }) => ({ handle: run.handle, state }))),
		deliver: { ready: () => true, send: (text) => sent.push(text), delivered: () => new Set() },
		onStartError: (_run, message) => errors.push(message),
	});
	ticks.push(tick);
	const run = queuedRun("bbb222");

	const before = Date.now();
	tick.wake();
	assert.ok(Date.now() - before < 500, `blocked ${Date.now() - before} ms`);
	await settleTmuxCalls();
	mock.timers.tick(5000);

	assert.deepEqual(errors, ["slow launch failure"]);
	assert.deepEqual(sent, ["Subagent bbb222 failed to start\n\nslow launch failure"]);
	assert.equal(readMetadata(run.runDir)?.state, "error");
	assert.deepEqual(started(), ["pi-subagent-bbb222"], "started once, not again on later ticks");
});

test("with a slow tmux, a child past its time limit is ended without blocking the tick, and reported once", async () => {
	slowTmux(1);
	const { tick, sent } = parentTick();
	const { run } = liveRun("aaa111", { deadline: new Date(Date.now() - 1000).toISOString() });

	const before = Date.now();
	tick.wake();
	const blocked = Date.now() - before;

	assert.ok(blocked < 500, `blocked ${blocked} ms`);
	assert.deepEqual(tmuxCalls(), [], "kill-session has not ended yet");
	assert.equal(readMetadata(run.runDir)?.timedOut, true);
	await settleTmuxCalls();
	mock.timers.tick(3000);
	await settleTmuxCalls();

	assert.deepEqual(tmuxCalls(), ["kill-session -t pi-subagent-aaa111"]);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /^Subagent aaa111 timed out\n/);
});
