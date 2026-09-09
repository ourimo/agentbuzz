#!/usr/bin/env node
/**
 * agentbuzz — the hook runtime.
 *
 * `agentbuzz init` copies this ONE file to ~/.config/agentbuzz/hook.mjs and
 * points Claude Code's hooks at it. That is deliberate: the command in
 * settings.json must keep working after the npx temp directory is gone, must not
 * depend on PATH, and must not pay npx's network latency on every turn. One
 * self-contained file with zero dependencies is the only shape that satisfies
 * all three.
 *
 * Three rules, inherited from the bash prototype and non-negotiable:
 *   1. ALWAYS exit 0.  A failed notification must never fail the user's run.
 *   2. Hard timeout on every network call. A hook must never hang a session.
 *   3. Nothing but the summary line leaves the machine.
 *
 * Usage:  cat payload.json | node hook.mjs
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export const CONFIG_DIR = process.env.AGENTBUZZ_HOME || join(homedir(), '.config', 'agentbuzz');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const STATE_DIR = join(CONFIG_DIR, 'state');
const LOG_FILE = join(CONFIG_DIR, 'log.jsonl');

export const DEFAULTS = {
  version: 1,
  threshold: 90,   // seconds; a Stop below this stays quiet
  dedupe: 60,      // seconds; identical title+body suppressed within this window
  tail: 500,       // transcript lines to scan — bounds the work on huge sessions
  channel: null    // { type: "ntfy", base, topic }
};

/* ── config ─────────────────────────────────────────────────────────────── */

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/* ── log ────────────────────────────────────────────────────────────────── */

export function logline(event, project, elapsed, action, detail = '') {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify({
      ts: new Date().toISOString(), event, project, elapsed, action, detail
    }) + '\n');
  } catch { /* logging must never throw into the hook path */ }
}

export function readLog() {
  try {
    return readFileSync(LOG_FILE, 'utf8').split('\n')
      .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/* ── formatting ─────────────────────────────────────────────────────────── */

/**
 * Assistant text is markdown. Unstripped, a notification reads as source:
 * "**[PLAN.md](PLAN.md)** (new, 370 lines)".
 *
 * Emphasis markers are removed only where they are actually emphasis. Stripping
 * `_` and `#` globally — as the first version did — turns `tool_name` into
 * `toolname` and `issue #42` into `issue 42`, which is exactly the wrong damage
 * to do to a notification about code.
 */
export function demarkdown(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, ' ')                 // fenced code → gone
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')       // links & images → their text
    .replace(/`([^`]+)`/g, '$1')                     // inline code → its contents
    .replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, (_, t) => (/[.!?:]$/.test(t.trim()) ? t : `${t.trim()}.`))
    .replace(/^\s{0,3}>\s?/gm, '')                   // blockquotes
    .replace(/^\s*(?:[-*+•]|\d+\.)\s+/gm, '')        // list markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')               // bold
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2') // italic — never mid-word
    .replace(/(^|\s)__([^_\n]+)__(?=\s|$)/g, '$1$2')  // bold, underscore form
    .replace(/^\s*[-=]{3,}\s*$/gm, ' ')              // rules
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Trim to a sentence boundary, never mid-word. A notification cut at exactly
 * 180 characters reads as truncated garbage; one cut after a full stop reads
 * as a sentence somebody wrote.
 */
export function trimToSentence(text, max = 180) {
  const t = text.trim();
  if (t.length <= max) return t;
  const window = t.slice(0, max + 1);
  const lastStop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (lastStop > max * 0.45) return window.slice(0, lastStop + 1).trim();
  const lastSpace = window.lastIndexOf(' ');
  return (lastSpace > 0 ? window.slice(0, lastSpace) : window.slice(0, max)).trim() + '…';
}

/**
 * "Wrapped up." "Done." "Here's what I wrote:" — true, and worthless on a lock
 * screen, where the first dozen characters are all most people read. Dropped
 * only when there is real content behind them.
 */
const FILLER = /^(wrapped up|done|all set|finished|complete|here'?s (what|the) [^.:!]{0,40}|that'?s (it|everything))[.:!]?$/i;

/**
 * A well-written final message leads with its summary and then elaborates in
 * lists and headings. Flattening the whole thing and taking 180 characters
 * drags that structure into the notification; taking the LEAD PARAGRAPH, minus
 * any filler opener, gets the sentence the author actually meant as the summary.
 *
 * Operates on the raw markdown, because paragraph boundaries do not survive
 * demarkdown.
 */
export function leadParagraph(raw) {
  const paragraphs = String(raw).split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  let fallback = '';

  for (const para of paragraphs) {
    // A heading standing alone is a label for what follows, not a summary of
    // it. "Files changed." is a true and useless notification.
    const headingOnly = /^\s{0,3}#{1,6}\s+/.test(para) && !para.includes('\n');

    let clean = demarkdown(para);
    if (!clean) continue;

    // Strip a filler opening sentence, but only if something follows it.
    const sentences = clean.split(/(?<=[.!?])\s+/);
    while (sentences.length > 1 && FILLER.test(sentences[0].trim())) sentences.shift();
    clean = sentences.join(' ').trim();

    if (!clean || FILLER.test(clean) || clean.length <= 12) continue;

    // A paragraph ending in a colon introduces something rather than saying it.
    if (headingOnly || clean.endsWith(':')) { fallback ||= clean; continue; }
    return clean;
  }
  return fallback || demarkdown(raw);
}

/**
 * Text an assistant emits between tool calls ("Let me check the config:",
 * "Now testing it —") is a preamble, not a summary. At a real Stop the last
 * block is the wrap-up, but a truncated tail or an interrupted turn can leave
 * a preamble last, and a notification that says "Now testing it —" is useless.
 */
export function isPreamble(text) {
  const t = text.trim();
  if (t.length >= 90) return false;
  return /[:—-]$/.test(t) || /^(let me|now |next,? |first,? |i'?ll |checking|looking|running|reading|testing)\b/i.test(t);
}

export function humanDuration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/** The three states the whole design system is built around. */
export function classify(event) {
  switch (event) {
    case 'Notification':      return { status: 'blocked', suffix: 'needs you',     prio: 'high',    tags: 'bell' };
    case 'PermissionRequest': return { status: 'blocked', suffix: 'permission',    prio: 'high',    tags: 'warning' };
    case 'StopFailure':
    case 'PostToolUseFailure':return { status: 'failed',  suffix: 'failed',        prio: 'high',    tags: 'x' };
    case 'SessionEnd':        return { status: 'done',    suffix: 'session ended', prio: 'low',     tags: 'crescent_moon' };
    default:                  return { status: 'done',    suffix: 'done',          prio: 'default', tags: 'white_check_mark' };
  }
}

/* ── transcript enrichment — runs LOCALLY, always ───────────────────────── */

/**
 * Read the tail of the session .jsonl and pull out (a) the last thing the
 * assistant said, and (b) what tools it used since the user's last real prompt.
 *
 * The transcript holds thinking blocks and full tool output. All of it is read
 * here, on this machine, and none of it is sent — that is the entire privacy
 * claim, and the reason enrichment cannot live on a server: the hook hands us a
 * file path, not a conversation.
 */
export function enrich(transcriptPath, tailLines) {
  const out = { summary: '', tools: 'no tools', files: 0 };
  if (!transcriptPath || !existsSync(transcriptPath)) return out;

  let records;
  try {
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
    records = lines.slice(-tailLines).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return out; }

  // Everything is scoped to the current turn: tools used and files touched
  // since the user's last REAL prompt. A `user` record is only a real prompt
  // when it has no `toolUseResult` key — tool results are stored as `user`
  // too, and missing that inflates the stats with the whole session.
  let turnStart = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type === 'user' && !('toolUseResult' in r)) { turnStart = i; break; }
  }
  const turn = records.slice(turnStart);

  // Summary: the last substantial assistant text, preferring a real wrap-up
  // over a between-tool-calls preamble. Falls back to the last text of any
  // kind rather than returning nothing.
  const texts = [];
  for (const r of turn) {
    if (r.type !== 'assistant') continue;
    for (const b of r.message?.content ?? []) {
      if (b?.type === 'text' && b.text?.trim()) texts.push(leadParagraph(b.text));
    }
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    if (!isPreamble(texts[i])) { out.summary = trimToSentence(texts[i]); break; }
  }
  if (!out.summary && texts.length) out.summary = trimToSentence(texts[texts.length - 1]);

  // Tool counts, and the number of distinct files actually changed. "4 files
  // changed" is the stat background.md promised and the tool counts alone
  // never delivered — 6× Edit could be six edits to one file.
  const counts = new Map();
  const touched = new Set();
  const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  for (const r of turn) {
    if (r.type !== 'assistant') continue;
    for (const b of r.message?.content ?? []) {
      if (b?.type !== 'tool_use' || !b.name) continue;
      counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
      const f = b.input?.file_path ?? b.input?.notebook_path;
      if (WRITES.has(b.name) && typeof f === 'string') touched.add(f);
    }
  }
  out.files = touched.size;
  if (counts.size) {
    out.tools = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${n}× ${name}`)
      .join(', ');
  }
  return out;
}

/* ── delivery ───────────────────────────────────────────────────────────── */

/**
 * Delivery adapters all take the same shape, so adding the hosted relay or
 * Telegram later is a new branch here and nothing else.
 */
export async function deliver(channel, note) {
  if (!channel) return { ok: false, detail: 'no channel configured' };

  if (channel.type === 'ntfy') {
    const base = channel.base || 'https://ntfy.sh';
    // ntfy drops non-ASCII header values, so the title goes out ASCII-only and
    // anything expressive lives in the body.
    const res = await fetch(`${base}/${channel.topic}`, {
      method: 'POST',
      headers: {
        'Title': asciiOnly(note.title),
        'Priority': note.prio,
        'Tags': note.tags
      },
      body: note.body,
      signal: AbortSignal.timeout(5000)
    });
    return { ok: res.status === 200, detail: `http ${res.status}` };
  }

  if (channel.type === 'relay') {
    const res = await fetch(channel.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${channel.key}` },
      // Exactly the payload printed on the landing page. Nothing else.
      body: JSON.stringify({
        project: note.project, status: note.status,
        title: note.rawTitle, body: note.summary, duration: note.elapsed
      }),
      signal: AbortSignal.timeout(5000)
    });
    return { ok: res.ok, detail: `http ${res.status}` };
  }

  return { ok: false, detail: `unknown channel ${channel.type}` };
}

const asciiOnly = (s) => s.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();

/* ── building the notification ──────────────────────────────────────────── */

export function buildNote(payload, cfg, elapsed) {
  const event = payload.hook_event_name || 'unknown';
  const project = basename(payload.cwd || process.cwd());
  const { status, suffix, prio, tags } = classify(event);

  let summary;
  // A "needs you" ping must carry the actual request. The generic transcript
  // summary is actively useless there: "wants permission to run rm -rf build/"
  // is the whole value of a blocked ping.
  if (event === 'PermissionRequest') {
    summary = `wants permission to use: ${payload.tool_name || 'a tool'}`;
  } else if (event === 'Notification' && payload.message) {
    summary = demarkdown(payload.message).slice(0, 180);
  }

  const { summary: fromTranscript, tools, files } = enrich(payload.transcript_path, cfg.tail);
  if (!summary) summary = fromTranscript || '(no summary)';
  const changed = files ? `${files} file${files === 1 ? '' : 's'} changed · ` : '';

  const blocked = status === 'blocked';
  return {
    event, project, status, elapsed,
    rawTitle: `${project} — ${suffix}`,
    title: `${project} — ${suffix}`,
    summary,
    body: blocked ? summary : `${summary}\n— ${changed}${tools} · ${humanDuration(elapsed)}`,
    prio, tags
  };
}

/* ── dedupe ─────────────────────────────────────────────────────────────── */

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const dedupeFile = (note) => join(STATE_DIR, `dedupe.${hash(note.title + '|' + note.body)}`);

function isDuplicate(note, windowSec, now) {
  try {
    const f = dedupeFile(note);
    if (!existsSync(f)) return false;
    const last = parseInt(readFileSync(f, 'utf8'), 10) || 0;
    return now - last < windowSec;
  } catch { return false; }   // dedupe is best-effort; never block a send on it
}

/**
 * Recorded only AFTER a successful delivery. Marking on attempt means one
 * transient network failure silently swallows the retry as a "duplicate" —
 * you lose two notifications instead of none.
 */
function recordSent(note, now) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(dedupeFile(note), String(now));
    // Sweep stale markers so the directory cannot grow without bound.
    for (const name of readdirSync(STATE_DIR)) {
      if (!name.startsWith('dedupe.')) continue;
      const p = join(STATE_DIR, name);
      if (now - Math.floor(statSync(p).mtimeMs / 1000) > 3600) unlinkSync(p);
    }
  } catch {}
}

/* ── the hook entrypoint ────────────────────────────────────────────────── */

export async function runHook(payload, { dryRun = false } = {}) {
  const cfg = loadConfig();
  const now = Math.floor(Date.now() / 1000);
  const event = payload.hook_event_name || 'unknown';
  const project = basename(payload.cwd || process.cwd());
  const session = payload.session_id || 'unknown';
  const startFile = join(STATE_DIR, `${session}.start`);

  // UserPromptSubmit: stamp the turn start and say nothing. Duration measured
  // this way is exact and costs nothing, unlike inferring it from timestamps.
  if (event === 'UserPromptSubmit') {
    try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(startFile, String(now)); } catch {}
    return { action: 'stamped' };
  }

  let start = now;
  try { start = parseInt(readFileSync(startFile, 'utf8'), 10) || now; } catch {}
  const elapsed = Math.max(0, now - start);

  // The duration gate. Stop fires on EVERY turn, so without this the product is
  // a notification every twenty seconds — a v1 correctness requirement, not a
  // paid feature.
  if (event === 'Stop' && elapsed < cfg.threshold) {
    logline(event, project, elapsed, 'suppressed-short');
    return { action: 'suppressed-short', elapsed };
  }

  if (!cfg.channel && !dryRun) {
    logline(event, project, elapsed, 'error', 'no channel configured');
    return { action: 'error', detail: 'no channel configured' };
  }

  const note = buildNote(payload, cfg, elapsed);

  if (dryRun) return { action: 'dryrun', note };

  if (isDuplicate(note, cfg.dedupe, now)) {
    logline(event, project, elapsed, 'suppressed-dupe');
    return { action: 'suppressed-dupe', note };
  }

  try {
    const { ok, detail } = await deliver(cfg.channel, note);
    if (ok) recordSent(note, now);
    logline(event, project, elapsed, ok ? 'sent' : 'error', ok ? '' : detail);
    return { action: ok ? 'sent' : 'error', detail, note };
  } catch (err) {
    // Timeouts land here. The run continues regardless — that is the point.
    logline(event, project, elapsed, 'error', String(err?.message || err).slice(0, 120));
    return { action: 'error', detail: String(err?.message || err) };
  }
}

/* ── main ───────────────────────────────────────────────────────────────── */

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let payload;
  try { payload = JSON.parse(raw); }
  catch { logline('unknown', '', 0, 'error', 'unparseable payload'); return; }

  const dryRun = process.env.AGENTBUZZ_DRYRUN === '1';
  const result = await runHook(payload, { dryRun });
  if (dryRun) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// Only run when executed directly, so the CLI can import this file instead.
if (process.argv[1] && process.argv[1].endsWith('hook.mjs')) {
  // Rule 1: always exit 0. Nothing here may fail the user's run.
  main().catch(() => {}).finally(() => process.exit(0));
}
