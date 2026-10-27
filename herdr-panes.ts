import { spawnSync } from "node:child_process";
import type { RunMetadata, RunState } from "./shared.ts";

/** Runs the `herdr` CLI and returns its JSON reply, or undefined when the call fails. */
export type HerdrCli = (args: string[]) => unknown;

export const runHerdr: HerdrCli = (args) => {
	const result = spawnSync(process.env.HERDR_BIN_PATH || "herdr", args, { encoding: "utf8", timeout: 5000 });
	if (result.status !== 0) return undefined;
	try {
		return JSON.parse(result.stdout);
	} catch {
		return undefined;
	}
};

const WORKING: ReadonlySet<RunState> = new Set(["starting", "busy"]);

/** Lavender pane and violet bar: a child pane looks unlike any working pane, so it reads as disposable. */
const CHILD_BACKGROUND = "bg=#f3edff";
const CHILD_STATUS = "bg=#6d28d9,fg=#ffffff,bold";

/** The pane command: style the child's tmux session, then watch it read-only until it ends. */
export function watchCommand(run: RunMetadata): string {
	const session = run.tmuxSession;
	const label = ` SUBAGENT ${run.name ?? run.handle} · read-only · closes when done `;
	return [
		`exec tmux set-option -t ${session} status-style '${CHILD_STATUS}'`,
		`set-option -t ${session} status-left-length 120`,
		`set-option -t ${session} status-left '${label.replaceAll("'", "")}'`,
		`set-option -t ${session} status-right ''`,
		`set-option -t ${session} window-status-format ''`,
		`set-option -t ${session} window-status-current-format ''`,
		`set-option -w -t ${session} window-style '${CHILD_BACKGROUND}'`,
		// `exec`: the pane closes by itself when the session ends; `-r`: keys cannot reach the child.
		`attach-session -r -t ${session}`,
	].join(" \\; ");
}

function paneId(reply: unknown): string | undefined {
	const id = (reply as { result?: { pane?: { pane_id?: unknown } } } | undefined)?.result?.pane?.pane_id;
	return typeof id === "string" ? id : undefined;
}

/**
 * Shows each working child in a read-only Herdr pane beside the parent pane, and closes the pane
 * when the child becomes idle, exits, or is stopped. The first pane splits right of the parent;
 * the others stack below it, so the parent keeps its width.
 */
export class HerdrPanes {
	private readonly open = new Map<string, string>();
	private readonly failed = new Set<string>();

	private readonly parentPane: string;
	private readonly herdr: HerdrCli;

	constructor(parentPane: string, herdr: HerdrCli = runHerdr) {
		this.parentPane = parentPane;
		this.herdr = herdr;
	}

	sync(runs: { run: RunMetadata; state: RunState }[]): void {
		// A new child reports `idle` once at startup, before its first turn begins; that is not "done".
		const isWorking = ({ run, state }: { run: RunMetadata; state: RunState }) =>
			WORKING.has(state) || (state === "idle" && !run.hasStarted);
		const working = new Map(runs.filter(isWorking).map(({ run }) => [run.handle, run]));
		for (const [handle, pane] of this.open) {
			if (working.has(handle)) continue;
			this.herdr(["pane", "close", pane]);
			this.open.delete(handle);
		}
		for (const handle of this.failed) if (!working.has(handle)) this.failed.delete(handle);
		for (const [handle, run] of working) {
			if (this.open.has(handle) || this.failed.has(handle)) continue;
			const pane = this.split(run);
			if (!pane) {
				this.failed.add(handle);
				continue;
			}
			this.open.set(handle, pane);
			this.herdr(["pane", "rename", pane, `◆ subagent ${run.name ?? run.handle}`]);
			this.herdr(["pane", "run", pane, watchCommand(run)]);
		}
	}

	closeAll(): void {
		for (const pane of this.open.values()) this.herdr(["pane", "close", pane]);
		this.open.clear();
		this.failed.clear();
	}

	private split(run: RunMetadata): string | undefined {
		const below = [...this.open.values()].at(-1);
		if (below) {
			const pane = paneId(this.herdr(["pane", "split", below, "--direction", "down", "--cwd", run.cwd, "--no-focus"]));
			if (pane) return pane;
		}
		return paneId(
			this.herdr(["pane", "split", this.parentPane, "--direction", "right", "--ratio", "0.6", "--cwd", run.cwd, "--no-focus"]),
		);
	}
}
