#!/usr/bin/env node
/**
 * validate-ledger.mjs — proves an auditor output conforms to the strict ledger
 * schema BEFORE it is accepted as the session's record of truth.
 *
 * The auditor is an LLM; its output is only deterministic if something checks
 * it. This validator implements the draft-07 subset the ledger and baseline
 * schemas use (type, required, properties, additionalProperties, items, enum,
 * minLength, minItems) with zero dependencies, then applies ledger-specific
 * sanity rules that a schema cannot express.
 *
 * Usage:
 *   node validate-ledger.mjs <file.json> [--schema <schema.json>] [--write-clean [<out.json>]] [--quiet]
 *
 *   --schema        defaults to ../references/ledger.schema.json
 *   --write-clean   re-serialise the parsed object as pretty JSON (strips any
 *                   ``` fences the model wrapped it in); defaults to in-place
 *
 * Exit 0 = VALID (warnings may still print), exit 1 = INVALID, exit 2 = usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SCHEMA = path.join(HERE, '..', 'references', 'ledger.schema.json');

/** Strip ```json fences and leading/trailing prose a model may have added. */
export function extractJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  if (!t.startsWith('{') && !t.startsWith('[')) {
    const i = t.search(/[[{]/);
    if (i >= 0) t = t.slice(i);
  }
  if (!t.endsWith('}') && !t.endsWith(']')) {
    const j = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (j >= 0) t = t.slice(0, j + 1);
  }
  return t;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(expected, v) {
  const actual = typeOf(v);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

/** Minimal draft-07 subset validator. Returns a list of "path: message". */
export function validateAgainst(schema, value, at = '$', errors = []) {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'string' && schema.minLength != null && value.trim().length < schema.minLength) errors.push(`${at}: must not be empty`);
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => validateAgainst(schema.items, v, `${at}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!(k in value)) errors.push(`${at}: missing required "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) validateAgainst(props[k], v, `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected key "${k}"`);
    }
  }
  return errors;
}

const HEDGES = /\b(probably|likely|should have|presumably|I think|appears to have|seems to have|may have)\b/i;

/** Rules the ledger schema cannot express. Returns { errors, warnings }. */
export function ledgerSanity(ledger) {
  const errors = [];
  const warnings = [];
  if (!ledger || typeof ledger !== 'object') return { errors, warnings };

  const summary = String(ledger.executive_summary ?? '');
  const sentences = summary.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).filter((s) => s.trim());
  if (sentences.length > 2) warnings.push(`executive_summary has ${sentences.length} sentences; the contract is 1-2`);
  if (HEDGES.test(summary)) warnings.push(`executive_summary hedges ("${summary.match(HEDGES)[0]}") — a ledger states, it does not guess`);

  const seen = new Set();
  for (const [i, a] of (ledger.completed_actions || []).entries()) {
    const key = String(a.task).trim().toLowerCase();
    if (seen.has(key)) warnings.push(`completed_actions[${i}] duplicates an earlier task: "${a.task}"`);
    seen.add(key);
    if (HEDGES.test(a.artifact_proof)) errors.push(`completed_actions[${i}].artifact_proof hedges ("${a.artifact_proof.match(HEDGES)[0]}") — proof must be an observed fact, not an inference`);
    if (/^(done|completed|success|n\/a|none|see log)\.?$/i.test(String(a.artifact_proof).trim())) errors.push(`completed_actions[${i}].artifact_proof is a placeholder ("${a.artifact_proof}"), not evidence`);
  }
  for (const [i, p] of (ledger.pending_follow_ups || []).entries()) {
    if (/^(none|n\/a|unknown)\.?$/i.test(String(p.blocker).trim())) warnings.push(`pending_follow_ups[${i}].blocker is "${p.blocker}" — if nothing blocks it, why is it pending?`);
  }
  return { errors, warnings };
}

export function validateFile(file, { schemaPath = DEFAULT_SCHEMA } = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  let parsed;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (e) {
    return { ok: false, parsed: null, errors: [`not parseable JSON: ${e.message}`], warnings: [], hadFences: /```/.test(raw) };
  }
  const errors = validateAgainst(schema, parsed);
  const isLedger = path.basename(schemaPath) === 'ledger.schema.json';
  const sanity = isLedger ? ledgerSanity(parsed) : { errors: [], warnings: [] };
  errors.push(...sanity.errors);
  return { ok: errors.length === 0, parsed, errors, warnings: sanity.warnings, hadFences: /```/.test(raw) };
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
  const file = a._[0];
  if (!file || a.help) {
    console.log('usage: validate-ledger.mjs <file.json> [--schema <schema.json>] [--write-clean [<out.json>]] [--quiet]');
    process.exit(file ? 0 : 2);
  }
  const schemaPath = a.schema ? path.resolve(a.schema) : DEFAULT_SCHEMA;
  const r = validateFile(path.resolve(file), { schemaPath });
  const counts = r.parsed && typeof r.parsed === 'object'
    ? Object.entries(r.parsed).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}=${v.length}`).join(' ')
    : '';
  if (r.ok) {
    if (a['write-clean']) {
      const out = typeof a['write-clean'] === 'string' ? path.resolve(a['write-clean']) : path.resolve(file);
      fs.writeFileSync(out, JSON.stringify(r.parsed, null, 2) + '\n');
      try { fs.chmodSync(out, 0o666); } catch {}
    }
    if (!a.quiet) {
      console.log(`VALID ${path.basename(schemaPath)} ${counts}${r.hadFences ? ' (fences stripped)' : ''}`);
      for (const w of r.warnings) console.log(`  warning: ${w}`);
    }
    process.exit(0);
  }
  console.error(`INVALID ${path.basename(schemaPath)}: ${r.errors.length} error(s)`);
  for (const e of r.errors) console.error(`  - ${e}`);
  for (const w of r.warnings) console.error(`  warning: ${w}`);
  process.exit(1);
}
