---
name: subagent
description: Spawn and communicate with observable Pi subagents for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Delegate work to a separate Pi process with its own context and tmux session. Managed subagents cannot spawn nested subagents, and this skill is not loaded into their sessions.

Use the `subagent` tool first. It works when the `subagent` CLI is not on `PATH`, and it returns what the CLI prints. Its `action` is `spawn`, `list`, `status`, `wait`, `send`, `stop`, `resume`, `last`, or `agents`; its other fields are the CLI flags below in camel case:

```json
{ "action": "spawn", "name": "review", "tools": "read,grep,find,ls", "noMcp": true, "prompt": "Review the current diff" }
{ "action": "send", "handle": "a1b2c3", "followUp": true, "message": "Also check the tests" }
{ "action": "wait", "handle": "a1b2c3", "timeout": "600" }
```

`prompt` is one string; `files` is a list. Use the CLI second: when the tool is not available, and for `rename` and `interrupt`, which only the CLI has. Never run `node …/subagent.ts`. The examples below show the CLI; the same rules apply to the tool.

## Spawn

Give each child a short, descriptive name. The name appears in the parent UI, while the generated handle remains its stable identifier:

```sh
subagent spawn --name implementation --prompt "Complete task"
```

By default, the child inherits the current Pi provider, model, and reasoning level from the bash environment. Use `--provider`, `--model`, or `--thinking` only when deliberately choosing a different configuration, for example a faster model for simple investigation or a stronger model for difficult review. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back to the CLI explicitly.

When a role fits, use an agent file: run `subagent agents` to list them, then `subagent spawn --agent <name> --prompt "..."`. The file sets model, thinking, tools, extensions, MCP, time limit, and instructions; a flag you also give overrides it. An unknown name fails and starts nothing. A `project` agent file (from `.pi/agents/` in the repository) cannot load extensions or drop the command guard: `spawn` ignores its `extensions` and warns. A project agent file that is a symlink is skipped with a warning.

`--cwd` defaults to the current directory. For implementation work that edits files, give each child its own worktree: `--worktree <topic> [--base <branch>]` creates `<repo>/<topic>` under `$PI_SUBAGENT_WORKTREE_ROOT` (default `~/WORK/dev/.worktrees`) on a new branch `<topic>` (from the current branch by default) and starts the child there. It fails when that path has other work. If branch `<topic>` exists already (a merger's integration branch, a re-spawn), it uses that branch and ignores `--base`; if another worktree has the branch checked out, it fails and names that path, so use `--cwd <path>`. `subagent stop` keeps the worktree and branch. Repeat `--prompt` and `--file` as needed; Pi receives all of them in the first user turn. Run `subagent spawn` directly without piping or redirecting its concise output.

A child holds its slot, idle or busy, until you stop it, and a queued child starts only when a slot is free. So after a child's result is merged or no longer needed, `stop` it, also when another child waits. A `State: queued` line names the idle children that hold slots; a result message that ends with `stop <handle> when you need no follow-up` means a queued child waits for that slot.

Give a child that could get stuck a time limit: `--timeout <duration>`, such as `90s`, `10m`, or `1h`. Past it, a child that has not answered (also one that never started its first turn) is stopped and reported as `timed out`, with the path of its transcript, so it cannot block the run. A child that answered and is idle is not stopped; each new message starts the limit again.

## Tools

Without `--tools`, Pi enables its four default tools:

- `read` - Read text files and images.
- `bash` - Execute shell commands. This can also modify files, so it is not a read-only capability.
- `edit` - Apply exact text replacements to existing files.
- `write` - Create or overwrite files.

Three additional built-in tools are available but off by default:

- `grep` - Search file contents.
- `find` - Find files by glob pattern.
- `ls` - List directory contents.

`--tools` is a comma-separated allowlist across built-in, extension, and custom tools. Common choices:

```sh
# Enforced read-only repository investigation
--tools read,grep,find,ls

# Investigation that may run tests or other commands; bash can modify files
--tools read,bash,grep,find,ls

# Implementation work: omit --tools to use the defaults
```

## Isolation flags

- `--no-extensions` - Disable normal extension discovery. Use for an independent run that should not inherit unrelated extension behavior or extension-provided tools. The subagent control bridge and the command guard `cc-safety-net` still load.
- `--extensions <list>` - Light child: load only the listed extensions (comma-separated paths or `npm:` sources), plus the subagent control bridge and the command guard `cc-safety-net`. The command guard always stays: `spawn` refuses `-cc-safety-net` unless the user set `PI_SUBAGENT_ALLOW_UNGUARDED=1` before starting Pi. Do not ask for `-cc-safety-net` to get around a blocked command. Use for reviews and other runs that need few extensions. With `--no-extensions` or `--extensions`, `spawn` adds the extension that provides the child's provider; when none does, it fails at once naming the provider: drop the flag or pass a built-in `--provider`.
- `--no-mcp` - Start no MCP servers. Use for every child that does not need MCP tools: 10 children otherwise start 10 copies of each server.
- `--no-skills` - Hide installed skills from the child. Use for tightly specified tasks that should rely only on the supplied prompt and files.
- `--no-prompt-templates` - Disable prompt-template commands. Usually unnecessary, but useful when testing a minimal child environment.
- `--no-context-files` - Ignore repository instruction files such as `AGENTS.md` and `CLAUDE.md`. Use only when those instructions would bias an independent investigation. Do not use for implementation unless intentionally bypassing repository guidance.

Spawn prints a random handle and the exact tmux attach command. Past the parallel limit, spawn prints `State: queued`: the child starts by itself when a slot is free. Do not stop or spawn it again; stop the idle children it names that you are done with. Keep the handle for later commands. Subagents persist after their current turn completes: `wait`, completion, and becoming idle do not terminate them. They survive `/reload`. When the spawning Pi session quits or is replaced, or its process dies, they are suspended (another Pi on the same session leaves them running, and only the spawning Pi gets their results) and relaunched with their history, through the queue, when that session is resumed. A child that was idle comes back idle. A child that was working continues its task and its result arrives as usual, so keep waiting for it; do not spawn it again. Children suspended more than 24 h before stay `suspended` in `subagent list`; start one with `subagent resume <handle>` only when the user wants it back. `<handle> is already resumed` means another call started it: use it, do not resume it again. They are only removed by `subagent stop`.

## Get the result

When `spawn` prints `Result: arrives as a message when the turn ends`, do not run `subagent wait`. Continue with other work or end your turn. Each time a child ends a turn, you get a message that starts with `Subagent <name> (<handle>) finished`, `failed (error)`, `failed (aborted)`, `exited`, `timed out`, `failed to start` (with the error: a launch that failed, or a first prompt Pi rejected, such as no login for the provider), or `waits for project trust in <cwd>`, followed by its answer and `[The whole answer: <path>]`. An answer longer than 2,000 characters arrives as its start and `[First 2000 of <n> characters. The whole answer: <path>]`: read that file when you need the rest. A failed, exited, timed-out, or not started child gave no result: send the task again or report the gap, and never count it as a review that found nothing. For `failed to start`, fix the cause first (another provider or model) or the retry fails the same way. A child that waits for project trust keeps its slot: tell the user to answer in its pane, or stop it; never decide trust for the user. A `send` gets its answer the same way.

Without that line (print mode, a plain terminal, `PI_SUBAGENT_NOTIFY=0`), no message arrives: use `wait`.

```sh
subagent status <handle>
subagent list
subagent wait <handle>
```

Run `subagent list` at any time to rediscover active subagents and their handles, names, and current states if you no longer remember them.

`wait` follows the durable session state and prints the latest final assistant response. The first line is `<handle> finished`, or `<handle> failed (error)` or `failed (aborted)` with exit code 1 when the turn ended in a provider error or an abort, `<handle> timed out` with exit code 1 when the child passed its `--timeout`, or `<handle> failed to start` and the error with exit code 1 when a queued child could not start or Pi rejected its first prompt. A failed turn is no result: send the task again or report the gap, and never count it as a review that found nothing. Run it directly so the bash tool returns that response; do not redirect it to a file or pipe it unless the user explicitly asks for an artifact. Do not infer completion from captured terminal text. Set the bash timeout above `wait`'s default 1800-second deadline.

## Review with two or more children

When children review the same change on separate axes (for example Standards and Spec):

- Give each axis only its own questions. The Standards child reports no spec gaps; the Spec child reports no style smells. Findings both would make go to one named axis.
- Tell each child to run the repository's lint and the focused tests for the changed files, unless the user forbids checks. A finding from a failed command beats one from reading.
- Tell each child to search the repository for any name it proposes (`rg -n '<newName>'`) and to report a clash, not the rename, when the name is already in use.

## Watch in Herdr

Inside Herdr, the extension opens a read-only pane beside the parent for each working child and closes it when the child is idle or stopped. Do not open, focus, or close these panes yourself, and do not run `herdr` commands for them.

## Communicate

```sh
# Change the name shown in the parent UI.
subagent rename <handle> "new name"

# Idle: starts a new prompt. Busy: steers the current work.
subagent send <handle> "message"
# A message or prompt that starts with `--`: `send <handle> -- "--verbose please"`, `spawn --prompt="--force push"`.

# Busy: waits until current work finishes, then starts another turn.
subagent send <handle> --follow-up "message"

# Busy: ends the current turn, like Escape. The child stays, ready for `send`.
subagent interrupt <handle>

# Prints the state and latest answer, whole, without waiting.
subagent last <handle>
```

Names are 1–64 characters and need not be unique. Messages use the subagent extension's control inbox; do not use `tmux send-keys`.

## Stop

```sh
subagent stop <handle>
```

Explicitly stop every subagent when it is no longer needed; do not leave completed subagents running idle. This terminates tmux and removes its metadata. `stop` prints where the transcript went: cite that path when the user may want to read what the child did. A result not yet delivered as a message follows in the `stop` output; it does not arrive again. Keep an idle subagent alive only when concrete follow-up work is expected, then stop it afterward.

The interactive `/subagent` command lists active subagents spawned by the current Pi session. Selecting one suspends the current Pi TUI and attaches to its tmux session; detaching returns to the parent Pi. When the parent already runs inside tmux, selection switches the current tmux client instead.
