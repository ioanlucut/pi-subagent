import assert from "node:assert/strict";
import { test } from "node:test";
import { HerdrPanes, watchCommand } from "./herdr-panes.ts";
import type { RunMetadata, RunState } from "./shared.ts";

/** A fake `herdr` CLI that records each call and gives each split a new pane ID. */
function fakeHerdr(failSplitsFrom: string[] = []) {
	const calls: string[] = [];
	let next = 2;
	const herdr = (args: string[]): unknown => {
		calls.push(args.join(" "));
		if (args[0] === "pane" && args[1] === "split") {
			if (failSplitsFrom.includes(args[2])) return undefined;
			return { result: { pane: { pane_id: `w1:p${next++}` } } };
		}
		return { result: {} };
	};
	return { calls, herdr, request: fakeRequest().request };
}

/** A fake Herdr socket: `layout.export` returns `root`; every request is recorded. */
function fakeRequest(root?: unknown) {
	const requests: string[] = [];
	const request = (method: string, params: Record<string, unknown>): unknown => {
		requests.push(method === "layout.set_split_ratio" ? `${method} ${JSON.stringify(params.path)} ${(params.ratio as number).toFixed(4)}` : method);
		return method === "layout.export" ? { layout: { root } } : {};
	};
	return { requests, request };
}

function run(handle: string, name?: string): RunMetadata {
	return { handle, name, tmuxSession: `pi-subagent-${handle}`, cwd: "/repo" } as RunMetadata;
}

const at = (state: RunState, ...runs: RunMetadata[]) => runs.map((r) => ({ run: r, state }));

test("a busy child opens one read-only pane right of the parent", () => {
	const { calls, herdr, request } = fakeHerdr();
	const panes = new HerdrPanes("w1:p1", herdr, request);
	panes.sync(at("busy", run("aaa", "review-spec")));
	panes.sync(at("busy", run("aaa", "review-spec")));
	assert.deepEqual(calls, [
		"pane split w1:p1 --direction right --ratio 0.6 --cwd /repo --no-focus",
		"pane rename w1:p2 ◆ subagent review-spec",
		`pane run w1:p2 ${watchCommand(run("aaa", "review-spec"))}`,
	]);
});

test("more children stack below the first child pane", () => {
	const { calls, herdr, request } = fakeHerdr();
	const panes = new HerdrPanes("w1:p1", herdr, request);
	panes.sync(at("starting", run("aaa"), run("bbb")));
	assert.equal(calls.filter((call) => call.startsWith("pane split"))[1], "pane split w1:p2 --direction down --cwd /repo --no-focus");
});

test("a child that becomes idle or exits closes its pane, and a new turn opens it again", () => {
	const { calls, herdr, request } = fakeHerdr();
	const panes = new HerdrPanes("w1:p1", herdr, request);
	panes.sync(at("busy", run("aaa"), run("bbb")));
	panes.sync([...at("idle", run("aaa")), ...at("busy", run("bbb"))]);
	panes.sync(at("exited", run("bbb")));
	assert.deepEqual(
		calls.filter((call) => call.startsWith("pane close")),
		["pane close w1:p2", "pane close w1:p3"],
	);
	panes.sync(at("busy", run("aaa")));
	assert.equal(calls.at(-3), "pane split w1:p1 --direction right --ratio 0.6 --cwd /repo --no-focus");
});

test("a child that leaves the list (stopped) closes its pane", () => {
	const { calls, herdr, request } = fakeHerdr();
	const panes = new HerdrPanes("w1:p1", herdr, request);
	panes.sync(at("busy", run("aaa")));
	panes.sync([]);
	assert.equal(calls.at(-1), "pane close w1:p2");
});

test("closeAll closes every open pane", () => {
	const { calls, herdr, request } = fakeHerdr();
	const panes = new HerdrPanes("w1:p1", herdr, request);
	panes.sync(at("busy", run("aaa"), run("bbb")));
	panes.closeAll();
	assert.deepEqual(calls.slice(-2), ["pane close w1:p2", "pane close w1:p3"]);
});

test("when the last child pane is gone, the next one splits from the parent", () => {
	const { calls, herdr, request } = fakeHerdr(["w1:p2"]);
	const panes = new HerdrPanes("w1:p1", herdr, request);
	panes.sync(at("busy", run("aaa")));
	panes.sync(at("busy", run("aaa"), run("bbb")));
	assert.deepEqual(calls.filter((call) => call.startsWith("pane split")).slice(-2), [
		"pane split w1:p2 --direction down --cwd /repo --no-focus",
		"pane split w1:p1 --direction right --ratio 0.6 --cwd /repo --no-focus",
	]);
});

test("a failed split is not retried each second for the same turn", () => {
	const { calls, herdr, request } = fakeHerdr(["w1:p1"]);
	const panes = new HerdrPanes("w1:p1", herdr, request);
	panes.sync(at("busy", run("aaa")));
	panes.sync(at("busy", run("aaa")));
	panes.sync(at("idle", run("aaa")));
	assert.deepEqual(calls, ["pane split w1:p1 --direction right --ratio 0.6 --cwd /repo --no-focus"]);
});

test("a child that reports idle before its first turn keeps its pane", () => {
	const { calls, herdr, request } = fakeHerdr();
	const panes = new HerdrPanes("w1:p1", herdr, request);
	const child = { ...run("aaa"), hasStarted: false };
	panes.sync([{ run: child, state: "starting" }]);
	panes.sync([{ run: child, state: "idle" }]);
	assert.equal(calls.filter((call) => call.startsWith("pane close")).length, 0);
	panes.sync([{ run: { ...child, hasStarted: true }, state: "idle" }]);
	assert.equal(calls.at(-1), "pane close w1:p2");
});

test("the pane command marks the child as a disposable subagent and attaches read-only", () => {
	const command = watchCommand(run("aaa", "review-spec"));
	assert.match(command, /^exec tmux set-option -t pi-subagent-aaa status-style /);
	assert.match(command, /status-left '#\{\?client_readonly, SUBAGENT review-spec · read-only · closes when done , SUBAGENT review-spec \}'/);
	assert.match(command, /set-option -w -t pi-subagent-aaa window-style 'bg=#f3edff'/);
	assert.match(command, / \\; attach-session -r -t pi-subagent-aaa$/);
});

test("a child name cannot run a command through the tmux status line", () => {
	const command = watchCommand(run("aaa", "x #(touch /tmp/pwned) #{pane_id}"));
	assert.match(command, /SUBAGENT x ##\(touch \/tmp\/pwned\) ##\{pane_id#\} · read-only/);
});

test("a comma or brace in a name does not end the read-only condition early", () => {
	assert.match(watchCommand(run("aaa", "a,b}c")), /#\{\?client_readonly, SUBAGENT a#,b#\}c · read-only · closes when done , SUBAGENT a#,b#\}c \}/);
});

const pane = (pane_id: string) => ({ type: "pane", pane_id });
const down = (first: unknown, second: unknown) => ({ type: "split", direction: "down", ratio: 0.5, first, second });

test("child panes stacked beside the parent get equal heights", () => {
	const { herdr } = fakeHerdr();
	// The parent on the left; the three child panes in a column on the right, as Herdr splits them.
	const { requests, request } = fakeRequest({ type: "split", direction: "right", ratio: 0.4, first: pane("w1:p1"), second: down(pane("w1:p2"), down(pane("w1:p3"), pane("w1:p4"))) });
	const panes = new HerdrPanes("w1:p1", herdr, request);

	panes.sync(at("busy", run("aaa"), run("bbb"), run("ccc")));
	panes.sync(at("busy", run("aaa"), run("bbb"), run("ccc")));

	assert.deepEqual(requests, ["layout.export", "layout.set_split_ratio [true] 0.3333", "layout.set_split_ratio [true,true] 0.5000"]);
});

test("one child pane, or a layout that puts the parent in the column, is not resized", () => {
	const { herdr } = fakeHerdr();
	const one = fakeRequest(down(pane("w1:p1"), pane("w1:p2")));
	new HerdrPanes("w1:p1", herdr, one.request).sync(at("busy", run("aaa")));
	assert.deepEqual(one.requests, []);

	const mixed = fakeRequest(down(pane("w1:p2"), down(pane("w1:p1"), pane("w1:p3"))));
	new HerdrPanes("w1:p1", herdr, mixed.request).sync(at("busy", run("aaa"), run("bbb")));
	assert.deepEqual(mixed.requests, ["layout.export"]);
});
