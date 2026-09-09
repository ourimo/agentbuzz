#!/usr/bin/env node
/** Zero-dependency tests.  node cli/test/run.mjs  */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  demarkdown, trimToSentence, leadParagraph, isPreamble,
  classify, humanDuration, enrich, buildNote, DEFAULTS
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

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
