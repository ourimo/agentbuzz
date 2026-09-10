#!/usr/bin/env node
/** Zero-dependency tests.  node cli/test/run.mjs  */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import {
  demarkdown, trimToSentence, leadParagraph, isPreamble,
  classify, humanDuration, enrich, buildNote, DEFAULTS,
  normalizeConfig, macArgs, deliver, adapters
} from '../runtime/hook.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; return; }
  fail++;
  console.log(`✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok_ = (name, cond) => { cond ? pass++ : (fail++, console.log(`✗ ${name}`)); };

/* ── demarkdown ─────────────────────────────────────────────────────────── */
// The regression that started this: emphasis stripping must not eat identifiers.
eq('keeps underscores in identifiers', demarkdown('the tool_name field'), 'the tool_name field');
eq('keeps hash in issue refs',        demarkdown('closes issue #42'), 'closes issue #42');
eq('strips bold',                     demarkdown('**done** now'), 'done now');
eq('strips inline code',              demarkdown('run `npm test` first'), 'run npm test first');
eq('strips links to their text',      demarkdown('see [the docs](https://x.com)'), 'see the docs');
eq('drops fenced code',               demarkdown('before\n```\ncode\n```\nafter'), 'before after');
eq('strips list markers',             demarkdown('- one\n- two'), 'one two');
// Headings must be terminated or they glue onto the next sentence.
eq('terminates headings',             demarkdown('## What it is\nThree things.'), 'What it is. Three things.');
eq('does not double-terminate',       demarkdown('## Ready?\nYes.'), 'Ready? Yes.');

/* ── trimToSentence ─────────────────────────────────────────────────────── */
const long = 'First sentence here. Second sentence is quite a bit longer than the first one. Third.';
eq('trims on a sentence boundary', trimToSentence(long, 40), 'First sentence here.');
// Truncation must land on a word boundary: the kept text is a prefix of the
// original, and the character it stopped before is a space.
const src = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu';
const kept = trimToSentence(src, 30).replace(/…$/, '');
ok_('never cuts mid-word', src.startsWith(kept) && src[kept.length] === ' ');
eq('short text is untouched', trimToSentence('Fine.', 180), 'Fine.');

/* ── leadParagraph ──────────────────────────────────────────────────────── */
eq('drops a filler opener',
   leadParagraph('Wrapped up. Everything is in the files now.'),
   'Everything is in the files now.');
eq('skips a heading-only paragraph',
   leadParagraph('## Files changed\n\nThe real content lives here.'),
   'The real content lives here.');
eq('skips a colon lead-in',
   leadParagraph('Here is the list:\n\nThe actual summary sentence.'),
   'The actual summary sentence.');
eq('keeps a normal lead',
   leadParagraph('Build is green.\n\nDetails follow.'),
   'Build is green.');
ok_('falls back rather than returning nothing', leadParagraph('## Only a heading').length > 0);

/* ── preamble detection ─────────────────────────────────────────────────── */
ok_('flags an interstitial',   isPreamble('Now testing it —'));
ok_('flags a "let me" line',   isPreamble('Let me check the config:'));
ok_('keeps a real summary',   !isPreamble('Both changes are in and verified on the simulator.'));

/* ── classify & duration ────────────────────────────────────────────────── */
eq('PermissionRequest is blocked', classify('PermissionRequest').status, 'blocked');
eq('Notification is blocked',      classify('Notification').status, 'blocked');
eq('StopFailure is failed',        classify('StopFailure').status, 'failed');
eq('Stop is done',                 classify('Stop').status, 'done');
eq('seconds',       humanDuration(43), '43s');
eq('minutes',       humanDuration(412), '6m 52s');
eq('hours',         humanDuration(7325), '2h 2m');

/* ── enrich: turn scoping and file counts ───────────────────────────────── */
const dir = mkdtempSync(join(tmpdir(), 'an-'));
const t = join(dir, 't.jsonl');
const A = (...content) => JSON.stringify({ type: 'assistant', message: { content } });
writeFileSync(t, [
  // Previous turn — must NOT be counted.
  JSON.stringify({ type: 'user', message: { content: 'old prompt' } }),
  A({ type: 'tool_use', name: 'Bash', input: {} }),
  // A tool RESULT is stored as `user`; treating it as a prompt is the classic bug.
  JSON.stringify({ type: 'user', toolUseResult: { stdout: 'x' }, message: { content: 'result' } }),
  // Current turn.
  JSON.stringify({ type: 'user', message: { content: 'the real prompt' } }),
  A({ type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } }),
  A({ type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } }),
  A({ type: 'tool_use', name: 'Write', input: { file_path: '/b.ts' } }),
  A({ type: 'text', text: 'Now checking:' }),
  A({ type: 'text', text: '**Build is green** and `npm test` passes.' })
].join('\n') + '\n');

const e = enrich(t, 500);
eq('summary skips the preamble', e.summary, 'Build is green and npm test passes.');
eq('tool counts are turn-scoped', e.tools, '2× Edit, 1× Write');
eq('distinct files changed', e.files, 2);
eq('previous turn excluded', /Bash/.test(e.tools), false);

/* ── buildNote ──────────────────────────────────────────────────────────── */
const blocked = buildNote(
  { hook_event_name: 'PermissionRequest', cwd: '/x/checkout', tool_name: 'Bash', transcript_path: t },
  DEFAULTS, 41);
eq('blocked title', blocked.title, 'checkout — permission');
// The payload's request, not the transcript summary — the whole value of a
// blocked ping is knowing what it is blocked ON.
eq('blocked body is the request', blocked.body, 'wants permission to use: Bash');
eq('blocked status', blocked.status, 'blocked');

const done = buildNote(
  { hook_event_name: 'Stop', cwd: '/x/checkout', transcript_path: t }, DEFAULTS, 412);
eq('done title', done.title, 'checkout — done');
eq('done body', done.body, 'Build is green and npm test passes.\n— 2 files changed · 2× Edit, 1× Write · 6m 52s');
// The stat line also stands alone, for the macOS banner's subtitle slot.
eq('done stats', done.stats, '2 files changed · 2× Edit, 1× Write · 6m 52s');
eq('a blocked ping has no stats', blocked.stats, '');

/* ── config migration ───────────────────────────────────────────────────── */
// v1 wrote a single `channel`. An old config on disk must keep delivering.
const migrated = normalizeConfig({ channel: { type: 'ntfy', topic: 'abc' } });
eq('v1 channel becomes a list', migrated.channels.length, 1);
eq('v1 channel is preserved', migrated.channels[0].topic, 'abc');
ok_('v1 key is dropped', !('channel' in migrated));
eq('a v2 list survives untouched',
   normalizeConfig({ channels: [{ type: 'relay' }, { type: 'macos' }] }).channels.length, 2);
// Both keys present: the list wins, or a re-init would resurrect a stale channel.
eq('the list wins over a stale channel',
   normalizeConfig({ channel: { type: 'ntfy' }, channels: [{ type: 'macos' }] }).channels[0].type, 'macos');
eq('empty config yields no channels', normalizeConfig({}).channels.length, 0);

/* ── the macOS banner: argv, never interpolation ────────────────────────── */
const hostile = 'he said "rm -rf /" \\ then ) stopped';
const mac = macArgs({ summary: hostile, title: 'proj — done', stats: '2 files · 4s', status: 'done' });
const script = mac.filter((a, i) => mac[i - 1] === '-e').join('\n');
ok_('the summary never enters the script text', !script.includes(hostile));
ok_('the script reads its text from argv', /item 1 of argv/.test(script));
// Without `--`, a summary starting with "-" is parsed as an option and the
// script dies with "the run handler is specified more than once".
ok_('arguments are separated by --', mac.includes('--'));
eq('argv order is body, title, subtitle', mac.slice(mac.indexOf('--') + 1).join('|'),
   `${hostile}|proj — done|2 files · 4s`);
ok_('a finished run is silent', !/sound name/.test(script));
ok_('a blocked run makes a sound',
    /sound name/.test(macArgs({ status: 'blocked', summary: 'x', title: 'y', stats: '' }).join(' ')));

// The real thing, on a real osascript — same argv, harmless statement, no banner.
if (platform() === 'darwin') {
  const probe = mac.map((a) => (a.startsWith('display notification') ? 'return item 1 of argv' : a));
  let out = '';
  try { out = execFileSync('osascript', probe, { encoding: 'utf8' }).trim(); } catch (e) { out = `threw: ${e.message}`; }
  eq('osascript returns the summary verbatim', out, hostile);
}

/* ── delivery fan-out ───────────────────────────────────────────────────── */
adapters.stub = async () => ({ ok: true, detail: 'ok' });
adapters.boom = async () => { throw new Error('adapter exploded'); };

eq('no channels is not a delivery', (await deliver([], {})).ok, false);
eq('an unknown channel fails', (await deliver([{ type: 'nope' }], {})).ok, false);
// ok means "the user was notified", not "everything worked" — there is no retry
// anywhere, so one live channel is the whole success condition.
eq('one live channel is enough', (await deliver([{ type: 'stub' }, { type: 'nope' }], {})).ok, true);
ok_('the failure is still reported',
    /nope: unknown channel/.test((await deliver([{ type: 'stub' }, { type: 'nope' }], {})).detail));
// Rule 1: a throwing adapter may never reach the hook's caller.
eq('a throwing adapter is contained', (await deliver([{ type: 'boom' }], {})).ok, false);
eq('a throwing adapter does not stop the others',
   (await deliver([{ type: 'boom' }, { type: 'stub' }], {})).ok, true);
eq('a bare channel object still delivers', (await deliver({ type: 'stub' }, {})).ok, true);
eq('one result per channel', (await deliver([{ type: 'stub' }, { type: 'stub' }], {})).results.length, 2);

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
