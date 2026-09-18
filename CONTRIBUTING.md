# Contributing

Thanks for looking at this. The rules below are short, and two of them are
absolute.

## Two things that must never happen

**No credential ever reaches a commit.** Not yours, not a test account's, not
one you believe is expired. If a key does land in a commit, it is burned —
rotate it, and say so, rather than quietly force-pushing over it.

**No prompt text ever reaches a commit.** Prompts are real work. They carry
client architecture, internal identifiers, file layouts, and now and then a
credential somebody pasted in a hurry. That includes your eval fixtures, your
local prompt log, and any excerpt you were about to paste into an issue or a
pull request description to illustrate a point. Describe the shape of the
prompt instead.

This is enforced, not just asked for. `scripts/check-leaks.mjs` runs as a
pre-commit hook, as part of `npm test`, and again in CI on every pull request.
The local hook is installed by `npm install`. `--no-verify` skips the hook; it
does not skip CI.

If the scanner stops you and the string really is an invented test value,
**assemble it from fragments at runtime** rather than exempting the file — the
redaction tests do exactly this, so no file in the repository holds a
contiguous string shaped like a key. GitHub's own push protection scans pushes
independently of ours and will block an invented key just as readily as a real
one, so this is the only approach that works with both.

There is an allow list at the top of `scripts/check-leaks.mjs` and it is empty.
Keep it that way if you can. If an entry is ever unavoidable it goes there, with
a reason, and not in a comment inside the file — a file that can exempt itself
is a file a careless paste can exempt too.

Never resolve a blocked push by clicking GitHub's "allow this secret" link.

## Getting set up

```
npm install        # also points git at the repo's hooks
npm test           # build, tests, leak scan — no API key needed
```

`npm test` needs no TypeSafe key and makes no network calls. Only the eval does.

## Running the eval

The fixtures are not in the repository and will not be added. Build your own:

```
node dist/cli.js fixtures-init
```

That samples your own Claude Code history, locally, sends nothing, and writes a
file with every label blank. Label it by hand from the criteria in
`src/checks.ts` **before** you look at any model output — labelling afterwards
is how an eval quietly stops measuring anything. Then run `npm run eval`.
Details are in [test/fixtures/README.md](test/fixtures/README.md).

Your numbers will not match the ones in the repository, because your fixture set
is not the one they were produced on. That is expected. Put your before/after in
the pull request and the maintainer will re-run the committed set locally to
confirm the change is a real improvement.

## Testing your changes in Claude Code

Load the working copy directly rather than registering it as a marketplace:

```
claude --plugin-dir /path/to/JevPromptCoach
```

Do not add your checkout with `claude plugin marketplace add ./`. That
registers the name `jevpromptcoach` against a local directory, and because
marketplace names are unique, adding the real one afterwards fails with a
message about the source differing from the one declared in settings. If you
have already done it, `claude plugin marketplace remove jevpromptcoach` clears
it.

Run `npm run build` before testing: the hook runs from `dist/`, not `src/`.

## Things worth knowing before you change them

**The hook is the critical path.** In on-demand mode it must do nothing but
append a line and exit. No API call, no import that pulls in the Jev client, no
work that can block. If you add something to `src/hook.ts`, check it still
starts in about 27 ms and that nothing reaches the network.

**The hook must never exit 2.** On `UserPromptSubmit` that blocks the prompt and
erases what the developer typed. Every failure path exits 0 with no output. This
is not negotiable and there is a test for it.

**Everything sent must be redacted first.** `src/redact.ts` is the boundary, and
the caller is responsible for applying it — the functions downstream do not
redact. This has already been got wrong once, in `always` mode, which is why
`test/hook-privacy.test.mjs` asserts it at the wire rather than at a function
boundary. Keep it that way.

**Thresholds come from the eval, not from taste.** The numbers in
`src/checks.ts` were selected by `npm run eval -- --tune` and cross-validated.
If you change a check's wording you have changed its calibration, so re-tune and
say what moved.

**Do not claim a correlation the data does not support.** The report hides its
per-check outcome columns behind a significance test precisely because the
signal did not hold up on real history. If you add a new signal, validate it
first and be willing to publish a negative result — see
[docs/OUTCOME-SIGNAL.md](docs/OUTCOME-SIGNAL.md) for the shape that takes.

**`dist/` is committed.** Claude Code installs plugin dependencies with
`--ignore-scripts`, so no build ever runs at install time — without a committed
bundle the hook points at nothing. Run `npm run build` and commit the result;
CI fails if the committed bundle does not match a fresh build of `src/`.

**Do not add a lockfile.** `npm install` will write one; it is gitignored, and
CI fails if one is ever tracked. Claude Code runs `npm ci` when a plugin has
both a `package.json` and a lockfile, which puts 43 MB of build tooling into
every user's plugin cache for nothing — the bundle already contains everything
the plugin runs. Pin new devDependencies to an exact version instead; that is
what replaces the lockfile here.

**Node 22 is the floor.** Claude Code is a native binary and brings no Node, so
whatever the user has installed runs the hook. CI tests 22 and 24. Do not reach
for a newer API without raising the floor deliberately and saying so.

## Style

Use the ASCII apostrophe, never the typographic one, everywhere — code,
comments, commit messages, and user-facing copy.

Comments should say why, not what. Match the surrounding code.
