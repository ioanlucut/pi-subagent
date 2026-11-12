import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { claimResultDelivery, clearResults, markExitKnown, markWaiting, pendingResults, reportExitedRuns, reportSettledTurn } from "./outbox.ts";
import { inboxDir, writeMetadata, type RunMetadata } from "./shared.ts";

let root: string;

// An empty TMUX_TMPDIR has no tmux server, so every run here has no live child.
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psa-outbox-"));
	process.env.TMUX_TMPDIR = root;
	delete process.env.TMUX;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A run of a parent session whose transcript ends with `message`. */
function storedRun(handle: string, message?: Record<string, unknown>, patch: Partial<RunMetadata> = {}): RunMetadata {
	const runDir = join(root, handle);
	mkdirSync(inboxDir(runDir), { recursive: true });
	const sessionFile = join(runDir, "session.jsonl");
	if (message) writeFileSync(sessionFile, `${JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "assistant", ...message } })}\n`);
	const now = new Date().toISOString();
	const run = { version: 1, handle, tmuxSession: `pi-subagent-${handle}`, runDir, sessionFile, parentSessionId: "parent", state: "idle", hasStarted: true, createdAt: now, updatedAt: now, ...patch } as RunMetadata;
	writeMetadata(run);
	return run;
}

const answer = (text: string) => ({ content: [{ type: "text", text }], stopReason: "stop" });

test("a settled turn reaches the parent once, as a message with the child's answer", () => {
	const run = storedRun("aaa111", answer("All good."), { name: "review" });

	reportSettledTurn(run.runDir);
	const pending = pendingResults([run]);

	assert.equal(pending?.text, "Subagent review (aaa111) finished\n\nAll good.");
	for (const file of pending.files) rmSync(file);
	assert.equal(pendingResults([run]), undefined);
});

test("a turn that ended in a provider error is reported as failed, not finished", () => {
	const run = storedRun("bbb222", { content: [], stopReason: "error", errorMessage: "OAuth refresh failed" });

	reportSettledTurn(run.runDir);

	assert.equal(pendingResults([run])?.text, "Subagent bbb222 failed (error)\n\nOAuth refresh failed");
});

test("a turn with a queued `send` is not reported: the next turn has the result", () => {
	const run = storedRun("ccc333", answer("Half way."));
	writeFileSync(join(inboxDir(run.runDir), "1.json"), JSON.stringify({ message: "go on", delivery: "followUp" }));

	reportSettledTurn(run.runDir);

	assert.equal(pendingResults([run]), undefined);
});

test("a child with no parent session reports nothing: nobody would read it", () => {
	const run = storedRun("ddd444", answer("Done."), { parentSessionId: undefined });

	reportSettledTurn(run.runDir);

	assert.equal(existsSync(join(run.runDir, "outbox")), false);
});

test("results of several children arrive as one message", () => {
	const first = storedRun("eee555", answer("One."));
	const second = storedRun("fff666", answer("Two."));
	reportSettledTurn(first.runDir);
	reportSettledTurn(second.runDir);

	assert.equal(pendingResults([first, second])?.text, "Subagent eee555 finished\n\nOne.\n\n---\n\nSubagent fff666 finished\n\nTwo.");
});

test("a child whose process ended without `stop` is reported once", () => {
	const run = storedRun("ggg777", answer("Partial."));

	reportExitedRuns([run]);
	reportExitedRuns([run]);
	const pending = pendingResults([run]);

	assert.equal(pending?.files.length, 1);
	assert.match(pending.text, /^Subagent ggg777 exited\n\nIts process ended/);
});

test("a suspended child and a child that tmux has not started yet are not reported as exited", () => {
	const suspended = storedRun("hhh888", answer("x"), { suspended: true });
	const starting = storedRun("iii999", undefined, { state: "starting", hasStarted: false });

	reportExitedRuns([suspended, starting]);

	assert.equal(pendingResults([suspended, starting]), undefined);
});

test("a run that `stop` removed is not created again by a late report", () => {
	const run = storedRun("jjj000", answer("x"));
	rmSync(run.runDir, { recursive: true });

	reportExitedRuns([run]);

	assert.equal(existsSync(run.runDir), false);
});

test("clearResults drops the results that `wait` printed", () => {
	const run = storedRun("kkk111", answer("Done."));
	reportSettledTurn(run.runDir);

	clearResults(run.runDir);

	assert.equal(pendingResults([run]), undefined);
});

test("a child that `stop` is ending is not reported as exited", () => {
	const run = storedRun("lll222", answer("x"));
	markExitKnown(run.runDir);

	reportExitedRuns([run]);

	assert.equal(pendingResults([run]), undefined);
});

test("a result that a running `wait` will print is left for it; a killed `wait` gives it back", () => {
	const run = storedRun("mmm333", answer("Done."));
	reportSettledTurn(run.runDir);
	markWaiting(run.runDir);

	assert.equal(pendingResults([run]), undefined);

	const stale = new Date(Date.now() - 3_000);
	utimesSync(join(run.runDir, "waiting"), stale, stale);
	assert.equal(pendingResults([run])?.files.length, 1);
});

test("a turn that ended because the parent suspended or stopped the child is not reported", () => {
	const suspended = storedRun("nnn444", { content: [], stopReason: "aborted", errorMessage: "Operation aborted" }, { suspended: true });
	const stopping = storedRun("ooo555", { content: [], stopReason: "aborted", errorMessage: "Operation aborted" });
	markExitKnown(stopping.runDir);

	reportSettledTurn(suspended.runDir);
	reportSettledTurn(stopping.runDir);

	assert.equal(pendingResults([suspended, stopping]), undefined);
});

test("only a TUI or RPC parent delivers results, and it says so to the `spawn` its tools run", () => {
	const saved = process.env.PI_SUBAGENT_NOTIFY;
	try {
		delete process.env.PI_SUBAGENT_NOTIFY;
		assert.equal(claimResultDelivery("tui"), true);
		assert.equal(process.env.PI_SUBAGENT_NOTIFY, "1");

		// A `pi -p` that a delivering parent started inherits "1", but print mode ends with the turn.
		assert.equal(claimResultDelivery("print"), false);
		assert.equal(process.env.PI_SUBAGENT_NOTIFY, "0");

		assert.equal(claimResultDelivery("rpc"), false, "the user turned it off");
	} finally {
		if (saved === undefined) delete process.env.PI_SUBAGENT_NOTIFY;
		else process.env.PI_SUBAGENT_NOTIFY = saved;
	}
});
