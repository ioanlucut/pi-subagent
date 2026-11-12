import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import { InboxDelivery } from "./inbox.ts";
import { claimResultDelivery, pendingResults, reportExitedRuns, reportSettledTurn } from "./outbox.ts";
import {
	claimRunDir,
	effectiveRunState,
	processStartTime,
	listRuns,
	pruneStaleRuns,
	readMetadata,
	removeRunDir,
	resumeSuspendedRuns,
	runDisplayName,
	suspendOrphanedRuns,
	suspendRuns,
	type RunMetadata,
	tmuxSessionExists,
	updateMetadata,
} from "./shared.ts";
import { HerdrPanes } from "./herdr-panes.ts";
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
	}

	pi.registerCommand("subagent", {
		description: "Select and attach to a subagent spawned by this session",
		handler: async (_args, ctx) => {
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) => effectiveRunState(run) !== "exited");
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
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;
		// Inside Herdr, show each working child in a read-only pane beside this one; PI_SUBAGENT_HERDR_PANES=0 turns it off.
		const panes =
			process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID && process.env.PI_SUBAGENT_HERDR_PANES !== "0"
				? new HerdrPanes(process.env.HERDR_PANE_ID)
				: undefined;

		const activity = new ActivityTracker();

		const refreshWidget = (): void => {
			if (!widgetContext) return;
			const activeRuns = listRuns(widgetContext.sessionManager.getSessionId())
				.map((run) => ({ run, state: effectiveRunState(run) }))
				.filter(({ state }) => state !== "exited");
			panes?.sync(activeRuns);
			if (activeRuns.length === 0) {
				widgetContext.ui.setWidget("subagents", undefined);
				return;
			}

			widgetContext.ui.setWidget(
				"subagents",
				widgetLines(
					activeRuns.map(({ run, state }) => ({ run, state, activity: activity.read(run) })),
					widgetContext.ui.theme,
					// Pi pads each widget line by one column on each side.
					(process.stdout.columns ?? 80) - 2,
				),
				{ placement: "belowEditor" },
			);
		};

		let resultsTimer: ReturnType<typeof setInterval> | undefined;
		let resultsContext: ExtensionContext | undefined;

		/** Put the results of this session's children into the chat, so the agent does not block on `wait`. */
		const deliverResults = (): void => {
			const ctx = resultsContext;
			if (!ctx) return;
			// Compaction: not idle, and no run to queue behind. Pi would reject the message; try again next tick.
			if (!ctx.isIdle() && ctx.signal === undefined) return;
			const runs = listRuns(ctx.sessionManager.getSessionId());
			reportExitedRuns(runs);
			const pending = pendingResults(runs);
			if (!pending) return;
			// Idle: starts a turn. Busy: waits until the current work is done.
			pi.sendMessage(
				{ customType: "subagent-result", content: pending.text, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			for (const file of pending.files) rmSync(file, { force: true });
		};

		// `subagent spawn` runs from the bash tool, which inherits these, and saves them to find orphans later.
		process.env.PI_SUBAGENT_PARENT_PID = String(process.pid);
		process.env.PI_SUBAGENT_PARENT_STARTED = processStartTime(process.pid) ?? "";

		pi.on("session_start", async (_event, ctx) => {
			// Suspend children of parents that died without shutdown, so they relaunch when their session resumes.
			await suspendOrphanedRuns();
			// Without this, a child nobody stopped stays on disk and relaunches each time its session resumes.
			pruneStaleRuns();
			// Relaunch children that were suspended when this session was last quit or switched away from.
			resumeSuspendedRuns(ctx.sessionManager.getSessionId(), (run, message) => {
				if (ctx.hasUI) ctx.ui.notify(`Could not resume subagent ${runDisplayName(run)}: ${message}`, "error");
			});

			if (claimResultDelivery(ctx.mode)) {
				resultsContext = ctx;
				resultsTimer = setInterval(deliverResults, 1000);
				resultsTimer.unref();
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
			refreshWidget();
			widgetTimer = setInterval(refreshWidget, 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", async (event, ctx) => {
			if (resultsTimer) clearInterval(resultsTimer);
			resultsTimer = undefined;
			resultsContext = undefined;
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			panes?.closeAll();
			if (event.reason === "reload") return;
			// Suspend running children: stop the process but keep transcript and metadata so resuming this
			// session relaunches them. Children that already exited on their own are discarded.
			const running: RunMetadata[] = [];
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (tmuxSessionExists(run.tmuxSession)) running.push(run);
				else if (!run.suspended) removeRunDir(run.runDir);
			}
			await suspendRuns(running);
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

	const processInbox = (): void => {
		const ctx = currentContext;
		if (!ctx) return;
		syncSessionName();
		inbox.deliver({
			isIdle: () => ctx.isIdle(),
			send: (message, deliverAs) => pi.sendUserMessage(message, deliverAs && { deliverAs }),
			abort: () => ctx.abort(),
		});
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const metadata = readMetadata(runDir);
		if (!metadata) return;
		updateMetadata(runDir, {
			childSessionId: ctx.sessionManager.getSessionId(),
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
		updateMetadata(runDir, { state: "busy", hasStarted: true, error: undefined });
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
