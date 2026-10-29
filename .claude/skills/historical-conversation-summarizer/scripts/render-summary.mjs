#!/usr/bin/env node
/**
 * render-summary.mjs — turns a validated ledger.json into the human-readable
 * handoff (SUMMARY.md) and the folder index (README.md).
 *
 * The ledger is the machine-readable truth; SUMMARY.md is a faithful rendering
 * of it plus the manifest/stats context, never a second opinion. Nothing in
 * here interprets, re-orders or softens the auditor's findings.
 *
 * Usage:
 *   node render-summary.mjs <summary-root>
 *
 * Reads  <root>/manifest.json, <root>/ledger.json,
 *        <root>/execution-artifact/stats.json (optional), <root>/baseline.json (optional)
 * Writes <root>/SUMMARY.md, <root>/README.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readJson(file, optional = false) {
  if (!fs.existsSync(file)) {
    if (optional) return null;
    throw new Error(`missing ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function table(headers, rows) {
  if (!rows.length) return '_None._\n';
  const out = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) out.push(`| ${r.map(cell).join(' | ')} |`);
  return out.join('\n') + '\n';
}

function span(stats) {
  if (!stats?.first_ts || !stats?.last_ts) return null;
  const ms = Date.parse(stats.last_ts) - Date.parse(stats.first_ts);
  if (!Number.isFinite(ms)) return null;
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

export function renderSummary({ manifest, ledger, stats, baseline }) {
  const repo = manifest.repo || {};
  const meta = [
    ['Summary id', manifest.id],
    ['Recorded (UTC)', manifest.timestamp_utc],
    ['Session', manifest.session_id ?? 'unknown'],
    ['Working directory', manifest.cwd],
    ['Repo', repo.origin ? `${repo.origin} (${repo.branch ?? '?'} @ ${repo.head ?? '?'})` : repo.name ?? 'none'],
    ['Recorded by', `${manifest.user ?? '?'}@${manifest.host ?? '?'}`],
    ['Folder', manifest.path],
  ];
  const L = ledger;
  const lines = [];
  lines.push(`# Execution Summary — ${manifest.title || manifest.slug}`, '');
  lines.push(table(['Field', 'Value'], meta));
  lines.push(`## Executive summary`, '', L.executive_summary, '');
  lines.push(`## Completed actions (${L.completed_actions.length})`, '');
  lines.push(`Only actions with explicit proof in the execution log. Anything not listed here was **not** verified as done.`, '');
  lines.push(table(['#', 'Task', 'Artifact proof'], L.completed_actions.map((a, i) => [i + 1, a.task, a.artifact_proof])));
  lines.push(`## Out of scope (${L.out_of_scope_items.length})`, '');
  lines.push(`Requests the agent bypassed, rejected, or could not perform with its tools or permissions.`, '');
  lines.push(table(['#', 'Requested', 'Rejection reason'], L.out_of_scope_items.map((o, i) => [i + 1, o.requested_feature, o.rejection_reason])));
  lines.push(`## Pending follow-ups (${L.pending_follow_ups.length})`, '');
  lines.push(`Where the next human or agent picks up.`, '');
  lines.push(table(['#', 'Action needed', 'Blocker'], L.pending_follow_ups.map((p, i) => [i + 1, p.action_needed, p.blocker])));

  if (baseline?.requests?.length) {
    lines.push(`## Baseline — requests in scope (${baseline.requests.length})`, '');
    lines.push(table(['Id', 'Request', 'Turn', 'Boundary'], baseline.requests.map((r) => [r.id, r.request, r.source_turn, r.explicit_boundary ?? ''])));
    const c = baseline.constraints || {};
    lines.push(`Permission mode: \`${c.permission_mode ?? 'unknown'}\` · Tools: ${(c.tools_available || []).join(', ') || 'none listed'}`, '');
    if (c.rules_in_effect?.length) lines.push(`Rules in effect: ${c.rules_in_effect.join('; ')}`, '');
    if (c.environment?.length) lines.push(`Environment: ${c.environment.join('; ')}`, '');
  }

  if (stats) {
    const tools = Object.entries(stats.tools_by_name || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}`)
      .join(', ');
    lines.push(`## Execution stats`, '');
    lines.push(table(['Metric', 'Value'], [
      ['User turns', stats.turns_user],
      ['Assistant turns', stats.turns_assistant],
      ['Tool calls', stats.tool_calls],
      ['Tool errors', stats.tool_errors],
      ['Interrupted calls', stats.tool_interrupted],
      ['Calls with no result', stats.tool_missing_result],
      ['Tools used', tools || 'none'],
      ['Models', (stats.models || []).join(', ') || 'unknown'],
      ['Span', span(stats) ?? 'unknown'],
      ['Window', `${stats.first_ts ?? '?'} → ${stats.last_ts ?? '?'}`],
    ]));
  }

  lines.push(`## Files`, '');
  lines.push(`- \`ledger.json\` — the machine-readable ledger this page renders (schema: \`ledger.schema.json\` in the skill's references)`);
  lines.push(`- \`baseline.json\` — the in-scope request list and constraints the auditor judged against`);
  lines.push(`- \`execution-artifact/scope.md\` — the user's own turns, verbatim`);
  lines.push(`- \`execution-artifact/transcript.md\` — chronological conversation and tool calls`);
  lines.push(`- \`execution-artifact/execution-log.jsonl\` — one line per tool call with result status`);
  lines.push(`- \`execution-artifact/session.jsonl\` — raw Claude Code transcript, when copied`);
  lines.push(`- \`manifest.json\` — identity: id, timestamp, uuid, slug, session, repo`, '');
  return lines.join('\n');
}

export function renderReadme({ manifest, ledger }) {
  return [
    `# ${manifest.id}`,
    '',
    `Historical conversation summary for session \`${manifest.session_id ?? 'unknown'}\` in \`${manifest.cwd}\`.`,
    '',
    `**Start with [SUMMARY.md](SUMMARY.md).** It is the handoff: what was done (with proof), what was out of scope, and what is pending.`,
    '',
    `| Completed | Out of scope | Pending |`,
    `| --- | --- | --- |`,
    `| ${ledger.completed_actions.length} | ${ledger.out_of_scope_items.length} | ${ledger.pending_follow_ups.length} |`,
    '',
    `## Layout`,
    '',
    '```',
    `${manifest.id}/`,
    `├── README.md                    this index`,
    `├── SUMMARY.md                   human-readable handoff rendered from ledger.json`,
    `├── ledger.json                  strict extraction schema output (the truth)`,
    `├── baseline.json                in-scope requests + constraints the ledger was judged against`,
    `├── manifest.json                identity and provenance`,
    `└── execution-artifact/`,
    `    ├── scope.md                 the user's turns (THE SCOPE)`,
    `    ├── transcript.md            chronological conversation + tool calls`,
    `    ├── execution-log.jsonl      one JSON line per tool call (THE LOG)`,
    `    ├── stats.json               counts and time span`,
    `    └── session.jsonl            raw Claude Code transcript (if copied)`,
    '```',
    '',
  ].join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.argv[2];
  if (!root || root === '--help') {
    console.log('usage: render-summary.mjs <summary-root>');
    process.exit(root ? 0 : 2);
  }
  try {
    const dir = path.resolve(root);
    const manifest = readJson(path.join(dir, 'manifest.json'));
    const ledger = readJson(path.join(dir, 'ledger.json'));
    const stats = readJson(path.join(dir, 'execution-artifact', 'stats.json'), true);
    const baseline = readJson(path.join(dir, 'baseline.json'), true);
    for (const k of ['executive_summary', 'completed_actions', 'out_of_scope_items', 'pending_follow_ups']) {
      if (!(k in ledger)) throw new Error(`ledger.json missing "${k}" — run validate-ledger.mjs first`);
    }
    const summaryPath = path.join(dir, 'SUMMARY.md');
    const readmePath = path.join(dir, 'README.md');
    fs.writeFileSync(summaryPath, renderSummary({ manifest, ledger, stats, baseline }) + '\n');
    fs.writeFileSync(readmePath, renderReadme({ manifest, ledger }));
    for (const f of [summaryPath, readmePath]) {
      try { fs.chmodSync(f, 0o666); } catch {}
    }
    console.log(summaryPath);
    console.log(readmePath);
  } catch (e) {
    console.error(`render-summary: ${e.message}`);
    process.exit(1);
  }
}
