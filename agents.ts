import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

function isInside(path: string, dir: string): boolean {
	const rel = relative(dir, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

/**
 * A repository can commit a symlink, so a project agent file could name any file the user can read and
 * put it in the child's prompt. A project file counts only as a regular file in a directory whose real
 * path is inside the project; the user's own global files may be links.
 */
function isTrustedFile(file: string, dir: string, scope: AgentScope, projectDir: string): boolean {
	if (scope === "global") return true;
	if (lstatSync(file).isFile() && isInside(realpathSync(dir), realpathSync(projectDir))) return true;
	process.stderr.write(`Warning: skipped the project agent file ${file}; it is not a regular file inside the project\n`);
	return false;
}

/** Every role by name; a project file hides a global one with the same name. Warns once for each skipped file. */
export function listAgents(projectDir: string): AgentDefinition[] {
	const agents = new Map<string, AgentDefinition>();
	for (const [dir, scope] of agentDirs(projectDir)) {
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir).filter((file) => file.endsWith(".md")).sort()) {
			const file = join(dir, entry);
			if (!isTrustedFile(file, dir, scope, projectDir)) continue;
			const agent = parseAgentFile(file, scope);
			if (agent && !agents.has(agent.name)) agents.set(agent.name, agent);
		}
	}
	return [...agents.values()];
}
