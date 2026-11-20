import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Cross-process locks on a file, with Node built-ins only: the parent tick holds one on Pi's UI thread,
 * where a program start can take 2 s. The parent tick, the CLI, and the child each change one run's
 * metadata; without a lock, a write from an older read drops another process's change.
 *
 * A lock is a file that names its holder's process ID. It is made whole, then linked to its name, which
 * fails like `O_EXCL` when the name exists: a holder killed at any time leaves a lock with its ID, never
 * an empty one. A waiter takes it over when that process is gone, or when the file is older than
 * `ABANDONED_MS` (the ID was reused): a holder only reads and writes a small file. Waiting is synchronous,
 * as every caller is.
 */
const POLL_MS = 5;
/** Far above a real hold (a few ms), so a slow holder keeps its lock; below `TIMEOUT_MS`, so a lock whose process ID was reused is taken over before a waiter gives up. */
const ABANDONED_MS = 5000;
const TIMEOUT_MS = 6000;

/** Paths this process holds: a second take inside the first would wait for itself. */
const held = new Set<string>();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run `fn` while this process holds the lock at `path`. Undefined, with `fn` not run, when the directory
 * of `path` is gone (a removed run). Throws when another holder keeps the lock longer than `TIMEOUT_MS`,
 * and when `fn` takes the same lock again.
 */
export function withLock<T>(path: string, fn: () => T): T | undefined {
	if (held.has(path)) throw new Error(`pi-subagent: lock ${path} is taken again inside itself`);
	if (!acquire(path)) return undefined;
	held.add(path);
	try {
		return fn();
	} finally {
		held.delete(path);
		try {
			unlinkSync(path);
		} catch {
			// Removed with its run directory.
		}
	}
}

function acquire(path: string): boolean {
	const deadline = Date.now() + TIMEOUT_MS;
	for (;;) {
		const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
		try {
			writeFileSync(temporary, String(process.pid), { mode: 0o600 });
			linkSync(temporary, path);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return false;
			if (code !== "EEXIST") throw error;
		} finally {
			try {
				unlinkSync(temporary);
			} catch {
				// Not made: the run directory is gone.
			}
		}
		if (isAbandoned(path)) {
			// Two waiters can both see it abandoned; the second then removes the first's new lock. Rare:
			// it needs a dead holder and two waiters in the same few microseconds.
			try {
				unlinkSync(path);
			} catch {
				// Another waiter took it over first.
			}
			continue;
		}
		if (Date.now() > deadline) throw new Error(`pi-subagent: lock ${path} is held for more than ${TIMEOUT_MS} ms`);
		Atomics.wait(sleeper, 0, 0, POLL_MS);
	}
}

function isAbandoned(path: string): boolean {
	try {
		if (Date.now() - statSync(path).mtimeMs > ABANDONED_MS) return true;
		const pid = Number(readFileSync(path, "utf8"));
		return Number.isInteger(pid) && pid > 0 && !processExists(pid);
	} catch {
		// Gone since `open`: try again.
		return false;
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
