import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Cross-process locks on a file, with Node built-ins only: the parent tick holds one on Pi's UI thread,
 * where a program start can take 2 s. The parent tick, the CLI, and the child each change one run's
 * metadata; without a lock, a write from an older read drops another process's change.
 *
 * A lock is a file that names its holder: its process ID and a random token. It is made whole, then linked
 * to its name, which fails like `O_EXCL` when the name exists: a holder killed at any time leaves a lock
 * with its ID, never an empty one. A waiter takes a lock over only when its process is gone, never for its
 * age: a holder stalled for seconds (a stopped process, a sleeping laptop) still holds it, and two holders
 * at once would lose an update. An ID reused by a live process makes waiters time out, which changes
 * nothing. A holder removes only its own lock, so it never frees another holder's. Waiting is synchronous,
 * as every caller is.
 */
const POLL_MS = 5;
/** A real hold takes a few ms; a waiter outside the parent tick waits this long, then gives up and changes nothing. */
const TIMEOUT_MS = 6000;

/** Thrown when another live holder keeps the lock past the waiter's time: nothing was changed. */
export class LockBusyError extends Error {}

/** Paths this process holds: a second take inside the first would wait for itself. */
const held = new Set<string>();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** The end of the lock waits of the running `waitingAtMost`, if any. */
let scopeDeadline = Number.POSITIVE_INFINITY;

/**
 * Run `fn` with all its lock waits together limited to `ms`: the parent tick runs on Pi's UI thread, so it
 * gives up early and tries again on its next tick. A free lock is still taken after that time.
 */
export function waitingAtMost<T>(ms: number, fn: () => T): T {
	const before = scopeDeadline;
	scopeDeadline = Math.min(before, Date.now() + ms);
	try {
		return fn();
	} finally {
		scopeDeadline = before;
	}
}

/**
 * Run `fn` while this process holds the lock at `path`. Undefined, with `fn` not run, when the directory
 * of `path` is gone (a removed run). Throws `LockBusyError` when another holder keeps the lock longer than
 * the wait allows, and an error when `fn` takes the same lock again.
 */
export function withLock<T>(path: string, fn: () => T): T | undefined {
	if (held.has(path)) throw new Error(`pi-subagent: lock ${path} is taken again inside itself`);
	const owner = `${process.pid} ${Math.random().toString(36).slice(2)}`;
	if (!acquire(path, owner)) return undefined;
	held.add(path);
	try {
		return fn();
	} finally {
		held.delete(path);
		// Safe between the read and the unlink: this process lives, so no waiter takes its lock over.
		if (readLock(path) === owner) unlinkSync(path);
	}
}

function acquire(path: string, owner: string): boolean {
	const started = Date.now();
	const deadline = Math.min(Date.now() + TIMEOUT_MS, scopeDeadline);
	for (;;) {
		const linked = tryLink(path, owner);
		if (linked !== undefined) return linked;
		const holder = readLock(path);
		if (holder !== undefined && !holderLives(holder)) {
			removeDeadLock(path, holder);
			continue;
		}
		if (Date.now() > deadline) throw new LockBusyError(`pi-subagent: lock ${path} is held by a live process; gave up after ${Date.now() - started} ms and changed nothing`);
		Atomics.wait(sleeper, 0, 0, POLL_MS);
	}
}

/** True when this process now holds the lock, false when its directory is gone, undefined when it is held. */
function tryLink(path: string, content: string): boolean | undefined {
	const temporary = `${path}.${content.replace(" ", ".")}`;
	try {
		writeFileSync(temporary, content, { mode: 0o600 });
		linkSync(temporary, path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return false;
		if (code !== "EEXIST") throw error;
		return undefined;
	} finally {
		try {
			unlinkSync(temporary);
		} catch {
			// Not made: the run directory is gone.
		}
	}
}

/**
 * Remove the lock of a dead holder. Two waiters can both see it dead; the first then takes the lock, and
 * the second must not remove that new lock. So the removal holds a breaker lock, and removes only a lock
 * that still names the dead holder. A breaker of a dead process is removed as is: that needs a process
 * killed in the microseconds it holds one.
 */
function removeDeadLock(path: string, holder: string): void {
	const breaker = `${path}.break`;
	const owner = `${process.pid} ${Math.random().toString(36).slice(2)}`;
	const linked = tryLink(breaker, owner);
	if (linked === undefined) {
		const other = readLock(breaker);
		if (other !== undefined && !holderLives(other)) unlinkQuietly(breaker);
		Atomics.wait(sleeper, 0, 0, POLL_MS);
		return;
	}
	if (!linked) return;
	try {
		if (readLock(path) === holder) unlinkQuietly(path);
	} finally {
		if (readLock(breaker) === owner) unlinkQuietly(breaker);
	}
}

/** The holder named in the lock file; undefined when there is none. */
function readLock(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** A lock that names no valid process (a damaged file) has no live holder. */
function holderLives(holder: string): boolean {
	const pid = Number(holder.split(" ")[0]);
	return Number.isInteger(pid) && pid > 0 && processExists(pid);
}

function unlinkQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Removed by another process, or with its run directory.
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
