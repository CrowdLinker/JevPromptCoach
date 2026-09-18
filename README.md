# JevPromptCoach

Scores how well you write prompts to a coding agent, and shows whether your
habits are improving. Runs on [TypeSafe](https://typesafe.ai)'s Jev model.

It adds nothing to the time between pressing Enter and getting a response.

> **Unofficial community plugin.** Not affiliated with, endorsed by, or
> supported by TypeSafe or Anthropic. You bring your own TypeSafe API key.

---

## Why this exists

Most prompt-quality tools put a language model between you and your agent. They
score the prompt before it is sent, which means a round trip on every message and
timeouts measured in minutes.

JevPromptCoach does not sit there. In its default mode the hook appends one line
to a local file and exits. Scoring happens when you ask for it, in a command.

The second thing it does differently: it will score the prompts you have
**already written**. A backfill over a year of local Claude Code history costs
about six cents, because Jev charges $0.042 per million input tokens and nothing
for output. You get a report on day one instead of in two weeks.

## Requirements

- **Node 22 or newer** — `node --version`
- **Claude Code 2.1.x or newer.** Plugin-declared `UserPromptSubmit` hooks did
  not execute on some earlier versions, and the plugin depends on them.
- **A TypeSafe API key**, from [console.typesafe.ai](https://console.typesafe.ai/settings/keys).

The plugin bundles its own dependencies into `dist/`. There is no install step,
no `node_modules`, nothing fetched at runtime, and the only host it ever
contacts is `api.typesafe.ai`. Installed, it is 376 KB.

Claude Code itself ships as a native binary and brings no Node of its own, so
the Node on your `PATH` is what runs the hook. Node 22 is the floor, and CI
tests 22 and 24.

## Install

**1. Add the marketplace and install the plugin.**

```
claude plugin marketplace add CrowdLinker/JevPromptCoach
claude plugin install jevpromptcoach@jevpromptcoach
```

Confirm it loaded — status should be `enabled`:

```
claude plugin list
```

**2. Give it your API key.**

Create the key file first, lock it down, and only then put the key in it — so
the key never exists in a world-readable file, and never appears on a command
line where your shell would record it in history:

```
mkdir -p ~/.claude/jevpromptcoach
touch ~/.claude/jevpromptcoach/.env
chmod 600 ~/.claude/jevpromptcoach/.env
```

Then open `~/.claude/jevpromptcoach/.env` in your editor and add one line:

```
TYPESAFE_API_KEY=your-key-here
```

The key file is where the plugin looks. A hook does not run under your shell
profile, so a key exported only in `.zshrc` may never reach it, and `always`
mode needs it here. The plugin never writes this file, never logs the key, and
never lets it into an error message.

If you would rather not use an editor, this reads the key without echoing it and
without putting it in your history:

```
mkdir -p ~/.claude/jevpromptcoach && touch ~/.claude/jevpromptcoach/.env && chmod 600 ~/.claude/jevpromptcoach/.env
read -rs KEY && printf 'TYPESAFE_API_KEY=%s\n' "$KEY" > ~/.claude/jevpromptcoach/.env && unset KEY
```

Paste the key at the blank prompt and press Enter. That works in both bash and
zsh. `TYPESAFE_API_KEY` in the environment still takes precedence if you have a
reason to set it — that is how CI and the eval supply it — but the file is the
one to use day to day.

**3. Check it is working.**

```
/jevpromptcoach:config
```

That prints your mode, privacy level, whether the key was found, and how many
prompts have been logged so far. Submit a prompt or two and run it again — if
the logged count is not rising, the hook is not firing, and
[docs/HOOK-BEHAVIOUR.md](docs/HOOK-BEHAVIOUR.md) covers why that happens.

## Setup

**Pick a mode.** The default is `on-demand`, which never adds latency. Switch
only if you want a score on every message:

```
/jevpromptcoach:config mode always
```

**Pick a privacy level.** The default is `redact`. If prompts in your work
should never leave the machine at all:

```
/jevpromptcoach:config privacy metadata_only
```

**Backfill your history.** This is the part worth doing on day one — it scores
the prompts you have already written, so the first report covers months instead
of nothing:

```
/jevpromptcoach:config backfill
```

It prints how many prompts it found and what they will cost, and sends nothing
until you confirm. Over 1,039 prompts it cost $0.06.

Then:

```
/jevpromptcoach:report
```

**If the marketplace refuses to add.** A message about the source differing
from *"the one declared for it in settings"* means the name `jevpromptcoach` is
already registered against a different source — most often a local directory,
from developing the plugin. Marketplace names are unique, so the GitHub source
cannot be added under a name that is taken. Remove the old registration and
retry:

```
claude plugin marketplace remove jevpromptcoach
claude plugin marketplace add CrowdLinker/JevPromptCoach
```

Removing a marketplace uninstalls the plugins that came from it. Your log,
scores and config live in `~/.claude/jevpromptcoach/` and are untouched.

**Uninstalling.** `claude plugin uninstall jevpromptcoach@jevpromptcoach`
removes the plugin but leaves your data. To delete that too, remove
`~/.claude/jevpromptcoach/` — it holds the log, the score cache, your config and
the key file, and nothing else.

## Commands

Plugin commands are namespaced, and the prefix is not reliably optional — an
agent launched via Task or `@mention` cannot resolve the short form. Always write
the full name.

### `/jevpromptcoach:score <text>`

Scores a draft **before** you send it. This is the teaching surface: it prints
the score, every check as pass/fail/not-applicable, and for each failure the
cause, the consequence, and the fix — then rewrites *your* text so it would pass.

```
/jevpromptcoach:score fix the bug in the code, it doesnt work, refactor everything while youre in there
```

```
# Prompt score: 0/100

FAIL  Says which file or function  (0.03)
FAIL  Says what "done" looks like  (0.26)
FAIL  Asks for one thing  (0.06)
...

### Says which file or function
- What is missing: You wrote "it" or "the code" instead of a name.
- What goes wrong: The agent has to guess which file you meant. It searches,
  or it edits the wrong one.
- Do this instead: Name the file, function, or symbol you want changed.
```

With no argument it explains itself and shows an example. It does not error.

### `/jevpromptcoach:report [N]`

Patterns across the last N logged prompts, default 200. Hit rate per check, a
30-day trend, and **one** habit to work on. Not seven.

See [docs/EXAMPLE-REPORT.md](docs/EXAMPLE-REPORT.md) for a real one, generated
over 1,040 prompts of actual history.

### `/jevpromptcoach:config`

Mode, privacy level, backfill, and clearing the log.

```
/jevpromptcoach:config                      show current settings
/jevpromptcoach:config mode always          score inline as you type
/jevpromptcoach:config privacy metadata_only
/jevpromptcoach:config backfill             estimate, then confirm
/jevpromptcoach:config clear                delete the local log
```

## The seven checks

Coding-agent habits, not generic prompt engineering. All seven ride in **one**
Jev request per prompt — Jev reads the prompt once and answers every question
against it in parallel, so the full set costs about what one question costs.

| Check | What it looks for |
| --- | --- |
| Says which file or function | A real name, not "the code" or "it" |
| Says what "done" looks like | What should be true when the work is finished |
| Asks for one thing | One concrete change, not "refactor everything" |
| Says what not to touch | What must stay as it is |
| Includes the real error | The actual error text, or what you expected versus what happened |
| Asks for a plan first | Asked to see the approach before a big or risky change |
| Says how to check it worked | The test or command that would prove it |

Their ids in the code and in `test/eval-results.json` are `named_target`,
`success_condition`, `bounded_scope`, `constraints`, `repro_included`,
`plan_first` and `verification`.

Two are conditional. `repro_included` is only scored on bug reports and
`plan_first` only on large or destructive requests; both applicability questions
ride in the same request and are read by code. Everything else is marked `n/a`
rather than counted as a failure.

Not scored at all: slash commands, one-word replies, anything under 15
characters, and Claude Code's own injected messages.

## Two modes

Chosen once, stored in `~/.claude/jevpromptcoach/config.json`.

### `on-demand` (default) — zero added latency

The hook appends one line to a local JSONL log and exits 0. No API call, no
network, no import of the Jev client. Scoring happens later, when you run a
command.

Measured cost: **27–31 ms** per prompt, of which ~20 ms is Node process startup.
The log append itself is well under a millisecond. This is off the network path
entirely — it is not waiting on anything, and it cannot delay a response.

### `always` — one line, non-blocking

The hook also scores the prompt and prints one line while the prompt proceeds:

```
JevPromptCoach: 29/100 · this prompt does not say which file or function, and
how to check it worked. Run /jevpromptcoach:score to see how to fix it.
```

Guarantees:

- **Never exit 2.** On `UserPromptSubmit`, exit 2 blocks the prompt and *erases
  what you typed*. Every failure path in the hook exits 0.
- **A hard timeout** (default 4 s, `config timeout <ms>`). Jev does not answer in
  time, nothing prints. A missed score is fine; a stalled prompt is not.
- **`*` bypasses.** A prompt starting with `*` is never logged or scored.
- **Only findings we can stand behind.** Two checks are barred from the inline
  line entirely on the eval evidence below, and anything near a threshold is
  dropped rather than shown.

`always` does not use the mechanism the docs suggest. Writing to stderr with a
non-zero exit displays nothing on Claude Code 2.1.277; a top-level
`systemMessage` on exit 0 does. The measurements are in
[docs/HOOK-BEHAVIOUR.md](docs/HOOK-BEHAVIOUR.md), along with three other
undocumented behaviours worth knowing if you write hooks.

## Privacy

Prompts contain code, paths, and sometimes secrets. One of the prompts in this
developer's own history contained a live Azure client secret, which is why
redaction is a module with tests rather than a regex in passing.

**The log is local.** `~/.claude/jevpromptcoach/`, mode `0600`. Nothing leaves
your machine except during a command you ran.

| Level | What is stored and sent |
| --- | --- |
| `redact` (default) | Prompt text with credentials, emails and identifying path segments removed. Filenames survive, because `named_target` is about whether you named one. |
| `metadata_only` | Derived features only — length, word count, has-a-code-fence, has-a-file-path. Never the text. Scoring needs text, so this turns scoring off. |
| `raw` | Prompt text as written. Credential-shaped strings are **still** stripped. |

Stripped at every level, including `raw`: `sk-`, `sk-ant-`, `sk-proj-`, `ghp_`
and friends, `AKIA`/`ASIA`, `AIza`, Slack `xox*`, JWTs, PEM blocks, Azure client
secrets, `Bearer` tokens, and anything assigned to a name ending in
`KEY`/`TOKEN`/`SECRET`/`PASSWORD`.

**Exactly what is sent, and when:**

| When | What goes to `api.typesafe.ai` |
| --- | --- |
| `/jevpromptcoach:score` | The one prompt you passed, redacted |
| `/jevpromptcoach:report` | Any logged prompts not yet scored, redacted, batched |
| `config backfill` | Your history, redacted, batched — **after** a cost estimate and an explicit confirmation |
| `always` mode | Each prompt as you submit it, redacted |
| Ever, otherwise | Nothing |

No telemetry. No other network destination. The API key is read from the
environment or the key file, and never logged, printed, or included in an error
message — error text is scrubbed of it on the way out.

A prompt is scored once. Results are cached by content hash, so unchanged text is
never re-sent.

## Backfill

```
/jevpromptcoach:config backfill
```

Reads `~/.claude/projects/**`, finds your human-typed prompts, prints an
estimate, and sends nothing until you confirm.

Real numbers from this repository's own development:

```
Transcripts scanned:      1623 human-typed prompts found
Worth scoring:            1039
Correction-rate pairs:    607
Total:       ~$0.0531
```

Actual cost after running it: **$0.0618** for 1,039 prompts and 607 pairs.

Claude Code writes one JSONL file per session and marks genuinely typed prompts
with `promptSource: "typed"`. Tool results, subagent traffic, compaction
summaries and slash-command wrappers all arrive as `type: "user"` too, and are
all excluded. Older records predate that field and are admitted on shape.
`src/history.ts` is the parser.

## The outcome signal, and why the report does not use it

Hit rates are self-referential — they say a prompt matched the checks, not that
it worked. The plan was to anchor them to correction rate: for each consecutive
pair of prompts in a session, did the second one correct the first?

**It was validated against 633 real pairs before the report was built around it,
and it failed.** Six of seven checks show a *negative* gap — prompts that pass a
check are followed by a correction slightly more often, not less — and no gap is
significant. The judge itself works; the pairs were read back and it identifies
corrections cleanly. Correction rate just does not measure what it was meant to.

The full numbers, the verification that the detector is sound, and what it
probably means are in [docs/OUTCOME-SIGNAL.md](docs/OUTCOME-SIGNAL.md).

So the report ships **hit rates and trends only**. Per-check correction columns
are hidden behind a significance test that this data does not clear, and the
report says so rather than implying a correlation. The code stays in, because the
gate is data-driven and your history may clear it.

Phase 2, turns-to-completion, is deliberately not built. It faces the same
confound.

## Eval

40 real prompts from actual history, hand-labelled per check before any model
output existed. `npm run eval`.

The headline metric is **fail-precision**: of the prompts where the plugin says a
habit is missing, how many really were. That is the number that matters, because
a missing-habit finding is the only thing `always` mode ever shows you, and a
false one interrupts a message for nothing. Precision beats recall here every
time.

Thresholds were tuned on these fixtures, so the figures at those thresholds are
optimistic. The number worth quoting is five-fold cross-validated, re-selecting
thresholds inside each fold and scoring only held-out prompts:

| Check | CV fail-precision | CV fail-recall | n | Inline? |
| --- | --- | --- | --- | --- |
| Says which file or function | 0.96 | 0.93 | 28 | yes |
| Says what "done" looks like | 1.00 | 0.86 | 14 | yes |
| Asks for one thing | 1.00 | 0.60 | 10 | yes |
| Says what not to touch | 0.97 | 0.97 | 30 | yes |
| Includes the real error | 1.00 | 0.80 | 5 | **no** — 5 cases is too thin |
| Asks for a plan first | 0.86 | 0.75 | 8 | **no** — below the 0.90 bar |
| Says how to check it worked | 1.00 | 0.97 | 39 | yes |

Applicability gates: `is_bug_report` 0.93, `is_large_change` 0.85.

The two checks that do not clear the bar still appear in `/jevpromptcoach:score`
and `/jevpromptcoach:report`, where you asked. They are barred from the inline
line, where you did not.

**The fixtures are not committed, by design.** They are real prompts from real
work — client architecture, internal identifiers, file layouts, and now and then
a credential someone pasted in a hurry. There is no safe way to publish that, so
what ships is the result: [test/eval-results.txt](test/eval-results.txt) and
[test/eval-results.json](test/eval-results.json), which are aggregate metrics
with no prompt text in them.

You can build and label your own set in a few minutes — `node dist/cli.js
fixtures-init` samples your own history locally, sends nothing, and needs no API
key. See [test/fixtures/README.md](test/fixtures/README.md), which also covers
what a pull request touching accuracy should include.

Two honest notes on the fixture set:

- It is **stratified, not random**. A purely random sample of this history had
  one prompt naming a verification and no measurable positive class for several
  checks, so a handful of real prompts carrying the sparse signals were swapped
  in for near-duplicate short ones. Every prompt is real and unedited.
- Nine labels were **corrected once** after the first run, where the original
  label contradicted the check's own written criteria — seven
  `success_condition` labels on prompts that state an action and nothing about
  what finished looks like, one `bounded_scope`, one `plan_first`. The rule was
  applied mechanically from the criteria text, not per item to agree with the
  model. It is recorded here because re-labelling after seeing model output is
  exactly how an eval quietly becomes circular.

Thresholds sit below 0.5 for several checks. Jev's probabilities on these
questions run low in absolute terms while ranking prompts well; what matters is
the separation, not where it falls.

## How it works

```
UserPromptSubmit ──► hook.ts ──► redact ──► append JSONL ──► exit 0
                                                              (on-demand: stops here)
/jevpromptcoach:score  ─┐
/jevpromptcoach:report ─┼──► one batched request ──► api.typesafe.ai/v1/systemone
config backfill        ─┘                            model: jev-latest
```

Every question is a Noul — a yes/no question returning a calibrated probability.
The seven checks and two gates are nine Nouls in one request. A backfill packs up
to 60 prompts into a single request, sized against the 64k total and 32k
state-only budgets.

Noul answers carry no `confidence` field, unlike Choice and Score. Certainty is
read from the probability's distance from the threshold, which is what the
inline margin gates on.

The scoring model is `jev-latest` (currently `jev-1.13.0`) and there is no
fallback to any other provider. If Jev does not answer, nothing is scored and the
command says so.

The one thing Jev does not do is write. `/jevpromptcoach:score` produces the
rewrite through your own agent, from Jev's verdicts and your repository — Jev
answers typed questions and cannot generate text. All *measurement* is Jev's.

Source layout: `src/checks.ts` defines the questions, thresholds and inline
eligibility. `src/score.ts` batches and interprets. `src/hook.ts` is the critical
path. `src/redact.ts` is the privacy boundary. `src/report.ts` aggregates and
runs the significance test. `src/history.ts` parses Claude Code transcripts.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the detail. Two rules are absolute: **no
credential and no prompt text ever reaches a commit** — yours or anyone's.

That is enforced rather than asked for. `scripts/check-leaks.mjs` runs as a
pre-commit hook (installed by `npm install`), as part of `npm test`, and again
in CI on every pull request. `--no-verify` skips the hook, not CI.

```
npm install          # also points git at the repo's hooks
npm test             # build, tests, leak scan — no API key, no network
npm run typecheck
node dist/cli.js fixtures-init   # build your own eval set, locally, from your history
npm run eval                     # calls Jev; ~$0.002 for 40 prompts
npm run eval -- --cached         # recompute metrics from the last run, no API calls
```

The eval needs a labelled `test/fixtures/prompts.json`, which is gitignored.
Without one, `npm test` and the build still work — only `npm run eval` needs it.

The tests cover the two things that must not regress: that redaction removes
every credential shape it claims to, and that the hook sends redacted text and
exits 0 on every path. The hook test asserts on the actual request body, against
a local capture server, because the bug it exists to catch was a caller passing
the raw prompt to a function that does no redaction of its own.

### Why `dist/` is committed, and why there is no lockfile

Both come from the same measurement.

Claude Code installs a plugin's dependencies with `--ignore-scripts`, so **no
build ever runs at install time**. Without a committed `dist/`, the hook would
point at a file that does not exist. The bundle is self-contained — the hook
runs with no `node_modules` at all, which is also what keeps it at 27 ms.

Given that, a lockfile is pure cost. Claude Code runs `npm ci` when a plugin has
both a `package.json` and a lockfile, and it installs devDependencies: 43 MB of
esbuild and TypeScript in every user's plugin cache, on a 60-second timeout, of
which nothing is used. Dropping the lockfile skips that step entirely.

| | plugin cache |
| --- | --- |
| with a lockfile | 44 MB |
| without | **376 KB** |

Reproducibility is kept by pinning every devDependency to an exact version and
by CI failing if a fresh build of `src/` differs from the committed `dist/`. CI
also fails if a lockfile reappears, because re-adding one is an easy and
invisible way to put the 43 MB back.

The remaining cost of committing a bundle is diff noise, and `.gitattributes`
marks `dist/` as generated so GitHub collapses it in pull requests. Running the
TypeScript directly instead — Node can strip types natively now — was measured
and rejected: 51 ms against 25 ms for the compiled bundle, on a hook whose whole
claim is that it stays out of the way.

## Licence

MIT. See [LICENSE](LICENSE).
