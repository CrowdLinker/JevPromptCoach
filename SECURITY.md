# Security policy

Jev (Prompt Coach) reads what a developer types into a coding agent. Prompts
carry client code, internal paths and, occasionally, live credentials — one
prompt in this project's own development history contained a working Azure
client secret. That is the risk this plugin is built around, and it is the risk
a security report should be measured against.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting on this
repository: the **Security** tab, then **Report a vulnerability**. Please do not
open a public issue, and please do not include real prompt text or a real
credential in the report — describe the shape of the input that triggers the
problem instead.

We aim to respond within five working days. There is no paid bounty. If the
report is in scope we will tell you so, agree a disclosure date with you, and
credit you in the release notes unless you ask us not to.

## Supported versions

Only the most recently published version is supported. Fixes ship as a new
release rather than as a backport, because the version string in the plugin
manifest is what `claude plugin update` compares — an install that is not on the
latest version will not have the fix.

## In scope

The plugin makes two promises, and a report that breaks either is in scope:

- **Nothing leaves the machine that was not supposed to.** The log is local. The
  only network destination is TypeSafe's API, and only during a command the user
  ran. Anything that sends prompt text outside those documented paths, defeats
  the redaction boundary, or leaks text while the privacy level is set to
  metadata-only, is a vulnerability.
- **The plugin cannot cost the user their work.** The prompt hook runs on every
  message a developer sends. A failure mode that blocks a prompt, erases what
  was typed, or hangs the editor is treated as a security issue, not a bug.

Also in scope: the API key being written to a log, an error message, a crash
dump or any file other than the key file; and any way to make the plugin contact
a host other than TypeSafe's API.

## Out of scope

- **Vulnerabilities in TypeSafe's API or model.** Report those to TypeSafe. We
  will help route a report if you are unsure where it belongs.
- **The absent lockfile.** This is deliberate. A committed lockfile makes Claude
  Code install the full build toolchain into every user's plugin cache, tens of
  megabytes of it, none of which runs. Development dependencies are pinned to
  exact versions instead, which gives the same reproducibility without shipping
  the tooling. A report that the lockfile is missing will be closed.
- **Automated scanner matches on the leak detector's own text.** The script that
  blocks credentials from being committed has to describe the patterns it looks
  for, and generic scanners flag those descriptions as findings. Confirm a match
  is a real credential before reporting it.
- **Anything requiring an attacker who already has the user's filesystem.** If
  they can read the key file, they can read the key.

## What the plugin does with prompt text

The short version: the log lives on the user's own machine with owner-only
permissions, redaction runs before anything is sent, and credential-shaped
strings are stripped at every privacy level including the most permissive one.
There is no telemetry and no second network destination. The README documents
exactly what is sent and when, level by level; `src/redact.ts` is the boundary
where it happens.

Prompts are never committed to this repository — not as fixtures, not as
examples, not in a commit message. A pre-commit scan enforces both that rule and
the no-credentials rule, and the same scan runs in the test suite and in CI.
