# agentbuzz

Know the second your agent needs you. Notifications from Claude Code to your
phone and Apple Watch — when a run finishes, fails, or stops for permission.

```bash
npx agentbuzz init
```

## What it does

Registers hooks with Claude Code and, when something worth interrupting you for
happens, sends a one-line summary to your phone.

| Command | |
|---|---|
| `init` | Detect Claude Code, back up and **merge** hooks, pair a channel, send a test |
| `test` | Send a notification that looks like a real one |
| `status` | What the hook has been doing — and why it has been quiet |
| `config` | Print config, or `--threshold <seconds>` to change it |
| `uninstall` | Remove only our hooks; everything else is left alone |

## Your code never leaves your machine

A Claude Code hook hands us a **file path**, not a conversation. The transcript
is read locally to build the summary; only that summary is sent. No file
contents, no diffs, no prompts, no tool output.

This is not a policy — it is the only architecture that works, and it is why the
enrichment is a local script rather than a server.

## Quiet by default

`Stop` fires every time the agent finishes responding, which in normal
back-and-forth is a notification every twenty seconds. Turns shorter than the
threshold (default **90s**) stay silent, and identical notifications inside 60s
are deduplicated.

If it has been quiet, `agentbuzz status` tells you whether that was on purpose:

```
Listening · last run 6m ago (checkout, 43s, suppressed-short)

4 sent   12 stayed quiet
turn duration: median 43s · p90 105s · max 1850s
4 of 16 turns crossed the 90s threshold
```

Silence with a log line is working. Silence with no log line is broken.

## Design rules

Three, and they are not negotiable:

1. **Always exit 0.** A failed notification must never fail your run.
2. **Hard timeout on every network call.** A hook must never hang a session.
   Hooks are also registered `async`, so a notification costs you no latency.
3. **Nothing but the summary line leaves the machine.**

## How it installs

`init` backs up `~/.claude/settings.json`, then **merges** — it adds to the
existing hook arrays rather than replacing them, so hooks from other tools
survive. Malformed JSON is refused rather than rewritten.

The runtime is copied to `~/.config/agentbuzz/hook.mjs` and the hook command
is `node ~/.config/agentbuzz/hook.mjs`. That is deliberate: it keeps working
after npx's temp directory is gone, needs nothing on `PATH`, and pays no npx
latency per turn.

Hooks are snapshotted at session start, so **restart Claude Code** after
installing or nothing happens.

## Events

`UserPromptSubmit` (stamps turn start, sends nothing), `Stop`, `StopFailure`,
`Notification`, `PermissionRequest`.

`PermissionRequest` is the valuable one — a frozen agent waiting on you costs
more than a finished one. Its ping carries the actual request rather than a
generic summary.

## Config

`~/.config/agentbuzz/config.json`

```json
{
  "threshold": 90,
  "dedupe": 60,
  "tail": 500,
  "channel": { "type": "ntfy", "base": "https://ntfy.sh", "topic": "agentbuzz-…" }
}
```

> **ntfy.sh topics are unauthenticated.** Anyone who knows the topic name can
> read your notifications. The long random name is the only protection — do not
> shorten it. Point `base` at your own ntfy server if that is not good enough.

## Inspecting it

```bash
echo '{"hook_event_name":"Stop","session_id":"x","cwd":"'$PWD'"}' \
  | npx agentbuzz hook --dry-run
```

Prints exactly what would be sent, and sends nothing.

MIT.
