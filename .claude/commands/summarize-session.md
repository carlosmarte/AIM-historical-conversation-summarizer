---
name: summarize-session
description: Audit and summarize this (or a named) Claude Code session into /Users/Shared/agents/historical/<timestamp>-<uuid>-<slug>/ — extracts the execution artifact, writes the baseline, runs the cold execution-auditor agent, validates the ledger, renders SUMMARY.md.
argument-hint: "[slug] [--session <id|path>] [--include-thinking]"
allowed-tools: Bash, Read, Write, Grep, Agent, Skill
---

Run the `historical-conversation-summarizer` skill end to end on the current session and
report the saved folder, the executive summary, the counts, and the pending follow-ups.

Arguments: `$ARGUMENTS`

- A bare word or phrase is the slug (the session's subject).
- `--session <uuid|path>` audits a past session instead of the live one.
- `--include-thinking` keeps the agent's thinking blocks in the transcript.

Follow the skill's procedure exactly: mint the root with `create-summary-folder.mjs`,
extract with `extract-session.mjs`, write and validate `baseline.json`, spawn the
`execution-auditor` agent as a fresh subagent (not a fork) with file paths only, validate
`ledger.json`, render with `render-summary.mjs`. Never write the ledger yourself.
