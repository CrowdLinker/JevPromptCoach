# The outcome signal did not validate

Hit rates on their own are self-referential: they tell you a prompt matched the
checks, not that the prompt worked. The plan was to anchor them to an outcome —
correction rate — and report, per check, how often a developer had to correct
themselves when the check passed versus when it failed.

It was validated against real history before the report was built around it. It
did not hold up. This is what was measured and what was concluded.

## What was measured

1,040 prompts from one developer's Claude Code history, 121 sessions, April to
September 2026. 633 consecutive same-session prompt pairs, each judged by one
Noul: *does the second message correct, clarify or redirect the first?*

Overall correction rate: **26.9%**.

| Check | hit rate | corrected when it passes | when it fails | gap | p |
| --- | --- | --- | --- | --- | --- |
| Names a specific target | 20% | 30.9% (n=123) | 25.9% (n=510) | −5.0pp | 0.26 |
| States a success condition | 54% | 28.0% (n=343) | 25.5% (n=290) | −2.5pp | 0.49 |
| Bounded scope | 78% | 28.1% (n=499) | 22.4% (n=134) | −5.7pp | 0.19 |
| States constraints | 20% | 26.1% (n=115) | 27.0% (n=518) | +0.9pp | 0.84 |
| Reproduction included | 46% | 33.3% (n=42) | 26.9% (n=52) | −6.4pp | 0.50 |
| Asks for a plan first | 31% | 31.8% (n=22) | 27.3% (n=33) | −4.5pp | 0.72 |
| Names a verification | 3% | 36.4% (n=11) | 26.7% (n=622) | −9.7pp | n/a |

A positive gap is the result the hypothesis predicted: passing the check should
mean *fewer* corrections. Six of seven gaps are negative, none is significant at
p < 0.05, and the largest sits on a sample of eleven.

## The detector is not the problem

The obvious explanation for a null result is a broken judge, so the pairs were
read back by hand, ranked by probability.

The top of the list is unambiguous. Every pair above 0.9 opens with an explicit
reversal — a flat "no", a request to revert, or a statement that the result is
still wrong — and several are the second or third attempt at the same visual or
behavioural detail.

The bottom of the list is equally clean, and is not corrections at all: a
finished piece of work followed by "commit and push", or one self-contained
infrastructure question followed by an unrelated second one.

(The pairs themselves are real work and are not reproduced here. The fixture set
they came from is deliberately not committed — see test/fixtures/README.md.)

The judge is doing its job. Correction rate is simply not measuring what it was
hoped to measure.

## The likely reason, stated as a hypothesis

Correction rate appears to track **engagement with hard work**, not prompt
quality. A vague prompt like *"git commit and push"* is trivially satisfiable and
is almost never corrected. A prompt that names files, states constraints and
defines done is usually attached to something substantial, and substantial work
invites refinement.

If that is right, task difficulty is a confound sitting upstream of both the
check outcome and the correction, and the correlation the metric was supposed to
expose is swamped by it. This is a hypothesis drawn from the data above, not a
result — it was not separately tested.

It also matters for what comes next. Phase 2 was going to be
turns-to-completion. That metric faces the same confound, and harder tasks take
more turns for reasons that have nothing to do with how they were asked for. A
usable outcome signal probably has to condition on task difficulty rather than
ignore it.

## What the plugin does about it

Nothing is claimed that was not measured.

- The per-check correction columns are **hidden** unless a check's gap clears a
  two-proportion z-test at p < 0.05 with at least 20 pairs in each arm. On this
  data nothing clears, so nothing is shown.
- The report prints the overall correction rate as a plain observation and says
  in as many words that no correlation is claimed.
- The focus habit falls back to worst hit rate, which is what it uses when no
  outcome gap is available to weight by.

The code is in `src/correction.ts` and stays in, because the gate is data-driven:
another developer's history may well clear it, and the report will then show the
columns. It is the claim that is withheld, not the measurement.
