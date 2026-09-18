---
description: Score a draft prompt against seven coding-agent habits and rewrite it
argument-hint: [the prompt text you are about to send]
disable-model-invocation: true
allowed-tools: Bash
---

The developer wants this prompt scored. Everything between the markers is the
prompt, exactly as typed:

<prompt>
$ARGUMENTS
</prompt>

## Step 1: run the scorer

Run this with the Bash tool, putting the prompt between the two marker lines
byte for byte: no trimming, no fixing of typos or spacing, backticks and quotes
included. The heredoc is quoted, so the shell interprets nothing inside it. If
there is no prompt text, run it with nothing between the markers; the scorer
then prints how the command is used.

```
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" score-stdin <<'JPC_PROMPT_TEXT_EOF_9f3a'
<the prompt text>
JPC_PROMPT_TEXT_EOF_9f3a
```

The scorer is not run inline by this file on purpose: a backtick in the prompt
would end an inline command early and score a fragment.

## Step 2: show the result

Show the developer the output as it is printed — the score, the per-check
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

If the output says the API key is missing, or that Jev did not answer, print
that message and stop. Do not score the prompt yourself — Jev (Prompt Coach)
measures on Jev or not at all.
