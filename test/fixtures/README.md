# Eval fixtures

`prompts.json` is **not committed, and must not be.** It holds 40 real prompts
taken from a developer's own Claude Code history, and real prompts are real work:
client architecture, internal identifiers, file layouts, and occasionally a
credential someone pasted in a hurry. There is no version of that which is safe
in a public repository.

What is committed is the *result*: [../eval-results.txt](../eval-results.txt) and
[../eval-results.json](../eval-results.json). Those are aggregate metrics with no
prompt text in them.

## Building your own set

```
npm run build
node dist/cli.js fixtures-init          # 40 prompts from your history, unlabelled
node dist/cli.js fixtures-init --count=60 --out=test/fixtures/prompts.json
```

It reads `~/.claude/projects/**`, applies the same skip rules the plugin uses,
samples across short, medium and long prompts, and writes the fixture file with
every label set to `null`. Nothing is sent anywhere — this step is entirely local
and needs no API key.

Then **label it by hand, before running the eval**. Open the file and set each
label from the criteria in `src/checks.ts`, reading the criteria rather than
going on instinct. Labelling after seeing the model's probabilities is how an
eval quietly stops measuring anything.

- `true` — the habit is present
- `false` — the habit is absent
- `null` — the check does not apply

`repro_included` is `null` unless the prompt is a bug report, and `plan_first` is
`null` unless it asks for a large or destructive change. Set the two `gates` to
match; the eval asserts they agree.

Then:

```
npm run eval
```

## If you are contributing an accuracy change

Run the eval against your own labelled set locally and put the before/after
numbers in the pull request. **Do not commit your fixture file**, and do not
paste prompts into the PR description — the same reasoning applies to your work
as to anyone's.

The numbers in the repository were produced on the maintainer's private set, so a
PR's numbers will not match them exactly. That is expected. The maintainer
re-runs the committed set locally to confirm a change is a real improvement
before merging.

## Format

`fixtures-init` writes the file in the shape the eval expects, so the quickest
way to see the format is to run it and open the result. Each entry carries an
id, the prompt verbatim, a label per check, and the two applicability gates.
`src/eval.ts` reads it and `src/checks.ts` names every field.

## Conversation fixtures

A follow-up such as "yes, commit it" can only be judged against what came
before it. When `always` mode sends the agent's replies, which it does unless
`JEVPROMPTCOACH_SESSION_REPLIES=0`, each check is asked in its conversation
form instead, and those forms have their own thresholds. They are measured on a
second fixture set, built the same way and kept off the repository for the same
reasons, with one more: it also holds the agent's replies, which quote code and
client detail back.

```
node dist/cli.js fixtures-init --conversations
```

That writes `conversations.json`: 40 follow-ups from your history, each with the
exchanges before it (your prompt and the agent's closing reply, at most two
exchanges), every label `null`. Only follow-ups whose previous turn ended with
the agent saying something are picked, since that reply is what the set exists
to measure. Everything is redacted at your privacy level, so the eval later
sends exactly what `always` mode would.

**Label the last message only, read together with its context**, from the
`conversation` criteria in `src/checks.ts`, not the standalone ones:

- A habit is present if the follow-up supplies it, or if the shown context
  already established it and the follow-up relies on it: accepting the agent's
  proposal, answering its question, or pointing unambiguously at something
  named earlier ("the email one").
- Only what is shown counts. If you remember the session and know more than the
  context holds, label from the context; Jev only ever sees that much.
- The gates describe the follow-up's request in its context, and the two
  conditional checks follow them exactly as in the standalone set.

Then:

```
npm run eval -- --conversations
npm run eval -- --conversations --tune
```

The eval refuses a file with unlabelled entries, so the order cannot be got
wrong by accident. Results go to `test/eval-conversations-results.txt` and
`.json`, beside the standalone ones, and like them hold no prompt text. A
conversation check reaches the inline line only by the same rule as a
standalone one: cross-validated fail-precision of at least 0.90 over at least
ten failing examples.

Forty is enough to measure the common failures and thin for the rare ones. A
check needs at least five failing examples to be measured at all and ten to be
allowed inline; if one falls short, `--count=60` gives it more to work with.
