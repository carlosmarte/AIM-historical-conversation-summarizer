#!/usr/bin/env node
/**
 * create-summary-folder.mjs — the ONE place a historical-summary root is minted.
 *
 *     /Users/Shared/agents/historical/<timestamp>-<uuid>-<slug>/
 *
 *   <timestamp>  UTC, compact ISO 8601: 20261028T193000Z  (sorts chronologically,
 *                no colons, matches the sibling /Users/Shared/agents/analysis/ roots)
 *   <uuid>       v4, lowercase (crypto.randomUUID)
 *   <slug>       kebab-case, [a-z0-9-], ≤ 40 chars, names the SUBJECT of the session
 *
 * The script owns IDENTITY (timestamp, uuid, slug, layout, manifest, pointer).
 * The model owns CONTENT (scope, baseline, ledger, summary) written afterwards.
 *
 * Usage:
 *   node create-summary-folder.mjs --slug "<text to slugify>" [--root <dir>]
 *        [--session-id <id>] [--cwd <dir>] [--title "<text>"] [--json]
 *
 * Prints the absolute path of the new root (or a JSON object with --json).
 * Zero dependencies: node builtins only.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ROOT = '/Users/Shared/agents/historical';
export const POINTER_FILE = '.historical-conversation-summarizer--last';
export const SCHEMA_VERSION = '1';

export function slugify(text, max = 40) {
  let s = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (s.length > max) {
    s = s.slice(0, max);
    const cut = s.lastIndexOf('-');
    if (cut > 8) s = s.slice(0, cut);
    s = s.replace(/-+$/, '');
  }
  return s || 'session';
}

export function compactTimestamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function git(args, cwd) {
  try {
    return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function repoInfo(cwd) {
  const toplevel = git('rev-parse --show-toplevel', cwd);
  if (!toplevel) return { toplevel: null, name: path.basename(cwd), origin: null, branch: null, head: null };
  return {
    toplevel,
    name: path.basename(toplevel).replace(/\.git$/, ''),
    origin: git('remote get-url origin', cwd),
    branch: git('rev-parse --abbrev-ref HEAD', cwd),
    head: git('rev-parse --short HEAD', cwd),
  };
}

function mkdirShared(dir) {
  // /Users/Shared is multi-user: a dir created under a default umask by one Mac
  // user is unwritable by the next. mkdir failing is FATAL; chmod failing is not.
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o777);
  } catch {
    /* owned by another user — the record still lands */
  }
}

export function createSummaryFolder(opts = {}) {
  const root = path.resolve(opts.root || DEFAULT_ROOT);
  const cwd = path.resolve(opts.cwd || process.cwd());
  const now = new Date();
  const timestamp = compactTimestamp(now);
  const uuid = randomUUID().toLowerCase();
  const slug = slugify(opts.slug);
  const id = `${timestamp}-${uuid}-${slug}`;
  const dir = path.join(root, id);

  try {
    mkdirShared(root);
  } catch (e) {
    throw new Error(`cannot create root ${root}: ${e.message}`);
  }
  if (fs.existsSync(dir)) throw new Error(`refusing to reuse existing root ${dir}`);
  mkdirShared(dir);
  mkdirShared(path.join(dir, 'execution-artifact'));

  let user = null;
  let host = null;
  try {
    user = os.userInfo().username;
  } catch {}
  try {
    host = os.hostname().split('.')[0];
  } catch {}

  const manifest = {
    schema_version: SCHEMA_VERSION,
    id,
    timestamp_utc: now.toISOString(),
    timestamp: timestamp,
    uuid,
    slug,
    title: opts.title || null,
    path: dir,
    root,
    session_id: opts.sessionId || process.env.CLAUDE_CODE_SESSION_ID || null,
    cwd,
    repo: repoInfo(cwd),
    user,
    host,
    created_by: 'historical-conversation-summarizer',
    files: {
      manifest: 'manifest.json',
      scope: 'execution-artifact/scope.md',
      transcript: 'execution-artifact/transcript.md',
      execution_log: 'execution-artifact/execution-log.jsonl',
      stats: 'execution-artifact/stats.json',
      baseline: 'baseline.json',
      ledger: 'ledger.json',
      summary: 'SUMMARY.md',
      readme: 'README.md',
    },
  };
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  try {
    fs.chmodSync(manifestPath, 0o666);
  } catch {}

  // Pointer: lets a follow-up step ("render the last summary") find this root
  // without re-deriving the name. Best effort — never fatal.
  try {
    fs.writeFileSync(path.join(root, POINTER_FILE), dir + '\n');
  } catch {}

  return { dir, manifest };
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
    console.log('usage: create-summary-folder.mjs --slug "<text>" [--root <dir>] [--session-id <id>] [--cwd <dir>] [--title "<text>"] [--json]');
    process.exit(0);
  }
  const slugSource = a.slug || a._.join(' ') || a.title;
  if (!slugSource) {
    console.error('create-summary-folder: --slug is required (the subject of the session, 2-5 words)');
    process.exit(2);
  }
  try {
    const { dir, manifest } = createSummaryFolder({
      slug: slugSource,
      root: a.root,
      cwd: a.cwd,
      sessionId: a['session-id'],
      title: a.title,
    });
    if (a.json) console.log(JSON.stringify(manifest, null, 2));
    else console.log(dir);
  } catch (e) {
    console.error(`create-summary-folder: ${e.message}`);
    process.exit(1);
  }
}
