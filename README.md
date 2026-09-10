# agentbuzz

**Unblock your agent from your wrist.** When Claude Code stops for permission,
the prompt lands on your iPhone and Apple Watch — tap Allow, or dictate the next
instruction, and it carries on. It also tells you when a run finishes or breaks.

```bash
npx agentbuzz init
```

[agentnotify.web.app](https://agentnotify.web.app) · [support](https://agentnotify.web.app/support)

This repository is the **local client**: the hook runtime that runs on your
machine, and the installer that wires it into Claude Code. It is the part that
reads your transcripts, so it is the part worth reading before you run it.

---

## Your code never leaves your machine

A Claude Code hook hands us a **file path**, not a conversation. The transcript
is read locally to build a one-line summary, and only that summary is sent:

```json
{ "project": "checkout", "status": "blocked",
  "title": "wants permission to use Bash", "body": "npm run migrate:prod",
  "duration": 372 }
```

No file contents, no diffs, no prompts, no tool output. This is not a policy —
it is the only architecture that works, and it is why enrichment is a local
script rather than a server. Read [`runtime/hook.mjs`](runtime/hook.mjs) and
check.

With `--ntfy` it talks to [ntfy.sh](https://ntfy.sh) (or your own server) and
never touches our infrastructure at all. With `--macos` nothing leaves the
machine at all — see below.

## Channels

You can have more than one, and every configured channel gets every
notification. They are delivered in parallel, so a slow one never holds up a
fast one.

| | |
|---|---|
| `relay` | The default. Push to the iPhone and Apple Watch app; the only channel that can approve a permission request. |
| `ntfy` | [ntfy.sh](https://ntfy.sh) or your own server. No account with us. |
| `macos` | A banner on the Mac the agent is running on. No account, no network, works offline. |

The combination worth having is **`relay` + `macos`**: a banner while you are at
the desk, a buzz on your wrist once you are not.

### The Mac banner

```bash
npx agentbuzz init --macos          # banner only — no account, nothing to pair
npx agentbuzz config --macos on     # add it to a phone you already paired
npx agentbuzz config --macos off
```

Two limits, both structural:

- **It is ping-only.** Allow / Deny buttons need an app that registered a
  notification category with macOS, which a script cannot do. Approving a
  permission request stays on the phone and the Watch.
- **The banner says "Script Editor".** It is posted through `osascript`, which
  has no bundle identity of its own, so macOS attributes it to Script Editor —
  and if Script Editor's notifications are switched off, delivery reports
  success and nothing appears. **System Settings → Notifications → Script
  Editor → Allow.** The alternative is a dependency on `terminal-notifier`,
  which is worth less than the zero-dependency guarantee.

## What `init` does to your machine

It is worth being explicit, because this edits a config file and installs
something that runs on every turn:

1. **Backs up** `~/.claude/settings.json` next to the original.
2. **Merges** hooks into it — it adds to the existing arrays and never replaces
   hooks from other tools. Malformed JSON is refused, not rewritten.
3. Copies the runtime to `~/.config/agentbuzz/hook.mjs` and points the hooks at
   `node ~/.config/agentbuzz/hook.mjs`. Vendoring one file is deliberate: it
   keeps working after npx's temp directory is gone, needs nothing on `PATH`,
   and pays no npx latency per turn.
4. Stores config, including a delivery credential, in `~/.config/agentbuzz/`.

`npx agentbuzz uninstall` removes only our hooks and leaves every other tool's
alone.

Hooks are read once at session start, so **restart Claude Code** after
installing or nothing happens.

## Commands

| | |
|---|---|
| `init` | Detect Claude Code, back up and merge hooks, pair, send a test |
| `test` | Send a notification that looks like a real one |
| `status` | What the hook has been doing — and why it has been quiet |
| `config` | Print config, or `--threshold <sec>` / `--macos on\|off` to change it |
| `uninstall` | Remove only our hooks |

Flags for `init`: `--ntfy` (deliver via ntfy instead of the app), `--macos`
(banner on this Mac — on its own, no account is needed), `--no-macos`,
`--topic <name>`, `--threshold <sec>`, `--server <url>`, `--yes`.

`test` exits non-zero if **any** channel failed. The hook is deliberately more
forgiving at runtime: one channel that delivered means you were notified, and
nothing here ever retries.

## Quiet by default

`Stop` fires every time the agent finishes responding — in normal back-and-forth
that is a notification every twenty seconds. Turns shorter than the threshold
(90s by default) stay silent, and identical notifications inside 60s are
deduplicated.

Silence is therefore ambiguous, so `status` disambiguates it:

```
Listening · last run 6m ago (checkout, 43s, suppressed-short)

4 sent   12 stayed quiet
turn duration: median 43s · p90 105s · max 1850s
4 of 16 turns crossed the 90s threshold
```

Silence with a log line is working. Silence with no log line is broken.

## Three rules

1. **Always exit 0.** A failed notification must never fail your run.
2. **Hard timeout on every network call.** Hooks are also registered `async`, so
   a notification costs you no latency. If the API is down, your agent does not
   notice.
3. **Nothing but the summary line leaves the machine.**

## Development

Zero dependencies, Node ≥18.17.

```bash
node test/run.mjs          # 36 assertions, no install step
```

There is no `npm install` — the absence of a dependency tree is a feature for
something that reads your transcripts, and CI never installs anything so it
stays that way.

```bash
node scripts/grade-summaries.mjs 20
```

prints the notification that *would* be sent for the last turn of your 20 most
recent transcripts, and sends nothing. That is how summary quality is judged:
by reading real output, not by reasoning about it.

Inspect a single event without sending it:

```bash
echo '{"hook_event_name":"Stop","session_id":"x","cwd":"'$PWD'"}' \
  | npx agentbuzz hook --dry-run
```

## Config

`~/.config/agentbuzz/config.json`

```json
{
  "threshold": 90,
  "dedupe": 60,
  "tail": 500,
  "channels": [
    { "type": "relay", "endpoint": "https://…/v1/ingest", "key": "…" },
    { "type": "macos" }
  ]
}
```

Configs written before multi-channel stored a single `channel` object. Those
are migrated on read, so an old install keeps working untouched.

> **ntfy.sh topics are unauthenticated.** Anyone who knows the topic name can
> read your notifications. The long random name is the only protection — do not
> shorten it. Point `base` at your own server if that is not good enough.

## Licence

MIT. See [LICENSE](LICENSE).
