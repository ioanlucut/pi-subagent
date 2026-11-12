import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { inboxDir, updateMetadata, type InboxMessage } from "./shared.ts";

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

			updateMetadata(this.runDir, { state: "busy", error: undefined });
			try {
				if (idle) {
					this.promptPendingSince = now;
					target.send(payload.message);
				} else {
					target.send(payload.message, payload.delivery === "followUp" ? "followUp" : "steer");
				}
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
