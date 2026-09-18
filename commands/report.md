---
description: Prompt-habit patterns and trends across your logged prompts
argument-hint: [how many recent prompts, default 200]
disable-model-invocation: true
allowed-tools: Bash
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" report "$1"`

---

Print the report above exactly as it is. It is already formatted, and the
numbers in it are the product.

Add nothing of your own: no extra advice, no second opinion on their prompting,
no list of other habits to work on. The report deliberately surfaces one focus
habit, and adding more is the failure mode it exists to avoid.

If it reports no scored prompts yet, tell them they can run
`/jevpromptcoach:config backfill` to score their existing Claude Code history,
and that it prints a cost estimate first and sends nothing without confirmation.
