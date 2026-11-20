import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LockBusyError, waitingAtMost, withLock } from "./lock.ts";

let root: string;
let lock: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psa-lock-"));
	lock = join(root, "x.lock");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Another process that takes the lock, says so, and holds it `ms`. */
async function holder(ms: number) {
	const ready = join(root, "ready");
	const code = `import { writeFileSync } from "node:fs"; import { withLock } from ${JSON.stringify(join(import.meta.dirname, "lock.ts"))};
		withLock(${JSON.stringify(lock)}, () => { writeFileSync(${JSON.stringify(ready)}, ""); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms}); });`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
	while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 10));
	return child;
}

test("a live holder that keeps the lock past 5 s keeps it; the waiter gives up after its time and runs nothing", async () => {
	const child = await holder(7000);
	let ran = false;

	const started = Date.now();
	assert.throws(() => withLock(lock, () => (ran = true)), LockBusyError);

	assert.ok(Date.now() - started >= 5500, `gave up after ${Date.now() - started} ms`);
	assert.equal(ran, false);
	assert.match(readFileSync(lock, "utf8"), new RegExp(`^${child.pid} `), "the holder still has its lock");
	await once(child, "exit");
	assert.equal(existsSync(lock), false, "the holder removed its own lock");
});

test("a lock whose holder is dead is taken over at once", async () => {
	const child = await holder(60_000);
	child.kill("SIGKILL");
	await once(child, "exit");
	assert.equal(existsSync(lock), true, "the lock is left behind");

	const started = Date.now();
	assert.equal(withLock(lock, () => "ran"), "ran");

	assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("a release does not remove a lock that another holder now owns", () => {
	const other = `${process.ppid} other`;

	withLock(lock, () => {
		// Another holder that took the lock while this one held it.
		unlinkSync(lock);
		writeFileSync(lock, other);
	});

	assert.equal(readFileSync(lock, "utf8"), other);
});

test("waitingAtMost limits the wait for a held lock", () => {
	writeFileSync(lock, `${process.ppid} other`);

	const started = Date.now();
	assert.throws(() => waitingAtMost(200, () => withLock(lock, () => {})), LockBusyError);

	const waited = Date.now() - started;
	assert.ok(waited >= 200 && waited < 400, `waited ${waited} ms`);
});
