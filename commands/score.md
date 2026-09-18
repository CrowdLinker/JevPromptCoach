---
description: Score a draft prompt against seven coding-agent habits and rewrite it
argument-hint: [the prompt text you are about to send]
disable-model-invocation: true
allowed-tools: Bash
---

## Scoring result

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" score-stdin <<'JPC_PROMPT_TEXT_EOF_9f3a'
$ARGUMENTS
JPC_PROMPT_TEXT_EOF_9f3a`

---

Show the developer the result above as it is printed — the score, the per-check
pass/fail, and for every failure its cause, consequence and fix. Do not re-order
or re-word it.

Then, if any check failed, finish with one more section:

## Rewritten

Rewrite **their exact prompt** so it would pass the checks that failed. Keep
their intent, their files, their wording and their voice. Fill the gaps from
what the repository actually contains — real file names, the real test command
from `package.json` or the project's own docs — rather than placeholders. If
something genuinely cannot be known from the prompt or the repo, mark it with
`<...>` so it is obvious what the developer still has to supply.

Never print a generic template, and never rewrite a prompt that passed
everything. If no check failed, say so in one line and stop.

If the output above says the API key is missing, or that Jev did not answer,
print that message and stop. Do not score the prompt yourself — JevPromptCoach
measures on Jev or not at all.
