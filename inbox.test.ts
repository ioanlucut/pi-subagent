import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { InboxDelivery } from "./inbox.ts";
import { inboxDir, readMetadata, writeMetadata, type RunMetadata } from "./shared.ts";

let runDir: string;

beforeEach(() => {
	runDir = mkdtempSync(join(tmpdir(), "psa-inbox-"));
	mkdirSync(inboxDir(runDir));
	writeMetadata({ version: 1, handle: "abc123", tmuxSession: "s", runDir, sessionFile: join(runDir, "session.jsonl"), state: "idle" } as RunMetadata);
});

afterEach(() => rmSync(runDir, { recursive: true, force: true }));

function queue(name: string, message: string, delivery: "auto" | "followUp" | "interrupt" = "auto"): void {
	writeFileSync(join(inboxDir(runDir), `${name}.json`), JSON.stringify({ message, delivery }));
}

/** A fake child: records each message with its delivery mode. */
function child(idle: boolean) {
	const sent: string[] = [];
	return {
		sent,
		isIdle: () => idle,
		send: (message: string, deliverAs?: string) => void sent.push(`${deliverAs ?? "prompt"}:${message}`),
		abort: () => void sent.push("abort"),
	};
}

const pending = () => readdirSync(inboxDir(runDir)).sort();

test("an idle child gets one message as a prompt; the next waits until that run starts", () => {
	queue("1", "first");
	queue("2", "second");
	const inbox = new InboxDelivery(runDir);
	const idle = child(true);

	inbox.deliver(idle);
	inbox.deliver(idle);

	assert.deepEqual(idle.sent, ["prompt:first"]);
	assert.deepEqual(pending(), ["2.json"]);
	assert.equal(readMetadata(runDir)?.state, "busy");

	inbox.promptStarted();
	const busy = child(false);
	inbox.deliver(busy);

	assert.deepEqual(busy.sent, ["steer:second"]);
	assert.deepEqual(pending(), []);
});

test("a busy child gets every queued message in one pass, each with its delivery mode", () => {
	queue("1", "first");
	queue("2", "second", "followUp");
	const busy = child(false);

	new InboxDelivery(runDir).deliver(busy);

	assert.deepEqual(busy.sent, ["steer:first", "followUp:second"]);
	assert.deepEqual(pending(), []);
});

test("a prompt that never becomes a run stops blocking the inbox after 15 seconds", () => {
	queue("1", "first");
	queue("2", "second");
	const inbox = new InboxDelivery(runDir);
	const idle = child(true);

	inbox.deliver(idle, 1_000);
	inbox.deliver(idle, 15_999);
	assert.deepEqual(idle.sent, ["prompt:first"]);

	inbox.deliver(idle, 16_000);
	assert.deepEqual(idle.sent, ["prompt:first", "prompt:second"]);
});

test("a broken inbox file is removed and reported, and later messages still arrive", () => {
	writeFileSync(join(inboxDir(runDir), "1.json"), "{not json");
	queue("2", "second");
	const idle = child(true);

	new InboxDelivery(runDir).deliver(idle);

	assert.deepEqual(idle.sent, ["prompt:second"]);
	assert.deepEqual(pending(), []);
});

test("an interrupt ends a busy child's turn, and does nothing to an idle child", () => {
	queue("1", "", "interrupt");
	const busy = child(false);
	new InboxDelivery(runDir).deliver(busy);
	assert.deepEqual(busy.sent, ["abort"]);

	queue("2", "", "interrupt");
	const idle = child(true);
	new InboxDelivery(runDir).deliver(idle);
	assert.deepEqual(idle.sent, []);
	assert.deepEqual(pending(), []);
});
