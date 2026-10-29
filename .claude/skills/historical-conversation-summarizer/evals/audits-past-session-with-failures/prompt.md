---
tags: [historical-conversation-summarizer]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash, Agent]
---

Audit the session transcript in fixture-session.jsonl (it's a Claude Code transcript export from yesterday, the one where I asked for the CSV importer and an email to the finance team). I want the historical summary saved under /Users/Shared/agents/historical with the slug "csv-importer", and I specifically want to see what was NOT done called out — the agent claimed it emailed finance and I don't believe it.

Input files: fixture-session.jsonl
