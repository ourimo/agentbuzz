#!/usr/bin/env node
/**
 * End-to-end installer test.  node cli/test/install.mjs
 *
 * Runs the REAL `init` and `uninstall` against a throwaway home directory and a
 * throwaway ntfy server, and inspects the files that come out. Unit-testing the
 * merge functions was not an option — bin/agentbuzz.js runs a command on import
 * by design — and it would have been the weaker test anyway: what matters is
 * that three agents with two different hook file formats all end up correct,
 * and that everyone else's hooks survive the round trip.
 */
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

const exec = promisify(execFile);

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentbuzz.js');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (got === want) { pass++; return; }
  fail++;
  console.log(`✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
};
const ok_ = (name, cond) => { cond ? pass++ : (fail++, console.log(`✗ ${name}`)); };

/* ── a throwaway home ───────────────────────────────────────────────────── */
const home = mkdtempSync(join(tmpdir(), 'ab-home-'));
const claudeFile = join(home, '.claude', 'settings.json');
const codexFile  = join(home, '.codex', 'hooks.json');
const cursorFile = join(home, '.cursor', 'hooks.json');
// The config dir must be named as it really is: isOurs() recognises our hooks
// by the agentbuzz in their path, so a temp dir called anything else would make
// uninstall silently find nothing.
const configDir  = join(home, '.config', 'agentbuzz');

for (const d of [dirname(claudeFile), dirname(codexFile), dirname(cursorFile)]) mkdirSync(d, { recursive: true });

// Claude Code: other settings, another tool's hook, and a stale hook of ours
// from back when this thing was called agentnotify.
writeFileSync(claudeFile, JSON.stringify({
  model: 'opus',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo other-tool' }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'node /old/agentnotify/hook.mjs' }] }]
  }
}, null, 2));

// Codex: a hooks file that already belongs to someone else.
writeFileSync(codexFile, JSON.stringify({
  description: 'my own hooks',
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }] }
}, null, 2));

// Cursor: the directory exists but no hooks file — the common case, and the one
// where we have to create the file ourselves.

/* ── a throwaway ntfy ───────────────────────────────────────────────────── */
const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ path: req.url, title: req.headers.title, body });
    res.writeHead(200).end('ok');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ntfy = `http://127.0.0.1:${server.address().port}`;

const env = {
  ...process.env,
  AGENTBUZZ_HOME: configDir,
  AGENTBUZZ_CLAUDE_SETTINGS: claudeFile,
  AGENTBUZZ_CODEX_HOOKS: codexFile,  AGENTBUZZ_CODEX_HOME: dirname(codexFile),
  AGENTBUZZ_CURSOR_HOOKS: cursorFile, AGENTBUZZ_CURSOR_HOME: dirname(cursorFile)
};
/**
 * Async on purpose. The fake ntfy server shares this process's event loop, so a
 * synchronous execFileSync would block the very server the CLI is waiting on
 * and every delivery would "time out" — which is exactly what it did.
 */
const run = async (...args) => {
  try { return (await exec('node', [CLI, ...args], { env, encoding: 'utf8' })).stdout; }
  catch (e) { return `EXIT ${e.code}\n${e.stdout ?? ''}${e.stderr ?? ''}`; }
};
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const commandsFor = (data, event) => (data.hooks?.[event] ?? [])
  .flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks.map((h) => h.command) : [e.command]));

/* ── init, with no --agent: everything detected ─────────────────────────── */
const out = await run('init', '--yes', '--ntfy', '--server', ntfy, '--no-macos', '--threshold', '0');
ok_('init detected all three', /Claude Code/.test(out) && /Codex CLI/.test(out) && /Cursor/.test(out));
ok_('init warns that Cursor cannot report blocked', /no "waiting for approval" event/.test(out));
ok_('init did not exit non-zero', !out.startsWith('EXIT'));

/* Claude Code — a shared settings file that must survive intact. */
const claude = read(claudeFile);
eq('unrelated settings preserved', claude.model, 'opus');
ok_("another tool's hook preserved", commandsFor(claude, 'Stop').includes('echo other-tool'));
ok_('a stale agentnotify hook is replaced, not doubled',
    !commandsFor(claude, 'Notification').some((c) => c.includes('/old/agentnotify/')));
for (const e of ['UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest']) {
  ok_(`claude ${e} mounted`, commandsFor(claude, e).some((c) => c.includes('--agent claude')));
}
eq('claude mounts exactly one of ours per event',
   commandsFor(claude, 'Stop').filter((c) => c.includes('--agent claude')).length, 1);
ok_('claude hooks are async', claude.hooks.Stop.some((e) => e.hooks?.some((h) => h.async === true)));

/* Codex — same nesting as Claude Code, its own file. */
const codex = read(codexFile);
eq('codex description preserved', codex.description, 'my own hooks');
ok_("codex's own guard hook preserved", commandsFor(codex, 'PreToolUse').includes('echo guard'));
ok_('codex matcher preserved', codex.hooks.PreToolUse[0].matcher === 'Bash');
for (const e of ['UserPromptSubmit', 'Stop', 'PermissionRequest']) {
  ok_(`codex ${e} mounted`, commandsFor(codex, e).some((c) => c.includes('--agent codex')));
}
ok_('codex nests its commands', Array.isArray(codex.hooks.Stop.at(-1).hooks));
// Interrupt means the user pressed Ctrl-C — they do not need to be told.
ok_('codex Interrupt is not mounted', !codex.hooks.Interrupt);

/* Cursor — a file we had to create, in the other format entirely. */
const cursor = read(cursorFile);
eq('cursor file carries a version', cursor.version, 1);
for (const e of ['beforeSubmitPrompt', 'afterAgentResponse', 'stop']) {
  ok_(`cursor ${e} mounted`, commandsFor(cursor, e).some((c) => c.includes('--agent cursor')));
}
ok_('cursor entries are flat, not nested', cursor.hooks.stop.every((e) => !('hooks' in e)));
eq('cursor entries carry a timeout', cursor.hooks.stop[0].timeout, 10);
// Cursor exposes nothing that means "waiting for you", so nothing is mounted
// on its per-command events — that would ping on every command in a run.
ok_('cursor shell hooks are left alone', !cursor.hooks.beforeShellExecution);

/* The runtime was vendored, and the test notification really was delivered. */
ok_('runtime vendored', existsSync(join(configDir, 'hook.mjs')));
eq('config stored the ntfy channel', read(join(configDir, 'config.json')).channels[0].type, 'ntfy');
eq('the test notification reached the server', received.length, 1);
ok_('and it looked like a real one', /done/.test(received[0]?.title ?? ''));

/* ── the hook runtime, driven exactly as each agent would drive it ──────── */
const fire = (agent, payload) =>
  JSON.parse(execFileSync('node', [join(configDir, 'hook.mjs'), '--agent', agent],
    { env: { ...env, AGENTBUZZ_DRYRUN: '1' }, input: JSON.stringify(payload), encoding: 'utf8' }));

eq('cursor turn start is stamped',
   fire('cursor', { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c9', workspace_roots: [home] }).action,
   'stamped');
eq('cursor text is captured, not sent',
   fire('cursor', { hook_event_name: 'afterAgentResponse', conversation_id: 'c9', text: 'Shipped the parser fix.' }).action,
   'captured');
const cursorStop = fire('cursor', {
  hook_event_name: 'stop', status: 'completed', conversation_id: 'c9', workspace_roots: [home]
});
eq('cursor stop builds a note', cursorStop.action, 'dryrun');
eq('and it carries the captured summary', cursorStop.note.summary, 'Shipped the parser fix.');
eq('an aborted cursor turn is ignored',
   fire('cursor', { hook_event_name: 'stop', status: 'aborted', conversation_id: 'c9' }).action, 'ignored');
eq('codex stop reads its own payload',
   fire('codex', { hook_event_name: 'Stop', session_id: 'x1', cwd: home, last_assistant_message: 'All green.' })
     .note.summary, 'All green.');

/* ── uninstall: every agent, ours only ──────────────────────────────────── */
const gone = await run('uninstall', '--yes');
ok_('uninstall reports all three', /Claude Code/.test(gone) && /Codex CLI/.test(gone) && /Cursor/.test(gone));

const claude2 = read(claudeFile), codex2 = read(codexFile), cursor2 = read(cursorFile);
eq('claude settings still intact', claude2.model, 'opus');
ok_("claude keeps the other tool's hook", commandsFor(claude2, 'Stop').includes('echo other-tool'));
ok_('codex keeps its guard', commandsFor(codex2, 'PreToolUse').includes('echo guard'));
eq('codex description survives uninstall', codex2.description, 'my own hooks');
const leftovers = [claude2, codex2, cursor2]
  .flatMap((d) => Object.keys(d.hooks ?? {}).flatMap((e) => commandsFor(d, e)))
  .filter((c) => /agentbuzz/.test(c));
eq('no agentbuzz hook left anywhere', leftovers.length, 0);
// Cursor's file held nothing but ours, so its hooks key should be gone rather
// than left as an empty object.
ok_('cursor file left clean', !cursor2.hooks || Object.keys(cursor2.hooks).length === 0);

server.close();
console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
