/**
 * The seven habits, as Noul questions.
 *
 * These are coding-agent habits, not generic prompt engineering: each one is a
 * thing a developer either did or did not put in the message, observable from
 * the text alone. Every question is phrased so that a high `noul` means the
 * developer did the good thing.
 *
 * Two of the checks only apply to some prompts — you cannot fault a refactor
 * request for carrying no error text. `appliesWhen` names an applicability
 * question that is asked in the same call (speculative fan-out: the extra
 * questions are free) and read by code in src/score.ts.
 */

export type CheckId =
  | 'named_target'
  | 'success_condition'
  | 'bounded_scope'
  | 'constraints'
  | 'repro_included'
  | 'plan_first'
  | 'verification';

export interface CheckDef {
  id: CheckId;
  /**
   * What the habit is, in the words a developer would use to a colleague.
   * These are read by people who have not read this file, so they say what to
   * do rather than naming the concept: "Says which file or function", not
   * "Names a specific target".
   */
  label: string;
  /** The same habit phrased as what is missing, for the `always` one-liner. */
  shortfall: string;
  instructions: string;
  criteria: { true: string; false: string };
  /** Applicability gate; the check is scored `n/a` when the gate is not met. */
  appliesWhen?: { gate: GateId; minProbability: number };
  /**
   * Above this the check passes. Selected by `npm run eval -- --tune` against
   * test/fixtures, maximising fail-recall subject to fail-precision >= 0.95.
   * Jev's probabilities for these questions sit low in absolute terms while
   * ranking the prompts well, which is why several thresholds are below 0.5;
   * the number that matters is the separation, not where it falls.
   */
  threshold: number;
  /**
   * Distance from `threshold` a probability must clear before the finding is
   * allowed into the one-line `always` output. Inside this band the check is
   * reported as undecided and stays out of the inline line entirely.
   */
  inlineMargin: number;
  /**
   * Whether this check may appear in the `always` one-liner at all.
   *
   * Set from the cross-validated fail-precision in test/eval-results.txt: a
   * check qualifies only at >= 0.90 with at least 10 failing examples behind
   * it. In `always` mode a false positive interrupts a message the developer
   * did not ask us about, so a check we cannot stand behind is shown in
   * /jevpromptcoach:score and /jevpromptcoach:report — where the developer
   * asked — and nowhere else.
   */
  inlineEligible: boolean;
  /**
   * The same habit judged on a follow-up, read together with the conversation
   * before it, the agent's replies included. Used only when replies are sent
   * (JEVPROMPTCOACH_SESSION_REPLIES). Something counts as present if the
   * follow-up supplies it, or if the shown conversation already established it
   * and the follow-up relies on it, for instance by accepting what the agent
   * proposed. The threshold and inline eligibility come from the conversation
   * eval (`npm run eval -- --conversations`), separately from the standalone ones.
   */
  conversation: {
    instructions: string;
    criteria: { true: string; false: string };
    threshold: number;
    inlineEligible: boolean;
  };
  /** Why it matters, shown by /jevpromptcoach:score when the check fails. */
  cause: string;
  consequence: string;
  fix: string;
}

export type GateId = 'is_bug_report' | 'is_large_change';

export interface GateDef {
  id: GateId;
  instructions: string;
  criteria: { true: string; false: string };
}

export const GATES: GateDef[] = [
  {
    id: 'is_bug_report',
    instructions:
      'The message reports something that is broken, failing, or behaving wrongly, and asks for it to be diagnosed or fixed.',
    criteria: {
      true: 'Reports a defect, crash, failure, wrong output, or regression in existing behaviour.',
      false: 'Asks for new work, a refactor, an explanation, a review, or a question. Nothing is claimed to be broken.',
    },
  },
  {
    id: 'is_large_change',
    instructions:
      'The message asks for work that is large, architectural, or destructive, rather than a small contained edit.',
    criteria: {
      true: 'Asks to rewrite, migrate, restructure, redesign, delete, drop, or reset something; or spans many files, modules, or a whole system.',
      false: 'Asks for one contained edit, a question, a review, or a small addition that is easy to undo.',
    },
  },
];

export const CHECKS: CheckDef[] = [
  {
    id: 'named_target',
    label: 'Mentions which file or function',
    shortfall: 'which file or function',
    instructions:
      'The message identifies where to work by naming at least one concrete file, path, function, class, component, endpoint, or symbol.',
    criteria: {
      true: 'Names something the reader could go and open or search for: a filename, a path, a function or method name, a class, a component, a route, a table, or a specific identifier from the codebase.',
      false:
        'Refers to the work only in general terms such as "the code", "it", "this", "the function", "the bug", "the app", or describes it purely by behaviour with no name attached.',
    },
    threshold: 0.65,
    inlineMargin: 0.2,
    // CV fail-precision 0.96 over 28 failing examples.
    inlineEligible: true,
    conversation: {
      instructions:
        'The agent knows exactly where to work: the message names a concrete file, path, function, class, component, endpoint, or symbol, or points unambiguously at one already named in the conversation.',
      criteria: {
        true: 'Names a concrete target, or refers without ambiguity to one named earlier by either side: "the email one" after the agent listed email-worker.ts among other files, or "yes, go ahead" accepting a change the agent described in a named file.',
        false:
          'The target is unclear even with the conversation: nothing concrete was named earlier, or several candidates were named and the message does not say which, or the message starts new work described only in general terms.',
      },
      threshold: 0.15,
      // CV fail-precision 0.60 over 11 failing examples: ranks better than standalone (AUC 0.82 vs 0.63) but too thin to stand behind inline.
      inlineEligible: false,
    },
    cause: 'You wrote "it" or "the code" instead of a name.',
    consequence: 'The agent has to guess which file you meant. It searches, or it edits the wrong one.',
    fix: 'Name the file, function, or symbol you want changed.',
  },
  {
    id: 'success_condition',
    label: 'States what "done" looks like',
    shortfall: 'what "done" looks like',
    instructions: 'The message states what should be true, or what should happen, once the work is finished.',
    criteria: {
      true: 'Describes the intended end state or desired behaviour: what should happen instead, what the output should be, what should pass, or what the user should see.',
      false:
        'Describes only the action to take, or only the current problem, without saying what "finished" looks like.',
    },
    threshold: 0.35,
    inlineMargin: 0.2,
    // CV fail-precision 1.00 over 14 failing examples.
    inlineEligible: true,
    conversation: {
      instructions:
        'What should be true once the request in the message is done is known: the message states the outcome or the output it wants, or it approves a proposal from the agent that describes the resulting behaviour.',
      criteria: {
        true: 'States the intended end state or the output wanted ("so the page shows X", "give me five titles"), or approves a specific proposal in which the agent described what the result will be.',
        false:
          'Only names a step to carry out (commit, push, deploy, merge, review, run something) without an outcome, even when the conversation describes the work around it; or starts new work without an end state.',
      },
      threshold: 0.2,
      // CV fail-precision 0.75 over 18 failing examples, below the 0.90 bar.
      inlineEligible: false,
    },
    cause: 'Nothing in the request says what should be true at the end.',
    consequence: 'The agent picks its own finish line, and stops somewhere you did not want.',
    fix: 'Add one sentence: what should be true when this works.',
  },
  {
    id: 'bounded_scope',
    label: 'Keeps to one requirement',
    shortfall: 'a single focused requirement',
    instructions:
      'The message asks for one contained, well-defined piece of work rather than an open-ended or sweeping change.',
    criteria: {
      true: 'Asks for a single change, or a small set of clearly enumerated changes, with a recognisable boundary.',
      false:
        'Asks for something open-ended or sweeping — "clean this up", "refactor everything", "make it better", "fix all the issues" — or bundles several unrelated requests into one message.',
    },
    threshold: 0.45,
    inlineMargin: 0.2,
    // CV fail-precision 1.00 over 10 failing examples.
    inlineEligible: true,
    conversation: {
      instructions:
        'The request, read with the conversation, is one contained, well-defined piece of work rather than an open-ended or sweeping change.',
      criteria: {
        true: 'Asks for one change or a small set of clearly enumerated changes, including accepting one specific proposal the agent described.',
        false:
          'Asks for something open-ended or sweeping, bundles several unrelated requests, or accepts a broad proposal ("do all of it") whose edges the conversation never set.',
      },
      threshold: 0.45,
      // Not measurable: 2 failing examples in the conversation set.
      inlineEligible: false,
    },
    cause: 'The request has no edges, so the agent decides how far to go.',
    consequence:
      'You get a huge change touching files you never meant to touch, and reviewing it takes longer than the fix would have.',
    fix: 'Cut it to the one change you want first. Ask for the rest after.',
  },
  {
    id: 'constraints',
    label: 'States what must not change',
    shortfall: 'what must not change',
    instructions:
      'The message states a limit on the work: something that must not be touched, must keep working, or must not change.',
    criteria: {
      true: 'Names something to leave alone or preserve — a file, module, interface, behaviour, or API that must stay stable — or forbids an approach ("without adding a dependency", "do not change the schema").',
      false: 'States no limit. Nothing is marked off as out of bounds or required to stay the same.',
    },
    threshold: 0.3,
    inlineMargin: 0.2,
    // CV fail-precision 1.00 over 30 failing examples (0.97 before the eval redacted).
    inlineEligible: true,
    conversation: {
      instructions:
        'A limit on the work is in force: the message states one, or one stated earlier in the conversation still applies to what the message asks for.',
      criteria: {
        true: 'Names something to leave alone or preserve, or forbids an approach, in the message or earlier in the conversation for this same work, and nothing has withdrawn it.',
        false: 'No limit that applies to the requested work appears in the message or anywhere in the conversation.',
      },
      threshold: 0.8,
      // CV fail-precision 0.97 over 34 failing examples. 34 of 40 fixtures fail it, so precision is flattered by the base rate; AUC 0.99.
      inlineEligible: true,
    },
    cause: 'Nothing in the request is marked off-limits.',
    consequence: 'Something that was working gets rewritten along the way.',
    fix: 'Say what must stay as it is — the API, the database schema, the other callers.',
  },
  {
    id: 'repro_included',
    label: 'Gives the actual error',
    shortfall: 'the actual error',
    instructions:
      'The message includes the actual evidence of the failure: real error output, a log line, a stack trace, or a specific statement of what happened versus what was expected.',
    criteria: {
      true: 'Quotes real output — an error message, exception, stack trace, failing assertion, or log — or states both the observed behaviour and the expected behaviour specifically.',
      false:
        'Describes the failure only in general terms such as "it is broken", "it does not work", "there is an error", without the actual text or a concrete expected-versus-actual pair.',
    },
    appliesWhen: { gate: 'is_bug_report', minProbability: 0.5 },
    threshold: 0.4,
    inlineMargin: 0.2,
    // only 5 failing examples in the fixture set — too thin to stand behind inline.
    inlineEligible: false,
    conversation: {
      instructions:
        'For the failure being reported, the actual evidence is available: in the message, or earlier in the conversation, quoted by the developer or reported by the agent from running something.',
      criteria: {
        true: 'Real output (an error message, stack trace, failing assertion, or log) or a specific expected-versus-actual pair appears in the message or the conversation for this failure.',
        false:
          'The failure is described only in general terms, and no actual output or concrete expected-versus-actual pair for it appears anywhere in the conversation.',
      },
      threshold: 0.4,
      // Not measurable: 1 failing example in the conversation set.
      inlineEligible: false,
    },
    cause: 'The bug is described, but the actual error text is not in the message.',
    consequence: 'The agent guesses the error from your description and fixes a different problem.',
    fix: 'Paste the real error, and say what you expected to happen instead.',
  },
  {
    id: 'plan_first',
    label: 'Asks for a plan first',
    shortfall: 'a plan before any changes',
    instructions:
      'The message asks to see a plan, an approach, or options before any code is written or anything is changed.',
    criteria: {
      true: 'Explicitly asks to plan, propose, outline, investigate, or explain the approach first, or to check in before making the change.',
      false: 'Asks for the work to be carried out directly, with no step before it.',
    },
    appliesWhen: { gate: 'is_large_change', minProbability: 0.5 },
    threshold: 0.35,
    inlineMargin: 0.2,
    // 8 failing examples, under the 10 the inline bar asks for (CV fail-precision
    // 1.00 on the redacted run, 0.86 before it).
    inlineEligible: false,
    conversation: {
      instructions:
        'Before a large or risky change is carried out, a plan has been asked for or seen: the message asks for one, or it approves a plan the agent laid out in the conversation.',
      criteria: {
        true: 'Asks to plan, propose, outline, or investigate first, or approves a specific plan the agent already described for this change.',
        false: 'Asks for the large change to be carried out directly, and no plan for it appears in the conversation.',
      },
      threshold: 0.35,
      // Not measurable: 4 failing examples in the conversation set.
      inlineEligible: false,
    },
    cause: 'You asked for a big or risky change without asking to see the approach first.',
    consequence: 'You find out how it was going to be done only after it has been done.',
    fix: 'Ask for the plan first, then approve it. "Plan this before changing anything."',
  },
  {
    id: 'verification',
    label: 'States the verification steps',
    shortfall: 'the verification steps',
    instructions: 'The message names the specific test, command, or check that would prove the work is correct.',
    criteria: {
      true: 'Names something runnable or checkable: a test file or test name, a command to run, a script, a URL or page to load, or an explicit instruction to verify in a stated way.',
      false:
        'Names no test or command. Asks only for the change, or says "make sure it works" without saying how that would be established.',
    },
    threshold: 0.6,
    inlineMargin: 0.2,
    // CV fail-precision 1.00 over 39 failing examples.
    inlineEligible: true,
    conversation: {
      instructions:
        'How the work will be checked is known: the message names a test, command, or check, or accepts a proposal from the agent that names one, or continues work whose verification was stated earlier.',
      criteria: {
        true: 'A runnable or checkable step for this work (a test file or name, a command, a script, a page to load) appears in the message, or in an earlier message or agent proposal the message accepts or continues.',
        false:
          'No test, command, or check for this work appears in the message or the conversation, or the message says only "make sure it works".',
      },
      threshold: 0.75,
      // CV fail-precision 0.97 over 38 failing examples. 38 of 40 fixtures fail it, so precision is flattered by the base rate; AUC 0.89.
      inlineEligible: true,
    },
    cause: 'Nothing in the request says how to tell whether it worked.',
    consequence: 'The agent says it worked, and you find out later that it did not.',
    fix: 'Name the command. "Verify with npm test -- auth.spec.ts."',
  },
];

export const CHECK_IDS: CheckId[] = CHECKS.map((c) => c.id);
export const CHECK_BY_ID = new Map<CheckId, CheckDef>(CHECKS.map((c) => [c.id, c]));

/** The correction-rate outcome signal. One Noul over a consecutive prompt pair. */
export const CORRECTION_QUESTION = {
  id: 'is_correction' as const,
  instructions:
    'In the conversation below, does the SECOND message correct, clarify, or redirect the request made in the FIRST message, rather than moving on to new work?',
  criteria: {
    true: 'The second message pushes back, fixes a misunderstanding, restates the request more precisely, points out that the result was wrong, or asks for the previous attempt to be changed or undone.',
    false:
      'The second message accepts the previous result and moves on, starts unrelated work, or simply asks a new question.',
  },
  threshold: 0.6,
};
