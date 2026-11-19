import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "subagent.ts");

export const TOOL_ACTIONS = ["spawn", "list", "status", "wait", "send", "stop", "resume", "last", "agents"] as const;

export interface SubagentToolParams {
	action: (typeof TOOL_ACTIONS)[number];
	handle?: string;
	message?: string;
	followUp?: boolean;
	name?: string;
	prompt?: string;
	files?: string[];
	agent?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	cwd?: string;
	worktree?: string;
	base?: string;
	tools?: string;
	extensions?: string;
	noExtensions?: boolean;
	noMcp?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noContextFiles?: boolean;
	timeout?: string;
}

/** The part of Pi's tool context the tool reads: what Pi's bash tool gives a `subagent` command in its environment. */
export interface SubagentToolContext {
	cwd: string;
	sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
	model?: { provider: string; id: string };
	thinkingLevel?: string;
}

const VALUE_FLAGS = ["name", "agent", "provider", "model", "thinking", "cwd", "worktree", "base", "tools", "extensions", "timeout"] as const;
const SWITCHES = ["noExtensions", "noMcp", "noSkills", "noPromptTemplates", "noContextFiles"] as const;

/** `noMcp` to `--no-mcp`. */
function flag(param: string): string {
	return `--${param.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function cliArgs(params: SubagentToolParams): string[] {
	const handle = params.handle ? [params.handle] : [];
	switch (params.action) {
		case "spawn":
			return [
				"spawn",
				...VALUE_FLAGS.flatMap((param) => (params[param] === undefined ? [] : [flag(param), params[param] as string])),
				...SWITCHES.flatMap((param) => (params[param] ? [flag(param)] : [])),
				...(params.prompt === undefined ? [] : ["--prompt", params.prompt]),
				...(params.files ?? []).flatMap((file) => ["--file", file]),
			];
		case "wait":
			return ["wait", ...handle, ...(params.timeout === undefined ? [] : ["--timeout", params.timeout])];
		case "send":
			return ["send", ...handle, ...(params.followUp ? ["--follow-up"] : []), ...(params.message === undefined ? [] : [params.message])];
		default:
			return [params.action, ...handle];
	}
}

/**
 * Runs the `subagent` CLI that ships beside this file, so the tool prints what the CLI prints and works
 * when `subagent` is not on `PATH`. The session, model, and directory come from the tool context, as
 * Pi's bash tool puts them in a command's environment.
 */
export function runSubagentTool(
	params: SubagentToolParams,
	ctx: SubagentToolContext,
	signal?: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_SESSION_ID: ctx.sessionManager.getSessionId(),
		PI_SESSION_FILE: ctx.sessionManager.getSessionFile(),
		PI_PROVIDER: ctx.model?.provider,
		PI_MODEL: ctx.model?.id,
		PI_REASONING_LEVEL: ctx.thinkingLevel,
	};
	for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
	return new Promise((resolveRun) => {
		execFile(process.execPath, [cli, ...cliArgs(params)], { cwd: ctx.cwd, env, signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			const text = [stdout, stderr].map((part) => part.trim()).filter(Boolean).join("\n\n");
			resolveRun({ text: text || (error ? String(error.message) : ""), isError: Boolean(error) });
		});
	});
}
