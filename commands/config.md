---
description: Set JevPromptCoach mode and privacy, backfill history, or clear the log
argument-hint: [mode on-demand|always] [privacy redact|metadata_only|raw] [backfill] [clear]
disable-model-invocation: true
allowed-tools: Bash
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" config $ARGUMENTS`

---

Print the output above exactly as it is.

If it was a backfill **estimate** (it will say nothing has been sent), ask the
developer whether to go ahead, and run it only if they say yes:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" config backfill --confirm
```

Never run a backfill with `--confirm` without asking first — it sends prompt
text from their existing history to the TypeSafe API, and the estimate is how
they consent to that.

For everything else the command has already done the work. Do not re-run it.
