#!/usr/bin/env node
/**
 * extract-session.mjs — builds the EXECUTION ARTIFACT from a Claude Code session.
 *
 * "You cannot summarize what you did not record." Claude Code already records
 * every turn and tool call in ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl.
 * This script turns that raw stream into the three inputs the auditor needs:
 *
 *   <out>/execution-artifact/scope.md             the user's own turns (THE SCOPE)
 *   <out>/execution-artifact/transcript.md        chronological, human-readable
 *   <out>/execution-artifact/execution-log.jsonl  one line per tool call, with
 *                                                 its result status/excerpt (THE LOG)
 *   <out>/execution-artifact/stats.json           counts, tools used, time span
 *   <out>/execution-artifact/session.jsonl        verbatim copy of the raw stream
 *                                                 (omit with --no-copy-raw)
 *
 * Usage:
 *   node extract-session.mjs --out <summary-root> [--session <id|path>] [--cwd <dir>]
 *        [--max-result-chars 1500] [--max-input-chars 4000] [--include-thinking]
 *        [--no-copy-raw] [--json]
 *
 * Session resolution order: --session as a path → --session as an id under the
 * project dir → $CLAUDE_CODE_SESSION_ID → the most recently modified .jsonl in
 * ~/.claude/projects/<encoded-cwd>/ (the live session is the one being written).
 *
 * Zero dependencies: node builtins only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function encodeProjectDir(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

export function projectsDirFor(cwd, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', encodeProjectDir(cwd));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveSession({ session, cwd, home } = {}) {
  cwd = path.resolve(cwd || process.cwd());
  const pdir = projectsDirFor(cwd, home);
  if (session && fs.existsSync(session) && fs.statSync(session).isFile()) return path.resolve(session);
  const id = session || process.env.CLAUDE_CODE_SESSION_ID;
  if (id && UUID_RE.test(id)) {
    const p = path.join(pdir, `${id}.jsonl`);
    if (fs.existsSync(p)) return p;
    if (session) throw new Error(`session ${id} not found under ${pdir}`);
  }
  if (session) throw new Error(`session "${session}" is neither a file nor an id under ${pdir}`);
  if (!fs.existsSync(pdir)) throw new Error(`no project transcript dir: ${pdir}`);
  const candidates = fs
    .readdirSync(pdir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: fs.statSync(path.join(pdir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!candidates.length) throw new Error(`no .jsonl transcripts under ${pdir}`);
  return path.join(pdir, candidates[0].f);
}

export function readJsonl(file) {
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a half-written trailing line in a live session — skip */
    }
  }
  return out;
}

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export function stripSystemReminders(text) {
  let n = 0;
  const cleaned = String(text).replace(SYSTEM_REMINDER_RE, () => {
    n++;
    return '';
  });
  return { text: cleaned.replace(/\n{3,}/g, '\n\n').trim(), stripped: n };
}

/** Classify a user-authored text block: what actually came from the human? */
export function classifyUserText(text) {
  const t = String(text).trimStart();
  if (/^Base directory for this skill:/.test(t)) return 'skill_injection';
  if (/^<command-name>/.test(t) || /^<local-command-stdout>/.test(t)) return 'local_command';
  if (/^\[Request interrupted/.test(t)) return 'interrupt';
  if (/^<task-notification>/.test(t) || /^\[Artifact comment/.test(t)) return 'harness_notification';
  return 'human';
}

function truncate(s, max) {
  s = String(s ?? '');
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + `\n… [truncated: ${s.length - max} more chars]`, truncated: true };
}

function truncateDeep(value, max) {
  if (typeof value === 'string') return truncate(value, max).text;
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, max));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = truncateDeep(v, max);
    return o;
  }
  return value;
}

function resultText(block, record) {
  // Prefer the structured toolUseResult (stdout/stderr) when present; fall back
  // to the content blocks the model actually saw.
  const r = record?.toolUseResult;
  if (r && typeof r === 'object' && !Array.isArray(r) && ('stdout' in r || 'stderr' in r)) {
    const parts = [];
    if (r.stdout) parts.push(r.stdout);
    if (r.stderr) parts.push(`[stderr]\n${r.stderr}`);
    return { text: parts.join('\n'), interrupted: !!r.interrupted };
  }
  const c = block?.content;
  if (typeof c === 'string') return { text: c, interrupted: false };
  if (Array.isArray(c)) {
    return {
      text: c.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n'),
      interrupted: false,
    };
  }
  if (typeof r === 'string') return { text: r, interrupted: false };
  return { text: '', interrupted: false };
}

function compactInput(tool, input) {
  // What a reader needs to recognise the call at a glance.
  if (!input || typeof input !== 'object') return String(input ?? '');
  switch (tool) {
    case 'Bash':
      return input.command ?? JSON.stringify(input);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return input.file_path ?? input.notebook_path ?? JSON.stringify(input);
    case 'Glob':
    case 'Grep':
      return `${input.pattern ?? ''}${input.path ? `  in ${input.path}` : ''}`;
    case 'Agent':
    case 'Task':
      return `${input.subagent_type ?? 'agent'}: ${input.description ?? ''}`;
    case 'Skill':
      return input.skill ?? JSON.stringify(input);
    case 'WebFetch':
    case 'WebSearch':
      return input.url ?? input.query ?? JSON.stringify(input);
    default:
      return JSON.stringify(input);
  }
}

export function extract(records, opts = {}) {
  const maxResult = opts.maxResultChars ?? 1500;
  const maxInput = opts.maxInputChars ?? 4000;
  const includeThinking = !!opts.includeThinking;

  const events = []; // ordered, for the transcript
  const calls = new Map(); // tool_use_id -> log entry
  const log = [];
  const scope = [];
  const stats = {
    session_id: null,
    cwd: null,
    title: null,
    models: new Set(),
    first_ts: null,
    last_ts: null,
    turns_user: 0,
    turns_assistant: 0,
    user_text_kinds: {},
    tool_calls: 0,
    tool_errors: 0,
    tool_interrupted: 0,
    tool_missing_result: 0,
    tools_by_name: {},
    sidechain_records: 0,
    system_reminders_stripped: 0,
    skipped_record_types: {},
  };

  let seq = 0;
  for (const rec of records) {
    if (rec.sessionId && !stats.session_id) stats.session_id = rec.sessionId;
    if (rec.type === 'ai-title' && rec.aiTitle) stats.title = rec.aiTitle;
    if (rec.type !== 'user' && rec.type !== 'assistant') {
      stats.skipped_record_types[rec.type] = (stats.skipped_record_types[rec.type] || 0) + 1;
      continue;
    }
    if (rec.cwd && !stats.cwd) stats.cwd = rec.cwd;
    if (rec.isSidechain) stats.sidechain_records++;
    const ts = rec.timestamp || null;
    if (ts) {
      if (!stats.first_ts || ts < stats.first_ts) stats.first_ts = ts;
      if (!stats.last_ts || ts > stats.last_ts) stats.last_ts = ts;
    }
    const msg = rec.message || {};
    const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];

    if (rec.type === 'user') {
      let countedTurn = false;
      for (const block of content) {
        if (block.type === 'tool_result') {
          const id = block.tool_use_id;
          const entry = calls.get(id);
          const { text, interrupted } = resultText(block, rec);
          const isError = !!block.is_error;
          const excerpt = truncate(text, maxResult);
          const result = {
            status: interrupted ? 'interrupted' : isError ? 'error' : 'ok',
            is_error: isError,
            interrupted,
            chars: text.length,
            excerpt: excerpt.text,
            excerpt_truncated: excerpt.truncated,
            ts,
            duration_ms: entry?.ts && ts ? Math.max(0, Date.parse(ts) - Date.parse(entry.ts)) : null,
          };
          if (isError) stats.tool_errors++;
          if (interrupted) stats.tool_interrupted++;
          if (entry) entry.result = result;
          else {
            // Result without a visible call (e.g. the call lived in a sidechain file).
            const orphan = { seq: ++seq, ts: null, tool_use_id: id, tool: 'unknown', input: null, input_compact: null, sidechain: !!rec.isSidechain, orphan_result: true, result };
            log.push(orphan);
          }
          events.push({ kind: 'tool_result', ts, id, result, tool: entry?.tool ?? 'unknown' });
        } else if (block.type === 'text') {
          const { text, stripped } = stripSystemReminders(block.text);
          stats.system_reminders_stripped += stripped;
          if (!text) continue;
          const kind = classifyUserText(text);
          stats.user_text_kinds[kind] = (stats.user_text_kinds[kind] || 0) + 1;
          if (!countedTurn && kind === 'human') {
            stats.turns_user++;
            countedTurn = true;
          }
          events.push({ kind: 'user_text', ts, text, textKind: kind, uuid: rec.uuid, sidechain: !!rec.isSidechain });
          if (kind === 'human' && !rec.isSidechain) scope.push({ ts, uuid: rec.uuid, text });
        } else {
          events.push({ kind: 'user_other', ts, blockType: block.type });
        }
      }
    } else {
      // assistant
      if (msg.model) stats.models.add(msg.model);
      let countedTurn = false;
      for (const block of content) {
        if (block.type === 'tool_use') {
          const entry = {
            seq: ++seq,
            ts,
            tool_use_id: block.id,
            tool: block.name,
            input: truncateDeep(block.input, maxInput),
            input_compact: truncate(compactInput(block.name, block.input), 300).text,
            sidechain: !!rec.isSidechain,
            model: msg.model || null,
            result: null,
          };
          calls.set(block.id, entry);
          log.push(entry);
          stats.tool_calls++;
          stats.tools_by_name[block.name] = (stats.tools_by_name[block.name] || 0) + 1;
          events.push({ kind: 'tool_use', ts, entry });
        } else if (block.type === 'text') {
          const text = String(block.text ?? '').trim();
          if (!text) continue;
          if (!countedTurn) {
            stats.turns_assistant++;
            countedTurn = true;
          }
          events.push({ kind: 'assistant_text', ts, text, uuid: rec.uuid, sidechain: !!rec.isSidechain });
        } else if (block.type === 'thinking' && includeThinking) {
          const text = String(block.thinking ?? '').trim();
          if (text) events.push({ kind: 'thinking', ts, text });
        }
      }
    }
  }

  for (const e of log) {
    if (!e.result && !e.orphan_result) {
      e.result = { status: 'missing', is_error: false, interrupted: false, chars: 0, excerpt: '', excerpt_truncated: false, ts: null, duration_ms: null };
      stats.tool_missing_result++;
    }
  }

  stats.models = [...stats.models];
  return { events, log, scope, stats };
}

export function renderScope(scope, stats) {
  const lines = [
    `# Scope — the user's own turns`,
    ``,
    `Session: ${stats.session_id ?? 'unknown'}`,
    `Working directory: ${stats.cwd ?? 'unknown'}`,
    `Title (harness-generated): ${stats.title ?? 'none'}`,
    ``,
    `Each turn below is verbatim user input with harness \`<system-reminder>\` blocks removed.`,
    `The FIRST turn is the original request; later turns may narrow, widen or redirect it.`,
    ``,
  ];
  scope.forEach((t, i) => {
    lines.push(`## Turn ${i + 1} · ${t.ts ?? 'no timestamp'} · ${t.uuid ?? ''}`, ``, t.text, ``);
  });
  if (!scope.length) lines.push(`_No human turns found._`, ``);
  return lines.join('\n');
}

export function renderTranscript(events, stats, opts = {}) {
  const maxResult = opts.maxResultChars ?? 1500;
  const lines = [
    `# Transcript — session ${stats.session_id ?? 'unknown'}`,
    ``,
    `Chronological. Tool inputs are compacted, results are excerpted (full lengths in execution-log.jsonl).`,
    ``,
  ];
  let n = 0;
  for (const e of events) {
    switch (e.kind) {
      case 'user_text': {
        n++;
        const label = e.textKind === 'human' ? 'USER' : `USER (${e.textKind})`;
        lines.push(`## [${n}] ${e.ts ?? ''} · ${label}${e.sidechain ? ' · sidechain' : ''}`, ``, e.text, ``);
        break;
      }
      case 'assistant_text':
        n++;
        lines.push(`## [${n}] ${e.ts ?? ''} · ASSISTANT${e.sidechain ? ' · sidechain' : ''}`, ``, e.text, ``);
        break;
      case 'thinking':
        n++;
        lines.push(`## [${n}] ${e.ts ?? ''} · ASSISTANT (thinking)`, ``, e.text, ``);
        break;
      case 'tool_use': {
        const t = e.entry;
        lines.push(`### → tool_use #${t.seq} ${t.tool} (${t.tool_use_id})`, '', '```', t.input_compact, '```', '');
        break;
      }
      case 'tool_result': {
        const r = e.result;
        const dur = r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : '';
        lines.push(`### ← tool_result ${e.tool} (${e.id}) · ${r.status.toUpperCase()} · ${r.chars} chars${dur}`, '');
        if (r.excerpt) lines.push('```', truncate(r.excerpt, maxResult).text, '```', '');
        break;
      }
      default:
        break;
    }
  }
  return lines.join('\n');
}

function mkdirShared(dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o777);
  } catch {}
}

function writeShared(file, data) {
  fs.writeFileSync(file, data);
  try {
    fs.chmodSync(file, 0o666);
  } catch {}
}

export function extractToDir({ sessionFile, outRoot, copyRaw = true, ...opts }) {
  const records = readJsonl(sessionFile);
  const { events, log, scope, stats } = extract(records, opts);
  const dir = path.join(outRoot, 'execution-artifact');
  mkdirShared(dir);
  const files = {
    scope: path.join(dir, 'scope.md'),
    transcript: path.join(dir, 'transcript.md'),
    execution_log: path.join(dir, 'execution-log.jsonl'),
    stats: path.join(dir, 'stats.json'),
  };
  writeShared(files.scope, renderScope(scope, stats) + '\n');
  writeShared(files.transcript, renderTranscript(events, stats, opts) + '\n');
  writeShared(files.execution_log, log.map((l) => JSON.stringify(l)).join('\n') + (log.length ? '\n' : ''));
  const statsOut = { ...stats, source_file: sessionFile, records_total: records.length, extracted_at: new Date().toISOString() };
  writeShared(files.stats, JSON.stringify(statsOut, null, 2) + '\n');
  if (copyRaw) {
    files.session = path.join(dir, 'session.jsonl');
    fs.copyFileSync(sessionFile, files.session);
    try {
      fs.chmodSync(files.session, 0o666);
    } catch {}
  }
  return { files, stats: statsOut };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || a.h) {
    console.log('usage: extract-session.mjs --out <summary-root> [--session <id|path>] [--cwd <dir>] [--max-result-chars N] [--max-input-chars N] [--include-thinking] [--no-copy-raw] [--json]');
    process.exit(0);
  }
  if (!a.out) {
    console.error('extract-session: --out <summary-root> is required (mint it with create-summary-folder.mjs first)');
    process.exit(2);
  }
  try {
    const sessionFile = resolveSession({ session: a.session, cwd: a.cwd });
    const { files, stats } = extractToDir({
      sessionFile,
      outRoot: path.resolve(a.out),
      copyRaw: !a['no-copy-raw'],
      maxResultChars: a['max-result-chars'] ? Number(a['max-result-chars']) : undefined,
      maxInputChars: a['max-input-chars'] ? Number(a['max-input-chars']) : undefined,
      includeThinking: !!a['include-thinking'],
    });
    const summary = { session_file: sessionFile, session_id: stats.session_id, title: stats.title, files, stats: { turns_user: stats.turns_user, turns_assistant: stats.turns_assistant, tool_calls: stats.tool_calls, tool_errors: stats.tool_errors, tool_interrupted: stats.tool_interrupted, tool_missing_result: stats.tool_missing_result, tools_by_name: stats.tools_by_name, first_ts: stats.first_ts, last_ts: stats.last_ts } };
    if (a.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`session:  ${sessionFile}`);
      console.log(`scope:    ${files.scope}`);
      console.log(`log:      ${files.execution_log}  (${stats.tool_calls} calls, ${stats.tool_errors} errors, ${stats.tool_missing_result} missing results)`);
      console.log(`turns:    ${stats.turns_user} user / ${stats.turns_assistant} assistant`);
    }
  } catch (e) {
    console.error(`extract-session: ${e.message}`);
    process.exit(1);
  }
}
