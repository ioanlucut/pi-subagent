import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { RunMetadata, RunState } from "./shared.ts";
import { ActivityTracker, displayWidth, widgetLines, type RunActivity } from "./widget.ts";

let dir: string;
let sessionFile: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "psa-widget-"));
	sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (handle: string, name?: string, patch: Partial<RunMetadata> = {}) => ({ handle, name, sessionFile, ...patch }) as RunMetadata;

const entry = (message: Record<string, unknown>, timestamp = "2026-11-12T10:00:00.000Z") => `${JSON.stringify({ type: "message", id: "x", parentId: null, timestamp, message })}\n`;
const user = (timestamp: string) => entry({ role: "user", content: "Task" }, timestamp);
const assistant = (content: unknown[], output: number, cost: number) => entry({ role: "assistant", content, usage: { output, cost: { total: cost } } });
const toolCall = (name: string, args: Record<string, unknown>) => ({ type: "toolCall", name, arguments: args });

test("the tracker sums output tokens and cost, and keeps the last tool call and the turn start", () => {
	appendFileSync(sessionFile, user("2026-11-12T10:00:00.000Z"));
	appendFileSync(sessionFile, assistant([toolCall("read", { path: "/repo/a.ts" })], 100, 0.01));
	appendFileSync(sessionFile, assistant([toolCall("bash", { command: "npm test\necho done" })], 50, 0.02));

	const activity = new ActivityTracker().read(run("aaa"));

	assert.equal(activity.outputTokens, 150);
	assert.equal(activity.cost.toFixed(2), "0.03");
	assert.equal(activity.last, "bash npm test");
	assert.equal(activity.turnStartedAt, Date.parse("2026-11-12T10:00:00.000Z"));
});

test("the tracker reads only what was appended since its last read, and waits for a complete line", () => {
	const tracker = new ActivityTracker();
	const line = assistant([{ type: "text", text: "All good.\nDetails follow." }], 40, 0.5);
	appendFileSync(sessionFile, assistant([toolCall("grep", { pattern: "TODO" })], 10, 0.1) + line.slice(0, 30));

	assert.equal(tracker.read(run("aaa")).outputTokens, 10);
	assert.equal(tracker.read(run("aaa")).last, "grep TODO");

	appendFileSync(sessionFile, line.slice(30));
	const activity = tracker.read(run("aaa"));

	assert.equal(activity.outputTokens, 50);
	assert.equal(activity.last, "All good.");
});

test("the tracker starts again when the transcript is replaced by a shorter one", () => {
	const tracker = new ActivityTracker();
	appendFileSync(sessionFile, assistant([toolCall("read", { path: "a" })], 100, 1) + assistant([toolCall("read", { path: "b" })], 100, 1));
	assert.equal(tracker.read(run("aaa")).outputTokens, 200);

	writeFileSync(sessionFile, assistant([{ type: "text", text: "New." }], 7, 0.1));

	assert.equal(tracker.read(run("aaa")).outputTokens, 7);
});

/** A theme that marks colors, so a test sees which part got which color. */
const theme = { fg: (color: string, text: string) => (text ? `<${color}>${text}</>` : "") };
const plain = { fg: (_color: string, text: string) => text };
const row = (handle: string, state: RunState, activity: Partial<RunActivity> = {}, name?: string, patch: Partial<RunMetadata> = {}) => ({
	run: run(handle, name, patch),
	state,
	activity: { outputTokens: 0, cost: 0, ...activity },
});

test("each child gets one row: state, name, time in this turn, last action, tokens and cost", () => {
	const now = Date.parse("2026-11-12T10:01:05.000Z");
	const lines = widgetLines(
		[
			row("aaa111", "busy", { outputTokens: 12_400, cost: 0.416, last: "bash npm test", turnStartedAt: now - 65_000 }, "review-spec"),
			row("bbb222", "idle", { outputTokens: 900, cost: 0.02, last: "No findings.", turnStartedAt: now - 300_000 }, "standards"),
			row("ccc333", "error", {}, undefined, { error: "No API key" }),
		],
		plain,
		60,
		now,
	);

	assert.deepEqual(lines, [
		"⟳ review-spec  1m05s  bash npm test               ↓12k $0.42",
		"✓ standards           No findings.                ↓900 $0.02",
		"✗ ccc333              No API key                    ↓0 $0.00",
	]);
	assert.deepEqual(lines.map((line) => line.length), [60, 60, 60]);
});

test("a row never exceeds the width: the last action is cut, the totals stay", () => {
	const lines = widgetLines([row("aaa111", "busy", { last: "bash ".padEnd(200, "x"), outputTokens: 1_500_000, cost: 12 }, "a-very-long-child-name-that-goes-on-and-on")], plain, 70, 0);

	assert.equal(lines[0].length, 70);
	assert.match(lines[0], /^⟳ a-very-long-child-name-… {9}bash x+… ↓1\.5M \$12\.00$/);
});

test("the state decides the icon color, and more than five children are counted", () => {
	const rows = ["a", "b", "c", "d", "e", "f", "g"].map((handle) => row(handle, "starting"));

	const lines = widgetLines(rows, theme, 40, 0);

	assert.equal(lines.length, 6);
	assert.match(lines[0], /^<muted>◌<\/> a {9}<muted>starting/);
	assert.equal(lines[5], "<dim>+2 more · /subagent to attach</>");
	assert.match(widgetLines([row("a", "busy")], theme, 40, 0)[0], /^<warning>⟳<\/>/);
	assert.deepEqual(widgetLines([], theme, 40, 0), []);
});

test("display width counts wide characters and emoji as two columns, and the row icons as one", () => {
	assert.equal(displayWidth("ab"), 2);
	assert.equal(displayWidth("レビュー"), 8);
	assert.equal(displayWidth("🚀"), 2);
	assert.equal(displayWidth("⟳◌✓✗■…↓"), 7);
});

test("a row with wide characters is as wide as any other row", () => {
	const lines = widgetLines(
		[row("aaa111", "busy", { last: "bash echo 日本語のテキスト 🚀🚀🚀 and more text" }, "レビュー"), row("bbb222", "idle", { last: "ok" }, "ascii")],
		plain,
		50,
		0,
	);

	assert.deepEqual(lines.map(displayWidth), [50, 50]);
});
