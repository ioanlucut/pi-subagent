import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	listRuns,
	processStartTime,
	readMetadata,
	resumeSuspendedRuns,
	suspendOrphanedRuns,
	suspendRuns,
	tmuxSessionExists,
} from "./shared.ts";

const cli = join(import.meta.dirname, "subagent.ts");
// PATH entries the CLI itself needs: tmux and the system tools.
const basePath = `${dirname(spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout.trim())}:/usr/bin:/bin`;

let root: string;

// Each test gets its own tmux server (TMUX_TMPDIR) and agent dir, so no real session is touched.
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psa-"));
	process.env.TMUX_TMPDIR = join(root, "tmux");
	mkdirSync(process.env.TMUX_TMPDIR);
	delete process.env.TMUX;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});

afterEach(() => {
	spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
	rmSync(root, { recursive: true, force: true });
});

/** Write an executable `pi` that records what it received, then stays alive like a real child. */
function fakePi(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const script = join(dir, "pi");
	writeFileSync(
		script,
		// Node, like pi: a shell would reset PWD itself and hide what the launcher passed.
		`#!${process.execPath}\nconst { join } = require("node:path");\nrequire("node:fs").writeFileSync(join(process.env.PI_SUBAGENT_RUN_DIR, "probe"), Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n") + "\\n");\nsetInterval(() => {}, 1000);\n`,
	);
	chmodSync(script, 0o755);
	return dir;
}

/** Start the tmux server from an environment the later spawn must not inherit. */
function startTmuxServer(env: NodeJS.ProcessEnv): void {
	const result = spawnSync("tmux", ["new-session", "-d", "-s", "server"], { env: { ...process.env, ...env } });
	assert.equal(result.status, 0, String(result.error ?? result.stderr));
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
	return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

/** The environment the fake `pi` saw, once it has written it. */
async function childEnv(agentDir: string, timeoutMs = 5000): Promise<Map<string, string>> {
	const path = join(onlyRunDir(agentDir), "probe");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = existsSync(path) ? readFileSync(path, "utf8") : "";
		if (text.endsWith("\n")) return new Map(text.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]));
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	assert.fail(`Timed out waiting for ${path}`);
}

function onlyRunDir(agentDir: string): string {
	const runs = join(agentDir, "subagents");
	const handles = spawnSync("ls", [runs], { encoding: "utf8" }).stdout.trim().split("\n");
	assert.equal(handles.length, 1);
	return join(runs, handles[0]);
}

/** Spawn `count` children through the CLI into the agent dir this process uses. */
function spawnChildren(count: number, env: NodeJS.ProcessEnv = {}): void {
	const bin = fakePi(join(root, "bin"));
	for (let i = 0; i < count; i++) {
		const result = runCli(["spawn", "--cwd", root, "--prompt", "hi"], { ...spawnEnv(agentDir(), bin), ...env });
		assert.equal(result.status, 0, result.stderr);
	}
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR as string;
}

const spawnEnv = (agentDir: string, bin: string): NodeJS.ProcessEnv => ({
	PATH: `${bin}:${basePath}`,
	PI_CODING_AGENT_DIR: agentDir,
	PI_PROVIDER: "test",
	PI_MODEL: "test",
	PI_SUBAGENT_RUN_DIR: "",
});

test("spawn gives the child the caller's agent dir, not the tmux server's", async () => {
	startTmuxServer({ PATH: basePath, PI_CODING_AGENT_DIR: join(root, "stale-agent") });
	const agentDir = join(root, "agent");

	const result = runCli(["spawn", "--cwd", root, "--prompt", "hi"], spawnEnv(agentDir, fakePi(join(root, "bin"))));

	assert.equal(result.status, 0, result.stderr);
	assert.equal((await childEnv(agentDir)).get("PI_CODING_AGENT_DIR"), agentDir);
});

test("spawn gives the child the caller's environment, not the tmux server's", async () => {
	startTmuxServer({ AWS_PROFILE: "stale", SERVER_ONLY: "1" });
	const agentDir = join(root, "agent");

	const result = runCli(["spawn", "--cwd", root, "--prompt", "hi"], {
		...spawnEnv(agentDir, fakePi(join(root, "bin"))),
		AWS_PROFILE: "caller",
	});

	assert.equal(result.status, 0, result.stderr);
	const env = await childEnv(agentDir);
	assert.equal(env.get("AWS_PROFILE"), "caller");
	assert.equal(env.get("SERVER_ONLY"), undefined);
	assert.ok(env.get("TMUX"), "the child still knows it runs in tmux");
});

test("spawn starts the child when the caller exports a variable the shell treats as readonly", async () => {
	const result = runCli(["spawn", "--cwd", root, "--prompt", "hi"], {
		...spawnEnv(agentDir(), fakePi(join(root, "bin"))),
		SHELLOPTS: "braceexpand",
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal((await childEnv(agentDir())).get("SHELLOPTS"), "braceexpand");
});

test("spawn starts the child when the tmux server has a NODE_OPTIONS that breaks node", async () => {
	startTmuxServer({ NODE_OPTIONS: `--require=${join(root, "deleted.cjs")}` });

	const result = runCli(["spawn", "--cwd", root, "--prompt", "hi"], spawnEnv(agentDir(), fakePi(join(root, "bin"))));

	assert.equal(result.status, 0, result.stderr);
	assert.equal((await childEnv(agentDir())).get("NODE_OPTIONS"), undefined);
});

test("spawn finds pi through an empty PATH entry, which means the working directory", async () => {
	fakePi(root);

	const result = runCli(["spawn", "--cwd", root, "--prompt", "hi"], {
		...spawnEnv(agentDir(), "/nonexistent"),
		PATH: `:${basePath}`,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.ok(await childEnv(agentDir()));
});

test("spawn gives the child its own working directory in PWD, not the caller's", async () => {
	const childCwd = join(root, "child-cwd");
	mkdirSync(childCwd);

	const result = runCli(["spawn", "--cwd", childCwd, "--prompt", "hi"], {
		...spawnEnv(agentDir(), fakePi(join(root, "bin"))),
		PWD: root,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal((await childEnv(agentDir())).get("PWD"), childCwd);
});

test("a failed relaunch leaves no launch file with the caller's environment behind", async () => {
	spawnChildren(1, { PI_SESSION_ID: "parent-session" });
	const [run] = listRuns();
	await suspendRuns([run]);
	const failingTmux = join(root, "failing-tmux");
	mkdirSync(failingTmux);
	writeFileSync(join(failingTmux, "tmux"), "#!/bin/sh\necho 'no server' >&2\nexit 1\n", { mode: 0o755 });
	const path = process.env.PATH;
	process.env.PATH = `${failingTmux}:${basePath}`;
	const errors: string[] = [];

	try {
		resumeSuspendedRuns("parent-session", (_run, message) => errors.push(message));
	} finally {
		process.env.PATH = path;
	}

	assert.deepEqual(errors, ["no server"]);
	assert.equal(existsSync(join(run.runDir, "launch.json")), false);
});

test("suspendRuns stops all children at the same time", async () => {
	spawnChildren(3);
	const runs = listRuns();
	// The fake child never reports "exited", so each stop waits for the full 2 s shutdown timeout.
	const started = Date.now();

	await suspendRuns(runs);

	assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
	for (const run of runs) {
		assert.equal(tmuxSessionExists(run.tmuxSession), false);
		assert.equal(readMetadata(run.runDir)?.suspended, true);
	}
});

/** A process ID that no process uses: a child that has already exited. */
function deadPid(): number {
	const child = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
	return Number(child.stdout.trim());
}

test("suspendOrphanedRuns suspends only children whose parent process is gone", async () => {
	spawnChildren(1, { PI_SUBAGENT_PARENT_PID: String(deadPid()) });
	spawnChildren(1, {
		PI_SUBAGENT_PARENT_PID: String(process.pid),
		PI_SUBAGENT_PARENT_STARTED: processStartTime(process.pid),
	});
	const live = listRuns().find((run) => run.parentPid === process.pid)!;
	const orphan = listRuns().find((run) => run.parentPid !== process.pid)!;

	await suspendOrphanedRuns();

	assert.equal(tmuxSessionExists(orphan.tmuxSession), false);
	assert.equal(readMetadata(orphan.runDir)?.suspended, true);
	assert.equal(tmuxSessionExists(live.tmuxSession), true);
	assert.equal(readMetadata(live.runDir)?.suspended, undefined);
});

test("a resumed orphan belongs to the new parent, so the next sweep leaves it running", async () => {
	spawnChildren(1, { PI_SUBAGENT_PARENT_PID: String(deadPid()), PI_SESSION_ID: "parent-session" });
	await suspendOrphanedRuns();

	resumeSuspendedRuns("parent-session", (_run, error) => assert.fail(error));
	await suspendOrphanedRuns();

	const [run] = listRuns();
	assert.equal(run.parentPid, process.pid);
	assert.equal(tmuxSessionExists(run.tmuxSession), true);
});

test("suspendOrphanedRuns treats a reused parent process ID as a dead parent", async () => {
	// This test process is alive, but it is not the process that spawned the child: its start time differs.
	spawnChildren(1, { PI_SUBAGENT_PARENT_PID: String(process.pid), PI_SUBAGENT_PARENT_STARTED: "Thu Jan  1 00:00:00 1970" });
	const [run] = listRuns();

	await suspendOrphanedRuns();

	assert.equal(tmuxSessionExists(run.tmuxSession), false);
	assert.equal(readMetadata(run.runDir)?.suspended, true);
});

/** Run `body` with some process.env values replaced, then restore them. */
async function withEnv(env: NodeJS.ProcessEnv, body: () => Promise<void> | void): Promise<void> {
	const saved = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
	Object.assign(process.env, env);
	try {
		await body();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("a live parent stays the parent when the sweeping Pi uses another time zone", async () => {
	let started: string | undefined;
	await withEnv({ TZ: "Asia/Tokyo" }, () => {
		started = processStartTime(process.pid);
	});
	spawnChildren(1, { PI_SUBAGENT_PARENT_PID: String(process.pid), PI_SUBAGENT_PARENT_STARTED: started });
	const [run] = listRuns();

	await withEnv({ TZ: "America/New_York" }, () => suspendOrphanedRuns());

	assert.equal(tmuxSessionExists(run.tmuxSession), true);
});

test("a parent whose state ps cannot report is not treated as dead", async () => {
	spawnChildren(1, {
		PI_SUBAGENT_PARENT_PID: String(process.pid),
		PI_SUBAGENT_PARENT_STARTED: processStartTime(process.pid),
	});
	const [run] = listRuns();
	const brokenPs = join(root, "broken-ps");
	mkdirSync(brokenPs);
	writeFileSync(join(brokenPs, "ps"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });

	await withEnv({ PATH: `${brokenPs}:${basePath}` }, () => suspendOrphanedRuns());

	assert.equal(tmuxSessionExists(run.tmuxSession), true);
});
