import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pendingResults, reportExitedRuns, reportSettledTurn } from "./outbox.ts";
import { resumeSuspendedRuns, startQueuedRuns, stopTimedOutRuns } from "./queue.ts";
import { runSubagentTool, TOOL_ACTIONS } from "./tool.ts";
import {
	claimRunDir,
	effectiveRunState,
	guarded,
	getRunsDir,
	listRuns,
	processStartTime,
	pruneStaleRuns,
	readMetadata,
	removeRunDir,
	suspendOrphanedRuns,
	suspendSessionRuns,
	suspendRuns,
	tmuxSessionExists,
	updateMetadata,
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
	// The caller's own NODE_OPTIONS would reach the child and hide what the tests check.
	delete process.env.NODE_OPTIONS;
	// Set when the tests run from a Pi that delivers results; each test chooses it for itself.
	delete process.env.PI_SUBAGENT_NOTIFY;
	delete process.env.PI_SUBAGENT_QUEUE;
	delete process.env.PI_SUBAGENT_LIMIT;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});

afterEach(() => {
	spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
	// A child that tmux has not ended yet can still write a file (a lock) while the remove runs.
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * Write an executable `pi` that records what it received and, like a real child, holds its FIFO and records
 * its process ID through `updateMetadata`, then stays alive.
 */
function fakePi(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const script = join(dir, "pi");
	writeFileSync(
		script,
		// Node, like pi: a shell would reset PWD itself and hide what the launcher passed.
		`#!${process.execPath}\nconst { join } = require("node:path");\nconst fs = require("node:fs");\nconst { updateMetadata } = require(${JSON.stringify(join(import.meta.dirname, "shared.ts"))});\nconst fifo = join(process.env.PI_SUBAGENT_RUN_DIR, "alive");\nif (!fs.existsSync(fifo)) require("node:child_process").spawnSync("mkfifo", [fifo]);\nfs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);\nupdateMetadata(process.env.PI_SUBAGENT_RUN_DIR, { childPid: process.pid });\nrequire("node:fs").writeFileSync(join(process.env.PI_SUBAGENT_RUN_DIR, "argv"), JSON.stringify(process.argv.slice(2)));\nrequire("node:fs").writeFileSync(join(process.env.PI_SUBAGENT_RUN_DIR, "probe"), Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n") + "\\n");\nsetInterval(() => {}, 1000);\n`,
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

/** The arguments the fake `pi` got, once it has started. */
async function childArgs(agentDir: string): Promise<string[]> {
	await childEnv(agentDir);
	return JSON.parse(readFileSync(join(onlyRunDir(agentDir), "argv"), "utf8")) as string[];
}

/** The values of each `--extension` flag, in order. */
function extensionFlags(args: string[]): string[] {
	return args.flatMap((arg, i) => (arg === "--extension" ? [args[i + 1]] : []));
}

function onlyRunDir(agentDir: string): string {
	const runs = join(agentDir, "subagents");
	const handles = spawnSync("ls", [runs], { encoding: "utf8" }).stdout.trim().split("\n");
	assert.equal(handles.length, 1);
	return join(runs, handles[0]);
}

/** Spawn `count` children through the CLI into the agent dir this process uses. */
function spawnChildren(count: number, env: NodeJS.ProcessEnv = {}, args: string[] = []): void {
	const bin = fakePi(join(root, "bin"));
	for (let i = 0; i < count; i++) {
		const result = runCli(["spawn", "--cwd", root, ...args, "--prompt", "hi"], { ...spawnEnv(agentDir(), bin), ...env });
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
	PI_SUBAGENT_NESTED: "",
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
	assert.equal(readMetadata(run.runDir)?.suspended, true, "still suspended, so the next resume tries it again");
});

test("suspendRuns stops all children at the same time", async () => {
	spawnChildren(3);
	const runs = listRuns();
	// The fake child never reports "exited", so each stop waits for the full 2 s shutdown timeout:
	// one by one takes at least 3 × 2 s, at the same time about 2 s plus a loaded machine's overhead.
	const started = Date.now();

	await suspendRuns(runs);

	assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
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

test("suspendOrphanedRuns still suspends a run of an older version, with no child process ID and no parent start time", async () => {
	spawnChildren(1, { PI_SUBAGENT_PARENT_PID: String(deadPid()) });
	const [run] = listRuns();
	updateMetadata(run.runDir, { childPid: undefined, parentStarted: undefined });

	await suspendOrphanedRuns();

	assert.equal(tmuxSessionExists(run.tmuxSession), false);
	assert.equal(readMetadata(run.runDir)?.suspended, true);
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

test("a resumed child is starting, not exited, before its new process records its ID", async () => {
	spawnChildren(1, { PI_SESSION_ID: "parent-session" });
	const [run] = listRuns();
	updateMetadata(run.runDir, { childPid: deadPid() });
	await suspendRuns([run]);

	resumeSuspendedRuns("parent-session", (_run, error) => assert.fail(error));

	assert.equal(effectiveRunState(listRuns()[0]), "starting");
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

/** An idle child whose transcript ends with `message`, as `wait` finds it after the turn. */
function idleRun(message: Record<string, unknown>): string {
	startTmuxServer({ PATH: basePath });
	const handle = "abc123";
	const runDir = join(agentDir(), "subagents", handle);
	mkdirSync(runDir, { recursive: true });
	const sessionFile = join(runDir, "session.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "assistant", ...message } })}\n`);
	writeFileSync(
		join(runDir, "metadata.json"),
		JSON.stringify({ version: 1, handle, tmuxSession: "server", runDir, sessionFile, parentSessionId: "parent", state: "idle", hasStarted: true }),
	);
	return handle;
}

test("wait reports a turn that ended in a provider error as failed, not finished", () => {
	const handle = idleRun({ content: [], stopReason: "error", errorMessage: "OAuth refresh failed for anthropic" });
	const result = runCli(["wait", handle], {});
	assert.equal(result.status, 1);
	assert.match(result.stdout, /^abc123 failed \(error\)\n\nOAuth refresh failed for anthropic\n$/);
});

test("wait reports a completed turn as finished", () => {
	const handle = idleRun({ content: [{ type: "text", text: "All good." }], stopReason: "stop" });
	const result = runCli(["wait", handle], {});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "abc123 finished\n\nAll good.\n");
});

/** A run directory with no live child, last updated `ageDays` ago. */
function storedRun(handle: string, ageDays: number, tmuxSession = `pi-subagent-${handle}`): string {
	const runDir = join(agentDir(), "subagents", handle);
	mkdirSync(runDir, { recursive: true });
	const updatedAt = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
	writeFileSync(
		join(runDir, "metadata.json"),
		JSON.stringify({ version: 1, handle, tmuxSession, runDir, sessionFile: join(runDir, "session.jsonl"), state: "exited", suspended: true, createdAt: updatedAt, updatedAt }),
	);
	return runDir;
}

test("pruneStaleRuns removes runs with no live child that are older than 14 days", () => {
	const stale = storedRun("old111", 15);
	const recent = storedRun("new222", 13);

	pruneStaleRuns();

	assert.equal(existsSync(stale), false);
	assert.equal(existsSync(recent), true);
});

test("pruneStaleRuns keeps an old run whose child still runs", () => {
	startTmuxServer({ PATH: basePath });
	const live = storedRun("old333", 30, "server");

	pruneStaleRuns();

	assert.equal(existsSync(live), true);
});

test("a child claims its run for its own process: a Pi started from its tools has no run and cannot spawn", () => {
	const state = globalThis as { piSubagentRunDir?: string };
	process.env.PI_SUBAGENT_RUN_DIR = "/runs/abc123";
	try {
		assert.equal(claimRunDir(), "/runs/abc123");
		assert.equal(process.env.PI_SUBAGENT_RUN_DIR, undefined);
		assert.equal(claimRunDir(), "/runs/abc123", "a reload in the same process keeps the run");

		// A process started from the child's tools inherits this environment, without the run.
		const nested = runCli(["spawn", "--cwd", root, "--prompt", "hi"], { PI_PROVIDER: "test", PI_MODEL: "test" });
		assert.equal(nested.status, 1);
		assert.match(nested.stderr, /Nested subagents are disabled/);
		delete state.piSubagentRunDir;
		assert.equal(claimRunDir(), undefined);
	} finally {
		delete state.piSubagentRunDir;
		delete process.env.PI_SUBAGENT_RUN_DIR;
		delete process.env.PI_SUBAGENT_NESTED;
	}
});

test("wait takes the result with it, so the parent is not told a second time", () => {
	const handle = idleRun({ content: [{ type: "text", text: "All good." }], stopReason: "stop" });
	const [run] = listRuns();
	reportSettledTurn(run.runDir);
	assert.equal(pendingResults([run])?.files.length, 1);

	const result = runCli(["wait", handle], {});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(pendingResults([run]), undefined);
});

test("spawn tells the agent not to wait only when the parent delivers results", () => {
	const bin = fakePi(join(root, "bin"));
	const quiet = runCli(["spawn", "--cwd", root, "--prompt", "hi"], spawnEnv(agentDir(), bin));
	const notified = runCli(["spawn", "--cwd", root, "--prompt", "hi"], { ...spawnEnv(agentDir(), bin), PI_SUBAGENT_NOTIFY: "1", PI_SESSION_ID: "parent" });

	assert.doesNotMatch(quiet.stdout, /Result:/);
	assert.match(notified.stdout, /\nResult: arrives as a message when the turn ends\. Do not run `subagent wait`\.\n$/);
});

/** A tmux session started the way `startLaunch` starts a child, for the run directory `runDir`. */
function childSession(name: string, runDir: string): void {
	const result = spawnSync("tmux", ["new-session", "-d", "-s", name, "--", "/bin/sh", "-c", "sleep 60", "launch", join(runDir, "launch.json")]);
	assert.equal(result.status, 0, String(result.stderr));
}

test("a child session whose run directory is gone is ended; others are left alone", async () => {
	startTmuxServer({ PATH: basePath });
	const live = join(getRunsDir(), "aaa111");
	mkdirSync(live, { recursive: true });
	childSession("pi-subagent-aaa111", live);
	childSession("pi-subagent-bbb222", join(getRunsDir(), "bbb222"));
	// Another Pi profile keeps its runs in another agent dir; its live child is not an orphan.
	const otherProfile = join(root, "other-agent", "subagents", "ccc333");
	mkdirSync(otherProfile, { recursive: true });
	childSession("pi-subagent-ccc333", otherProfile);

	await suspendOrphanedRuns();

	assert.equal(tmuxSessionExists("pi-subagent-aaa111"), true);
	assert.equal(tmuxSessionExists("pi-subagent-bbb222"), false);
	assert.equal(tmuxSessionExists("pi-subagent-ccc333"), true);
	assert.equal(tmuxSessionExists("server"), true);
});

test("an executable pi-test.sh in the working directory does not replace pi", async () => {
	writeFileSync(join(root, "pi-test.sh"), `#!/bin/sh\ntouch "${join(root, "ran-pi-test")}"\nsleep 60\n`, { mode: 0o755 });

	spawnChildren(1);

	await childEnv(agentDir());
	assert.equal(existsSync(join(root, "ran-pi-test")), false);
});

test("PI_SUBAGENT_PI names the program the child runs in place of pi", async () => {
	const other = fakePi(join(root, "other"));
	const result = runCli(["spawn", "--cwd", root, "--prompt", "hi"], {
		...spawnEnv(agentDir(), join(root, "no-pi-here")),
		PI_SUBAGENT_PI: join(other, "pi"),
	});

	assert.equal(result.status, 0, result.stderr);
	assert.ok((await childEnv(agentDir())).get("PATH"), "the program ran");
});

/** A run directory whose transcript has a session header for `cwd` and one answer. */
function transcriptRun(handle: string, cwd: string): string {
	const runDir = join(agentDir(), "subagents", handle);
	mkdirSync(runDir, { recursive: true });
	const sessionFile = join(runDir, "session.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: "2026-11-12T10:00:00.123Z", cwd })}\n` +
			`${JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "Done." }] } })}\n`,
	);
	writeFileSync(join(runDir, "metadata.json"), JSON.stringify({ version: 1, handle, tmuxSession: `pi-subagent-${handle}`, runDir, sessionFile, cwd }));
	return runDir;
}

test("removing a run moves its transcript into Pi's sessions, where `pi --resume` lists it", () => {
	const runDir = transcriptRun("tra111", "/repo/my-app");
	const transcript = readFileSync(join(runDir, "session.jsonl"), "utf8");

	const kept = removeRunDir(runDir);

	assert.equal(kept, join(agentDir(), "sessions", "--repo-my-app--", "2026-11-12T10-00-00-123Z_child-session.jsonl"));
	assert.equal(readFileSync(kept, "utf8"), transcript);
	assert.equal(existsSync(runDir), false);
});

test("a run with no answer in its transcript leaves nothing in Pi's sessions", () => {
	const runDir = transcriptRun("tra222", "/repo/my-app");
	writeFileSync(join(runDir, "session.jsonl"), readFileSync(join(runDir, "session.jsonl"), "utf8").split("\n")[0] + "\n");

	assert.equal(removeRunDir(runDir), undefined);
	assert.equal(existsSync(join(agentDir(), "sessions")), false);
});

test("stop prints where the transcript went", () => {
	transcriptRun("tra333", "/repo/my-app");

	const result = runCli(["stop", "tra333"], {});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^Stopped tra333\nTranscript: .*--repo-my-app--\/2026-11-12T10-00-00-123Z_child-session\.jsonl \(`pi --resume` in \/repo\/my-app\)\n$/);
});

test("after stop, the answer file named in the parent's message still exists, beside the kept transcript", () => {
	const runDir = transcriptRun("tra444", "/repo/my-app");
	updateMetadata(runDir, { parentSessionId: "parent" });
	reportSettledTurn(runDir);
	const [run] = listRuns("parent");
	const file = /\[The whole answer: (\S+)\]$/.exec(pendingResults([run])?.text ?? "")?.[1];

	const result = runCli(["stop", "tra444"], {});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(file, join(agentDir(), "sessions", "--repo-my-app--", "2026-11-12T10-00-00-123Z_child-session.answers", basename(file ?? "")));
	assert.equal(readFileSync(file ?? "", "utf8"), "Done.");
});

test("last prints the latest answer and the state, without waiting", () => {
	const handle = idleRun({ content: [{ type: "text", text: "All good." }], stopReason: "stop" });
	const [run] = listRuns();
	updateMetadata(run.runDir, { state: "busy" });

	const result = runCli(["last", handle], {});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "abc123 busy\n\nAll good.\n");
});

test("last prints a long answer whole, not the summary the parent got", () => {
	const text = "y".repeat(10_000);
	const handle = idleRun({ content: [{ type: "text", text }], stopReason: "stop" });

	const result = runCli(["last", handle], {});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `abc123 idle\n\n${text}\n`);
});

test("interrupt queues an interrupt for a busy child, and tells that an idle child has nothing to stop", () => {
	const handle = idleRun({ content: [], stopReason: "stop" });
	const [run] = listRuns();

	assert.equal(runCli(["interrupt", handle], {}).stdout, "abc123 is idle: nothing to interrupt\n");

	updateMetadata(run.runDir, { state: "busy" });
	const result = runCli(["interrupt", handle], {});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "Interrupting abc123. Its turn ends as failed (aborted).\n");
	const [file] = readdirSync(join(run.runDir, "inbox"));
	assert.deepEqual(JSON.parse(readFileSync(join(run.runDir, "inbox", file), "utf8")), { message: "", delivery: "interrupt" });
});

/** Install a fake command guard where `pi install npm:cc-safety-net` puts it, and list it in Pi's packages. */
function installGuard(): string {
	const guard = join(agentDir(), "npm", "node_modules", "cc-safety-net");
	mkdirSync(guard, { recursive: true });
	writeFileSync(join(agentDir(), "settings.json"), JSON.stringify({ packages: ["npm:cc-safety-net@2.7.15"] }));
	return guard;
}

test("spawn --extensions passes a command guard that Pi's packages list as a local path", async () => {
	const guard = join(root, "checkouts", "cc-safety-net");
	mkdirSync(guard, { recursive: true });
	mkdirSync(agentDir());
	writeFileSync(join(agentDir(), "settings.json"), JSON.stringify({ packages: ["npm:other", { source: "../checkouts/cc-safety-net" }] }));

	const result = runCli(["spawn", "--cwd", root, "--extensions", "/ext/a.ts", "--prompt", "hi"], spawnEnv(agentDir(), fakePi(join(root, "bin"))));

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.deepEqual(extensionFlags(await childArgs(agentDir())), [join(import.meta.dirname, "index.ts"), guard, "/ext/a.ts"]);
});

test("spawn --extensions warns when Pi's packages have no command guard, and starts the child", async () => {
	const result = runCli(["spawn", "--cwd", root, "--extensions", "/ext/a.ts", "--prompt", "hi"], spawnEnv(agentDir(), fakePi(join(root, "bin"))));

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "Warning: the command guard cc-safety-net is not installed in Pi's packages; the child runs without it\n");
	assert.deepEqual(extensionFlags(await childArgs(agentDir())), [join(import.meta.dirname, "index.ts"), "/ext/a.ts"]);
});

test("spawn --extensions loads only the listed extensions, this extension, and the command guard", async () => {
	const guard = installGuard();
	const result = runCli(
		["spawn", "--cwd", root, "--extensions", "/ext/a.ts,npm:b", "--prompt", "hi"],
		spawnEnv(agentDir(), fakePi(join(root, "bin"))),
	);

	assert.equal(result.status, 0, result.stderr);
	const args = await childArgs(agentDir());
	assert.ok(args.includes("--no-extensions"));
	assert.deepEqual(extensionFlags(args), [join(import.meta.dirname, "index.ts"), guard, "/ext/a.ts", "npm:b"]);
});

test("spawn --extensions drops the command guard only when the list names -cc-safety-net", async () => {
	installGuard();
	const result = runCli(
		["spawn", "--cwd", root, "--extensions", "/ext/a.ts,-cc-safety-net", "--prompt", "hi"],
		spawnEnv(agentDir(), fakePi(join(root, "bin"))),
	);

	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(extensionFlags(await childArgs(agentDir())), [join(import.meta.dirname, "index.ts"), "/ext/a.ts"]);
});

test("spawn --no-mcp starts the child with no MCP servers", async () => {
	const result = runCli(["spawn", "--cwd", root, "--no-mcp", "--prompt", "hi"], spawnEnv(agentDir(), fakePi(join(root, "bin"))));

	assert.equal(result.status, 0, result.stderr);
	assert.ok((await childArgs(agentDir())).includes("--no-mcp"));
});

test("a suspended light child relaunches with the same flags", async () => {
	installGuard();
	const bin = fakePi(join(root, "bin"));
	const result = runCli(
		["spawn", "--cwd", root, "--extensions", "/ext/a.ts", "--no-mcp", "--prompt", "hi"],
		{ ...spawnEnv(agentDir(), bin), PI_SESSION_ID: "parent-session" },
	);
	assert.equal(result.status, 0, result.stderr);
	const first = await childArgs(agentDir());
	const [run] = listRuns();
	await suspendRuns([run]);
	rmSync(join(run.runDir, "probe"));

	await withEnv({ PATH: `${bin}:${basePath}` }, () =>
		resumeSuspendedRuns("parent-session", (_run, error) => assert.fail(error)),
	);

	const relaunched = await childArgs(agentDir());
	assert.deepEqual(extensionFlags(relaunched), extensionFlags(first));
	assert.ok(relaunched.includes("--no-extensions"));
	assert.ok(relaunched.includes("--no-mcp"));
});

test("a child with no new flags starts as today: all extensions and MCP servers", async () => {
	installGuard();
	spawnChildren(1);

	const args = await childArgs(agentDir());
	assert.equal(args.includes("--no-extensions"), false);
	assert.equal(args.includes("--no-mcp"), false);
	assert.deepEqual(extensionFlags(args), []);
});

/** A Git repository named `repo` with one commit on `main`, and the home that holds its worktrees. */
function gitRepo(): { repo: string; home: string } {
	const home = join(root, "home");
	const repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	const git = (...args: string[]) => {
		const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
		assert.equal(result.status, 0, result.stderr);
	};
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git("add", "a.txt");
	git("commit", "-q", "-m", "init");
	git("checkout", "-q", "-b", "other");
	return { repo, home };
}

function gitOut(cwd: string, ...args: string[]): string {
	return spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();
}

test("spawn --worktree creates the worktree on a new branch from --base and starts the child in it", async () => {
	const { repo, home } = gitRepo();
	const worktree = join(home, "WORK", "dev", ".worktrees", "repo", "t1");

	const result = runCli(["spawn", "--cwd", repo, "--worktree", "t1", "--base", "main", "--prompt", "hi"], {
		...spawnEnv(agentDir(), fakePi(join(root, "bin"))),
		HOME: home,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, new RegExp(`\nWorktree: ${worktree} \\(branch t1\\)\n`));
	assert.equal(gitOut(worktree, "branch", "--show-current"), "t1");
	assert.equal(gitOut(worktree, "rev-parse", "HEAD"), gitOut(repo, "rev-parse", "main"));
	assert.equal((await childEnv(agentDir())).get("PWD"), worktree);
});

test("spawn --worktree reuses a clean worktree of the same branch, and refuses one with other work", () => {
	const { repo, home } = gitRepo();
	const worktree = join(home, "WORK", "dev", ".worktrees", "repo", "t1");
	const env = { ...spawnEnv(agentDir(), fakePi(join(root, "bin"))), HOME: home };
	const spawn = () => runCli(["spawn", "--cwd", repo, "--worktree", "t1", "--prompt", "hi"], env);
	assert.equal(spawn().status, 0);
	assert.equal(spawn().status, 0, "a clean worktree of the same branch is reused");
	writeFileSync(join(worktree, "wip.txt"), "work\n");

	const result = spawn();

	assert.equal(result.status, 1);
	assert.match(result.stderr, /has other work/);
	assert.equal(listRuns().length, 2, "no third child");
	assert.equal(readFileSync(join(worktree, "wip.txt"), "utf8"), "work\n");
});

test("PI_SUBAGENT_WORKTREE_ROOT moves the worktree root", async () => {
	const { repo, home } = gitRepo();
	const worktree = join(root, "trees", "repo", "t1");

	const result = runCli(["spawn", "--cwd", repo, "--worktree", "t1", "--prompt", "hi"], {
		...spawnEnv(agentDir(), fakePi(join(root, "bin"))),
		HOME: home,
		PI_SUBAGENT_WORKTREE_ROOT: join(root, "trees"),
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(gitOut(worktree, "branch", "--show-current"), "t1");
	assert.equal((await childEnv(agentDir())).get("PWD"), worktree);
});

test("stop leaves the worktree and its branch", () => {
	const { repo, home } = gitRepo();
	const worktree = join(home, "WORK", "dev", ".worktrees", "repo", "t1");
	const env = { ...spawnEnv(agentDir(), fakePi(join(root, "bin"))), HOME: home };
	assert.equal(runCli(["spawn", "--cwd", repo, "--worktree", "t1", "--prompt", "hi"], env).status, 0);
	const [run] = listRuns();

	const result = runCli(["stop", run.handle], env);

	assert.equal(result.status, 0, result.stderr);
	assert.equal(gitOut(worktree, "branch", "--show-current"), "t1");
	assert.ok(gitOut(repo, "rev-parse", "--verify", "refs/heads/t1"), "the branch is kept");
});

/** What a parent Pi with a tick gives the `spawn` its bash tool runs: its session, and a limit of 2. */
const queueEnv = { PI_SESSION_ID: "parent", PI_SUBAGENT_QUEUE: "1", PI_SUBAGENT_LIMIT: "2" };

/** Spawn `count` children; returns each `spawn`'s output. */
function spawnMany(count: number, env: NodeJS.ProcessEnv): string[] {
	const bin = fakePi(join(root, "bin"));
	return Array.from({ length: count }, (_, i) => {
		const result = runCli(["spawn", "--name", `c${i}`, "--cwd", root, "--prompt", `task ${i}`], { ...spawnEnv(agentDir(), bin), ...env });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	});
}

const byName = (name: string) => listRuns().find((run) => run.name === name)!;

/** Wait until the fake `pi` of `run` has written what it got. */
async function startedChild(run: { runDir: string }): Promise<string> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (existsSync(join(run.runDir, "probe"))) return readFileSync(join(run.runDir, "probe"), "utf8");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	assert.fail(`${run.runDir} did not start`);
}

/** The parent tick, in a Pi started with a limit of 2. */
const tick = () => withEnv({ PI_SUBAGENT_LIMIT: "2" }, () => void startQueuedRuns(listRuns("parent"), (_run, error) => assert.fail(error)));

test("with a limit of 2, spawning 3 children starts 2 and queues 1", async () => {
	const outputs = spawnMany(3, queueEnv);

	assert.deepEqual(listRuns().map((run) => [run.name, run.state]), [["c0", "starting"], ["c1", "starting"], ["c2", "queued"]]);
	assert.equal(tmuxSessionExists(byName("c2").tmuxSession), false);
	assert.match(outputs[2], /^Spawned c2 \(\w+\)\nState: queued, starts when fewer than 2 children run\n/);
	await tick();
	assert.equal(byName("c2").state, "queued", "no slot is free");
});

test("with a limit of 2, 5 spawns at the same time start 2 and queue 3", async () => {
	const env = { ...process.env, ...spawnEnv(agentDir(), fakePi(join(root, "bin"))), ...queueEnv };
	const codes = await Promise.all(
		Array.from({ length: 5 }, (_, i) => {
			const child = spawn(process.execPath, [cli, "spawn", "--name", `c${i}`, "--cwd", root, "--prompt", "hi"], { env, stdio: "ignore" });
			return new Promise<number | null>((done) => child.on("close", done));
		}),
	);

	assert.deepEqual(codes, [0, 0, 0, 0, 0]);
	const states = listRuns().map((run) => run.state);
	assert.deepEqual([states.filter((state) => state === "starting").length, states.filter((state) => state === "queued").length], [2, 3]);
});

test("the session lock starts no program: spawn asks tmux about an older run before it takes the lock", () => {
	// An older version's run, with no process ID: only tmux can tell whether it lives.
	const old = storedRun("old111", 0);
	updateMetadata(old, { state: "busy", parentSessionId: "parent" });
	// A `tmux` and a `ps` that record each call, and whether the session lock was held then.
	const bin = fakePi(join(root, "bin"));
	const calls = join(root, "calls");
	const locked = `ls "${join(agentDir(), "subagents")}"/session-*.lock >/dev/null 2>&1 && echo "$0 in lock" >> "${calls}"`;
	for (const [name, real] of [["tmux", spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout.trim()], ["ps", "/bin/ps"]]) {
		writeFileSync(join(bin, name), `#!/bin/sh
echo "$0 $1" >> "${calls}"
${locked}
exec "${real}" "$@"
`, { mode: 0o755 });
	}

	const result = runCli(["spawn", "--name", "new", "--cwd", root, "--prompt", "hi"], { ...spawnEnv(agentDir(), bin), ...queueEnv });

	assert.equal(result.status, 0, result.stderr);
	const lines = readFileSync(calls, "utf8").trim().split("\n");
	assert.ok(lines.some((line) => line.endsWith("tmux has-session")), "tmux was asked about the older run");
	assert.deepEqual(lines.filter((line) => line.endsWith("in lock")), []);
	assert.equal(byName("new").state, "starting");
});

test("subagentLimit in Pi's settings limits a session to 2 children, and PI_SUBAGENT_LIMIT overrides it", () => {
	mkdirSync(agentDir(), { recursive: true });
	writeFileSync(join(agentDir(), "settings.json"), JSON.stringify({ subagentLimit: 2 }));

	const outputs = spawnMany(3, { PI_SESSION_ID: "parent", PI_SUBAGENT_QUEUE: "1" });
	assert.deepEqual(listRuns().map((run) => run.state), ["starting", "starting", "queued"]);
	assert.match(outputs[2], /\nState: queued, starts when fewer than 2 children run\n/);

	const [override] = spawnMany(1, { ...queueEnv, PI_SUBAGENT_LIMIT: "9" });
	assert.match(override, /\nState: queued, starts when fewer than 9 children run\n/, "older children wait, so it queues");
});

test("when a child ends, the next tick starts the queued child with the caller's environment and its prompt", async () => {
	spawnMany(3, { ...queueEnv, AWS_PROFILE: "caller" });
	assert.equal(runCli(["stop", byName("c0").handle], {}).status, 0);

	await tick();

	const queued = byName("c2");
	assert.equal(queued.state, "starting");
	assert.equal(tmuxSessionExists(queued.tmuxSession), true);
	assert.match(await startedChild(queued), /^AWS_PROFILE=caller$/m);
	assert.equal(JSON.parse(readFileSync(join(queued.runDir, "argv"), "utf8")).at(-1), "Task:\ntask 2");
});

test("list and status show a queued child as queued", () => {
	spawnMany(3, queueEnv);

	assert.match(runCli(["list"], { PI_SESSION_ID: "parent" }).stdout, /^c2 \(\w+\)  queued  /m);
	assert.match(runCli(["status", byName("c2").handle], {}).stdout, /^c2 \(\w+\): queued /);
});

test("a queued child that fails to start is reported to the parent once, and wait prints the failure and exits 1", async () => {
	spawnMany(3, queueEnv);
	assert.equal(runCli(["stop", byName("c0").handle], {}).status, 0);
	const failingTmux = join(root, "failing-tmux");
	mkdirSync(failingTmux);
	writeFileSync(join(failingTmux, "tmux"), "#!/bin/sh\necho 'no server' >&2\nexit 1\n", { mode: 0o755 });
	const errors: string[] = [];
	await withEnv({ PATH: `${failingTmux}:${basePath}`, PI_SUBAGENT_LIMIT: "2" }, () => void startQueuedRuns(listRuns("parent"), (_run, message) => errors.push(message)));
	const queued = byName("c2");
	assert.deepEqual(errors, ["no server"]);
	assert.match(pendingResults([queued])?.text ?? "", new RegExp(`^Subagent c2 \\(${queued.handle}\\) failed to start\\n\\nno server$`));

	const result = runCli(["wait", queued.handle], {});

	assert.equal(result.status, 1, result.stderr);
	assert.equal(result.stdout, `${queued.handle} failed to start\n\nno server\n`);
	assert.equal(pendingResults([queued]), undefined, "wait printed it, so the parent is not told a second time");
});

test("stop removes a queued child, and it never starts", async () => {
	spawnMany(3, queueEnv);
	const queued = byName("c2");

	const result = runCli(["stop", queued.handle], {});
	assert.equal(runCli(["stop", byName("c0").handle], {}).status, 0);
	await tick();

	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(queued.runDir), false);
	assert.equal(tmuxSessionExists(queued.tmuxSession), false);
});

test("a queued child's time limit counts from its start, not from its spawn", async () => {
	spawnMany(2, queueEnv);
	const bin = fakePi(join(root, "bin"));
	assert.equal(runCli(["spawn", "--name", "late", "--cwd", root, "--timeout", "1s", "--prompt", "hi"], { ...spawnEnv(agentDir(), bin), ...queueEnv }).status, 0);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));

	stopTimedOutRuns(listRuns("parent"));
	assert.equal(byName("late").timedOut, undefined, "a queued child is not stopped");
	assert.equal(runCli(["stop", byName("c0").handle], {}).status, 0);
	await tick();

	const started = byName("late");
	assert.equal(started.state, "starting");
	assert.ok(Date.parse(started.deadline!) > Date.now(), "the limit starts with the child");
});

test("a spawn with no parent tick starts each child at once, past the limit", () => {
	spawnMany(3, { ...queueEnv, PI_SUBAGENT_QUEUE: "" });

	for (const run of listRuns()) {
		assert.equal(run.state, "starting");
		assert.equal(tmuxSessionExists(run.tmuxSession), true);
	}
});

test("resuming a session with 6 suspended children and a limit of 2 starts 2 and queues 4", async () => {
	spawnMany(6, { PI_SESSION_ID: "parent" });
	await suspendRuns(listRuns());

	await withEnv({ PI_SUBAGENT_LIMIT: "2" }, () => resumeSuspendedRuns("parent", (_run, error) => assert.fail(error)));

	const runs = listRuns();
	assert.deepEqual(runs.map((run) => [run.name, run.state]), [["c0", "starting"], ["c1", "starting"], ["c2", "queued"], ["c3", "queued"], ["c4", "queued"], ["c5", "queued"]]);
	assert.deepEqual(runs.map((run) => tmuxSessionExists(run.tmuxSession)), [true, true, false, false, false, false]);
});

test("a child suspended 25 hours ago stays suspended after resume, and list shows it as suspended", async () => {
	spawnMany(2, { PI_SESSION_ID: "parent" });
	await suspendRuns(listRuns());
	updateMetadata(byName("c0").runDir, { suspendedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });

	resumeSuspendedRuns("parent", (_run, error) => assert.fail(error));

	assert.equal(tmuxSessionExists(byName("c0").tmuxSession), false);
	assert.equal(byName("c0").suspended, true);
	assert.equal(byName("c1").state, "starting", "a child suspended just now starts");
	assert.match(runCli(["list"], { PI_SESSION_ID: "parent" }).stdout, /^c0 \(\w+\)  suspended  /m);
	assert.match(runCli(["status", byName("c0").handle], {}).stdout, /^c0 \(\w+\): suspended /);
});

test("a queued child is suspended when its parent quits: after 25 h it stays suspended, and a recent one starts with its prompt", async () => {
	spawnMany(4, queueEnv);
	await suspendSessionRuns("parent");
	updateMetadata(byName("c2").runDir, { suspendedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });

	await withEnv({ PI_SUBAGENT_LIMIT: "2" }, () => resumeSuspendedRuns("parent", (_run, error) => assert.fail(error)));

	assert.equal(tmuxSessionExists(byName("c2").tmuxSession), false);
	assert.match(runCli(["list"], { PI_SESSION_ID: "parent" }).stdout, /^c2 \(\w+\)  suspended  /m);
	assert.equal(byName("c3").state, "queued", "behind the limit");
	assert.equal(runCli(["stop", byName("c0").handle], {}).status, 0);
	await tick();
	assert.equal(byName("c3").state, "starting");
	await startedChild(byName("c3"));
	assert.equal(JSON.parse(readFileSync(join(byName("c3").runDir, "argv"), "utf8")).at(-1), "Task:\ntask 3");
});

test("a suspended queued child with a saved launch but no transcript is queued on resume; one with neither is removed", async () => {
	spawnMany(3, queueEnv);
	await suspendSessionRuns("parent");
	rmSync(byName("c2").sessionFile);
	const gone = byName("c1");
	for (const file of [gone.sessionFile, join(gone.runDir, "launch.json")]) rmSync(file, { force: true });

	await withEnv({ PI_SUBAGENT_LIMIT: "2" }, () => resumeSuspendedRuns("parent", (_run, error) => assert.fail(error)));

	assert.equal(byName("c2")?.state, "starting", "its saved launch keeps the task");
	assert.equal(existsSync(gone.runDir), false, "nothing to start it with");
});

/** A child of session `parent` suspended 25 hours ago, so resuming the session leaves it suspended. */
async function oldSuspendedChild(): Promise<string> {
	spawnMany(1, { PI_SESSION_ID: "parent" });
	const [run] = listRuns();
	await suspendRuns([run]);
	updateMetadata(run.runDir, { name: "old", suspendedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
	return run.handle;
}

test("subagent resume queues a suspended child, and it starts when a slot is free", async () => {
	const handle = await oldSuspendedChild();
	spawnMany(2, queueEnv);

	const result = runCli(["resume", handle], queueEnv);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^Resumed old \(\w+\)\nState: queued, starts when fewer than 2 children run\n/);
	await tick();
	assert.equal(byName("old").state, "queued", "no slot is free");
	assert.equal(runCli(["stop", byName("c0").handle], {}).status, 0);
	await tick();
	assert.equal(byName("old").state, "starting");
	assert.equal(tmuxSessionExists(byName("old").tmuxSession), true);
});

/**
 * Run `subagent <args>` in `count` processes at once. Each waits before its first lock until all have come
 * there, so each has read the run and checked it, as two commands that run at the same moment would.
 */
async function cliAtOnce(argsList: string[][], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }[]> {
	const barrier = join(root, "barrier");
	mkdirSync(barrier);
	const hook = join(root, "barrier.mjs");
	writeFileSync(
		hook,
		`import fs from "node:fs";\nimport { syncBuiltinESMExports } from "node:module";\nconst write = fs.writeFileSync;\nlet first = true;\nfs.writeFileSync = (path, ...args) => {\n\tif (first && String(path).includes(".lock.")) {\n\t\tfirst = false;\n\t\twrite(${JSON.stringify(barrier)} + "/" + process.pid, "");\n\t\tconst end = Date.now() + 10000;\n\t\twhile (fs.readdirSync(${JSON.stringify(barrier)}).length < ${argsList.length}) {\n\t\t\tif (Date.now() > end) throw new Error("barrier timeout");\n\t\t\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);\n\t\t}\n\t}\n\treturn write(path, ...args);\n};\nsyncBuiltinESMExports();\n`,
	);
	return Promise.all(
		argsList.map((args) => {
			const child = spawn(process.execPath, ["--import", hook, cli, ...args], { env: { ...process.env, ...env } });
			let out = "";
			child.stdout.on("data", (data) => (out += data));
			child.stderr.on("data", (data) => (out += data));
			return new Promise<{ code: number | null; out: string }>((done) => child.on("close", (code) => done({ code, out })));
		}),
	);
}

test("with a limit of 1, two subagent resume of different children at the same time start 1 and queue 1", async () => {
	spawnMany(2, { PI_SESSION_ID: "parent" });
	await suspendRuns(listRuns());

	const results = await cliAtOnce([["resume", byName("c0").handle], ["resume", byName("c1").handle]], { ...queueEnv, PI_SUBAGENT_LIMIT: "1" });

	assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.out).join());
	assert.deepEqual(listRuns().map((run) => run.state).sort(), ["queued", "starting"]);
	assert.deepEqual(results.map((result) => result.out.split("\n")[1]).sort(), ["State: busy", "State: queued, starts when fewer than 1 children run"]);
});

test("two subagent resume of one child at the same time start it once; the other says it is already resumed", async () => {
	const handle = await oldSuspendedChild();

	const results = await cliAtOnce([["resume", handle], ["resume", handle]], { PATH: `${join(root, "bin")}:${basePath}` });

	assert.deepEqual(results.map((result) => result.code).sort(), [0, 1], results.map((result) => result.out).join());
	assert.match(results.find((result) => result.code === 1)!.out, new RegExp(`^${handle} is already resumed\n$`));
	await startedChild(byName("old"));
	assert.equal(effectiveRunState(byName("old")), "starting", "the live run is not marked error");
	assert.equal(tmuxSessionExists(byName("old").tmuxSession), true);
});

test("the subagent tool resumes a suspended child, as the CLI does", async () => {
	assert.ok((TOOL_ACTIONS as readonly string[]).includes("resume"), "the model can choose the action");
	const handle = await oldSuspendedChild();

	let result = { text: "", isError: true };
	await withEnv({ PATH: `${join(root, "bin")}:${basePath}` }, async () => {
		result = await runSubagentTool({ action: "resume", handle }, toolContext("parent"));
	});

	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /^Resumed old \(\w+\)\nState: busy\n/);
	assert.equal(tmuxSessionExists(byName("old").tmuxSession), true);
});

test("subagent resume with no parent tick starts the child at once", async () => {
	const handle = await oldSuspendedChild();

	const result = runCli(["resume", handle], { PATH: `${join(root, "bin")}:${basePath}` });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^Resumed old \(\w+\)\nState: busy\n/);
	assert.equal(tmuxSessionExists(byName("old").tmuxSession), true);
	assert.equal(runCli(["resume", handle], {}).status, 1, "a running child cannot be resumed");
});

/** Run the CLI with `args`, held just before it writes `launch.json`, and call `during` while it is held. */
async function withLaunchHeld(args: string[], env: NodeJS.ProcessEnv, during: () => Promise<void>): Promise<void> {
	const barrier = join(root, "barrier");
	mkdirSync(barrier);
	const hook = join(root, "hold-launch.mjs");
	writeFileSync(
		hook,
		`import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeFileSync;
fs.writeFileSync = (path, ...rest) => {
	if (String(path).endsWith("/launch.json")) {
		write(${JSON.stringify(join(barrier, "ready"))}, "");
		const end = Date.now() + 15000;
		while (!fs.existsSync(${JSON.stringify(join(barrier, "go"))}) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	}
	return write(path, ...rest);
};
syncBuiltinESMExports();
`,
	);
	const child = spawn(process.execPath, ["--import", hook, cli, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const closed = new Promise<number | null>((done) => child.on("close", done));
	const deadline = Date.now() + 10000;
	while (!existsSync(join(barrier, "ready"))) {
		assert.ok(Date.now() < deadline, "the CLI did not reach the launch write");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	try {
		await during();
	} finally {
		writeFileSync(join(barrier, "go"), "");
	}
	assert.equal(await closed, 0, stderr);
}

/** The parent tick, with a `tmux` that records each subcommand it gets; returns them. */
async function tickWithRecordedTmux(): Promise<string[]> {
	const bin = join(root, "recording-tmux");
	const calls = join(root, "tmux-calls");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "$1" >> "${calls}"\nexec "${spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout.trim()}" "$@"\n`, { mode: 0o755 });
	rmSync(calls, { force: true });
	await withEnv({ PATH: `${bin}:${basePath}` }, tick);
	return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
}

test("a tick does not start a spawn before its launch is saved; after it is, the child starts", async () => {
	spawnMany(2, queueEnv);
	const bin = fakePi(join(root, "bin"));

	await withLaunchHeld(["spawn", "--name", "late", "--cwd", root, "--prompt", "late task"], { ...spawnEnv(agentDir(), bin), ...queueEnv }, async () => {
		assert.equal(runCli(["stop", byName("c0").handle], {}).status, 0);
		assert.deepEqual((await tickWithRecordedTmux()).filter((call) => call === "new-session"), []);
	});

	await tick();
	const started = byName("late");
	assert.equal(started.state, "starting");
	await startedChild(started);
	assert.equal(JSON.parse(readFileSync(join(started.runDir, "argv"), "utf8")).at(-1), "Task:\nlate task");
});

test("a queued resume is not started before its launch is saved; after it is, the next tick starts it", async () => {
	const handle = await oldSuspendedChild();
	// As a child that started: its launcher took the file, so resume saves a new one.
	rmSync(join(byName("old").runDir, "launch.json"), { force: true });
	spawnMany(2, queueEnv);

	await withLaunchHeld(["resume", handle], { ...spawnEnv(agentDir(), join(root, "bin")), ...queueEnv }, async () => {
		assert.equal(runCli(["stop", byName("c0").handle], {}).status, 0);
		assert.deepEqual((await tickWithRecordedTmux()).filter((call) => call === "new-session"), []);
	});

	assert.equal(byName("old").state, "queued");
	await tick();
	assert.equal(byName("old").state, "starting");
	await startedChild(byName("old"));
});

test("the tick skips a queued run with no saved launch until the launch exists", async () => {
	spawnMany(3, queueEnv);
	assert.equal(runCli(["stop", byName("c0").handle], {}).status, 0);
	const launch = join(byName("c2").runDir, "launch.json");
	const saved = readFileSync(launch);
	rmSync(launch);

	assert.deepEqual((await tickWithRecordedTmux()).filter((call) => call === "new-session"), []);
	assert.equal(byName("c2").state, "queued");

	writeFileSync(launch, saved, { mode: 0o600 });
	await tick();
	assert.equal(byName("c2").state, "starting");
	await startedChild(byName("c2"));
});

test("a guarded timer callback that throws does not throw, logs once, and runs again on the next tick", () => {
	const logged: string[] = [];
	const error = console.error;
	console.error = (message: string) => void logged.push(message);
	let calls = 0;
	try {
		const tick = guarded("widget", () => {
			calls++;
			throw new RangeError("Invalid count value: -1");
		});
		tick();
		tick();
	} finally {
		console.error = error;
	}

	assert.equal(calls, 2);
	assert.equal(logged.length, 1);
	assert.match(logged[0], /^pi-subagent: widget failed, retrying each tick: RangeError: Invalid count value: -1/);
});

test("wait on a busy child with --timeout 2s reports it timed out after about 2 s, and keeps its transcript", () => {
	const launched = Date.now();
	spawnChildren(1, {}, ["--timeout", "2s"]);
	const [run] = listRuns();
	const deadline = Date.parse(run.deadline ?? "");
	assert.ok(deadline - launched >= 2000 && deadline - launched < 2000 + (Date.now() - launched), run.deadline);

	const result = runCli(["wait", run.handle], {});

	// `wait` polls each 500 ms; the rest is program starts on a slow machine.
	const late = Date.now() - deadline;
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stdout, new RegExp(`^${run.handle} timed out\\n\\nIt passed its time limit of 2s and was stopped\\. Transcript: ${run.sessionFile}\\n$`));
	assert.ok(late >= 0 && late < 5000, `stopped ${late} ms after the deadline`);
	assert.equal(tmuxSessionExists(run.tmuxSession), false);
	assert.equal(existsSync(run.sessionFile), true);
});

test("a child past its time limit is stopped by the parent tick and reported once as timed out", async () => {
	spawnChildren(1, { PI_SESSION_ID: "parent" }, ["--timeout", "1s"]);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));

	for (let i = 0; i < 3; i++) {
		const runs = listRuns("parent");
		stopTimedOutRuns(runs);
		reportExitedRuns(runs);
	}

	const [run] = listRuns("parent");
	const pending = pendingResults([run]);
	assert.equal(pending?.files.length, 1);
	assert.match(pending.text, new RegExp(`^Subagent ${run.handle} timed out\\n\\nIt passed its time limit of 1s and was stopped\\.`));
	assert.equal(tmuxSessionExists(run.tmuxSession), false);
	assert.equal(existsSync(run.sessionFile), true);
});

test("spawn rejects a time limit that is not a duration", () => {
	const result = runCli(["spawn", "--cwd", root, "--timeout", "soon", "--prompt", "hi"], spawnEnv(agentDir(), fakePi(join(root, "bin"))));

	assert.equal(result.status, 1);
	assert.match(result.stderr, /--timeout must be a duration such as 90s, 10m, or 1h/);
	assert.deepEqual(listRuns(), []);
});

/** Write the agent file `<dir>/<name>.md` with `frontmatter` lines and `body`. */
function agentFile(dir: string, name: string, frontmatter: string[], body = ""): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\n${frontmatter.join("\n")}\n---\n${body}`);
}

/** The value after `flag` in the child's arguments. */
function flagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

test("spawn --agent starts the child with the agent file's model, thinking, tools, extensions, and instructions", async () => {
	const guard = installGuard();
	agentFile(join(agentDir(), "agents"), "implementer", ["description: Implements one ticket", "model: anthropic/claude-x", "thinking: high", "tools: read,bash", "extensions: /ext/a.ts", "mcp: false"], "Follow the brief.\n");

	const result = runCli(["spawn", "--cwd", root, "--agent", "implementer", "--prompt", "hi"], spawnEnv(agentDir(), fakePi(join(root, "bin"))));

	assert.equal(result.status, 0, result.stderr);
	const args = await childArgs(agentDir());
	assert.equal(flagValue(args, "--provider"), "anthropic");
	assert.equal(flagValue(args, "--model"), "claude-x");
	assert.equal(flagValue(args, "--thinking"), "high");
	assert.equal(flagValue(args, "--tools"), "read,bash");
	assert.deepEqual(extensionFlags(args), [join(import.meta.dirname, "index.ts"), guard, "/ext/a.ts"]);
	assert.ok(args.includes("--no-mcp"));
	assert.equal(args.at(-1), "Follow the brief.\n\nTask:\nhi");
});

test("a flag on spawn overrides the agent file", async () => {
	agentFile(join(agentDir(), "agents"), "implementer", ["model: anthropic/claude-x", "thinking: high"]);

	const result = runCli(["spawn", "--cwd", root, "--agent", "implementer", "--model", "x", "--prompt", "hi"], spawnEnv(agentDir(), fakePi(join(root, "bin"))));

	assert.equal(result.status, 0, result.stderr);
	const args = await childArgs(agentDir());
	assert.equal(flagValue(args, "--model"), "x");
	assert.equal(flagValue(args, "--thinking"), "high");
});

test("spawn --agent takes the agent file's time limit, and --timeout on spawn overrides it", () => {
	agentFile(join(agentDir(), "agents"), "implementer", ["timeout: 10m"]);
	const env = spawnEnv(agentDir(), fakePi(join(root, "bin")));

	const fromFile = runCli(["spawn", "--cwd", root, "--name", "file", "--agent", "implementer", "--prompt", "hi"], env);
	const fromFlag = runCli(["spawn", "--cwd", root, "--name", "flag", "--agent", "implementer", "--timeout", "90s", "--prompt", "hi"], env);

	assert.equal(fromFile.status, 0, fromFile.stderr);
	assert.equal(fromFlag.status, 0, fromFlag.stderr);
	const timeouts = Object.fromEntries(listRuns().map((run) => [run.name, run.timeout]));
	assert.deepEqual(timeouts, { file: "10m", flag: "90s" });
});

/** `runCli` from the directory `cwd`, as a parent Pi working in a project runs it. */
function runCliIn(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
	return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

test("a project agent file overrides a global one with the same name", async () => {
	const project = join(root, "project");
	agentFile(join(agentDir(), "agents"), "implementer", ["model: global-model"]);
	agentFile(join(project, ".pi", "agents"), "implementer", ["model: project-model"]);

	const result = runCliIn(project, ["spawn", "--agent", "implementer", "--prompt", "hi"], spawnEnv(agentDir(), fakePi(join(root, "bin"))));

	assert.equal(result.status, 0, result.stderr);
	assert.equal(flagValue(await childArgs(agentDir()), "--model"), "project-model");
});

test("a project agent file cannot load extensions or drop the command guard, and spawn warns once naming it", async () => {
	installGuard();
	const project = join(root, "project");
	agentFile(join(project, ".pi", "agents"), "reviewer", ["extensions: payload.ts, -cc-safety-net", "tools: read"]);
	const file = join(realpathSync(project), ".pi", "agents", "reviewer.md");

	const result = runCliIn(project, ["spawn", "--agent", "reviewer", "--prompt", "hi"], spawnEnv(agentDir(), fakePi(join(root, "bin"))));

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, `Warning: ignored the extensions of the project agent file ${file}; only a global agent file or --extensions on spawn can load extensions\n`);
	const args = await childArgs(agentDir());
	assert.equal(args.includes("--no-extensions"), false);
	assert.deepEqual(extensionFlags(args), []);
	assert.equal(flagValue(args, "--tools"), "read");
});

test("agents lists the name, scope, and description of each agent, a project one in place of a global one", () => {
	const project = join(root, "project");
	agentFile(join(agentDir(), "agents"), "reviewer", ["description: Reviews a change"]);
	agentFile(join(agentDir(), "agents"), "implementer", ["description: Global implementer"]);
	agentFile(join(project, ".pi", "agents"), "implementer", ["description: Implements one ticket"]);

	const result = runCliIn(project, ["agents"], { PI_CODING_AGENT_DIR: agentDir() });

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "implementer  project  Implements one ticket\nreviewer  global  Reviews a change\n");
});

test("spawn --agent with an unknown name fails and starts nothing", () => {
	agentFile(join(agentDir(), "agents"), "implementer", []);

	const result = runCli(["spawn", "--cwd", root, "--agent", "nope", "--prompt", "hi"], spawnEnv(agentDir(), fakePi(join(root, "bin"))));

	assert.equal(result.status, 1);
	assert.equal(result.stderr, "Unknown agent: nope (known: implementer; see `subagent agents`)\n");
	assert.equal(existsSync(getRunsDir()), false);
});

/** What the `subagent` tool gets from Pi: the parent session, its model, and its working directory. */
function toolContext(sessionId = "parent-session") {
	return {
		cwd: root,
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "parent.jsonl") },
		model: { provider: "test", id: "test-model" },
		thinkingLevel: "high",
	};
}

test("the subagent tool spawns a child of the tool's session when the subagent CLI is not on PATH", async () => {
	const bin = fakePi(join(root, "bin"));
	await withEnv({ ...spawnEnv(agentDir(), bin), PI_PROVIDER: "", PI_MODEL: "" }, async () => {
		assert.equal(spawnSync("which", ["subagent"]).status, 1);

		const result = await runSubagentTool({ action: "spawn", name: "tool child", prompt: "hi" }, toolContext());

		assert.equal(result.isError, false, result.text);
		assert.match(result.text, /^Spawned tool child \([a-z0-9]+\)\nState: busy\n/);
	});
	const args = await childArgs(agentDir());
	assert.equal(flagValue(args, "--model"), "test-model");
	assert.equal(flagValue(args, "--thinking"), "high");
	assert.equal(args.at(-1), "Task:\nhi");
	const [run] = listRuns("parent-session");
	assert.equal(run.cwd, realpathSync(root));
	assert.equal(run.parentSessionFile, join(root, "parent.jsonl"));
});

test("each subagent tool action prints what the matching CLI command prints", async () => {
	const handle = idleRun({ content: [{ type: "text", text: "All good." }], stopReason: "stop" });
	agentFile(join(agentDir(), "agents"), "reviewer", ["description: Reviews a change"]);
	const env = { PI_SESSION_ID: "parent", PI_SUBAGENT_NOTIFY: "" };
	const both = async (params: Parameters<typeof runSubagentTool>[0], args: string[]) => {
		const tool = await runSubagentTool(params, { ...toolContext("parent"), cwd: process.cwd() });
		const cli = runCli(args, env);
		return { tool, cli: { text: [cli.stdout, cli.stderr].map((part) => part.trim()).filter(Boolean).join("\n\n"), isError: cli.status !== 0 } };
	};

	for (const [params, args] of [
		[{ action: "list" }, ["list"]],
		[{ action: "status", handle }, ["status", handle]],
		[{ action: "last", handle }, ["last", handle]],
		[{ action: "agents" }, ["agents"]],
		[{ action: "wait", handle, timeout: "5" }, ["wait", handle, "--timeout", "5"]],
		[{ action: "send", handle, message: "more", followUp: true }, ["send", handle, "--follow-up", "more"]],
		[{ action: "status", handle: "nope00" }, ["status", "nope00"]],
	] as const) {
		const { tool, cli } = await both(params, [...args]);
		assert.deepEqual(tool, cli, params.action);
	}
	assert.match((await both({ action: "list" }, ["list"])).tool.text, /^abc123  idle/);

	const stopped = await runSubagentTool({ action: "stop", handle }, toolContext("parent"));
	assert.equal(stopped.isError, false, stopped.text);
	assert.equal(stopped.text, "Stopped abc123");
	assert.equal(listRuns("parent").length, 0);
});

test("a child spawned with the subagent tool is suspended and resumed like a CLI child", async () => {
	const bin = fakePi(join(root, "bin"));
	await withEnv({ ...spawnEnv(agentDir(), bin), PI_SUBAGENT_PARENT_PID: String(process.pid), PI_SUBAGENT_PARENT_STARTED: processStartTime(process.pid) }, async () => {
		const result = await runSubagentTool({ action: "spawn", noMcp: true, prompt: "hi" }, toolContext());
		assert.equal(result.isError, false, result.text);
		const first = await childArgs(agentDir());
		const [run] = listRuns("parent-session");
		assert.equal(run.parentPid, process.pid);

		await suspendRuns([run]);
		assert.equal(readMetadata(run.runDir)?.suspended, true);
		rmSync(join(run.runDir, "probe"));
		resumeSuspendedRuns("parent-session", (_run, error) => assert.fail(error));

		const relaunched = await childArgs(agentDir());
		assert.ok(relaunched.includes("--no-mcp"));
		assert.equal(flagValue(relaunched, "--model"), flagValue(first, "--model"));
		assert.equal(tmuxSessionExists(run.tmuxSession), true);
	});
});

test("the bundled skill names the subagent tool first and the CLI second", () => {
	const skill = readFileSync(join(import.meta.dirname, "skills", "subagent", "SKILL.md"), "utf8");
	const tool = skill.indexOf("Use the `subagent` tool first");
	assert.ok(tool > 0 && tool < skill.indexOf("Use the CLI second"));
});
