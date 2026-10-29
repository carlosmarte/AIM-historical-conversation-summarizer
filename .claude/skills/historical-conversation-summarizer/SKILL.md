---
name: historical-conversation-summarizer
description: Post-execution audit of an AI agent session — extract the session's Execution Artifact (scope, transcript, tool-call log) from the Claude Code transcript, enumerate the in-scope requests as a Baseline, run the cold execution-auditor agent to produce the strict ledger (completed_actions with artifact_proof, out_of_scope_items, pending_follow_ups, executive_summary), validate it against the schema, and save the whole bundle under /Users/Shared/agents/historical/<timestamp>-<uuid>-<slug>/. Use whenever the user wants a session summarized, audited, handed off, or wrapped up — "summarize this session", "what did we actually get done", "write the handoff", "save a historical summary", "audit what the agent did vs what I asked", "ledger of completed vs pending", or at the end of a long task when the next person or agent needs to pick up cleanly. Also use on a past session id or transcript path, not only the live one. Do NOT use for summarizing documents, articles or code — it audits execution logs only.
allowed-tools: Bash, Read, Write, Grep, Agent
argument-hint: "[slug] [--session <id|path>] [--include-thinking]"
---

# historical-conversation-summarizer

Turn a messy, token-heavy session into a ledger of absolute facts that a human or the
next agent can pick up from. This is an **evaluation** job, not an action job: nothing in
this skill does or fixes the session's work. It records what the log proves was done, what
was refused or impossible, and what is still open.

Three outcomes, in order of importance:

1. **Boundary enforcement** — what was *not* done is stated explicitly, so nobody inherits
   a hallucinated expectation.
2. **Auditability** — every completed item carries proof a stranger can re-check.
3. **Handoff** — the folder stands alone; no conversation context is needed to read it.

## Home

```
/Users/Shared/agents/historical/
└── <timestamp>-<uuid>-<slug>/          # 20261028T193000Z-5c3a0bd8-…-historical-summarizer-agent-skills
    ├── README.md                       # index (rendered)
    ├── SUMMARY.md                      # human-readable handoff (rendered from ledger.json)
    ├── ledger.json                     # THE STRUCTURED EXTRACTION SCHEMA output — the truth
    ├── baseline.json                   # THE BASELINE COMPARATOR — requests + constraints
    ├── manifest.json                   # identity: id, timestamp, uuid, slug, session, repo
    └── execution-artifact/             # THE EXECUTION ARTIFACT — raw inputs
        ├── scope.md                    # the user's turns, verbatim (THE SCOPE)
        ├── transcript.md               # chronological conversation + tool calls
        ├── execution-log.jsonl         # one line per tool call with result status (THE LOG)
        ├── stats.json                  # counts, tools, time span
        └── session.jsonl               # raw Claude Code transcript copy
```

`<timestamp>` is compact UTC ISO 8601 (`20261028T193000Z`) so roots sort chronologically;
`<uuid>` is a lowercase v4; `<slug>` names the **subject** of the session in 2–5 kebab-case
words (≤ 40 chars). The folder is minted only by `scripts/create-summary-folder.mjs` —
never derive the path by hand, or two components will disagree about where things are.

The four primitives map onto the scripts and the agent like this:

| Primitive | Owner | Produces |
| --- | --- | --- |
| Execution Artifact | `scripts/extract-session.mjs` | `execution-artifact/*` |
| Baseline Comparator | **you**, in this session | `baseline.json` |
| Structured Extraction Schema | `references/ledger.schema.json` + `scripts/validate-ledger.mjs` | the contract and its enforcement |
| Synthesizer | the `execution-auditor` agent (a fresh subagent, never a fork) | `ledger.json` |

Read `references/primitives.md` if you need the design rationale; the procedure below is
self-contained.

## Procedure

All scripts are zero-dependency Node (`node >= 18`). `SKILL_DIR` below is this skill's
directory (`.claude/skills/historical-conversation-summarizer` in the repo, or wherever it
is installed).

### 1. Pick the session and the slug

- **Live session** (default): the extractor resolves it from `$CLAUDE_CODE_SESSION_ID`,
  falling back to the most recently modified transcript under
  `~/.claude/projects/<encoded-cwd>/`. Nothing to pass.
- **A past session**: pass `--session <uuid>` (looked up in the same project dir) or
  `--session /path/to/transcript.jsonl`.
- **A non-Claude-Code log** (pasted text, another harness's export): skip step 3's
  extractor and write `execution-artifact/scope.md`, `transcript.md` and
  `execution-log.jsonl` yourself in the same shapes (see `references/primitives.md`
  → "Artifact shapes"). Record `"source": "manual"` in `stats.json`.

The slug names the subject, not the activity: `auth-token-refresh`, not
`working-on-auth`. Use the user's argument if given; otherwise derive it from the first
request in the scope. The harness's own title (`ai-title` in the transcript, surfaced by
the extractor as `stats.title`) is a good fallback.

### 2. Mint the root

```bash
DIR=$(node "$SKILL_DIR/scripts/create-summary-folder.mjs" --slug "<slug>" --title "<short title>")
echo "$DIR"
```

This writes `manifest.json` and updates the pointer file
`/Users/Shared/agents/historical/.historical-conversation-summarizer--last`. Permissions:
`/Users/Shared` is multi-user, so the script `chmod 0777`s the directories it creates and
tolerates a chmod failure on paths another user owns. A `mkdir` failure is fatal — report
it with the error, do not relocate the summary somewhere else.

### 3. Extract the Execution Artifact

```bash
node "$SKILL_DIR/scripts/extract-session.mjs" --out "$DIR" [--session <id|path>] [--include-thinking]
```

Prints the resolved session file and the counts. Then read `"$DIR/execution-artifact/scope.md"`
in full and skim `stats.json`. If `turns_user` is 0, the session resolution is wrong —
stop and check `--session`, do not continue with an empty scope.

Why a script and not memory: the executing agent's recollection of its own session is
exactly the thing being audited. The artifact must come from the transcript on disk.

### 4. Write the Baseline Comparator

Write `"$DIR/baseline.json"` matching `references/baseline.schema.json`:

- `requests[]` — every discrete, checkable thing the user asked for, in order, split out of
  compound sentences, as close to the user's words as possible, each with its `source_turn`
  from `scope.md` and any `explicit_boundary` the user attached ("only under ./.claude",
  "don't commit"). Pasted background prose, design explanations and examples are **not**
  requests; only imperatives and questions are. Do not rank, merge or judge them — the
  auditor judges.
- `constraints` — what *this* session could and could not do: `tools_available` (the tool
  names you actually had), `permission_mode`, `rules_in_effect` (standing rules that shape
  outcomes: banned dependencies, directories not to scan, commit policy, "only commit when
  asked"), and `environment` facts that bounded the work (offline, no credentials, missing
  CLI, read-only path). These let the auditor tell *out of scope* (could never be done here)
  from *pending* (could be, was not).

Then validate it:

```bash
node "$SKILL_DIR/scripts/validate-ledger.mjs" "$DIR/baseline.json" --schema "$SKILL_DIR/references/baseline.schema.json" --write-clean
```

You write the baseline rather than the auditor because you know the session's tool list
and rules and the auditor does not; you enumerate rather than evaluate because you are the
party being audited.

### 5. Run the Synthesizer — the `execution-auditor` agent

Spawn the `execution-auditor` agent as a **fresh** subagent (never `fork`: a fork inherits
this conversation and loses the cold start that makes the audit honest). Give it only
paths — not your account of the session:

```
Audit this session and write the ledger.

SCOPE:       <DIR>/execution-artifact/scope.md
BASELINE:    <DIR>/baseline.json
LOG:         <DIR>/execution-artifact/execution-log.jsonl
TRANSCRIPT:  <DIR>/execution-artifact/transcript.md
SCHEMA:      <SKILL_DIR>/references/ledger.schema.json
VALIDATOR:   node <SKILL_DIR>/scripts/validate-ledger.mjs <DIR>/ledger.json
OUTPUT:      <DIR>/ledger.json

Rules you inherit: do not read or search any `.ai/` or `.archives/` directory; do not
modify anything except OUTPUT. Return the ledger JSON and nothing else.
```

Carry any other standing rules from your session into that prompt verbatim (subagents
inherit them only if you pass them on).

If the Agent tool reports that `execution-auditor` is not an available type (agent files
are registered at session start, so a session older than the file cannot see it), spawn a
`general-purpose` agent instead and paste the body of
`.claude/agents/execution-auditor.md` (everything below the frontmatter) at the top of the
prompt, followed by the same path block. The cold start is preserved either way.

### 6. Validate the ledger

```bash
node "$SKILL_DIR/scripts/validate-ledger.mjs" "$DIR/ledger.json" --write-clean
```

`VALID` → continue. `INVALID` → send the error list back to the same auditor agent
(SendMessage keeps its context) and have *it* fix the JSON. Do not edit `ledger.json`
yourself: the moment the audited party rewrites the audit, the ledger stops being
evidence. Warnings (hedged wording, a 3-sentence summary) are worth one round-trip to
the auditor; they are not blockers.

If the auditor's ledger contradicts what you remember doing, the ledger stands. If you can
point at a specific log line it missed, send *that line* to the auditor and let it decide.

### 7. Render and report

```bash
node "$SKILL_DIR/scripts/render-summary.mjs" "$DIR"
```

Writes `SUMMARY.md` and `README.md` from `ledger.json` + `manifest.json` + `stats.json` +
`baseline.json`. Then report to the user, in this order:

1. The absolute folder path.
2. The executive summary, verbatim.
3. Counts: completed / out of scope / pending.
4. The pending follow-ups, each on one line — this is what the next person acts on.

Do not restate the completed actions in prose; the folder has them.

## Rules

- **Never summarize from memory.** The artifact comes from the transcript on disk; the
  ledger comes from the auditor. Your role is plumbing plus the baseline.
- **The ledger is immutable once rendered.** A follow-up run on the same session mints a
  new root (new timestamp, new uuid); it does not edit an old one. The pointer file always
  names the latest.
- **Every claim traces to `#seq`.** If the auditor returns a `completed_actions` row without
  a traceable proof, that is a defect in the ledger, not a style issue — bounce it.
- **Don't widen the scope while auditing.** Noticing an unfinished thing in the log is a
  `pending_follow_ups` row, not a reason to go finish it now.
- The `execution-artifact/session.jsonl` copy can be large (hundreds of KB); pass
  `--no-copy-raw` to the extractor only if the user asks for a lean folder — the raw copy is
  what makes a later re-audit possible.

## Scripts

| Script | Purpose |
| --- | --- |
| `scripts/create-summary-folder.mjs` | Mints `<timestamp>-<uuid>-<slug>/`, writes `manifest.json`, updates the last-summary pointer |
| `scripts/extract-session.mjs` | Claude Code JSONL → `scope.md`, `transcript.md`, `execution-log.jsonl`, `stats.json`, raw copy |
| `scripts/validate-ledger.mjs` | Draft-07-subset validation of `ledger.json` (or `baseline.json` with `--schema`) plus ledger sanity rules; `--write-clean` strips fences and pretty-prints |
| `scripts/render-summary.mjs` | `ledger.json` → `SUMMARY.md` + `README.md` |

Run the tests with `node --test "$SKILL_DIR/scripts/*.test.mjs"`.
