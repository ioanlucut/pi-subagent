import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { RunMetadata, RunState } from "./shared.ts";

/** What the parent widget shows for one child, read from its transcript. */
export interface RunActivity {
	outputTokens: number;
	cost: number;
	/** The last tool call as `name argument`, or the first line of the last answer. */
	last?: string;
	/** When the child got its last message, in ms. */
	turnStartedAt?: number;
}

interface TranscriptEntry {
	type?: string;
	timestamp?: string;
	message?: { role?: string; content?: unknown; usage?: { output?: unknown; cost?: { total?: unknown } } };
}

const firstLine = (text: string): string => text.trim().split("\n")[0];

function applyLine(activity: RunActivity, line: string): void {
	let entry: TranscriptEntry;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	const message = entry?.message;
	if (entry.type !== "message" || !message) return;
	if (message.role === "user") {
		const at = Date.parse(entry.timestamp ?? "");
		if (!Number.isNaN(at)) activity.turnStartedAt = at;
		return;
	}
	if (message.role !== "assistant") return;
	if (typeof message.usage?.output === "number") activity.outputTokens += message.usage.output;
	if (typeof message.usage?.cost?.total === "number") activity.cost += message.usage.cost.total;
	if (!Array.isArray(message.content)) return;
	for (const part of message.content as Record<string, unknown>[]) {
		if (part?.type === "toolCall" && typeof part.name === "string") {
			// The first text argument says what the call is about: a command, a path, a pattern.
			const argument = Object.values((part.arguments as object | undefined) ?? {}).find((value) => typeof value === "string");
			activity.last = `${part.name} ${firstLine(argument ?? "")}`.trim();
		} else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
			activity.last = firstLine(part.text);
		}
	}
}

/** Reads each child's transcript, and on each later call only the lines appended since. */
export class ActivityTracker {
	private readonly read_ = new Map<string, RunActivity & { file: string; offset: number }>();

	read(run: RunMetadata): RunActivity {
		let activity = this.read_.get(run.handle);
		try {
			const size = statSync(run.sessionFile).size;
			// A shorter file is another transcript: start again.
			if (!activity || activity.file !== run.sessionFile || size < activity.offset) {
				activity = { file: run.sessionFile, offset: 0, outputTokens: 0, cost: 0 };
				this.read_.set(run.handle, activity);
			}
			if (size === activity.offset) return activity;
			const buffer = Buffer.alloc(size - activity.offset);
			const fd = openSync(run.sessionFile, "r");
			let length: number;
			try {
				length = readSync(fd, buffer, 0, buffer.length, activity.offset);
			} finally {
				closeSync(fd);
			}
			// Only complete lines: the child may be in the middle of a write.
			const end = buffer.subarray(0, length).lastIndexOf(0x0a) + 1;
			for (const line of buffer.toString("utf8", 0, end).split("\n")) if (line) applyLine(activity, line);
			activity.offset += end;
		} catch {
			// No transcript yet, or it was removed.
		}
		return activity ?? { outputTokens: 0, cost: 0 };
	}
}

export interface WidgetRow {
	run: RunMetadata;
	state: RunState;
	activity: RunActivity;
}

type Color = "warning" | "success" | "error" | "muted" | "dim";

export interface WidgetTheme {
	fg(color: Color, text: string): string;
}

const MAX_ROWS = 5;
const MAX_NAME = 24;
/** The longest duration text: `59m59s`, `10h00m`. */
const TIME_WIDTH = 6;
const ICONS: Record<RunState, [icon: string, color: Color]> = {
	starting: ["◌", "muted"],
	busy: ["⟳", "warning"],
	idle: ["✓", "success"],
	error: ["✗", "error"],
	exited: ["■", "muted"],
};

function formatCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// Wide East Asian characters and emoji take two terminal columns; combining marks and joiners none.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u;
const ZERO = /[\p{Mn}\p{Me}\u200B-\u200F\uFE00-\uFE0F]/u;
const charWidth = (char: string): number => (ZERO.test(char) ? 0 : WIDE.test(char) ? 2 : 1);

/** Terminal columns that `text` takes. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += charWidth(char);
	return width;
}

/** `text` in at most `width` columns, with `…` when cut. */
function cut(text: string, width: number): string {
	if (displayWidth(text) <= width) return text;
	let out = "";
	let used = 0;
	for (const char of text) {
		if (used + charWidth(char) > width - 1) break;
		out += char;
		used += charWidth(char);
	}
	return width <= 0 ? "" : `${out}…`;
}

const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - displayWidth(text)));

/**
 * The parent's subagent widget: one row per child with its state, name, time in the current turn,
 * last action, and output tokens and cost. Children past the fifth are counted.
 */
export function widgetLines(rows: WidgetRow[], theme: WidgetTheme, width: number, now = Date.now()): string[] {
	const paint = (color: Color, text: string): string => (text ? theme.fg(color, text) : "");
	const shown = rows.slice(0, MAX_ROWS);
	const nameWidth = Math.min(MAX_NAME, Math.max(0, ...shown.map(({ run }) => displayWidth(run.name ?? run.handle))));
	const lines = shown.map(({ run, state, activity }) => {
		const [icon, color] = ICONS[state];
		const name = pad(cut(run.name ?? run.handle, nameWidth), nameWidth);
		const time = state === "busy" && activity.turnStartedAt !== undefined ? formatDuration(now - activity.turnStartedAt) : "";
		const totals = `↓${formatCount(activity.outputTokens)} $${activity.cost.toFixed(2)}`;
		const room = Math.max(0, width - (2 + nameWidth + 2 + TIME_WIDTH + 2) - 1 - displayWidth(totals));
		const detail = cut(state === "starting" ? "starting" : state === "error" ? (run.error ?? "failed") : (activity.last ?? ""), room);
		return `${theme.fg(color, icon)} ${name}  ${paint("dim", time)}${" ".repeat(Math.max(0, TIME_WIDTH - time.length))}  ${paint("muted", detail)}${" ".repeat(Math.max(0, room - displayWidth(detail)))} ${paint("dim", totals)}`;
	});
	if (rows.length > shown.length) lines.push(theme.fg("dim", cut(`+${rows.length - shown.length} more · /subagent to attach`, width)));
	return lines;
}
