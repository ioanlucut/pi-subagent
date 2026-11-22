import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir, nextDeadline, readMetadata, updateMetadata, type InboxMessage } from "./shared.ts";

/** The child Pi, as far as inbox delivery needs it. */
export interface InboxTarget {
	isIdle(): boolean;
	/** No `deliverAs`: a new prompt, which starts a run. */
	send(message: string, deliverAs?: "steer" | "followUp"): void;
	/** End the current turn. */
	abort(): void;
}

/** A prompt that Pi rejects (for example, no login) never starts a run; stop waiting for it after this time. */
const PROMPT_PENDING_MS = 15_000;

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && ["auto", "followUp", "interrupt"].includes(message.delivery as string);
}

/** Hands the messages that `subagent send` queued in the run's inbox to the child, oldest first. */
export class InboxDelivery {
	// Set when an idle child gets a prompt, until that run starts. Pi starts the run after the call
	// returns, so the child still reports idle; a second prompt in that gap would be rejected and lost.
	private promptPendingSince: number | undefined;
	private readonly runDir: string;

	constructor(runDir: string) {
		this.runDir = runDir;
	}

	/** Call on `agent_start`: the prompt became a run, so later messages can steer it. */
	promptStarted(): void {
		this.promptPendingSince = undefined;
	}

	deliver(target: InboxTarget, now = Date.now()): void {
		const queueDir = inboxDir(this.runDir);
		if (!existsSync(queueDir)) return;
		for (const name of readdirSync(queueDir)
			.filter((entry) => entry.endsWith(".json"))
			.sort()) {
			const idle = target.isIdle();
			if (idle && this.promptPendingSince !== undefined && now - this.promptPendingSince < PROMPT_PENDING_MS) return;
			const path = join(queueDir, name);
			let payload: InboxMessage;
			try {
				const value: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
				payload = value;
			} catch (error) {
				unlinkSync(path);
				updateMetadata(this.runDir, {
					state: "error",
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			if (payload.delivery === "interrupt") {
				unlinkSync(path);
				if (!idle) target.abort();
				continue;
			}

			// A prompt to an idle child starts a new turn: its time limit counts from now.
			const metadata = readMetadata(this.runDir);
			const deadline = idle && metadata && nextDeadline(metadata);
			// The message is saved after this point of the transcript, if at all.
			const handed: HandedMessage = { message: payload.message, offset: transcriptSize(metadata?.sessionFile) };
			updateMetadata(this.runDir, { state: "busy", error: undefined, ...(deadline && { deadline }) });
			try {
				if (idle) {
					this.promptPendingSince = now;
					target.send(payload.message);
				} else {
					target.send(payload.message, payload.delivery === "followUp" ? "followUp" : "steer");
				}
				writeFileSync(path.replace(/\.json$/, HANDED), JSON.stringify(handed), { encoding: "utf8", mode: 0o600 });
				unlinkSync(path);
			} catch (error) {
				this.promptPendingSince = undefined;
				updateMetadata(this.runDir, {
					state: target.isIdle() ? "idle" : "busy",
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			}
		}
	}
}

/**
 * A message handed to Pi. Pi holds it in memory until its turn saves it to the transcript, and a quit drops it,
 * so its file stays until the transcript has it: `offset` is the transcript size when it was handed.
 */
interface HandedMessage {
	message: string;
	offset: number;
}

const HANDED = ".handed";

function transcriptSize(sessionFile: string | undefined): number {
	try {
		return sessionFile ? statSync(sessionFile).size : 0;
	} catch {
		return 0;
	}
}

/** The text of each user message in the transcript, with the byte offset of its line. */
function savedUserMessages(sessionFile: string): { text: string; offset: number }[] {
	let content: Buffer;
	try {
		content = readFileSync(sessionFile);
	} catch {
		return [];
	}
	const saved: { text: string; offset: number }[] = [];
	let offset = 0;
	for (const line of content.toString("utf8").split("\n")) {
		try {
			const message = (JSON.parse(line) as { message?: { role?: unknown; content?: unknown } }).message;
			if (message?.role === "user") saved.push({ text: messageText(message.content).trim(), offset });
		} catch {
			// Not a whole entry.
		}
		offset += Buffer.byteLength(line, "utf8") + 1;
	}
	return saved;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

/** The handed messages of a run, oldest first, each with whether the transcript has it. A saved message counts once. */
function handedMessages(runDir: string, sessionFile: string): { file: string; message: string; saved: boolean }[] {
	const dir = inboxDir(runDir);
	if (!existsSync(dir)) return [];
	const saved = savedUserMessages(sessionFile);
	return readdirSync(dir)
		.filter((entry) => entry.endsWith(HANDED))
		.sort()
		.flatMap((entry) => {
			const file = join(dir, entry);
			let handed: HandedMessage;
			try {
				handed = JSON.parse(readFileSync(file, "utf8")) as HandedMessage;
			} catch {
				return [];
			}
			const text = handed.message.trim();
			const match = saved.findIndex((entry) => entry.offset >= handed.offset && entry.text === text);
			if (match !== -1) saved.splice(match, 1);
			return [{ file, message: handed.message, saved: match !== -1 }];
		});
}

/**
 * The messages handed to the child that its transcript lacks: a quit dropped them from Pi's memory. A resume
 * sends them again after its own prompt. A leading space keeps Pi from reading a message that starts with `@` as a
 * file or with `/` as a command: the inbox sends them as plain text.
 */
export function unsavedMessages(runDir: string, sessionFile: string): string[] {
	return handedMessages(runDir, sessionFile)
		.filter((handed) => !handed.saved)
		.map((handed) => (/^[@/]/.test(handed.message) ? ` ${handed.message}` : handed.message));
}

/** The child calls this when a turn ends: drop the handed messages its transcript now has. */
export function forgetSavedMessages(runDir: string, sessionFile: string): void {
	for (const handed of handedMessages(runDir, sessionFile)) if (handed.saved) rmSync(handed.file, { force: true });
}
