# Pi Subagent

Observable, persistent [Pi](https://pi.dev) subagents for independent reviews, investigations, and delegated implementation.

Each subagent is a separate Pi process in its own tmux session, with its own JSONL transcript. The parent spawns it with a CLI, keeps working, and later waits for its answer, steers it, or attaches to its TUI. A child is a normal, full Pi, not a stripped-down tool call.

This is a fork of [badlogic/pi-subagent](https://github.com/badlogic/pi-subagent) by [Mario Zechner](https://mariozechner.at), with two fixes. Upstream has issues and pull requests disabled, so they live here:

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

Run `/reload` in each open Pi. The extension brings its own `subagent` skill, so the model in Pi knows the CLI without more setup. To check: `subagent list` prints `No subagents`.

## First run

Ask Pi in plain words ("get a second opinion on this diff"). The model runs the CLI with its bash tool, for example:

```sh
subagent spawn --name review --tools read,grep,find,ls --prompt "Review the current diff independently"
# Spawned review (a1b2c3)
# State: busy
# Attach: tmux attach -t pi-subagent-a1b2c3

subagent wait a1b2c3    # blocks until the child is idle, then prints its final answer
subagent stop a1b2c3    # removes the child, its tmux session, and its transcript
```

Let the model run `spawn`. Only Pi's bash tool sets the parent session, provider, model, and thinking level that `spawn` reads. A `!` command or another terminal does not: there `spawn` fails unless you pass `--provider` and `--model`, the child has no parent session, so it is never suspended or resumed, and `subagent list` shows the children of all sessions. Stop such children yourself.

## Commands

| Command                                                          | Effect                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `subagent spawn [options] (--prompt <text> \| --file <path>)...` | Start a child. Prints its handle and the tmux attach command.                               |
| `subagent list`                                                  | Handles, names, states, and models of this session's children (outside Pi: all).            |
| `subagent status <handle>`                                       | One child's state and model.                                                                |
| `subagent wait <handle> [--timeout <seconds>]`                   | Block until the child is idle, then print its last answer. Default timeout 1800 s.          |
| `subagent send <handle> <message>`                               | Idle child: start a new turn. Busy child: steer the current turn.                           |
| `subagent send <handle> --follow-up <message>`                   | Busy child: queue a turn after the current one.                                             |
| `subagent rename <handle> <name>`                                | Change the name shown in the parent UI.                                                     |
| `subagent stop <handle>`                                         | Remove the child for good.                                                                  |
| `/subagent` (in Pi)                                              | Pick a child and attach to its TUI. Detach to return; inside tmux, `tmux switch-client -l`. |

A status line below the Pi editor shows each child's name and state (`busy`, `idle`, `error`).

## Spawn options

| Option                                 | Default                                              | Use                                                                                   |
| -------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `--name <name>`                        | the handle                                           | Label in the UI, 1 to 64 characters.                                                  |
| `--provider`, `--model`                | the parent's                                         | Pick another model. Required for independent opinions.                                |
| `--thinking <level>`                   | the parent's, else `medium`                          | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.                            |
| `--cwd <dir>`                          | current directory                                    | Where the child works.                                                                |
| `--tools <names>`                      | Pi's default tools (`read`, `bash`, `edit`, `write`) | Comma-separated allowlist. `read,grep,find,ls` is read-only. `bash` can change files. |
| `--prompt <text>`                      |                                                      | Repeatable. All prompts go into the first turn.                                       |
| `--file <path>`                        |                                                      | Repeatable. Attached to the first turn.                                               |
| `--no-context-files`                   | off                                                  | Ignore `AGENTS.md` and `CLAUDE.md`, for a review those must not bias.                 |
| `--no-extensions`                      | off                                                  | No extensions except the subagent control bridge.                                     |
| `--no-skills`, `--no-prompt-templates` | off                                                  | Strip skills or prompt templates.                                                     |

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

Two children that edit the same checkout will conflict. Give each its own worktree with `--cwd`.

If the `--cwd` directory has an executable `pi-test.sh`, the child runs it in place of `pi` (an upstream hook for testing). Do not spawn into a checkout you do not trust.

## Lifecycle

| Event                                                                  | What happens to children                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The child finishes its turn                                            | It stays `idle` and keeps its context, ready for `send`.                                                                                |
| `/reload` in the parent                                                | Nothing. Children keep running.                                                                                                         |
| The parent quits or switches session                                   | Running children are suspended: the process stops, transcript and metadata stay. Children that already exited on their own are removed. |
| The parent dies without quitting                                       | The next Pi to start, in any session, suspends them.                                                                                    |
| The parent session starts again (`pi --resume`, `pi --session <file>`) | Suspended children start again, idle, with their full history.                                                                          |
| `subagent stop`                                                        | Removed for good: tmux session, transcript, metadata.                                                                                   |

A suspended child shows as `exited`, is hidden from the status line and `/subagent`, and refuses `send` and `wait` until its parent session starts again. Children cannot spawn their own subagents.

## How it works

```text
parent Pi ── bash tool ── subagent spawn ──► ~/.pi/agent/subagents/<handle>/
   │                                            metadata.json   state, model, parent
   │                                            session.jsonl   the child's transcript
   │                                            inbox/          messages from `send`
   │
   └─ extension: status line, /subagent,       tmux session pi-subagent-<handle>
      suspend and resume                         └─ launcher.ts ─► pi (the child)
```

- `subagent.ts` is the CLI. It writes the run directory and starts the tmux session.
- `index.ts` is the extension. In the parent it shows the status line, adds `/subagent`, and suspends and resumes children. In the child it reads `inbox/` and keeps `metadata.json` up to date.
- `launcher.ts` runs inside the tmux pane. tmux gives a new pane the tmux server's environment, so the CLI saves the caller's environment in a private `launch.json`. The launcher restores it, deletes the file, and becomes `pi`.
- `wait` reads the child's state from `metadata.json` and its answer from `session.jsonl`, never from the terminal screen.

Run directories live under `$PI_CODING_AGENT_DIR/subagents` (default `~/.pi/agent/subagents`), mode `0700`.

## Development

```sh
npm test
```

The tests use `node --test` with no dependencies. Each test starts its own tmux server on a private socket (`TMUX_TMPDIR`) and a fake `pi` that records what it got, so they touch no real session and need no model.

## Upstream

```sh
git remote add upstream git@github.com:badlogic/pi-subagent.git  # once
git fetch upstream && git merge upstream/main
npm test
```

Upstream has no license file.

## Credits

Pi Subagent is the work of [Mario Zechner](https://github.com/badlogic), who also created [Pi](https://pi.dev). The design is his: each subagent is a full Pi in its own tmux session, results come from the durable transcript and not the screen, and children are suspended and resumed with their parent session. This fork adds only the two fixes above, their tests, and this README. Thank you, Mario, for building Pi and this extension, and for sharing them.
