# Design: the four primitives

The summarizer is a post-execution pipeline that grades an agent's raw execution log
against its original instructions. It shifts from an *action* mindset to an *evaluation*
mindset: nothing here does work; it only records what the work provably was.

## Goals

| Goal | What it means in the output |
| --- | --- |
| Operational continuity (handoff) | `SUMMARY.md` + `pending_follow_ups` let a human or the next agent pick up exactly where the session stopped. |
| Auditability | `completed_actions[].artifact_proof` cites a log line (`#seq`) a stranger can re-check. |
| Boundary enforcement | `out_of_scope_items` states what was *not* done and why, so no one inherits a hallucinated expectation. |

## Primitives

### 1. The Execution Artifact (input data)

"You cannot summarize what you did not record." Claude Code records every turn and tool
call to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. `extract-session.mjs`
reads that stream and produces:

- **scope.md** — the original user prompt and every later human turn, verbatim, with
  harness `<system-reminder>` blocks removed. Skill injections, local command output and
  harness notifications are kept in the transcript but excluded from the scope.
- **transcript.md** — the chronological conversation: user text, assistant text, each
  `tool_use` (compacted input) and each `tool_result` (status, size, excerpt).
- **execution-log.jsonl** — one line per tool call: `seq`, `ts`, `tool_use_id`, `tool`,
  `input` (string values truncated at `--max-input-chars`), `input_compact`, `sidechain`,
  `result.{status, is_error, interrupted, chars, excerpt, excerpt_truncated, ts, duration_ms}`.
  `status` is one of `ok | error | interrupted | missing` (`missing` = the call was still
  in flight when extracted, or its result lives in a sidechain transcript).
- **stats.json** — turn and call counts, tools by name, models, first/last timestamps,
  what record types were skipped.
- **session.jsonl** — a verbatim copy of the raw transcript so a later re-audit is possible.

#### Artifact shapes (for a manual artifact from a non-Claude-Code log)

If the log did not come from Claude Code, write the same three files by hand:

```
scope.md            # "## Turn N · <ts> · <id>" headings, then the user's text verbatim
transcript.md       # "## [N] <ts> · USER|ASSISTANT" sections; "### → tool_use #seq <tool> (<id>)"
                    # and "### ← tool_result <tool> (<id>) · OK|ERROR · <chars> chars" blocks
execution-log.jsonl # one line per call, with at least:
                    # {"seq":1,"ts":"…","tool_use_id":"…","tool":"…","input":{…},
                    #  "input_compact":"…","result":{"status":"ok","is_error":false,
                    #  "interrupted":false,"chars":123,"excerpt":"…"}}
stats.json          # {"source":"manual","tool_calls":N,"tool_errors":N,…}
```

### 2. The Baseline Comparator

To say something is "out of scope" you need a fixed definition of in-scope.
`baseline.json` (schema: `baseline.schema.json`) lists every discrete request the user
made (`R1…Rn`, with the scope turn it came from and any explicit boundary) and the
constraints the agent operated under (tools available, permission mode, standing rules,
environment limits). The auditor walks that list so no request is silently dropped, and
uses the constraints to decide whether an unmet request was impossible here (out of
scope) or merely unfinished (pending).

The orchestrating session writes the baseline because only it knows its own tool list and
rules. It enumerates; it does not evaluate — evaluation is the auditor's job, and the
orchestrator is the party being audited.

### 3. The Structured Extraction Schema

Instead of "summarize the chat", the auditor must populate `ledger.schema.json`
(draft-07, `additionalProperties: false` everywhere):

```
executive_summary   string   1-2 objective sentences: what was achieved
completed_actions   [{task, artifact_proof}]            proven done, with the proof
out_of_scope_items  [{requested_feature, rejection_reason}]  asked, not done, why not
pending_follow_ups  [{action_needed, blocker}]          attempted/failed or needs a human
```

`validate-ledger.mjs` enforces the schema and a few rules the schema cannot express:
proofs may not hedge ("probably", "should have") or be placeholders ("done"); a pending
item whose blocker is "none" is flagged; the summary should be at most two sentences.

### 4. The Synthesizer

A separate, specialized agent (`.claude/agents/execution-auditor.md`) whose system prompt
makes it a cold, objective auditor. It reads the artifact, judges it against the baseline,
and writes the ledger. It is always a fresh subagent — never a fork of the executing
session — because the cold start is what keeps "what I meant to do" from leaking into
"what the log shows".

## Why the executing agent is kept away from the ledger

Three places where self-assessment would corrupt the output, and the guard for each:

| Temptation | Guard |
| --- | --- |
| Summarize from memory | The artifact is extracted from the transcript on disk by a script |
| Grade one's own work | The auditor is a fresh subagent given only file paths |
| "Fix" an unflattering ledger | The orchestrator may not edit `ledger.json`; validation failures go back to the auditor |

## Folder identity

`create-summary-folder.mjs` is the only component that derives
`/Users/Shared/agents/historical/<timestamp>-<uuid>-<slug>/`. Timestamp is compact UTC
ISO 8601 (chronological sort, filename-safe), uuid is lowercase v4, slug is the
session's subject. A pointer file in the root names the most recent summary so follow-up
steps can find it without re-deriving anything.
