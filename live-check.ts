#!/usr/bin/env node
// Live check: a real parent Pi (RPC mode) and a real child, with this checkout as the package.
// It uses a temporary agent directory that links your logins, so it touches no real run or session.
// It needs a model login and costs a few cents. Run: npm run check:live
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const repo = import.meta.dirname;
const realAgentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const root = mkdtempSync(join(tmpdir(), "psa-live-"));
const [agentDir, bin, cwd] = ["agent", "bin", "cwd"].map((name) => join(root, name));
for (const dir of [agentDir, bin, cwd]) mkdirSync(dir);
for (const name of readdirSync(realAgentDir)) {
	if (!["settings.json", "subagents", "sessions"].includes(name)) symlinkSync(join(realAgentDir, name), join(agentDir, name));
}
let settings: { packages?: unknown[] } = {};
try {
	settings = JSON.parse(readFileSync(join(realAgentDir, "settings.json"), "utf8"));
} catch {
	// No settings: only this package.
}
settings.packages = [...(settings.packages ?? []).filter((entry) => !String(entry).includes("pi-subagent")), repo];
writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
symlinkSync(join(repo, "subagent.ts"), join(bin, "subagent"));

const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PATH: `${bin}:${process.env.PATH}` };
// Started from a Pi, this process has that Pi's session and subagent variables; the parent here must be new.
for (const name of Object.keys(env)) if (/^PI_(SUBAGENT_|SESSION_)/.test(name)) delete env[name];
const model = [
	...(process.env.PI_PROVIDER ? ["--provider", process.env.PI_PROVIDER] : []),
	...(process.env.PI_MODEL ? ["--model", process.env.PI_MODEL] : []),
];
const pi = spawn("pi", ["--mode", "rpc", "--session-dir", join(agentDir, "sessions"), "--thinking", "low", ...model], {
	cwd,
	env,
	stdio: ["pipe", "pipe", "inherit"],
});

/** What the parent did and got, in order: `tool <command>`, `result <text>`, `widget <row>`, `settled`. */
const events: string[] = [];
const text = (content: unknown): string =>
	Array.isArray(content) ? content.map((part) => (part?.type === "text" ? part.text : "")).join("") : String(content ?? "");
let buffer = "";
pi.stdout.on("data", (chunk) => {
	buffer += chunk;
	for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
		let record;
		try {
			record = JSON.parse(buffer.slice(0, end));
		} catch {
			record = {};
		}
		buffer = buffer.slice(end + 1);
		if (record.type === "tool_execution_start") events.push(`tool ${record.args?.command ?? record.toolName}`);
		else if (record.type === "message_end" && record.message?.customType === "subagent-result") events.push(`result ${text(record.message.content)}`);
		else if (record.type === "agent_settled") events.push("settled");
		else if (record.method === "setWidget" && record.widgetKey === "subagents") {
			for (const row of record.widgetLines ?? []) events.push(`widget ${row.replace(/\u001b\[[0-9;]*m/g, "")}`);
		}
	}
});

/** The first event from index `from` that matches, or a failure after three minutes. */
async function until(pattern: RegExp, from = 0): Promise<number> {
	for (const deadline = Date.now() + 180_000; Date.now() < deadline; ) {
		const index = events.findIndex((event, i) => i >= from && pattern.test(event));
		if (index >= 0) return index;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	assert.fail(`no event matched ${pattern}`);
}
const prompt = (message: string) => pi.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
const cli = (...args: string[]) => spawnSync(process.execPath, [join(repo, "subagent.ts"), ...args], { env, encoding: "utf8" });
const runs = (): string[] => {
	try {
		return readdirSync(join(agentDir, "subagents"));
	} catch {
		return [];
	}
};

let failed = false;
try {
	prompt(
		"Use the subagent skill. Spawn one subagent named counter with --thinking low and this prompt: " +
			"Run the bash command `sleep 8; echo one`, then reply with exactly DONE. " +
			"Follow the skill for how to get its result. When you have the result, do not stop the subagent; reply only GOT=<its answer>.",
	);
	const first = await until(/^result Subagent counter \(\w+\) finished\n\nDONE/);
	let mark = await until(/^settled$/, first);
	assert.ok(!events.some((event) => /^tool .*subagent wait/.test(event)), "the agent ran `subagent wait`");
	assert.ok(
		events.some((event) => /^widget ⟳ counter +\d+s +bash sleep 8; echo one +↓\d+ \$\d+\.\d\d$/.test(event)),
		"no widget row showed the busy child with its tool call, tokens and cost",
	);
	const widest = Math.max(...events.filter((event) => event.startsWith("widget ")).map((event) => [...event].length - 7));
	assert.ok(widest <= 78, `a widget row is ${widest} columns wide`);
	console.log("ok  the result arrived as a message, with no `subagent wait`");
	console.log("ok  the widget showed the busy child: time, tool call, tokens, cost");

	// Two messages that the idle child finds in the same tick: both must get an answer.
	const [handle] = runs();
	const inbox = join(agentDir, "subagents", handle, "inbox");
	for (const word of ["ONE", "TWO"]) {
		writeFileSync(join(inbox, `${word}.tmp`), JSON.stringify({ message: `Reply with exactly the word ${word} and nothing else.`, delivery: "auto" }));
	}
	for (const [index, word] of ["ONE", "TWO"].entries()) renameSync(join(inbox, `${word}.tmp`), join(inbox, `${index}.json`));
	mark = await until(/^result Subagent counter \(\w+\) finished\n\nTWO/, mark);
	mark = await until(/^settled$/, mark);
	const transcript = readFileSync(join(agentDir, "subagents", handle, "session.jsonl"), "utf8");
	for (const word of ["ONE", "TWO"]) assert.match(transcript, new RegExp(`"role":"assistant","content":\\[[^\\]]*"text":"${word}"`), `the child never answered ${word}`);
	console.log("ok  two messages to the idle child in one tick both got an answer");

	spawnSync("tmux", ["kill-session", "-t", `pi-subagent-${handle}`]);
	mark = await until(/^result (.|\n)*Subagent counter \(\w+\) exited\n/, mark);
	await until(/^settled$/, mark);
	await new Promise((resolve) => setTimeout(resolve, 3000));
	assert.equal(events.filter((event) => /Subagent counter \(\w+\) exited\n/.test(event)).length, 1);
	console.log("ok  a child whose process was killed was reported as exited, once");
} catch (error) {
	failed = true;
	console.error(`FAILED: ${error instanceof Error ? error.message : error}\n--- events\n${events.join("\n")}`);
} finally {
	for (const handle of runs()) cli("stop", handle);
	pi.stdin.end();
	await new Promise<void>((resolve) => {
		pi.on("exit", () => resolve());
		setTimeout(() => {
			pi.kill("SIGKILL");
			resolve();
		}, 15_000);
	});
	rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
