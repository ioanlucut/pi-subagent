import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getRunsDir } from "./shared.ts";

/**
 * Whether the user lets `spawn` start a child without the command guard. The model writes the `spawn` command
 * and its environment, so `PI_SUBAGENT_ALLOW_UNGUARDED=1` counts only from the environment the parent Pi started
 * with: the parent records it at load in a file for its process, which `spawn` reads. The other source is
 * `subagentAllowUnguarded: true` in Pi's settings.
 *
 * A model with bash can still write either file, or run `pi --no-extensions` itself: this keeps a light child
 * guarded, and is no boundary against such a model.
 */
export function userAllowsUnguarded(): boolean {
	return allowedInSettings() || parentStartedAllowed();
}

/** The parent extension calls this at load, after it set `PI_SUBAGENT_PARENT_PID` and `PI_SUBAGENT_PARENT_STARTED`. */
export function recordUnguardedChoice(): void {
	const file = recordFile(process.env.PI_SUBAGENT_PARENT_PID);
	if (!file) return;
	// Also when not allowed: a record of an older Pi with this process ID must not count.
	if (process.env.PI_SUBAGENT_ALLOW_UNGUARDED !== "1") return rmSync(file, { force: true });
	mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(file, process.env.PI_SUBAGENT_PARENT_STARTED ?? "", { mode: 0o600 });
}

/** The record of the parent Pi that runs this `spawn`; its start time tells it from a later process with its ID. */
function parentStartedAllowed(): boolean {
	const file = recordFile(process.env.PI_SUBAGENT_PARENT_PID);
	try {
		return !!file && readFileSync(file, "utf8") === (process.env.PI_SUBAGENT_PARENT_STARTED ?? "");
	} catch {
		return false;
	}
}

function recordFile(pid: string | undefined): string | undefined {
	return pid && /^[1-9]\d*$/.test(pid) ? join(getRunsDir(), "allow-unguarded", pid) : undefined;
}

function allowedInSettings(): boolean {
	try {
		return (JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as { subagentAllowUnguarded?: unknown }).subagentAllowUnguarded === true;
	} catch {
		return false;
	}
}
