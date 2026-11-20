import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import { InboxDelivery } from "./inbox.ts";
import { claimResultDelivery, reportSettledTurn } from "./outbox.ts";
import {
	claimRunDir,
	guarded,
	effectiveRunState,
	holdAliveFifo,
	isLive,
	listRuns,
	ownStartTime,
	nextDeadline,
	pruneStaleRuns,
	readMetadata,
	runDisplayName,
	suspendOrphanedRuns,
	suspendSessionRuns,
	type RunMetadata,
	type RunState,
	updateMetadata,
} from "./shared.ts";
import { HerdrPanes } from "./herdr-panes.ts";
import { resumeSuspendedRuns, settleTmuxCalls } from "./queue.ts";
import { SessionTick } from "./tick.ts";
import { runSubagentTool } from "./tool.ts";
import { SubagentToolSchema } from "./tool-schema.ts";
import { ActivityTracker, widgetLines } from "./widget.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

function displayState(metadata: RunMetadata): string {
	return effectiveRunState(metadata).padEnd(8);
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = claimRunDir();
	// A Pi started from a child's tools: neither a parent nor that child.
	if (!runDir && process.env.PI_SUBAGENT_NESTED) return;
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));
		// A child cannot spawn, so only a parent gets the tool.
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description:
				"Delegate work to a separate Pi in its own tmux session, as the `subagent` CLI does: spawn, list, status, wait, send, stop, resume, last, agents. Prints what the matching CLI command prints. Load the `subagent` skill for when and how to use each action.",
			promptSnippet: "Spawn and talk to Pi subagents (same actions as the subagent CLI)",
			parameters: SubagentToolSchema,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const { text, isError } = await runSubagentTool(params, ctx, signal);
				return { content: [{ type: "text", text }], details: undefined, isError };
			},
		});
	}

	pi.registerCommand("subagent", {
		description: "Select and attach to a subagent spawned by this session",
		handler: async (_args, ctx) => {
			// A queued child has no tmux session to attach to yet.
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) => isLive(effectiveRunState(run)));
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}

			const items: SelectItem[] = runs.map((run) => ({
				value: run.handle,
				label: `${runDisplayName(run)}  ${displayState(run)}  ${run.provider}/${run.model}  ${run.thinking}`,
			}));
			let tui: TUI | undefined;
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				tui = customTui;
				const list = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);

				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Attach to subagent")), 1, 0));
				container.addChild(list);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`${keyHint("tui.select.confirm", "attach")}  ${keyHint("tui.select.cancel", "cancel")}`,
						),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						list.handleInput(data);
						customTui.requestRender();
					},
				};
			});
			if (!selected || !tui) return;
			const run = runs.find((candidate) => candidate.handle === selected);
			if (!run) return;

			if (process.env.TMUX) {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["switch-client", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) ctx.ui.notify(`Could not switch to ${run.handle}`, "error");
				return;
			}

			tui.stop();
			try {
				const exitCode = await new Promise<number | null>((resolveExit) => {
					const child = spawn("tmux", ["attach-session", "-t", run.tmuxSession], { stdio: "inherit" });
					child.on("error", () => resolveExit(null));
					child.on("close", resolveExit);
				});
				if (exitCode !== 0) process.stderr.write(`Could not attach to ${run.handle}\n`);
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		},
	});

	if (!runDir) {
		// Inside Herdr, show each working child in a read-only pane beside this one; PI_SUBAGENT_HERDR_PANES=0 turns it off.
		const panes =
			process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID && process.env.PI_SUBAGENT_HERDR_PANES !== "0"
				? new HerdrPanes(process.env.HERDR_PANE_ID)
				: undefined;

		const activity = new ActivityTracker();
		let tick: SessionTick | undefined;

		const showRows = (ctx: ExtensionContext, rows: { run: RunMetadata; state: RunState }[]): void => {
			panes?.sync(rows);
			if (rows.length === 0) {
				ctx.ui.setWidget("subagents", undefined);
				return;
			}
			ctx.ui.setWidget(
				"subagents",
				widgetLines(
					rows.map(({ run, state }) => ({ run, state, activity: activity.read(run) })),
					ctx.ui.theme,
					// Pi pads each widget line by one column on each side.
					(process.stdout.columns ?? 80) - 2,
				),
				{ placement: "belowEditor" },
			);
		};

		// `subagent spawn` runs from the bash tool, which inherits these, and saves them to find orphans later.
		process.env.PI_SUBAGENT_PARENT_PID = String(process.pid);
		process.env.PI_SUBAGENT_PARENT_STARTED = ownStartTime() ?? "";

		pi.on("session_start", async (_event, ctx) => {
			// Suspend children of parents that died without shutdown, so they relaunch when their session resumes.
			await suspendOrphanedRuns();
			// Without this, a child nobody stopped stays on disk and relaunches each time its session resumes.
			pruneStaleRuns();
			// Relaunch children that were suspended when this session was last quit or switched away from.
			resumeSuspendedRuns(ctx.sessionManager.getSessionId(), (run, message) => {
				if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
			});

			const delivers = claimResultDelivery(ctx.mode);
			// `spawn` from this Pi's bash tool queues past the limit only when a tick here starts queued runs.
			process.env.PI_SUBAGENT_QUEUE = delivers || ctx.hasUI ? "1" : "0";
			if (!delivers && !ctx.hasUI) return;
			tick = new SessionTick({
				sessionId: () => ctx.sessionManager.getSessionId(),
				show: ctx.hasUI ? (rows) => showRows(ctx, rows) : undefined,
				deliver: delivers
					? {
							// Compaction: not idle, and no run to queue behind. Pi would reject the message; try again next tick.
							ready: () => ctx.isIdle() || ctx.signal !== undefined,
							// Idle: starts a turn. Busy: waits until the current work is done.
							send: (text) =>
								pi.sendMessage(
									{ customType: "subagent-result", content: text, display: true },
									{ triggerTurn: true, deliverAs: "followUp" },
								),
						}
					: undefined,
				onStartError: (run, message) => {
					if (ctx.hasUI) ctx.ui.notify(`Could not start subagent ${runDisplayName(run)}: ${message}`, "error");
				},
			});
			tick.wake();
		});

		// `subagent spawn` runs from a tool: the first child of the session starts the tick.
		pi.on("tool_execution_end", () => tick?.wake());

		pi.on("session_shutdown", async (event, ctx) => {
			tick?.stop();
			tick = undefined;
			ctx.ui.setWidget("subagents", undefined);
			panes?.closeAll();
			if (event.reason === "reload") return;
			// A child the tick is still starting must have its tmux session before the suspend looks for it.
			await settleTmuxCalls();
			await suspendSessionRuns(ctx.sessionManager.getSessionId());
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let sessionName: string | undefined;

	const syncSessionName = (): void => {
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		const next = `subagent ${metadata.name ?? metadata.handle}`;
		if (next === sessionName) return;
		pi.setSessionName(next);
		sessionName = next;
	};

	const inbox = new InboxDelivery(runDir);

	const processInbox = guarded("inbox", (): void => {
		const ctx = currentContext;
		if (!ctx) return;
		syncSessionName();
		inbox.deliver({
			isIdle: () => ctx.isIdle(),
			send: (message, deliverAs) => pi.sendUserMessage(message, deliverAs && { deliverAs }),
			abort: () => ctx.abort(),
		});
	});

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		// The parent checks this FIFO each tick to find out, with no program started, whether this child runs.
		holdAliveFifo(runDir);
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
			childPid: process.pid,
			sessionFile: ctx.sessionManager.getSessionFile() ?? metadata.sessionFile,
			state: ctx.isIdle() ? "idle" : "busy",
			suspended: undefined,
			error: undefined,
		});
		syncSessionName();
		if (!timer) {
			timer = setInterval(processInbox, 250);
			timer.unref();
		}
		processInbox();
	});

	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		inbox.promptStarted();
		// A turn from idle that the inbox did not start (typed in the pane): its time limit counts from now.
		updateMetadata(runDir, (metadata) => {
			const deadline = metadata.state === "idle" ? nextDeadline(metadata) : undefined;
			return { state: "busy", hasStarted: true, error: undefined, ...(deadline && { deadline }) };
		});
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		if (!ctx.isIdle()) return;
		updateMetadata(runDir, { state: "idle" });
		reportSettledTurn(runDir);
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit") updateMetadata(runDir, { state: "exited" });
	});
}
