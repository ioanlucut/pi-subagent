import { existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, matchesGlob, relative, resolve, sep } from "node:path";
import { getAgentDir } from "./shared.ts";

/** An extension file Pi would load at start, from a package of its `settings.json` or its global `extensions` directory. */
export interface PiExtension {
	path: string;
	/** False when the user turned it off: a package filter or `settings.json` `extensions` (`pi config`). */
	enabled: boolean;
	/** The package root, or the entry of the global `extensions` directory, the file came from. */
	owner: string;
}

interface PackageEntry {
	source: string;
	/** The object form `{ source, ... }`: Pi then never loads the package root itself. */
	object: boolean;
	/** The package's `extensions` filter in `settings.json`; undefined: all the package declares. */
	filter?: string[];
	/** `autoload: false`: only what the filter names. */
	delta: boolean;
}

/**
 * Each extension file Pi finds in the user's packages and global `extensions` directory, in Pi's order, with
 * whether it is enabled. It follows Pi's package manager (1.5, "Select package resources" in `docs/packages.md`)
 * without running any of them: a light child and provider discovery must not load an extension the user turned off.
 */
export function piExtensions(): PiExtension[] {
	const agentDir = getAgentDir();
	let settings: { packages?: unknown; extensions?: unknown } = {};
	try {
		settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) ?? {};
	} catch {
		// No settings: no packages and no overrides.
	}
	const packages = (Array.isArray(settings.packages) ? settings.packages : []).flatMap((entry) => {
		const parsed = packageEntry(entry);
		return parsed ? packageExtensions(parsed) : [];
	});
	const overrides = stringList(settings.extensions) ?? [];
	const globalDir = join(agentDir, "extensions");
	const global = autoExtensionEntries(globalDir).map((path) => ({
		path,
		enabled: enabledByOverrides(path, overrides, agentDir),
		owner: join(globalDir, relative(globalDir, path).split(sep)[0]),
	}));
	return [...packages, ...global];
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function packageEntry(entry: unknown): PackageEntry | undefined {
	if (typeof entry === "string") return { source: entry, object: false, delta: false };
	const object = entry as { source?: unknown; extensions?: unknown; autoload?: unknown } | null;
	if (typeof object?.source !== "string") return undefined;
	return { source: object.source, object: true, filter: stringList(object.extensions), delta: object.autoload === false };
}

/** Where Pi keeps a package of its `settings.json`, after Pi's package manager: npm, git, or a local path. */
function packagePath(source: string): string {
	const agentDir = getAgentDir();
	if (source.startsWith("npm:")) {
		const spec = source.slice(4).trim();
		const at = spec.indexOf("@", 1);
		return join(agentDir, "npm", "node_modules", at === -1 ? spec : spec.slice(0, at));
	}
	const git = /^(?:git:|[a-z+]+:\/\/|git@)(?:[^@/]+@)?([^/:]+)[/:]([^@]+?)(?:\.git)?(?:@.*)?$/.exec(source);
	if (git) return join(agentDir, "git", git[1], git[2]);
	return resolve(agentDir, source.replace(/^~(?=\/|$)/, homedir()));
}

function packageExtensions({ source, object, filter, delta }: PackageEntry): PiExtension[] {
	const root = packagePath(source);
	if (!existsSync(root)) return [];
	if (statSync(root).isFile()) return [{ path: root, enabled: true, owner: root }];
	const manifest = piManifest(root);
	const files = declaredExtensions(root, manifest, object);
	// Pi loads a local directory with no resources at all, listed as a plain string, as one extension.
	if (files === undefined) return !object && isLocal(source) ? [{ path: root, enabled: true, owner: root }] : [];
	if (delta) {
		const enabled = new Map<string, boolean>();
		for (const pattern of filter ?? []) {
			const exact = /^[+-]/.test(pattern);
			const target = /^[!+-]/.test(pattern) ? pattern.slice(1) : pattern;
			for (const path of files)
				if (exact ? matchesExact(path, [target], root) : matches(path, [target], root)) enabled.set(path, !/^[!-]/.test(pattern));
		}
		return [...enabled].map(([path, on]) => ({ path, enabled: on, owner: root }));
	}
	const on = filter === undefined ? new Set(files) : filter.length === 0 ? new Set<string>() : applyPatterns(files, filter, root);
	return files.map((path) => ({ path, enabled: on.has(path), owner: root }));
}

/**
 * The extension files a package declares: its `pi.extensions` manifest, else its `extensions` directory. A manifest
 * that lists other resources only declares none, unless the package has the object form. Undefined: no resource at all.
 */
function declaredExtensions(root: string, manifest: Record<string, unknown> | undefined, object: boolean): string[] | undefined {
	const entries = stringList(manifest?.extensions);
	if (entries?.length) {
		const files = entries
			.filter((entry) => !/^[!+-]/.test(entry))
			.flatMap((entry) => (/[*?]/.test(entry) ? globSync(entry, { cwd: root }).sort().map((match) => resolve(root, match)) : [resolve(root, entry)]))
			.flatMap((path) => {
				if (!existsSync(path)) return [];
				return statSync(path).isDirectory() ? autoExtensionEntries(path) : [path];
			});
		const overrides = entries.filter((entry) => /^[!+-]/.test(entry));
		return overrides.length > 0 ? [...applyPatterns(files, overrides, root)] : files;
	}
	const resources = ["extensions", "skills", "prompts", "themes"];
	if (entries || (!object && resources.some((type) => manifest?.[type] !== undefined))) return [];
	if (existsSync(join(root, "extensions"))) return autoExtensionEntries(join(root, "extensions"));
	return object || resources.some((type) => existsSync(join(root, type))) ? [] : undefined;
}

function isLocal(source: string): boolean {
	return !/^(?:npm:|git:|git@|[a-z+]+:\/\/)/.test(source);
}

function piManifest(dir: string): Record<string, unknown> | undefined {
	try {
		return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { pi?: Record<string, unknown> }).pi;
	} catch {
		return undefined;
	}
}

/** The entry files of an extension directory: its manifest or `index`, else each `.ts`/`.js` file and each such directory in it. */
function autoExtensionEntries(dir: string): string[] {
	const own = entryFiles(dir);
	if (own) return own;
	try {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
			const path = join(dir, entry.name);
			const stat = statSync(path, { throwIfNoEntry: false });
			if (stat?.isFile() && /\.[jt]s$/.test(entry.name)) return [path];
			return stat?.isDirectory() ? (entryFiles(path) ?? []) : [];
		});
	} catch {
		return [];
	}
}

function entryFiles(dir: string): string[] | undefined {
	const declared = (stringList(piManifest(dir)?.extensions) ?? []).map((path) => resolve(dir, path)).filter((path) => existsSync(path));
	if (declared.length > 0) return declared;
	const index = ["index.ts", "index.js"].map((name) => join(dir, name)).find((path) => existsSync(path));
	return index ? [index] : undefined;
}

function matches(path: string, patterns: string[], base: string): boolean {
	return patterns.some((pattern) => [relative(base, path), basename(path), path].some((candidate) => matchesGlob(candidate, pattern)));
}

function matchesExact(path: string, patterns: string[], base: string): boolean {
	return patterns.some((pattern) => [relative(base, path), path].includes(pattern.replace(/^\.\//, "")));
}

/** Pi's filter: plain patterns include (none: all), `!` excludes, `+` adds back one exact path, `-` removes one. */
function applyPatterns(paths: string[], patterns: string[], base: string): Set<string> {
	const of = (prefix: string) => patterns.filter((pattern) => pattern.startsWith(prefix)).map((pattern) => pattern.slice(1));
	const includes = patterns.filter((pattern) => !/^[!+-]/.test(pattern));
	let result = includes.length === 0 ? paths : paths.filter((path) => matches(path, includes, base));
	result = result.filter((path) => !matches(path, of("!"), base));
	result = [...result, ...paths.filter((path) => !result.includes(path) && matchesExact(path, of("+"), base))];
	return new Set(result.filter((path) => !matchesExact(path, of("-"), base)));
}

/** `settings.json` `extensions` for the global directory: only `!`, `+`, and `-` turn a file off or on. */
function enabledByOverrides(path: string, patterns: string[], base: string): boolean {
	const of = (prefix: string) => patterns.filter((pattern) => pattern.startsWith(prefix)).map((pattern) => pattern.slice(1));
	let enabled = !matches(path, of("!"), base);
	if (matchesExact(path, of("+"), base)) enabled = true;
	if (matchesExact(path, of("-"), base)) enabled = false;
	return enabled;
}
