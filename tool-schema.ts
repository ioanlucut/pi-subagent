import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { TOOL_ACTIONS } from "./tool.ts";

/**
 * The `subagent` tool's parameters; `tool.ts` derives its parameter type from this. A file apart from
 * `tool.ts`, because only Pi provides `typebox`: the tests load `tool.ts` with no `node_modules`.
 */
export const SubagentToolSchema = Type.Object({
	// A plain `enum` schema, which every provider accepts, typed for `Static`.
	action: Type.Unsafe<(typeof TOOL_ACTIONS)[number]>(StringEnum(TOOL_ACTIONS)),
	handle: Type.Optional(Type.String({ description: "status, wait, send, stop, resume, last: the child's handle" })),
	message: Type.Optional(Type.String({ description: "send: the message" })),
	followUp: Type.Optional(Type.Boolean({ description: "send: queue after the current work (--follow-up)" })),
	name: Type.Optional(Type.String({ description: "spawn: short name shown in the UI" })),
	prompt: Type.Optional(Type.String({ description: "spawn: the task" })),
	files: Type.Optional(Type.Array(Type.String(), { description: "spawn: files for the first prompt (--file)" })),
	agent: Type.Optional(Type.String({ description: "spawn: role from an agent file (see action agents)" })),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	worktree: Type.Optional(Type.String({ description: "spawn: topic of a new worktree for the child" })),
	base: Type.Optional(Type.String({ description: "spawn: base branch of the worktree" })),
	tools: Type.Optional(Type.String({ description: "spawn: comma-separated tool allowlist" })),
	extensions: Type.Optional(Type.String({ description: "spawn: light child, only these extensions (comma-separated)" })),
	noExtensions: Type.Optional(Type.Boolean()),
	noMcp: Type.Optional(Type.Boolean()),
	noSkills: Type.Optional(Type.Boolean()),
	noPromptTemplates: Type.Optional(Type.Boolean()),
	noContextFiles: Type.Optional(Type.Boolean()),
	timeout: Type.Optional(
		Type.String({ description: "spawn: time limit such as 90s, 10m, 1h. wait: deadline in seconds (default 1800)" }),
	),
});
