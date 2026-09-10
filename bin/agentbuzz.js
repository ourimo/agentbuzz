#!/usr/bin/env node
/**
 * agentbuzz — CLI.
 *
 *   npx agentbuzz init        detect Claude Code, merge hooks, pair, test
 *   npx agentbuzz test        send a realistic notification
 *   npx agentbuzz status      what the hook has actually been doing
 *   npx agentbuzz uninstall   remove our hooks, leave everyone else's alone
 *
 * The hook itself is runtime/hook.mjs, which init copies into the config
 * directory. This file is only ever run by a human.
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { hostname } from 'node:os';

import {
  CONFIG_DIR, loadConfig, saveConfig, DEFAULTS,
  runHook, deliver, humanDuration, readLog, agentFromArgv
} from '../runtime/hook.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = join(HERE, '..', 'runtime', 'hook.mjs');
const RUNTIME_DST = join(CONFIG_DIR, 'hook.mjs');
const API = process.env.AGENTBUZZ_API || 'https://europe-west1-agentnotify.cloudfunctions.net/api';

/**
 * Where each agent keeps its hooks, and which of its events we mount. The
 * runtime half of this lives in AGENTS in runtime/hook.mjs; this half is only
 * about files on disk.
 *
 * `format` is the one real incompatibility between the three. Claude Code and
 * Codex nest the commands a level deeper —
 *   { "Stop": [ { "hooks": [ { "type": "command", "command": "…" } ] } ] }
 * — while Cursor lists them flat:
 *   { "stop":  [ { "type": "command", "command": "…" } ] }
 *
 * `shared` marks a file that is not ours to invent. ~/.claude/settings.json
 * holds a user's model, permissions and everything else, so its absence means
 * Claude Code was never run and we stop. The other two are dedicated hook
 * files: creating one is the normal way to add a hook, so we do.
 *
 * Paths are overridable so the installer can be tested end to end without
 * going anywhere near a real config.
 */
const AGENT_TARGETS = {
  claude: {
    label: 'Claude Code',
    file: process.env.AGENTBUZZ_CLAUDE_SETTINGS || join(homedir(), '.claude', 'settings.json'),
    home: join(homedir(), '.claude'),
    format: 'nested',
    shared: true,
    // Chosen from what the installed Claude Code actually emits —
    // `PermissionRequest` was found empirically in a live setup, not inferred
    // from docs, and it is the most valuable of the five.
    events: ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest']
  },
  codex: {
    label: 'Codex CLI',
    file: process.env.AGENTBUZZ_CODEX_HOOKS || join(homedir(), '.codex', 'hooks.json'),
    home: process.env.AGENTBUZZ_CODEX_HOME || join(homedir(), '.codex'),
    format: 'nested',
    shared: false,
    // Codex's Stop carries `last_assistant_message`, so it needs no transcript.
    // Interrupt is deliberately not mounted: it means the user pressed Ctrl-C,
    // and someone who just pressed Ctrl-C does not need to be told about it.
    events: ['UserPromptSubmit', 'Stop', 'PermissionRequest']
  },
  cursor: {
    label: 'Cursor',
    file: process.env.AGENTBUZZ_CURSOR_HOOKS || join(homedir(), '.cursor', 'hooks.json'),
    home: process.env.AGENTBUZZ_CURSOR_HOME || join(homedir(), '.cursor'),
    format: 'flat',
    shared: false,
    // afterAgentResponse is the summary source — Cursor exposes no transcript
    // we can parse — and `stop` is the notification. No permission event is
    // mounted because Cursor has none that means "waiting for you": its
    // beforeShellExecution fires before every command, approved or not.
    events: ['beforeSubmitPrompt', 'afterAgentResponse', 'stop']
  }
};

/** An agent counts as present if its own config directory is there. Each has a
 *  separate hooks file, so nothing here can be confused for another. */
const detectAgents = () => Object.keys(AGENT_TARGETS).filter((id) =>
  AGENT_TARGETS[id].shared ? existsSync(AGENT_TARGETS[id].file) : existsSync(AGENT_TARGETS[id].home));

/** The `--agent` is what tells the runtime whose payload it is reading. */
const hookCommand = (id) => `node ${RUNTIME_DST} --agent ${id}`;

/* ── tiny terminal helpers ──────────────────────────────────────────────── */
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s), bold = (s) => c('1', s);
const green = (s) => c('32', s), amber = (s) => c('33', s), red = (s) => c('31', s);
const ok = (s) => console.log(`  ${green('✓')} ${s}`);
const info = (s) => console.log(`  ${dim('·')} ${s}`);
const warn = (s) => console.log(`  ${amber('!')} ${s}`);
const err = (s) => console.log(`  ${red('✗')} ${s}`);

/** An unbundled script has no identity of its own, so the banner arrives as
 *  Script Editor — and if that is muted, delivery "succeeds" and nothing
 *  appears. Say it before it is asked. */
const MAC_PERMISSION_HINT =
  'No banner? System Settings → Notifications → Script Editor → Allow. macOS attributes it there.';

const describeChannel = (ch) =>
  ch.type === 'ntfy'  ? `ntfy · ${ch.topic}`
: ch.type === 'relay' ? `relay · ${ch.endpoint}`
: ch.type === 'macos' ? 'macos · banner on this Mac'
: ch.type;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

async function confirm(question, def = true) {
  if (flag('yes')) return true;
  if (!process.stdin.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`  ${question} ${dim(def ? '(Y/n)' : '(y/N)')} `)).trim().toLowerCase();
  rl.close();
  return a === '' ? def : a.startsWith('y');
}

/* ── settings.json: detect, back up, MERGE ──────────────────────────────── */

/// Recognises our hooks under every name this tool has had. It was agentnotify,
/// then briefly agentping — npm rejected both as too similar to existing
/// packages (agent-notify, agent-ping). Anyone carrying hooks from an earlier
/// build must have them REPLACED rather than added beside, or every
/// notification arrives twice.
const isOurs = (cmd) => /agent-?notify|agentping|agentbuzz/.test(String(cmd));

function readSettings(path) {
  if (!existsSync(path)) return { exists: false, data: {} };
  try {
    return { exists: true, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    // Malformed settings.json is a real case in the wild. Refuse rather than
    // "fix" it — silently rewriting someone's config is how you lose a user.
    return { exists: true, data: null, error: e.message };
  }
}

/** Write a hooks file back, preserving whatever else was in it. Cursor
 *  validates a top-level `version`, so a file we create must carry one. */
function writeHookFile(target, data) {
  mkdirSync(dirname(target.file), { recursive: true });
  if (target.format === 'flat' && data.version === undefined) data.version = 1;
  writeFileSync(target.file, JSON.stringify(data, null, 2) + '\n');
}

/** Is this agent wired up right now? Each agent owns its own hooks file, so
 *  our marker appearing anywhere in it is answer enough. */
const isWired = (target) => {
  try { return existsSync(target.file) && isOurs(readFileSync(target.file, 'utf8')); }
  catch { return false; }
};

function backup(path) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '');
  const dst = `${path}.${stamp}.bak`;
  copyFileSync(path, dst);
  return dst;
}

/**
 * Strip only OUR hook entries, preserving everyone else's.
 *
 * Shape-agnostic on purpose: it is also the uninstaller, and it must be able to
 * clean a file whose format it was not told. An entry that nests a `hooks`
 * array is Claude Code's or Codex's; anything else is read as a flat Cursor
 * entry. Neither branch touches an entry it does not recognise as ours.
 */
function stripOurs(hooks) {
  const out = {};
  let removed = 0;
  for (const [event, entries] of Object.entries(hooks ?? {})) {
    const kept = [];
    for (const entry of entries ?? []) {
      if (Array.isArray(entry?.hooks)) {
        const inner = entry.hooks.filter((h) => {
          if (isOurs(h?.command)) { removed++; return false; }
          return true;
        });
        if (inner.length) kept.push({ ...entry, hooks: inner });
      } else if (isOurs(entry?.command)) {
        removed++;
      } else {
        kept.push(entry);
      }
    }
    if (kept.length) out[event] = kept;
  }
  return { hooks: out, removed };
}

/** Count the hook commands in a file, split into ours and everyone else's. */
function countHooks(hooks) {
  const commands = Object.values(hooks ?? {}).flat()
    .flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks.map((h) => h?.command) : [e?.command]));
  return {
    ours: commands.filter((c) => isOurs(c)).length,
    others: commands.filter((c) => c !== undefined && !isOurs(c)).length
  };
}

function addOurs(hooks, target, command) {
  const out = { ...hooks };
  for (const event of target.events) {
    // async so a notification can never cost the user latency, and a hard
    // timeout so it can never hang a session even if async changed. Cursor
    // documents no async flag, so there the timeout carries the guarantee
    // alone — which is also why nothing is mounted on its per-tool events.
    const entry = target.format === 'flat'
      ? { type: 'command', timeout: 10, command }
      : { hooks: [{ type: 'command', async: true, timeout: 10, command }] };
    out[event] = [...(out[event] ?? []), entry];
  }
  return out;
}

/* ── commands ───────────────────────────────────────────────────────────── */

async function cmdInit() {
  console.log(`\n${bold('agentbuzz')} ${dim('· setup')}\n`);

  // 1. Detect every agent, or just the ones named with --agent.
  const requested = opt('agent');
  const ids = requested
    ? requested.split(',').map((x) => x.trim()).filter(Boolean)
    : detectAgents();

  const unknown = ids.filter((id) => !AGENT_TARGETS[id]);
  if (unknown.length) {
    err(`Unknown agent: ${unknown.join(', ')}`);
    info(`Known agents: ${Object.keys(AGENT_TARGETS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (!ids.length) {
    err('No supported agent found on this machine.');
    for (const t of Object.values(AGENT_TARGETS)) {
      info(`Looked for ${t.label}  ${dim((t.shared ? t.file : t.home).replace(homedir(), '~'))}`);
    }
    info('Install and run one of them once, then try again.');
    process.exitCode = 1;
    return;
  }

  // Read every target BEFORE touching any of them. A run that configures Codex
  // and then dies on unparseable Cursor JSON leaves the user half-installed and
  // with no idea which half.
  const targets = [];
  for (const id of ids) {
    const t = AGENT_TARGETS[id];
    const f = readSettings(t.file);
    if (f.data === null) {
      err(`${t.label}: ${t.file.replace(homedir(), '~')} is not valid JSON — ${f.error}`);
      info('Fix or move that file first. Refusing to rewrite it.');
      process.exitCode = 1;
      return;
    }
    // A shared config we did not create is proof the agent was never run.
    if (t.shared && !f.exists) {
      if (requested) {
        err(`No ${t.label} settings at ${t.file.replace(homedir(), '~')} — run it once first.`);
        process.exitCode = 1;
        return;
      }
      continue;
    }
    targets.push({ id, t, f });
    ok(`Found ${t.label}  ${dim(t.file.replace(homedir(), '~'))}${f.exists ? '' : dim(' (will be created)')}`);
  }
  if (!targets.length) { err('Nothing to configure.'); process.exitCode = 1; return; }

  const totals = targets.reduce((acc, { f }) => {
    const c = countHooks(f.data.hooks ?? {});
    return { ours: acc.ours + c.ours, others: acc.others + c.others };
  }, { ours: 0, others: 0 });

  if (totals.others) info(`${totals.others} hook${totals.others === 1 ? '' : 's'} from other tools — these will be preserved`);
  if (totals.ours) warn(`${totals.ours} existing agentbuzz hook${totals.ours === 1 ? '' : 's'} — these will be replaced`);

  // Cursor has no event meaning "waiting for you", so it can report a finished
  // or failed run and nothing else. Said here rather than discovered later,
  // when a permission prompt sits unanswered and the phone stays silent.
  if (targets.some(({ id }) => id === 'cursor')) {
    warn('Cursor: done and failed only — it exposes no "waiting for approval" event.');
  }

  const names = targets.map(({ t }) => t.label).join(', ');
  if (!(await confirm(`Configure ${names} for notifications?`))) { info('Nothing changed.'); return; }

  // 2. Channels.
  const cfg = loadConfig();
  cfg.threshold = Number(opt('threshold', cfg.threshold ?? DEFAULTS.threshold));

  // The REMOTE channel is the one that reaches you after you have walked away,
  // and it is the product. The hosted relay is its default — it is what
  // delivers to the app and the Watch. `--ntfy` is the escape hatch for people
  // who would rather not route anything through us.
  //
  // `--macos` on its own is the third path: nothing leaves this machine, so
  // there is no account and nothing to pair. It exists so the tool is useful
  // in the thirty seconds before anyone has installed an app.
  const previous = cfg.channels.find((ch) => ch.type === 'relay' || ch.type === 'ntfy');
  const remote = flag('ntfy')  ? 'ntfy'
               : flag('relay') ? 'relay'
               : (flag('macos') && !previous) ? null
               : previous?.type ?? 'relay';

  const channels = [];
  if (remote === 'relay') {
    const paired = await pairWithPhone();
    if (!paired) { err('Pairing did not complete — nothing was changed.'); process.exitCode = 1; return; }
    channels.push({ type: 'relay', endpoint: `${API}/v1/ingest`, key: paired.apiKey });
  } else if (remote === 'ntfy') {
    // A long random ntfy topic is the ONLY thing protecting it: ntfy.sh topics
    // are unauthenticated, and anyone who guesses the name reads one-line
    // summaries of what you are building.
    const topic = opt('topic') || previous?.topic || `agentbuzz-${randomBytes(9).toString('hex')}`;
    channels.push({ type: 'ntfy', base: opt('server', 'https://ntfy.sh'), topic });
  }

  // The Mac banner is an ADDITION to the remote channel, never a replacement:
  // a banner on the machine you walked away from is not a notification. Asked
  // about rather than assumed, because plenty of people are staring at the
  // window the agent is running in and want nothing from it.
  const wantsMac = process.platform === 'darwin' && !flag('no-macos') && (
    flag('macos') ||
    cfg.channels.some((ch) => ch.type === 'macos') ||
    await confirm('Also show a banner on this Mac?')
  );
  if (wantsMac) channels.push({ type: 'macos' });
  cfg.channels = channels;

  // 3. Back up, then merge — one agent at a time.
  for (const { id, t, f } of targets) {
    if (f.exists) {
      const bak = backup(t.file);
      ok(`Backed up  ${dim(bak.replace(homedir(), '~'))}`);
    }
    const stripped = stripOurs(f.data.hooks ?? {});
    f.data.hooks = addOurs(stripped.hooks, t, hookCommand(id));
    writeHookFile(t, f.data);
    ok(`${t.label} hooks  ${dim(t.events.join(', '))}`);
  }

  // 4. Vendor the runtime so the hook command survives npx's temp directory.
  mkdirSync(CONFIG_DIR, { recursive: true });
  copyFileSync(RUNTIME_SRC, RUNTIME_DST);
  saveConfig(cfg);
  ok(`Installed  ${dim(RUNTIME_DST.replace(homedir(), '~'))}`);

  // 5. Confirm delivery in both directions.
  const ntfy = cfg.channels.find((ch) => ch.type === 'ntfy');
  if (ntfy) {
    console.log(`\n  Subscribe to this topic in the ${bold('ntfy')} app:\n`);
    console.log(`      ${bold(ntfy.topic)}`);
    console.log(`      ${dim(`${ntfy.base}/${ntfy.topic}`)}\n`);
    info('iOS: set ntfy to Time Sensitive in Settings → Notifications, so blocked-agent');
    info('pings pierce Focus. Your Watch mirrors them automatically.');
  }
  // The hint belongs with the first banner. `test` prints it too, so only say
  // it here when no test is being sent.
  if (await confirm('\n  Send a test notification now?')) await sendTest(cfg);
  else if (wantsMac) info(dim(MAC_PERMISSION_HINT));

  // 6. Say the restart line out loud. Hooks are snapshotted at session start;
  //    skipping this makes users conclude it is broken within 60 seconds.
  console.log(`\n  ${bold(`Restart ${names}`)} to load the hooks.`);
  console.log(`  You'll be pinged when a run takes longer than ${bold(cfg.threshold + 's')} — short turns stay quiet.\n`);
}

/**
 * Pairing, as designed in PLAN.md §4: the first notification lands before an
 * account exists. We ask the relay for a code, show it, and poll. The phone
 * claims it and the key comes back here — no email, no password in front of
 * the aha moment.
 *
 * The code is a credential: whoever redeems it receives this machine's
 * notifications. It is single-use and expires in ten minutes.
 */
async function pairWithPhone() {
  const machine = hostname();
  let start;
  try {
    const res = await fetch(`${API}/v1/pair/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine }),
      signal: AbortSignal.timeout(10000)
    });
    start = await res.json();
    if (!res.ok) throw new Error(start?.error ?? `http ${res.status}`);
  } catch (e) {
    err(`Could not reach the relay — ${e.message}`);
    return null;
  }

  console.log(`\n  Open ${bold('agentbuzz')} on your iPhone and enter this code:\n`);
  console.log(`      ${bold(start.code)}`);
  console.log(`      ${dim(start.pairUrl)}\n`);

  const deadline = Date.parse(new Date(start.expiresAt).toISOString());
  process.stdout.write(`  ${dim('Waiting for your phone…')}`);

  for (;;) {
    if (Date.now() > deadline) { console.log(`\r  ${red('Code expired.')}            `); return null; }
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${API}/v1/pair/poll?code=${encodeURIComponent(start.code)}`, {
        signal: AbortSignal.timeout(10000)
      });
      const p = await res.json();
      if (p.expired) { console.log(`\r  ${red('Code expired.')}            `); return null; }
      if (p.claimed && p.apiKey) {
        console.log(`\r  ${green('✓')} Connected  ${dim(machine)}                `);
        return p;
      }
    } catch { /* transient — keep polling until the code expires */ }
  }
}

/** A test notification must look like a REAL one. "Test notification" proves
 *  the pipe works but demonstrates nothing; the enrichment is the pitch. */
async function sendTest(cfg = loadConfig()) {
  if (!cfg.channels.length) { err('No channel configured. Run: agentbuzz init'); process.exitCode = 1; return; }
  const stats = '12× Read, 4× Edit, 1× Bash · 1m 12s';
  const note = {
    project: 'agentbuzz', status: 'done',
    title: 'agentbuzz — done', rawTitle: 'agentbuzz — done',
    summary: 'Setup complete. This is what a finished run looks like.',
    stats,
    body: `Setup complete. This is what a finished run looks like.\n— ${stats}`,
    prio: 'default', tags: 'white_check_mark', elapsed: 72
  };
  const t0 = Date.now();
  try {
    // Reported per channel: "it worked" is the wrong answer when the banner
    // fired and the phone did not.
    const res = await deliver(cfg.channels, note);
    for (const r of res.results) {
      if (r.ok) ok(`Delivered via ${bold(r.type)}`);
      else err(`${r.type} — ${r.detail}`);
    }
    if (res.ok) info(dim(`${((Date.now() - t0) / 1000).toFixed(1)}s`));
    if (res.results.some((r) => r.type === 'macos' && r.ok)) info(dim(MAC_PERMISSION_HINT));
    // Stricter than the hook, deliberately. At runtime one live channel means
    // the user was notified and there is nothing to do; `test` is a diagnostic,
    // and a dead channel is exactly the thing it was run to find.
    if (res.results.some((r) => !r.ok)) process.exitCode = 1;
  } catch (e) {
    err(`Delivery failed — ${e.message}`);
    process.exitCode = 1;
  }
}

async function cmdUninstall() {
  console.log(`\n${bold('agentbuzz')} ${dim('· uninstall')}\n`);

  // Every known agent is swept, whatever `init` was asked for at the time —
  // uninstall leaving hooks behind on an agent the user forgot about is the
  // one failure mode that gets a tool called broken after it is gone.
  const cleaned = [];
  let total = 0;
  for (const [id, t] of Object.entries(AGENT_TARGETS)) {
    const f = readSettings(t.file);
    if (!f.exists) continue;
    if (f.data === null) { warn(`${t.label}: ${t.file.replace(homedir(), '~')} is not valid JSON — left alone.`); continue; }

    const { hooks, removed } = stripOurs(f.data.hooks ?? {});
    if (!removed) continue;

    const bak = backup(t.file);
    if (Object.keys(hooks).length) f.data.hooks = hooks; else delete f.data.hooks;
    writeHookFile(t, f.data);

    ok(`Backed up  ${dim(bak.replace(homedir(), '~'))}`);
    ok(`${t.label} — removed ${removed} hook${removed === 1 ? '' : 's'}, every other hook left alone`);
    cleaned.push(t.label);
    total += removed;
  }

  if (!total) { info('No agentbuzz hooks found.'); return; }
  info(`Config kept at ${CONFIG_DIR.replace(homedir(), '~')} — delete it by hand if you want it gone.`);
  console.log(`\n  ${bold(`Restart ${cleaned.join(', ')}`)} to apply.\n`);
}

/** The silence problem: with a threshold, a working install can be silent for
 *  an hour, and silence is indistinguishable from broken. This command is the
 *  answer — it shows what was seen and deliberately swallowed. */
function cmdStatus() {
  const cfg = loadConfig();
  const log = readLog();
  console.log(`\n${bold('agentbuzz')} ${dim('· status')}\n`);

  if (!cfg.channels.length) { warn('No channel configured. Run: agentbuzz init'); return; }
  cfg.channels.forEach((ch, i) => info(`${i ? '         ' : 'Channels '}  ${describeChannel(ch)}`));
  info(`Threshold  ${cfg.threshold}s`);
  // isOurs, not a literal — the hook path is ~/.config/agentbuzz, which the old
  // /agent-?notify/ pattern never matched, so this always read NOT installed.
  const wired = Object.entries(AGENT_TARGETS).filter(([, t]) => isWired(t));
  const installed = existsSync(RUNTIME_DST) && wired.length > 0;
  info(`Hooks      ${installed ? green('installed') : red('NOT installed')}`);
  if (installed) {
    info(`Agents     ${wired.map(([, t]) => t.label).join(', ')}`);
    const missing = Object.entries(AGENT_TARGETS)
      .filter(([id, t]) => !isWired(t) && detectAgents().includes(id));
    if (missing.length) {
      info(dim(`${missing.map(([, t]) => t.label).join(', ')} installed but not wired — agentbuzz init`));
    }
  }

  if (!log.length) {
    console.log(`\n  ${amber('No events logged yet.')}`);
    console.log(`  ${dim('If you have used Claude Code since installing, the hooks are not firing —')}`);
    console.log(`  ${dim('did you restart it? Hooks are snapshotted at session start.')}\n`);
    return;
  }

  const by = (k) => log.reduce((m, e) => (m[e[k]] = (m[e[k]] ?? 0) + 1, m), {});
  const actions = by('action');
  const sent = actions.sent ?? 0;
  const quiet = (actions['suppressed-short'] ?? 0) + (actions['suppressed-dupe'] ?? 0);
  const errors = actions.error ?? 0;

  const last = log[log.length - 1];
  const ago = humanDuration(Math.max(0, Math.floor((Date.now() - Date.parse(last.ts)) / 1000)));

  console.log(`\n  ${bold(`Listening · last run ${ago} ago`)} ${dim(`(${last.project}, ${last.elapsed}s, ${last.action})`)}\n`);
  console.log(`  ${green(String(sent))} sent   ${dim(`${quiet} stayed quiet`)}${errors ? `   ${red(`${errors} errors`)}` : ''}`);

  // Keyed on the canonical kind, so every agent's finished turns land in the
  // same histogram. Older log lines predate `kind` and only ever came from
  // Claude Code, so they are matched on its event name.
  const durations = log.filter((e) => (e.kind ? e.kind === 'done' : e.event === 'Stop'))
    .map((e) => e.elapsed).sort((a, b) => a - b);
  if (durations.length) {
    const at = (p) => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))];
    const over = durations.filter((d) => d >= cfg.threshold).length;
    console.log(`  ${dim(`turn duration: median ${at(0.5)}s · p90 ${at(0.9)}s · max ${durations[durations.length - 1]}s`)}`);
    console.log(`  ${dim(`${over} of ${durations.length} turns crossed the ${cfg.threshold}s threshold`)}`);
    if (sent === 0 && durations.length >= 10) {
      console.log(`\n  ${amber('Nothing has been sent yet.')} Try a lower threshold:`);
      console.log(`  ${dim(`agentbuzz config --threshold ${Math.max(30, at(0.9))}`)}`);
    }
  }
  console.log();
}

function cmdConfig() {
  const cfg = loadConfig();
  let changed = false;

  const t = opt('threshold');
  if (t !== null) { cfg.threshold = Number(t); changed = true; ok(`Threshold set to ${cfg.threshold}s`); }

  // Turning the banner on must not cost a re-pair: the phone's key already
  // lives in this config, and `init` would issue a new one and invalidate it.
  const m = opt('macos');
  if (m !== null) {
    const on = /^(on|yes|true|1)$/i.test(m);
    const rest = cfg.channels.filter((ch) => ch.type !== 'macos');
    cfg.channels = on ? [...rest, { type: 'macos' }] : rest;
    changed = true;
    ok(on ? 'Mac banner on' : 'Mac banner off');
    if (on && process.platform !== 'darwin') warn(`This is not a Mac (${process.platform}) — that channel will not fire.`);
    else if (on) info(dim(MAC_PERMISSION_HINT));
  }

  if (changed) {
    saveConfig(cfg);
    // The hook that reads this config is a VENDORED COPY, and it may predate
    // multi-channel — in which case it looks for `channel` and finds nothing,
    // and notifications stop without a word. Refresh it whenever we change the
    // shape of what it reads.
    if (existsSync(RUNTIME_DST)) copyFileSync(RUNTIME_SRC, RUNTIME_DST);
    return;
  }
  console.log(JSON.stringify(cfg, null, 2));
}

async function cmdHook() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload; try { payload = JSON.parse(raw); } catch { return; }
  const r = await runHook(payload, { dryRun: flag('dry-run'), agent: agentFromArgv() });
  if (flag('dry-run')) console.log(JSON.stringify(r, null, 2));
}

function usage() {
  console.log(`
${bold('agentbuzz')} — know the second your agent needs you

  ${bold('init')}        detect your agents, back up and merge hooks, send a test
  ${bold('test')}        send a notification that looks like a real one
  ${bold('status')}      what the hook has been doing, and why it has been quiet
  ${bold('config')}      print config, or ${dim('--threshold <sec>')} / ${dim('--macos on|off')} to change it
  ${bold('uninstall')}   remove only our hooks, restore nothing else
  ${bold('hook')}        internal: the hook entrypoint ${dim('(--dry-run to inspect)')}

  ${dim('init flags:')} --agent <ids> (default: every one detected)
              ${dim(Object.entries(AGENT_TARGETS).map(([id, t]) => `${id} = ${t.label}`).join('  ·  '))}
              --ntfy (deliver via ntfy.sh instead of the app)  --topic <name>
              --macos (banner on this Mac; on its own, no account needed)
              --no-macos  --threshold <sec>  --server <url>  --yes
`);
}

const cmd = args.find((a) => !a.startsWith('--'));
const table = { init: cmdInit, test: () => sendTest(), status: cmdStatus, config: cmdConfig, uninstall: cmdUninstall, hook: cmdHook };
await (table[cmd] ?? usage)();
