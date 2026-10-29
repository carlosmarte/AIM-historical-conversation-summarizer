import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { slugify, compactTimestamp, createSummaryFolder } from './create-summary-folder.mjs';
import { extract, classifyUserText, stripSystemReminders, encodeProjectDir, resolveSession, extractToDir } from './extract-session.mjs';
import { extractJson, validateAgainst, ledgerSanity, validateFile, DEFAULT_SCHEMA } from './validate-ledger.mjs';
import { renderSummary, renderReadme } from './render-summary.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hcs-'));

// ── create-summary-folder ───────────────────────────────────────────────────

test('slugify: kebab, bounded, never empty', () => {
  assert.equal(slugify('Historical Summarizer Agent Skills!!'), 'historical-summarizer-agent-skills');
  assert.equal(slugify('  --weird__chars--  '), 'weird-chars');
  assert.equal(slugify(''), 'session');
  const long = slugify('a very very very long slug that keeps going and going and going');
  assert.ok(long.length <= 40, long);
  assert.ok(!long.endsWith('-'));
});

test('compactTimestamp has no colons and sorts', () => {
  const t = compactTimestamp(new Date('2026-10-28T19:30:00.123Z'));
  assert.equal(t, '20261028T193000Z');
});

test('createSummaryFolder mints <ts>-<uuid>-<slug>, manifest, pointer', () => {
  const root = tmp();
  const { dir, manifest } = createSummaryFolder({ root, slug: 'Auth Token Refresh', cwd: HERE, sessionId: 'abc' });
  const base = path.basename(dir);
  assert.match(base, /^\d{8}T\d{6}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-auth-token-refresh$/);
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(dir, 'execution-artifact')));
  assert.equal(manifest.session_id, 'abc');
  assert.equal(manifest.slug, 'auth-token-refresh');
  assert.equal(fs.readFileSync(path.join(root, '.historical-conversation-summarizer--last'), 'utf8').trim(), dir);
});

// ── extract-session ─────────────────────────────────────────────────────────

test('encodeProjectDir matches Claude Code encoding', () => {
  assert.equal(encodeProjectDir('/Users/Shared/github.com/x/y'), '-Users-Shared-github-com-x-y');
});

test('classifyUserText separates human turns from injections', () => {
  assert.equal(classifyUserText('please fix the build'), 'human');
  assert.equal(classifyUserText('Base directory for this skill: /x\n# Skill'), 'skill_injection');
  assert.equal(classifyUserText('<command-name>/foo</command-name>'), 'local_command');
  assert.equal(classifyUserText('[Request interrupted by user]'), 'interrupt');
});

test('stripSystemReminders removes harness blocks and counts them', () => {
  const r = stripSystemReminders('hi <system-reminder>x</system-reminder> there <system-reminder>y</system-reminder>');
  assert.equal(r.text, 'hi  there');
  assert.equal(r.stripped, 2);
});

function fakeSession() {
  return [
    { type: 'mode', mode: 'normal', sessionId: 'S1' },
    { type: 'user', sessionId: 'S1', cwd: '/w', uuid: 'u1', timestamp: '2026-10-28T10:00:00.000Z', message: { role: 'user', content: 'Create foo.txt and email Bob <system-reminder>ignore</system-reminder>' } },
    { type: 'assistant', sessionId: 'S1', uuid: 'a1', timestamp: '2026-10-28T10:00:01.000Z', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/w/foo.txt', content: 'x'.repeat(50) } }] } },
    { type: 'user', sessionId: 'S1', uuid: 'u2', timestamp: '2026-10-28T10:00:03.500Z', toolUseResult: { stdout: 'ok', stderr: '', interrupted: false }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'File created' }] } },
    { type: 'assistant', sessionId: 'S1', uuid: 'a2', timestamp: '2026-10-28T10:00:04.000Z', message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'sendmail bob' } }] } },
    { type: 'user', sessionId: 'S1', uuid: 'u3', timestamp: '2026-10-28T10:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'sendmail: command not found' }] } },
    { type: 'user', sessionId: 'S1', uuid: 'u4', timestamp: '2026-10-28T10:00:06.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x\n# whatever' }] } },
    { type: 'assistant', sessionId: 'S1', uuid: 'a3', timestamp: '2026-10-28T10:00:07.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'No email tool.' }, { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'sleep 1' } }] } },
    { type: 'ai-title', aiTitle: 'Foo and email', sessionId: 'S1' },
  ];
}

test('extract builds scope, log with statuses, and stats', () => {
  const { log, scope, stats, events } = extract(fakeSession(), { maxInputChars: 10 });
  assert.equal(scope.length, 1, 'skill injection is not scope');
  assert.equal(scope[0].text, 'Create foo.txt and email Bob');
  assert.equal(stats.system_reminders_stripped, 1);
  assert.equal(stats.title, 'Foo and email');
  assert.equal(stats.tool_calls, 3);
  assert.equal(stats.tool_errors, 1);
  assert.equal(stats.tool_missing_result, 1);
  assert.deepEqual(log.map((l) => l.result.status), ['ok', 'error', 'missing']);
  assert.equal(log[0].result.duration_ms, 2500);
  assert.ok(log[0].input.content.includes('[truncated:'), 'long input values are truncated');
  assert.equal(log[0].input_compact, '/w/foo.txt');
  assert.equal(log[1].input_compact, 'sendmail bob');
  assert.equal(stats.turns_user, 1);
  assert.equal(stats.turns_assistant, 2);
  assert.ok(!events.some((e) => e.kind === 'thinking'), 'thinking excluded by default');
  assert.ok(extract(fakeSession(), { includeThinking: true }).events.some((e) => e.kind === 'thinking'));
});

test('extractToDir writes the artifact files and resolveSession finds them', () => {
  const home = tmp();
  const cwd = '/w/proj';
  const pdir = path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
  fs.mkdirSync(pdir, { recursive: true });
  const sid = '11111111-2222-4333-8444-555555555555';
  const file = path.join(pdir, `${sid}.jsonl`);
  fs.writeFileSync(file, fakeSession().map((r) => JSON.stringify(r)).join('\n') + '\n{"half": ');
  assert.equal(resolveSession({ session: sid, cwd, home }), file);
  assert.equal(resolveSession({ cwd, home }), file, 'latest jsonl by mtime');
  assert.throws(() => resolveSession({ session: 'nope', cwd, home }));
  const out = tmp();
  const { files, stats } = extractToDir({ sessionFile: file, outRoot: out, copyRaw: true });
  for (const f of Object.values(files)) assert.ok(fs.existsSync(f), f);
  assert.equal(stats.records_total, 9, 'half-written trailing line skipped');
  const lines = fs.readFileSync(files.execution_log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(fs.readFileSync(files.transcript, 'utf8').includes('tool_result Bash (t2) · ERROR'));
  assert.ok(fs.readFileSync(files.scope, 'utf8').includes('## Turn 1'));
});

// ── validate-ledger ─────────────────────────────────────────────────────────

const good = {
  executive_summary: 'Created foo.txt. Email was not sent.',
  completed_actions: [{ task: 'Create foo.txt', artifact_proof: 'Write #1 /w/foo.txt status ok' }],
  out_of_scope_items: [{ requested_feature: 'Email Bob', rejection_reason: 'No email tool; sendmail not found (#2)' }],
  pending_follow_ups: [],
};

test('extractJson strips fences and surrounding prose', () => {
  assert.deepEqual(JSON.parse(extractJson('Here you go:\n```json\n{"a":1}\n```\nDone.')), { a: 1 });
  assert.deepEqual(JSON.parse(extractJson('{"a":1}')), { a: 1 });
});

test('schema validation: strict keys, types, required', () => {
  const schema = JSON.parse(fs.readFileSync(DEFAULT_SCHEMA, 'utf8'));
  assert.deepEqual(validateAgainst(schema, good), []);
  const errs = validateAgainst(schema, { ...good, extra: 1, completed_actions: [{ task: 'x' }], pending_follow_ups: 'no' });
  assert.ok(errs.some((e) => e.includes('unexpected key "extra"')));
  assert.ok(errs.some((e) => e.includes('missing required "artifact_proof"')));
  assert.ok(errs.some((e) => e.includes('$.pending_follow_ups: expected array')));
  assert.ok(validateAgainst(schema, { ...good, executive_summary: '  ' }).some((e) => e.includes('must not be empty')));
});

test('ledger sanity: hedged proof is an error, hedged summary a warning', () => {
  const r = ledgerSanity({ ...good, executive_summary: 'It probably worked. Really. Honest.', completed_actions: [{ task: 'a', artifact_proof: 'should have written it' }, { task: 'A', artifact_proof: 'done' }] });
  assert.equal(r.errors.length, 2);
  assert.ok(r.warnings.some((w) => w.includes('3 sentences')));
  assert.ok(r.warnings.some((w) => w.includes('hedges')));
  assert.ok(r.warnings.some((w) => w.includes('duplicates')));
});

test('validateFile CLI round trip with --write-clean', () => {
  const d = tmp();
  const f = path.join(d, 'ledger.json');
  fs.writeFileSync(f, '```json\n' + JSON.stringify(good) + '\n```');
  const r = validateFile(f);
  assert.ok(r.ok && r.hadFences);
  const out = execFileSync('node', [path.join(HERE, 'validate-ledger.mjs'), f, '--write-clean']).toString();
  assert.match(out, /^VALID ledger\.schema\.json completed_actions=1 out_of_scope_items=1 pending_follow_ups=0 \(fences stripped\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), good);
  fs.writeFileSync(f, '{"executive_summary":"x"}');
  assert.throws(() => execFileSync('node', [path.join(HERE, 'validate-ledger.mjs'), f], { stdio: 'pipe' }));
});

// ── render-summary ──────────────────────────────────────────────────────────

test('renderSummary is faithful to the ledger', () => {
  const manifest = { id: 'ID', slug: 's', title: 'T', timestamp_utc: 'now', session_id: 'S', cwd: '/w', path: '/p', repo: { origin: 'o', branch: 'main', head: 'abc' }, user: 'u', host: 'h' };
  const md = renderSummary({ manifest, ledger: good, stats: { turns_user: 1, turns_assistant: 2, tool_calls: 3, tool_errors: 1, tool_interrupted: 0, tool_missing_result: 1, tools_by_name: { Bash: 2, Write: 1 }, models: ['m'], first_ts: '2026-10-28T10:00:00Z', last_ts: '2026-10-28T10:30:00Z' }, baseline: { requests: [{ id: 'R1', request: 'x | y', source_turn: 1 }], constraints: { permission_mode: 'default', tools_available: ['Bash'] } } });
  assert.ok(md.includes('## Completed actions (1)'));
  assert.ok(md.includes('| 1 | Create foo.txt | Write #1 /w/foo.txt status ok |'));
  assert.ok(md.includes('## Out of scope (1)'));
  assert.ok(md.includes('## Pending follow-ups (0)'));
  assert.ok(md.includes('x \\| y'), 'pipes escaped in cells');
  assert.ok(md.includes('| Span | 30 min |'));
  const readme = renderReadme({ manifest, ledger: good });
  assert.ok(readme.includes('| 1 | 1 | 0 |'));
});
