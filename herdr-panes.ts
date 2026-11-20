import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import type { RunMetadata, RunState } from "./shared.ts";

/** Runs the `herdr` CLI and returns its JSON reply, or undefined when the call fails. */
export type HerdrCli = (args: string[]) => Promise<unknown>;

/** A child process, not `spawnSync`: on a busy machine a program start takes a second, and the tick runs on Pi's UI thread. */
export const runHerdr: HerdrCli = (args) =>
	new Promise((resolveCall) => {
		execFile(process.env.HERDR_BIN_PATH || "herdr", args, { encoding: "utf8", timeout: 5000 }, (error, stdout) => {
			if (error) return resolveCall(undefined);
			try {
				resolveCall(JSON.parse(stdout));
			} catch {
				resolveCall(undefined);
			}
		});
	});

/**
 * Sends one request to the Herdr socket and returns its result, or undefined when it fails. The CLI
 * has no command for split ratios, so the column sizes go through the socket.
 */
export type HerdrRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export const herdrRequest: HerdrRequest = (method, params) =>
	new Promise((resolveRequest) => {
		const socketPath = process.env.HERDR_SOCKET_PATH;
		if (!socketPath) return resolveRequest(undefined);
		let reply = "";
		const socket = createConnection(socketPath, () => socket.write(`${JSON.stringify({ id: "pi-subagent", method, params })}\n`));
		const end = (result: unknown) => {
			socket.destroy();
			resolveRequest(result);
		};
		socket.setTimeout(5000, () => end(undefined));
		socket.on("error", () => end(undefined));
		// A socket that closes before a whole reply has no answer; no timeout fires after a close.
		socket.on("close", () => end(undefined));
		socket.on("data", (data) => {
			reply += data;
			if (!reply.includes("\n")) return;
			try {
				end((JSON.parse(reply) as { result?: unknown }).result);
			} catch {
				end(undefined);
			}
		});
	});

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
 * the others stack below it with equal heights, so the parent keeps its width. The `herdr` calls run
 * as child processes, one sync at a time, so the tick that asks for a change does not wait for them.
 */
export class HerdrPanes {
	private readonly open = new Map<string, string>();
	private readonly failed = new Set<string>();

	private readonly parentPane: string;
	private readonly herdr: HerdrCli;
	private readonly request: HerdrRequest;
	/** The child panes the column was last sized for, so an unchanged column is not sized again. */
	private sizedFor = "";
	/** The sync whose `herdr` calls still run. */
	private syncing: Promise<void> | undefined;
	/** The newest rows given while a sync ran: the sync after it uses them. */
	private next: { run: RunMetadata; state: RunState }[] | undefined;

	constructor(parentPane: string, herdr: HerdrCli = runHerdr, request: HerdrRequest = herdrRequest) {
		this.parentPane = parentPane;
		this.herdr = herdr;
		this.request = request;
	}

	/**
	 * Open and close panes for `runs`. Returns at once; the promise ends when Herdr has made the changes.
	 * One sync runs at a time: rows given meanwhile wait for it, and only the newest are synced next, so
	 * the last tick's rows (the tick stops after them) are never lost.
	 */
	sync(runs: { run: RunMetadata; state: RunState }[]): Promise<void> {
		this.next = runs;
		this.syncing ??= this.drain().finally(() => (this.syncing = undefined));
		return this.syncing;
	}

	private async drain(): Promise<void> {
		for (let runs = this.next; runs; runs = this.next) {
			this.next = undefined;
			// A rejection nobody handles would end Pi; the next tick tries again.
			await this.reconcile(runs).catch((error: unknown) =>
				console.error(`pi-subagent: Herdr panes failed: ${error instanceof Error ? error.stack : String(error)}`),
			);
		}
	}

	private async reconcile(runs: { run: RunMetadata; state: RunState }[]): Promise<void> {
		// A new child reports `idle` once at startup, before its first turn begins; that is not "done".
		const isWorking = ({ run, state }: { run: RunMetadata; state: RunState }) =>
			WORKING.has(state) || (state === "idle" && !run.hasStarted);
		const working = new Map(runs.filter(isWorking).map(({ run }) => [run.handle, run]));
		for (const [handle, pane] of this.open) {
			if (working.has(handle)) continue;
			this.open.delete(handle);
			await this.herdr(["pane", "close", pane]);
		}
		for (const handle of this.failed) if (!working.has(handle)) this.failed.delete(handle);
		for (const [handle, run] of working) {
			if (this.open.has(handle) || this.failed.has(handle)) continue;
			const pane = await this.split(run);
			if (!pane) {
				this.failed.add(handle);
				continue;
			}
			this.open.set(handle, pane);
			await this.herdr(["pane", "rename", pane, `◆ subagent ${run.name ?? run.handle}`]);
			await this.herdr(["pane", "run", pane, watchCommand(run)]);
		}
		await this.equalizeColumn();
	}

	/** Give the stacked child panes equal heights; Herdr halves the lowest pane on each split. */
	private async equalizeColumn(): Promise<void> {
		const ids = [...this.open.values()];
		const key = ids.join(" ");
		if (key === this.sizedFor) return;
		this.sizedFor = key;
		if (ids.length < 2) return;
		const root = ((await this.request("layout.export", { pane_id: this.parentPane })) as { layout?: { root?: LayoutNode } } | undefined)?.layout?.root;
		if (!root) return;
		for (const { path, ratio } of equalColumnRatios(root, ids)) {
			await this.request("layout.set_split_ratio", { pane_id: this.parentPane, path, ratio });
		}
	}

	/** Close every child pane, the ones a running sync opens included. */
	async closeAll(): Promise<void> {
		this.next = undefined;
		await this.syncing;
		const panes = [...this.open.values()];
		this.open.clear();
		this.failed.clear();
		await Promise.all(panes.map((pane) => this.herdr(["pane", "close", pane])));
	}

	private async split(run: RunMetadata): Promise<string | undefined> {
		const below = [...this.open.values()].at(-1);
		if (below) {
			const pane = paneId(await this.herdr(["pane", "split", below, "--direction", "down", "--cwd", run.cwd, "--no-focus"]));
			if (pane) return pane;
		}
		return paneId(
			await this.herdr(["pane", "split", this.parentPane, "--direction", "right", "--ratio", "0.6", "--cwd", run.cwd, "--no-focus"]),
		);
	}
}
