# Pi Subagent

Observable, persistent [Pi](https://pi.dev) subagents for independent reviews, investigations, and delegated implementation.

Each subagent is a full Pi in its own tmux session, with its own JSONL transcript. The parent starts it with the `subagent` model tool or the `subagent` CLI, keeps working, and gets the child's answer as a chat message. You can watch each child, steer it, attach to it, or stop it. A child is a normal, full Pi, not a stripped-down tool call.

## Features

| Area | What you get |
| --- | --- |
| **Delegate** | A `subagent` model tool and a `subagent` CLI with the same actions: `spawn`, `list`, `status`, `wait`, `send`, `stop`, `resume`, `last`, `agents`. The bundled skill teaches the model when and how to use them. |
| **Results** | Each finished turn arrives in the parent chat as a message, so the parent does not block. A long answer arrives as its first 2,000 characters and the path of a file with the whole answer. `subagent last` prints it whole. |
| **Steer** | `send` starts a new turn or steers a busy one; `--follow-up` queues a turn; `interrupt` ends a busy turn, like Escape. |
| **Watch** | One row per child below the editor: state, time, last action, tokens, cost. Inside [Herdr](https://github.com/herdrdev/herdr), each working child opens in a read-only pane beside the parent. `/subagent` attaches to a child's TUI. |
| **Queue** | At most 4 children of one session run at once (`subagentLimit`). The rest queue and start by themselves, in order, when a slot is free. |
| **Time limits** | `--timeout 10m` stops a child that is still working at its deadline and reports it as `timed out`. An idle child that has answered is not stopped. |
| **Roles** | Agent files in `~/.pi/agent/agents/` or a project's `.pi/agents/` hold a role's model, thinking level, tools, extensions, and instructions: `spawn --agent implementer`. A project agent file cannot load code. |
| **Light children** | `--extensions <list>` loads only the listed extensions; `--no-mcp` starts no MCP servers. The command guard `cc-safety-net` stays in each light child. |
| **Worktrees** | `--worktree <topic> --base <branch>` gives a child its own Git worktree and branch under `~/WORK/dev/.worktrees/<repo>/<topic>`, so parallel implementers do not conflict. |
| **Lifecycle** | Quitting the parent suspends its children; resuming the parent session starts them again with their full history. A parent that dies leaves no running children: the next Pi suspends them. Transcripts stay after `stop`, and `pi --resume` can continue them. |
| **Fast parent** | The parent checks its children with no program start, and only while it has children. A session with no children does no subagent work. On a busy machine this was the difference between a frozen Pi and a responsive one. |
| **Safe in parallel** | Parallel `spawn`, two `resume` of one child, and two Pi on one session keep the limit and never start a child twice: every change to a run happens under a lock. |
| **Right environment** | A child gets the environment of the shell that started it, not of the tmux server, so it uses the same logins (`PI_CODING_AGENT_DIR`) and `PATH`. |
| **Verified** | `npm test` (166 tests), `npm run verify:spec`, and `npm run verify:e2e` (real Pi processes, a fake model, no login), the last two also in CI. See Development. |

This is a fork of [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent) by [Mario Zechner](https://mariozechner.at). Upstream has issues and pull requests disabled, so the changes live here. Upstream gives each child a tmux session and its transcript, the CLI (`spawn`, `list`, `status`, `wait`, `send` with `--follow-up`, `stop`), attaching to a child's TUI, and suspend and resume with the parent session. This fork adds the rest of the table, including the model tool, result messages, the rows and Herdr panes, the queue, time limits, agent files, light children, worktrees, the fast parent, and the locks. Two upstream bugs are fixed:

| Issue                                                   | Upstream behaviour                                                                                                                                           | Here                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [#1](https://github.com/ioanlucut/pi-subagent/issues/1) | A child takes the environment of whatever process started the tmux server, so it can run with another `PI_CODING_AGENT_DIR` (other logins) or an old `PATH`. | A child gets the environment of the shell that ran `subagent spawn`.                  |
| [#2](https://github.com/ioanlucut/pi-subagent/issues/2) | Children keep running when the parent dies without quitting (crash, `kill -9`, closed terminal). Quitting stops children one by one, 2 s each.               | The next Pi to start suspends orphaned children. Quitting stops all children at once. |

## Requirements

- Pi
- Node.js 22.19 or newer (`subagent` is a TypeScript file run by `node`)
- tmux

## Install

Clone the fork and add it to `packages` in `~/.pi/agent/settings.json`:

```sh
git clone git@github.com:ioanlucut/pi-subagent.git ~/WORK/dev/pi-subagent
```

```json
{ "packages": ["/Users/<you>/WORK/dev/pi-subagent"] }
```

Pi installs no package `bin` entries, so link the CLI into a directory on your `PATH`:

```sh
ln -s ~/WORK/dev/pi-subagent/subagent.ts ~/.local/bin/subagent
```

Run `/reload` in each open Pi. The extension brings its own `subagent` skill and a `subagent` model tool, so the model in Pi can delegate without more setup, even when the CLI is not on `PATH`. To check: `subagent list` prints `No subagents`.

## First run

Ask Pi in plain words ("get a second opinion on this diff"). The model runs the CLI with its bash tool, for example:

```sh
subagent spawn --name review --tools read,grep,find,ls --prompt "Review the current diff independently"
# Spawned review (a1b2c3)
# State: busy
# Attach: tmux attach -t pi-subagent-a1b2c3

subagent wait a1b2c3    # blocks until the child is idle, then prints its final answer
subagent stop a1b2c3    # removes the child and its tmux session; keeps its transcript
```

The model can do the same with the `subagent` tool, for example `{ "action": "spawn", "name": "review", "tools": "read,grep,find,ls", "prompt": "Review the current diff independently" }`. The tool runs the CLI that ships with the extension and returns what the CLI prints; it takes the parent session, provider, model, thinking level, and directory from Pi, as the bash tool does. Its actions are `spawn`, `list`, `status`, `wait`, `send`, `stop`, `resume`, `last`, and `agents`, and its fields are the spawn options in camel case (`noMcp` for `--no-mcp`, `files` for `--file`). `rename` and `interrupt` stay CLI only.

Let the model run `spawn`. Only Pi's bash tool and the `subagent` tool set the parent session, provider, model, and thinking level that `spawn` reads. A `!` command or another terminal does not: there `spawn` fails unless you pass `--provider` and `--model`, the child has no parent session, so it is never suspended or resumed, and `subagent list` shows the children of all sessions. Stop such children yourself.

## Commands

| Command                                                          | Effect                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent spawn [options] (--prompt <text> \| --file <path>)...` | Start a child, or queue it past the limit (see below). Prints its handle and the tmux attach command.                                                                          |
| `subagent list`                                                  | Handles, names, states, and models of this session's children (outside Pi: all).                                                                                                |
| `subagent status <handle>`                                       | One child's state and model.                                                                                                                                                    |
| `subagent wait <handle> [--timeout <seconds>]`                   | Block until the child is idle, then print its last answer. Default timeout 1800 s. A turn that ended in a provider error or abort prints `<handle> failed (error)` and exits 1. A child past its `spawn --timeout` is stopped and prints `<handle> timed out`, exit 1. A queued child whose launch failed prints `<handle> failed to start` and the error, exit 1. |
| `subagent send <handle> <message>`                               | Idle child: start a new turn. Busy child: steer the current turn.                                                                                                               |
| `subagent send <handle> --follow-up <message>`                   | Busy child: queue a turn after the current one.                                                                                                                                 |
| `subagent rename <handle> <name>`                                | Change the name shown in the parent UI.                                                                                                                                         |
| `subagent last <handle>`                                         | Print the child's state and latest answer. Does not wait.                                                                                                     |
| `subagent interrupt <handle>`                                    | End a busy child's turn, like Escape in its TUI. The turn ends as `failed (aborted)`; the child stays, ready for `send`.                                      |
| `subagent stop <handle>`                                         | Remove the child. Its transcript stays, see Lifecycle. A queued child is removed before it starts. A result the parent has not got as a message yet is printed after `Stopped`, and is not sent again. |
| `subagent resume <handle>`                                       | Start a suspended child, such as one suspended more than 24 h ago. It queues past the limit, as `spawn` does. Of two `resume` of one child at once, one starts it; the other prints `<handle> is already resumed`. |
| `subagent agents`                                                | Name, scope (`project` or `global`), and description of each agent file, see Agent files.                                                                       |
| `/subagent` (in Pi)                                              | Pick a child and attach to its TUI. Detach to return; inside tmux, `tmux switch-client -l`.                                                                                     |

Below the Pi editor, each child has one row: its state, name, time in the current turn, last tool call or answer, and its output tokens and cost so far. Children after the fifth are counted.

```text
⟳ review-spec  1m05s  bash npm test               ↓12k $0.42
✓ standards           No findings.                ↓900 $0.02
```

### At most 4 children run at once

In the TUI and in RPC mode, at most 4 children of one parent session run at the same time, also when several `spawn` run at once, or two Pi of one session start queued children. A `spawn` past the limit returns at once with `State: queued`; the parent starts queued children in the order they were spawned, each within a second of a free slot. A child holds its slot while it runs, idle or busy, until it is stopped or exits. `list`, `status`, and the rows below the editor show `queued`; `stop` removes a queued child before it starts. To change the limit, set `subagentLimit` in `~/.pi/agent/settings.json` (`{ "subagentLimit": 2 }`); `PI_SUBAGENT_LIMIT`, set before you start Pi, overrides it. A `spawn` outside such a Pi (a plain terminal, print mode) starts the child at once, since nothing would start it later.

### Results arrive as messages

In the TUI and in RPC mode, the parent agent does not block on `wait`. Each time a child ends a turn, its answer arrives in the parent chat as a message:

```text
Subagent review-spec (a1b2c3) finished

<the child's answer>
```

The first line ends with `finished`, `failed (error)`, `failed (aborted)`, `exited` (the process ended and nobody stopped it), `timed out` (it passed its `--timeout` and was stopped; the message gives the transcript path), or `failed to start` (a queued child whose launch failed; the message gives the error). Each answer ends with the path of a file that holds it whole, beside the place `stop` keeps the transcript (`<time>_<id>.answers/` in Pi's sessions), so the path stays valid after `stop`. An answer longer than 2,000 characters arrives as its first 2,000 characters and that path; `subagent last` also prints it whole. An idle parent starts a turn for the message; a busy parent gets it when its current work is done. Results of several children that are ready at the same time arrive as one message. A result that `subagent wait` or `subagent stop` prints is not sent again.

Set `PI_SUBAGENT_NOTIFY=0` before you start Pi to turn the messages off. Print and JSON modes end with the turn, so there the agent uses `wait`.

### Watch children in Herdr

When the parent Pi runs in [Herdr](https://github.com/herdrdev/herdr), each working child opens in a pane in the same tab, beside the parent pane. The first child pane goes on the right of the parent; more children stack below it, each with the same height. Each pane:

- shows the child's live TUI, read-only (`tmux attach -r`), so keys cannot reach the child
- is marked as disposable: the border label `◆ subagent <name>`, a violet `SUBAGENT <name> · read-only · closes when done` bar, and a lavender background. When you attach with `/subagent`, keys reach the child and the bar shows only `SUBAGENT <name>`.
- closes when the child becomes idle, exits, or is stopped, and opens again on the child's next turn

The parent keeps focus. Set `PI_SUBAGENT_HERDR_PANES=0` before you start Pi to turn the panes off.

## Spawn options

| Option                                 | Default                                              | Use                                                                                   |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `--agent <name>`                       | none                                                 | Apply an agent file, see Agent files. The other flags override it.                    |
| `--name <name>`                        | the handle                                           | Label in the UI, 1 to 64 characters.                                                  |
| `--provider`, `--model`                | the parent's                                         | Pick another model. Required for independent opinions.                                |
| `--thinking <level>`                   | the parent's, else `medium`                          | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.                            |
| `--cwd <dir>`                          | current directory                                    | Where the child works.                                                                |
| `--worktree <topic>`                   | off                                                  | Create `~/WORK/dev/.worktrees/<repo>/<topic>` on a new branch `<topic>` and work there. Set `PI_SUBAGENT_WORKTREE_ROOT` to use another root than `~/WORK/dev/.worktrees`. Reuses a clean worktree of that branch; fails if the path has other work. `stop` keeps it. |
| `--base <branch>`                      | the current branch                                   | With `--worktree`: where the new branch starts.                                       |
| `--tools <names>`                      | Pi's default tools (`read`, `bash`, `edit`, `write`) | Comma-separated allowlist. `read,grep,find,ls` is read-only. `bash` can change files. |
| `--prompt <text>`                      |                                                      | Repeatable. All prompts go into the first turn.                                       |
| `--file <path>`                        |                                                      | Repeatable. Attached to the first turn.                                               |
| `--no-context-files`                   | off                                                  | Ignore `AGENTS.md` and `CLAUDE.md`, for a review those must not bias.                 |
| `--no-extensions`                      | off                                                  | No extensions except the subagent control bridge.                                     |
| `--extensions <list>`                  | all extensions                                       | Comma-separated paths or sources (`npm:…`). Loads only those, plus this extension and the command guard `cc-safety-net` from Pi's `packages` (npm, git, or local path); `-cc-safety-net` in the list drops the guard. When `packages` has no guard, `spawn` prints a warning. |
| `--no-mcp`                             | off                                                  | Start no MCP servers. With `--extensions`, a light child that starts fast.            |
| `--no-skills`, `--no-prompt-templates` | off                                                  | Strip skills or prompt templates.                                                     |
| `--timeout <duration>`                 | none                                                 | Time limit such as `90s`, `10m`, or `1h`, counted from each launch and from each new turn of an idle child. A child still working past it is stopped and reported as `timed out`; its run and transcript stay. A child that answered and is idle is not stopped. |

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `subagentLimit` in `~/.pi/agent/settings.json` | `4` | Children of one parent session that run at once; the rest queue. |
| `PI_SUBAGENT_LIMIT` | unset | Overrides `subagentLimit`. Set it before you start Pi. |
| `PI_SUBAGENT_NOTIFY=0` | on | No result messages in the parent chat; use `wait`. |
| `PI_SUBAGENT_HERDR_PANES=0` | on inside Herdr | No Herdr pane per working child. |
| `PI_SUBAGENT_WORKTREE_ROOT` | `~/WORK/dev/.worktrees` | Root for `--worktree`; the worktree is `<root>/<repo>/<topic>`. |
| `PI_SUBAGENT_PI` | `pi` | The program a child runs, for tests. |

`PI_SUBAGENT_PARENT_PID`, `PI_SUBAGENT_PARENT_STARTED`, `PI_SUBAGENT_QUEUE`, `PI_SUBAGENT_RUN_DIR`, and `PI_SUBAGENT_NESTED` pass state between the parent, the CLI, and the child; the package sets them, do not set them yourself.

## Agent files

An agent file holds a role, so each `spawn` does not repeat its settings. `subagent spawn --agent implementer` reads `implementer.md` from `.pi/agents/` in the current directory, then from `~/.pi/agent/agents/`. A project file overrides a global file with the same name. An unknown name fails and starts nothing.

A project agent file comes from the repository, not from you, so it cannot load code: `spawn` ignores its `extensions` field, keeps the default extensions and the command guard, and prints one warning that names the file. Only a global agent file or `--extensions` on `spawn` loads extensions.

```markdown
---
name: implementer
description: Implements one ticket in its worktree
model: anthropic/claude-opus-5-5
thinking: high
tools: read, bash, edit, write
extensions: npm:pi-web-access, ./my-extension.ts
mcp: false
---
Load the tdd skill. Commit with a conventional message.
```

| Field         | Same as                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| `name`        | `--agent <name>`. Default: the file name without `.md`.                       |
| `description` | The text `subagent agents` shows.                                             |
| `model`       | `--provider` and `--model` for `provider/model`, else `--model`.              |
| `thinking`    | `--thinking`                                                                  |
| `tools`       | `--tools`                                                                     |
| `extensions`  | `--extensions`. A relative path is relative to the agent file. Global only.   |
| `mcp`         | `false` is `--no-mcp`.                                                        |
| `timeout`     | `--timeout`                                                                   |
| body          | Added to the child's first prompt, before the `--prompt` text.                |

Flags on `spawn` override the file: `--agent implementer --model x` uses model `x`. `--extensions` or `--no-extensions` replaces the file's extensions.

## Recipes

### Review a plan before you build it

Have Pi write the plan to `changes.md` with every claim as `path:line`. Then give it to a reviewer on another model:

```sh
subagent spawn --name review-fable --provider anthropic --model claude-fable-5-1 \
  --tools read,grep,find,ls --file changes.md \
  --prompt "Review this plan against the code: wrong path:line claims, missed call sites, contradictions, designs that won't work as written."
```

### Audit with three models

One reviewer finds some bugs and misses others. Different models miss different bugs. Paste this into Pi and replace `<TARGET>` with a branch, a diff, a plan file, or a directory:

```text
Audit <TARGET> using three independent subagents:

- audit-sol: --provider openai-codex --model gpt-6.1-sol
- audit-astra: --provider openai-codex --model gpt-6-astra
- audit-opus: --provider amazon-bedrock --model eu.anthropic.claude-opus-5-5

Spawn each with --thinking high --tools read,grep,find,ls.

Give each the same instructions: Read repository instructions. Audit the target
against the actual code, following callers, dependencies, configuration, and
tests. Find concrete bugs, missed call sites, broken contracts, security issues,
contradictions, and designs that will not work as written. Verify any path:line
claims. Report only actionable findings with severity, exact path:line,
evidence, triggering scenario, impact, and smallest viable fix. Separate
evidence from speculation and state what remains unverified. No stylistic
nitpicks. Do not modify files.

Wait for all three. Verify and deduplicate their findings against the code; do
not decide by majority vote. Return confirmed findings by severity, disputed
concerns, and coverage limits. Stop all three subagents afterward. Do not
implement fixes.
```

Why it is written this way:

- **Explicit `--provider` and `--model`.** Without them, each child inherits the parent's model, and three copies of one model give one opinion three times.
- **`--tools read,grep,find,ls`.** The reviewers cannot change files, so they can run while you keep working.
- **No majority vote.** One correct finding beats two wrong agreements. The parent checks each finding against the code itself.
- **Stop them afterward.** Children live until `subagent stop`, also after they finish.

The short form, from Mario Zechner, the upstream author ([how i use subagents 99.99% of the time](https://x.com/badlogicgames/status/2110112810420351326)):

```text
Audit using three independent subagents:

- audit-sol: --provider openai-codex --model gpt-6.1-sol
- audit-astra: --provider openai-codex --model gpt-6-astra
- audit-opus: --provider amazon-bedrock --model eu.anthropic.claude-opus-5-5

Spawn each with --thinking high --tools read,grep,find,ls.

Wait for all three. Verify and deduplicate their findings against the code; do
not decide by majority vote. Return confirmed findings by severity, disputed
concerns, and coverage limits. Stop all three subagents afterward. Do not
implement fixes.
```

Use the model names your Pi has. `pi --list-models` shows them.

### Hand off implementation

Omit `--tools` so the child can edit, and give it the spec as a file:

```sh
subagent spawn --name implement --file /tmp/spec.md \
  --prompt "Implement this specification" --prompt "Run the targeted tests"
```

Two children that edit the same checkout will conflict. Give each its own worktree with `--worktree`:

```sh
subagent spawn --name impl-17 --cwd ~/WORK/dev/my-app --worktree 17_login --base main --file /tmp/spec.md
```

The child works in `~/WORK/dev/.worktrees/my-app/17_login` on branch `17_login`. `subagent stop` keeps the worktree and the branch; merge and remove them with Git.

`PI_SUBAGENT_PI` names the program a child runs in place of `pi`, for tests. Upstream ran an executable `pi-test.sh` from `--cwd`, so a cloned repository could choose the program; this fork does not.

## Lifecycle

| Event                                                                  | What happens to children                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The child finishes its turn                                            | It stays `idle` and keeps its context, ready for `send`.                                                                                |
| `/reload` in the parent                                                | Nothing. Children keep running.                                                                                                         |
| The parent quits or switches session                                   | Running and queued children are suspended: the process stops, transcript and metadata stay. Children that already exited on their own are removed, except one with a result not sent yet: it stays until the resumed session sends it. A child whose lock a stalled process holds is still stopped, and reported once; the others are suspended. |
| The parent dies without quitting                                       | The next Pi to start, in any session, suspends them.                                                                                    |
| The parent session starts again (`pi --resume`, `pi --session <file>`) | Children suspended in the last 24 h start again through the queue, idle, with their full history. Older ones stay suspended until `subagent resume`. |
| `subagent stop`                                                        | Removed: tmux session and metadata. A transcript with an answer is copied first, see below.                                             |
| A Pi starts, in any session                                            | Children with no running process and no change for 14 days are removed. A child tmux session whose run directory is gone is ended.     |

A removed child's transcript goes to Pi's sessions for its working directory, under its Pi session ID: `~/.pi/agent/sessions/--<cwd>--/<time>_<id>.jsonl`. `stop` prints the path. `pi --resume` in that directory lists it, so you can read what the child did, or continue it as a normal session. A child that never answered leaves no transcript.

A suspended child shows as `suspended` in `list` and `status`, is hidden from the rows below the editor and `/subagent`, and refuses `send` and `wait` until its parent session starts again or `subagent resume` starts it. Children cannot spawn their own subagents. A Pi that a child starts from its tools (a test, a script) is not that child and cannot spawn subagents.

## How it works

```text
parent Pi ── tool or bash: subagent spawn ──►   ~/.pi/agent/subagents/<handle>/
   │                                            metadata.json   state, model, parent
   │                                            metadata.lock   while a process changes metadata.json
   │                                            launch.json     the caller's environment, until tmux starts the child
   │                                            alive           FIFO the child holds open while it runs
   │                                            session.jsonl   the child's transcript
   │                                            inbox/          messages from `send`
   │                                            outbox/         results for the parent
   │                                            answers/        answers, before the transcript has a header
   │
   └─ extension: child rows, /subagent,        tmux session pi-subagent-<handle>
      suspend and resume                         └─ launcher.ts ─► pi (the child)
```

- `subagent.ts` is the CLI. It writes the run directory and starts the tmux session.
- `tool.ts` is the `subagent` model tool, with its parameters in `tool-schema.ts`. It runs `subagent.ts` with the session, model, and directory from Pi's tool context, so the tool and the CLI share one code path.
- `index.ts` is the extension. In the parent it shows one row per child, adds `/subagent`, and suspends and resumes children. In the child it keeps `metadata.json` up to date, with the child's process ID, and holds the run's `alive` FIFO open.
- `tick.ts` is the parent's one tick for the rows, the Herdr panes, the results, the time limits, and the queue. It runs each second only while the session has a child (queued ones included) or a result to send; it starts again when a tool call (`subagent spawn`) ends. A session with no children does no subagent work.
- Each second the parent checks whether each child runs, with no program started: it opens the run's `alive` FIFO for writing without blocking, which fails when no process holds its read end. The child holds it from its start, and the kernel closes it when the child ends, also on `kill -9`, so a process that later gets the child's ID does not count. (On macOS only a program such as `ps` can read another process's start time.) On a busy macOS any program start can take a second, and these checks run on Pi's UI thread. A child that has not recorded its process ID yet counts as running for 30 s after its launch, and as exited after that, also with no program started. Only a run made by an older version, which has no process ID field or no FIFO, still asks tmux. A child stopped at its time limit costs one `tmux kill-session`, once. That call, and the `tmux new-session` of a queued child, run as child processes: the tick takes the slot under the session lock and returns, and a start that fails is reported when tmux ends.
- `inbox.ts` gives the messages in `inbox/` to the child, oldest first.
- `widget.ts` reads each child's transcript for the rows: last action, tokens, cost.
- `outbox.ts` is the way back: the child writes each turn's result to `outbox/`, and the parent extension puts it into the chat and deletes the file.
- `launcher.ts` runs inside the tmux pane. tmux gives a new pane the tmux server's environment, so the CLI saves the caller's environment in a private `launch.json`, before the run can queue: the tick starts no queued run without it. The launcher restores it, deletes the file, and becomes `pi`.
- `lock.ts` is the lock for `metadata.json`: the parent tick, the CLI, and the child each change it, so each change reads, changes, and writes it under one lock per run, and no change is lost. The lock is a file with the holder's process ID and a random token, linked to its name, which fails like `O_EXCL` when it exists. A lock is taken over only when its process is gone, never for its age, and a holder removes only a lock that still has its own token. A waiter that cannot get a lock in 6 s fails and changes nothing; the parent tick waits at most 200 ms in all and tries again on its next tick, so a stalled holder does not freeze Pi. It starts no program. The same lock exists for a whole parent session, in `subagents/session-<hash>.lock`; `spawn`, `resume`, and the tick count and claim slots under it; they ask tmux about runs of an older version before they take that lock, so the lock holds for milliseconds. A quit waits at most 200 ms for each run's lock: a run it cannot lock is still stopped, and reported once.
- `wait` reads the child's state from `metadata.json` and its answer from `session.jsonl`, never from the terminal screen.

Run directories live under `$PI_CODING_AGENT_DIR/subagents` (default `~/.pi/agent/subagents`), mode `0700`.

## Development

```sh
npm test
```

The tests use `node --test` with no dependencies. Each test starts its own tmux server on a private socket (`TMUX_TMPDIR`) and a fake `pi` that records what it got, so they touch no real session and need no model.

```sh
npm run verify:spec
```

The spec check proves [#14](https://github.com/ioanlucut/pi-subagent/issues/14) on this machine, with no model and no login. It starts real `sleep` processes as children and a `tmux` that records each call, in a temporary agent directory. It prints one `ok` or `FAIL` line per claim and exits with the number of failures:

- 10 ticks with 3 live children start no `tmux`, and one tick blocks the UI thread for less than 50 ms; it also prints the cost the old check had on this machine
- a dead child, and a child whose process ID belongs to another process, are reported as exited
- a session with no children stops its tick
- the acceptance tests of each ticket, #15 to #24, pass. Each ticket names its tests exactly, so a renamed or deleted test is a `FAIL`

It proves each part alone, through a fake `pi` and a tick called directly. It does not prove that Pi runs the extension's tick, that a real child records its process ID, or that the parts work together.

```sh
npm run verify:e2e
```

The end-to-end check runs the real extension in real Pi processes, with no model login and no cost. A local fake model (OpenAI-compatible, scripted replies) drives a parent `pi --mode rpc` that loads this checkout's `index.ts`; its children are real Pi processes in real tmux sessions with the same fake model. It uses a temporary agent directory, a private tmux server, and a `tmux` that logs each call, and opens no Herdr pane. It takes about 30 s, prints one `ok` or `FAIL` line per step, and exits with the number of failures:

- a session with no children shows no subagent widget and starts no program
- the `subagent` tool, called by the model, spawns a real child Pi in tmux, and its metadata gets its real `childPid`
- with `subagentLimit: 1`, a second spawn shows `queued`, and starts by itself when the first child ends
- while the child works, the widget shows its row, and the parent's ticks run no `tmux has-session`
- the answer reaches the parent as a `subagent-result` message, with the path of a file that holds it whole
- a busy child with `--timeout 3s` is stopped by the parent and reported `timed out`
- `spawn --agent` and `--worktree` start a real child with the agent file's model, in the new worktree
- parent quit suspends a running child and a queued one; a new parent on the same session resumes them through the queue

CI runs `npm test` and then `npm run verify:e2e` on each push to `main` and each pull request, with Pi `1.5.2` (the version this package is tested with) and no login.

It does not prove what a real model does with the skill and the tool, the Herdr panes, or how the widget looks in the terminal; `check:live` and use do.

```sh
npm run check:live
```

The live check starts a real parent Pi in RPC mode and a real child, with this checkout as the package. It uses a temporary agent directory that links your logins, so it touches no real run or session. It needs a model login, takes about three minutes, and costs a few cents. It fails unless:

- the child's result arrives in the parent as a message, and the agent does not run `subagent wait`
- the widget shows the busy child with its time, tool call, tokens, and cost
- two messages that an idle child finds in the same tick both get an answer
- `interrupt` ends a busy child's turn before its command finishes
- a child whose process is killed is reported as `exited`, once
- `stop` keeps the transcript in Pi's sessions

## Upstream

```sh
git remote add upstream git@github.com:badlogic/pi-subagent.git  # once
git fetch upstream && git merge upstream/main
npm test
```

Upstream has no license file.

## Credits

Pi Subagent is the work of [Mario Zechner](https://github.com/badlogic), who also created [Pi](https://pi.dev). The design is his: each subagent is a full Pi in its own tmux session, results come from the durable transcript and not the screen, and children are suspended and resumed with their parent session. This fork adds the changes above, their tests, and this README. Thank you, Mario, for building Pi and this extension, and for sharing them.
