#!/usr/bin/env node
/**
 * Print the notification that WOULD be sent for the last turn of each recent
 * transcript on this machine. Sends nothing.
 *
 *   node cli/scripts/grade-summaries.mjs [count]
 *
 * PROTOTYPE.md §4 makes summary quality the gate on the whole thesis: "if
 * summaries are mush, stop and fix that before building anything else." This
 * is how that gets checked with eyes on real output instead of asserted.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildNote, DEFAULTS } from '../runtime/hook.mjs';

const root = join(homedir(), '.claude', 'projects');
const files = [];
for (const dir of readdirSync(root)) {
  const p = join(root, dir);
  try {
    for (const f of readdirSync(p)) {
      if (f.endsWith('.jsonl')) files.push({ path: join(p, f), project: dir, mtime: statSync(join(p, f)).mtimeMs });
    }
  } catch {}
}
files.sort((a, b) => b.mtime - a.mtime);

const n = Number(process.argv[2] ?? 15);
let mush = 0;
for (const f of files.slice(0, n)) {
  const project = f.project.replace(/^.*-/, '') || 'project';
  const note = buildNote(
    { hook_event_name: 'Stop', cwd: `/x/${project}`, transcript_path: f.path },
    { ...DEFAULTS },
    412
  );
  const [summary, meta] = note.body.split('\n');
  // A crude smell test — the reader is the real judge, but flag the obvious.
  const bad = summary === '(no summary)' || summary.length < 25 || /^(ok|done|yes|no)\b/i.test(summary);
  if (bad) mush++;
  console.log(`${bad ? '⚠' : ' '} ${note.title}`);
  console.log(`    ${summary}`);
  console.log(`    ${meta ?? ''}\n`);
}
console.log(`${files.length} transcripts on this machine · ${n} shown · ${mush} flagged as thin`);
