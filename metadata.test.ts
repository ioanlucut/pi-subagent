import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readMetadata, removeRunDir, updateMetadata, writeMetadata, type RunMetadata } from "./shared.ts";

const shared = join(import.meta.dirname, "shared.ts");
let root: string;
let runDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psa-meta-"));
	// The session lock sits in the runs dir of the agent dir.
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	runDir = join(root, "agent", "subagents", "abc123");
	const now = new Date().toISOString();
	writeMetadata({ version: 1, handle: "abc123", tmuxSession: "s", runDir, sessionFile: join(runDir, "session.jsonl"), state: "busy", createdAt: now, updatedAt: now } as RunMetadata);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Node running `code` as a module, with `shared.ts` as `shared` and the run's directory as `runDir` in scope. */
function node(code: string) {
	const script = `const shared = await import(${JSON.stringify(shared)});\nconst runDir = ${JSON.stringify(runDir)};\n${code}`;
	return spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "inherit", "inherit"], env: process.env });
}

/**
 * Run `code` in two processes at once, with `name` set to `name` and `error`, and their exit codes. Both
 * programs have started before either runs `code`: a start takes about 1 s.
 */
async function racing(code: string): Promise<number[]> {
	const go = join(root, "go");
	const writers = ["name", "error"].map((name) =>
		node(`
			const { existsSync, writeFileSync } = await import("node:fs");
			const name = "${name}";
			writeFileSync(${JSON.stringify(root)} + "/" + name + ".ready", "");
			while (!existsSync(${JSON.stringify(go)})) {}
			${code}
		`),
	);
	const exits = writers.map(async (writer) => (writer.exitCode ?? (await once(writer, "exit"))[0]) as number);
	// A writer that ended early (an import error) never gets ready, so the wait ends then too.
	const ready = () => ["name", "error"].every((name) => existsSync(join(root, `${name}.ready`)));
	while (!ready() && writers.every((writer) => writer.exitCode === null)) await new Promise((resolve) => setTimeout(resolve, 20));
	writeFileSync(go, "");
	return Promise.all(exits);
}

test("two processes that update different fields of one run 100 times at once lose no update", async () => {
	// Each counts in its own field; a write from an older read sets the other's field back.
	const codes = await racing(`for (let i = 0; i < 100; i++) shared.updateMetadata(runDir, (run) => ({ [name]: String(Number(run[name] ?? 0) + 1) }));`);

	assert.deepEqual(codes, [0, 0]);
	const run = readMetadata(runDir);
	assert.deepEqual([run?.name, run?.error], ["100", "100"]);
});

test("two processes that count in one file 100 times each under the session lock lose no count", async () => {
	const counter = join(root, "counter");
	writeFileSync(counter, "0");
	const codes = await racing(`
		const fs = await import("node:fs");
		const counter = ${JSON.stringify(counter)};
		for (let i = 0; i < 100; i++) shared.withSessionLock("parent", () => fs.writeFileSync(counter, String(Number(fs.readFileSync(counter, "utf8")) + 1)));
	`);

	assert.deepEqual(codes, [0, 0]);
	assert.equal(readFileSync(counter, "utf8"), "200");
});

test("a run lock left by a process that died while it held it is taken over", () => {
	const holder = spawnSync(process.execPath, ["--input-type=module", "-e", `import { withRunLock } from ${JSON.stringify(shared)}; withRunLock(${JSON.stringify(runDir)}, () => process.exit(0));`]);
	assert.equal(existsSync(join(runDir, "metadata.lock")), true, "the lock is left behind");
	assert.equal(holder.status, 0, String(holder.stderr));

	const started = Date.now();
	assert.equal(updateMetadata(runDir, { state: "idle" })?.state, "idle");
	assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test("removing a run waits for an update in flight, which then ends without error", async () => {
	// An update that takes 1 s between its read and its write, as a slow one does.
	const ready = join(root, "ready");
	const writer = node(`
		const { writeFileSync } = await import("node:fs");
		shared.updateMetadata(runDir, () => {
			writeFileSync(${JSON.stringify(ready)}, "");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
			return { state: "idle" };
		});
	`);
	const exit = once(writer, "exit");
	while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 10));

	removeRunDir(runDir);

	assert.deepEqual(await exit, [0, null], "the update in flight ended without error");
	assert.equal(existsSync(runDir), false);
});

test("a removed run is not created again by an update", () => {
	rmSync(runDir, { recursive: true });

	assert.equal(updateMetadata(runDir, { state: "idle" }), undefined);
	assert.equal(existsSync(runDir), false);
});
