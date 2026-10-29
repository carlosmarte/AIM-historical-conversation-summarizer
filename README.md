# AIM-historical-conversation-summarizer

A post-execution audit pipeline for AI agent sessions, packaged as Claude Code project
config under `.claude/`. It grades what an agent *provably did* against what the user
*asked for* and saves the result as a stateful handoff under
`/Users/Shared/agents/historical/<timestamp>-<uuid>-<slug>/`.

Three goals, in priority order: **boundary enforcement** (what was *not* done is stated),
**auditability** (every completed item cites proof from the log), **handoff** (the folder
stands alone).

## What's here

```
.claude/
├── agents/
│   └── execution-auditor.md          # the Synthesizer: a cold auditor that emits only the ledger JSON
├── commands/
│   └── summarize-session.md          # /summarize-session [slug] [--session <id|path>]
└── skills/
    └── historical-conversation-summarizer/
        ├── SKILL.md                  # the procedure: mint → extract → baseline → audit → validate → render
        ├── scripts/
        │   ├── create-summary-folder.mjs   # mints <timestamp>-<uuid>-<slug>/ + manifest.json
        │   ├── extract-session.mjs         # Claude Code JSONL → scope.md, transcript.md, execution-log.jsonl
        │   ├── validate-ledger.mjs         # strict schema + sanity checks on ledger.json / baseline.json
        │   ├── render-summary.mjs          # ledger.json → SUMMARY.md + README.md
        │   └── pipeline.test.mjs           # node --test
        ├── references/
        │   ├── ledger.schema.json          # the Structured Extraction Schema (draft-07, strict)
        │   ├── baseline.schema.json        # the Baseline Comparator schema
        │   └── primitives.md               # design: goals and the four primitives
        └── evals/                          # claude plugin eval cases
```

## The four primitives → components

| Primitive | Component | Output |
| --- | --- | --- |
| Execution Artifact | `extract-session.mjs` | `execution-artifact/{scope.md, transcript.md, execution-log.jsonl, stats.json, session.jsonl}` |
| Baseline Comparator | the orchestrating session, per `SKILL.md` step 4 | `baseline.json` |
| Structured Extraction Schema | `references/ledger.schema.json` + `validate-ledger.mjs` | the contract and its enforcement |
| Synthesizer | `agents/execution-auditor.md` (fresh subagent, never a fork) | `ledger.json` |

## Output folder

```
/Users/Shared/agents/historical/20261028T233938Z-0e14aaa1-d32e-4645-bdee-4d3c554eaafd-historical-summarizer-skill-build/
├── README.md              index
├── SUMMARY.md             human-readable handoff rendered from ledger.json
├── ledger.json            {executive_summary, completed_actions[], out_of_scope_items[], pending_follow_ups[]}
├── baseline.json          requests R1..Rn + constraints the ledger was judged against
├── manifest.json          id, timestamp, uuid, slug, session id, repo, user/host
└── execution-artifact/    scope.md · transcript.md · execution-log.jsonl · stats.json · session.jsonl
```

## Usage

In a Claude Code session inside a repo that has this `.claude/` directory:

```
/summarize-session api-rate-limiter
/summarize-session csv-importer --session 2c8d7dcb-f41e-41b5-a0db-58061dd2a9da
```

or just ask: "summarize this session for handoff". The scripts are zero-dependency Node and
can be run by hand; see `SKILL.md` for the exact sequence.

```bash
node --test .claude/skills/historical-conversation-summarizer/scripts/*.test.mjs
```

To make the skill, agent and command available in every project, copy or symlink the three
entries into `~/.claude/{skills,agents,commands}/`.
