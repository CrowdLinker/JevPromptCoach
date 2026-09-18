
The prefix is Claude Code's and cannot be removed from the hook side. Line
breaks inside the string come through as separate lines, which the three-line
notice in `src/inline.ts` relies on: the score shares the prefixed line and the
detail sits under it.
# What the UserPromptSubmit hook can and cannot do

Everything here was measured against Claude Code 2.1.277 on macOS by running a
probe hook and reading the `stream-json` output, not taken from documentation.
The behaviours it records are the reason the plugin is built the way it is, and
they are the first thing to re-check when a Claude Code release changes something.

## Plugin-declared UserPromptSubmit hooks do run

A known issue reported that a `UserPromptSubmit` hook declared in a plugin's
`hooks.json` registered and matched but never executed, while the same hook in
`~/.claude/settings.json` worked. On 2.1.277 the plugin-declared hook executes
normally. Jev (Prompt Coach) therefore ships as an ordinary plugin hook and needs no
settings.json installer.

If a future release regresses this, the symptom is silent: prompts stop being
logged and no error appears anywhere. `/jevpromptcoach:config` reports how many
prompts have been logged, which is the fastest way to notice.

## Declaring the hooks file in the manifest breaks the plugin

`hooks/hooks.json` is loaded automatically. Naming it again under `"hooks"` in
`.claude-plugin/plugin.json` is a fatal error — *"Duplicate hooks file detected"*
— and the whole plugin fails to load, commands included. The manifest's `hooks`
field is only for additional hook files. This is not in the plugin reference.

## The prompt arrives as `prompt`, not `user_input`

The hooks reference documents a `user_input` field. What 2.1.277 actually sends
on stdin is `prompt`, alongside `session_id`, `cwd`, `transcript_path`,
`prompt_id`, `permission_mode` and `hook_event_name`. The hook reads `prompt`
and falls back to `user_input` so it keeps working either way.

## How to show the developer a line without blocking them

Three channels were tested with the same probe. Only one works.

| Channel | Result |
| --- | --- |
| stderr, exit 1 | Nothing displayed |
| `hookSpecificOutput.systemMessage`, exit 0 | Nothing displayed |
| Top-level `systemMessage`, exit 0 | Displayed as `UserPromptSubmit says: …` |

The prefix is Claude Code's and cannot be removed from the hook side. Line
breaks inside the string come through as separate lines, which the three-line
notice in `src/inline.ts` relies on: the score shares the prefixed line and the
detail sits under it.

The documented behaviour for a non-zero exit is that stderr is shown to the
user. It is not, which matches the open report on the issue. `always` mode
therefore exits 0 and writes `{"systemMessage": "..."}` to stdout. That is
non-blocking, visible, and avoids the `UserPromptSubmit hook error` line a
non-zero exit produces.

**Exit 2 is never used.** On `UserPromptSubmit` it blocks the prompt and erases
what the developer typed. No score is worth that, so every failure path in
`src/hook.ts` ends at exit 0.

## `async: true` runs the hook but discards its output

An async hook is detached and does not block the prompt at all, which is
attractive for the logging path. It also means the hook's stdout is never read,
so `systemMessage` is silently dropped — `always` mode cannot use it. Since one
static `hooks.json` has to serve both modes, the hook is registered
synchronously and the mode is read at runtime from `config.json`.

The measured cost of that decision is ~27-31 ms per prompt in on-demand mode,
of which ~20 ms is Node process startup. The log append itself is well under a
millisecond. See the README for what that does and does not mean.
