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

/**
 * Sends one request to the Herdr socket and returns its result, or undefined when it fails. The CLI
 * has no command for split ratios, so the column sizes go through the socket.
 */
export type HerdrRequest = (method: string, params: Record<string, unknown>) => unknown;

export const herdrRequest: HerdrRequest = (method, params) => {
	const socket = process.env.HERDR_SOCKET_PATH;
	if (!socket) return undefined;
	// The poll that calls this is synchronous; a short-lived node child keeps it so.
	const script = `const s=require("net").createConnection(process.argv[1]);let o="";s.on("connect",()=>s.write(process.argv[2]+"\\n"));s.on("data",d=>{o+=d;if(o.includes("\\n")){process.stdout.write(o);s.destroy()}});s.on("error",()=>process.exit(1))`;
	const result = spawnSync(process.execPath, ["-e", script, socket, JSON.stringify({ id: "pi-subagent", method, params })], {
		encoding: "utf8",
		timeout: 5000,
	});
	try {
		return (JSON.parse(result.stdout) as { result?: unknown }).result;
	} catch {
		return undefined;
	}
};

type LayoutNode = { type: "pane"; pane_id: string } | { type: "split"; direction: string; first: LayoutNode; second: LayoutNode };

const contains = (node: LayoutNode, ids: Set<string>): boolean =>
	node.type === "pane" ? ids.has(node.pane_id) : contains(node.first, ids) || contains(node.second, ids);

/**
 * The ratios that give the child panes equal heights. Herdr splits are binary, so a column of n panes
 * is a chain of down-splits; split i must give its upper pane 1/(n−i) of what is left. Returns nothing
 * when the panes are not one such column, for example after the user moved a pane or the parent into it.
 */
export function equalColumnRatios(root: LayoutNode, ids: string[]): { path: boolean[]; ratio: number }[] {
	const wanted = new Set(ids);
	let node = root;
	const path: boolean[] = [];
	// Go down to the smallest part of the layout that holds every child pane.
	while (node.type === "split" && contains(node.first, wanted) !== contains(node.second, wanted)) {
		const second = contains(node.second, wanted);
		path.push(second);
		node = second ? node.second : node.first;
	}
	const ratios: { path: boolean[]; ratio: number }[] = [];
	for (let left = ids.length; left > 1; left--) {
		if (node.type !== "split" || node.direction !== "down" || node.first.type !== "pane" || !wanted.has(node.first.pane_id)) return [];
		ratios.push({ path: [...path], ratio: 1 / left });
		path.push(true);
		node = node.second;
	}
	return node.type === "pane" && wanted.has(node.pane_id) ? ratios : [];
}

const WORKING: ReadonlySet<RunState> = new Set(["starting", "busy"]);

/** Lavender pane and violet bar: a child pane looks unlike any working pane, so it reads as disposable. */
const CHILD_BACKGROUND = "bg=#f3edff";
const CHILD_STATUS = "bg=#6d28d9,fg=#ffffff,bold";

/** The pane command: style the child's tmux session, then watch it read-only until it ends. */
export function watchCommand(run: RunMetadata): string {
	const session = run.tmuxSession;
	// `##`: tmux expands `#(command)` and `#{format}` in the status line, and a name is free text.
	// `#,` and `#}`: inside the condition below, a plain comma or brace would end it.
	const name = (run.name ?? run.handle).replaceAll("#", "##").replaceAll(",", "#,").replaceAll("}", "#}");
	// `/subagent` attaches with keys; only this pane's read-only client gets the "read-only" bar.
	const label = `#{?client_readonly, SUBAGENT ${name} · read-only · closes when done , SUBAGENT ${name} }`;
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
 * the others stack below it with equal heights, so the parent keeps its width.
 */
export class HerdrPanes {
	private readonly open = new Map<string, string>();
	private readonly failed = new Set<string>();

	private readonly parentPane: string;
	private readonly herdr: HerdrCli;
	private readonly request: HerdrRequest;
	/** The child panes the column was last sized for, so an unchanged column is not sized again. */
	private sizedFor = "";

	constructor(parentPane: string, herdr: HerdrCli = runHerdr, request: HerdrRequest = herdrRequest) {
		this.parentPane = parentPane;
		this.herdr = herdr;
		this.request = request;
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
		this.equalizeColumn();
	}

	/** Give the stacked child panes equal heights; Herdr halves the lowest pane on each split. */
	private equalizeColumn(): void {
		const ids = [...this.open.values()];
		const key = ids.join(" ");
		if (key === this.sizedFor) return;
		this.sizedFor = key;
		if (ids.length < 2) return;
		const root = (this.request("layout.export", { pane_id: this.parentPane }) as { layout?: { root?: LayoutNode } } | undefined)?.layout?.root;
		if (!root) return;
		for (const { path, ratio } of equalColumnRatios(root, ids)) {
			this.request("layout.set_split_ratio", { pane_id: this.parentPane, path, ratio });
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
