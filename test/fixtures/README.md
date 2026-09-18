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
node dist/cli.js fixtures-init --count 60 --out test/fixtures/prompts.json
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
