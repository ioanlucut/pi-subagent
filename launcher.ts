// Runs as the child's tmux pane command: restore the caller's environment saved by `launchRun`, then become pi.
import { readFileSync, rmSync } from "node:fs";
import { TMUX_PANE_VARIABLES } from "./shared.ts";

const file = process.argv[2];
const { env, command } = JSON.parse(readFileSync(file, "utf8")) as { env: NodeJS.ProcessEnv; command: string[] };
rmSync(file);
for (const name of TMUX_PANE_VARIABLES) {
	if (process.env[name]) env[name] = process.env[name];
	else delete env[name];
}
// env finds the command on the restored PATH the same way a shell does.
process.execve!("/usr/bin/env", ["env", ...command], env);
