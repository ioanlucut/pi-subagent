import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "./shared.ts";

/** A role: what `spawn --agent <name>` applies before the caller's own flags. */
export interface AgentDefinition {
	name: string;
	description?: string;
	/** `spawn` flags from the frontmatter, in the order `spawn` parses them. */
	spawnArgs: string[];
	/** Instructions added to the child's first prompt. */
	body: string;
	file: string;
	/** `project`: from `.pi/agents/` in the working directory, so from whoever wrote the repository. */
	scope: AgentScope;
	/** A project file listed `extensions`; they were dropped, see `parseAgentFile`. */
	ignoredExtensions: boolean;
}

export type AgentScope = "project" | "global";

/** Project roles first, so a repository can override a global role with the same name. */
function agentDirs(projectDir: string): [string, AgentScope][] {
	return [
		[join(projectDir, ".pi", "agents"), "project"],
		[join(getAgentDir(), "agents"), "global"],
	];
}

/** Flat `key: value` frontmatter only: agent files hold a few scalars and lists, not nested YAML. */
function parseAgentFile(file: string, scope: AgentScope): AgentDefinition | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(readFileSync(file, "utf8"));
	if (!match) return undefined;
	const fields = new Map<string, string>();
	for (const line of match[1].split(/\r?\n/)) {
		const field = /^([a-z]+):\s*(.*?)\s*$/.exec(line);
		if (field) fields.set(field[1], field[2].replace(/^(["'])(.*)\1$/, "$2"));
	}
	const name = fields.get("name") || file.replace(/^.*\//, "").replace(/\.md$/, "");
	const spawnArgs: string[] = [];
	const model = fields.get("model");
	if (model) {
		// `provider/model`, as Pi's settings name a model; a bare ID keeps the caller's provider.
		const slash = model.indexOf("/");
		if (slash > 0) spawnArgs.push("--provider", model.slice(0, slash), "--model", model.slice(slash + 1));
		else spawnArgs.push("--model", model);
	}
	if (fields.get("thinking")) spawnArgs.push("--thinking", fields.get("thinking") as string);
	if (fields.get("tools")) spawnArgs.push("--tools", listValue(fields.get("tools") as string));
	const extensions = fields.get("extensions");
	// A cloned repository is not trusted: its extensions would run its code in the child, and
	// `-cc-safety-net` would drop the command guard. Pi's project trust does not cover `.pi/agents/`.
	const ignoredExtensions = scope === "project" && Boolean(extensions);
	if (extensions && !ignoredExtensions) {
		// A relative path names a file beside the agent file, not one in the child's working directory.
		const list = listValue(extensions)
			.split(",")
			.map((entry) => (/^([a-z]+:|-|\/)/.test(entry) ? entry : resolve(dirname(file), entry)));
		spawnArgs.push("--extensions", list.join(","));
	}
	if (fields.get("mcp") === "false") spawnArgs.push("--no-mcp");
	if (fields.get("timeout")) spawnArgs.push("--timeout", fields.get("timeout") as string);
	return { name, description: fields.get("description") || undefined, spawnArgs, body: match[2].trim(), file, scope, ignoredExtensions };
}

/** `a, b` or `[a, b]` to `a,b`. */
function listValue(value: string): string {
	return value
		.replace(/^\[(.*)\]$/, "$1")
		.split(",")
		.map((entry) => entry.trim().replace(/^(["'])(.*)\1$/, "$2"))
		.filter(Boolean)
		.join(",");
}

/** Every role by name; a project file hides a global one with the same name. */
export function listAgents(projectDir: string): AgentDefinition[] {
	const agents = new Map<string, AgentDefinition>();
	for (const [dir, scope] of agentDirs(projectDir)) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir).filter((file) => file.endsWith(".md")).sort()) {
			const agent = parseAgentFile(join(dir, entry), scope);
			if (agent && !agents.has(agent.name)) agents.set(agent.name, agent);
		}
	}
	return [...agents.values()];
}

export function findAgent(projectDir: string, name: string): AgentDefinition | undefined {
	return listAgents(projectDir).find((agent) => agent.name === name);
}
