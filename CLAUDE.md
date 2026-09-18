# JevPromptCoach — working notes

A Claude Code plugin that scores how well a developer writes prompts to a coding
agent. It runs on TypeSafe's Jev model and on nothing else.

Read `CONTRIBUTING.md` too — the rules there apply to you.

## Two absolute rules

**Never commit a credential.** Not the user's, not a test account's, not one
that looks expired. `scripts/check-leaks.mjs` runs as a pre-commit hook, in
`npm test`, and in CI. Do not pass `--no-verify`. If you are about to write a
key into any file, stop and put it in `~/.claude/jevpromptcoach/.env` instead.

**Never commit prompt text.** Not eval fixtures, not the local prompt log, not
an excerpt in a commit message, a doc, or a PR description. Prompts are the
user's real work and carry client detail. When you need to describe one, describe
its shape. `test/fixtures/prompts.json` is gitignored and stays that way.

If the user asks you to publish something containing either, say what is in it
and confirm before doing it.

## What must not regress

The plugin's whole claim is that it adds no latency and leaks nothing. Both are
easy to break with a change that looks reasonable.

- **`src/hook.ts` is on the critical path.** In on-demand mode it appends one
  line and exits. Adding an import that pulls in the Jev client would load the
  SDK on every prompt — the client is behind a dynamic import for that reason.
  Budget is about 27 ms, nearly all of it Node startup.
- **The hook never exits 2.** On `UserPromptSubmit` exit 2 blocks the prompt and
  erases what the user typed. Every failure path exits 0 silently.
- **Redaction is the caller's job.** `src/redact.ts` is the boundary; nothing
  downstream of it redacts. Anything heading for the API must already have been
  through `applyPrivacy`. This was wrong once in `always` mode, which is why the
  test asserts it on the wire.
- **`metadata_only` means no text leaves the machine.** Any new code path that
  sends text must check for it.
- **`dist/` is committed and must match `src/`.** Run `npm run build` after any
  source change; CI fails if it drifts.

## Where things live

`src/checks.ts` holds the seven questions, their thresholds and their inline
eligibility — it is the file to read to understand what the plugin measures.
`src/score.ts` batches requests and turns probabilities into verdicts.
`src/report.ts` aggregates and runs the significance test. `src/history.ts`
parses Claude Code's own transcripts. `src/hook.ts` and `src/inline.ts` are the
prompt path. `docs/HOOK-BEHAVIOUR.md` records what Claude Code's hook API
actually does, as measured, where it differs from its documentation.

## How to be right about this codebase

**Verify against the docs and the running system, not memory.** The TypeSafe API
is not OpenAI-compatible and a base-URL swap will not work. Noul answers carry no
`confidence` field, unlike Choice and Score. Claude Code's hook documentation is
wrong in at least three places that matter here; `docs/HOOK-BEHAVIOUR.md` lists
them and how they were tested.

**Thresholds are evidence, not taste.** They come from `npm run eval -- --tune`
and are cross-validated. Changing a check's wording changes its calibration —
re-tune and report what moved. Never hand-edit a threshold to make a case pass.

**Never relabel fixtures to agree with the model.** That is how an eval stops
measuring anything. If a label is genuinely wrong against the check's written
criteria, fix it, apply the same rule to every fixture, and record it.

**Report negative results.** The correction-rate outcome signal was measured and
failed; the report hides the columns rather than implying a correlation. Keep
that standard.

## Checks before you finish

Run `npm test` — it builds, runs the tests and runs the leak scan, and needs no
API key. Run `npm run typecheck`. Only run `npm run eval` if a key is present and
the user has agreed to spend on it; it costs about $0.002 and a backfill costs
about $0.06.

Anything that sends the user's history to the API needs explicit confirmation
first, with a cost estimate. The backfill command already works this way — keep
it that way.

## Style

ASCII apostrophes everywhere, never the typographic one, including in French
copy and UI strings. Comments explain why, not what.
