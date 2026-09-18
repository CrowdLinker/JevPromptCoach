/**
 * Privacy. Prompts contain code, paths and sometimes secrets, so redaction runs
 * before anything is written to the log and again before anything is sent to
 * the API. Both passes use this module; a prompt that was logged under `raw`
 * and later read under `redact` is still redacted on the way out.
 */
import type { Privacy } from './config.js';

interface Rule {
  name: string;
  pattern: RegExp;
  replace: string | ((match: string) => string);
}

/**
 * Credential shapes first, so a key living inside a path or URL is masked as a
 * key rather than swallowed whole by the path rule.
 */
const CREDENTIAL_RULES: Rule[] = [
  { name: 'pem', pattern: /-----BEGIN[^-]{0,80}-----[\s\S]*?-----END[^-]{0,80}-----/g, replace: '[PEM]' },
  { name: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_\-]{8,}/g, replace: '[KEY]' },
  { name: 'openai', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{16,}/g, replace: '[KEY]' },
  { name: 'github', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: '[KEY]' },
  { name: 'aws', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: '[KEY]' },
  { name: 'google', pattern: /\bAIza[A-Za-z0-9_\-]{30,}/g, replace: '[KEY]' },
  { name: 'slack', pattern: /\bxox[abprs]-[A-Za-z0-9\-]{10,}/g, replace: '[KEY]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, replace: '[JWT]' },
  { name: 'bearer', pattern: /\b[Bb]earer\s+[A-Za-z0-9._\-]{12,}/g, replace: 'Bearer [KEY]' },
  {
    name: 'azure-client-secret',
    // Azure client secrets carry a '~' mid-token, which is vanishingly rare in
    // prose, code identifiers and paths. Found in real local history, where it
    // was written as "value - <secret>" and matched no labelled rule below.
    pattern: /(?<![\w~/])[A-Za-z0-9_.-]{4,}~[A-Za-z0-9_.~-]{12,}(?![\w])/g,
    replace: '[KEY]',
  },
  {
    name: 'labelled-secret',
    // A secret introduced by a label: "value - x", "Secret: x", "client secret = x".
    // The separator must be ':', '=' or a spaced hyphen, and the value may not
    // contain '/', so a path like secret-client/app/main.ts is not a match.
    pattern: /\b(value|secret|password|passwd|token|api[ _-]?key|client[ _-]?secret)\b\s*(?::|=|-\s)\s*(['"`]?)([^\s'"`,;/\\]{12,})\2/gi,
    replace: (m: string) => m.replace(/((?::|=|-\s)\s*['"`]?)([^\s'"`,;/\\]{12,})/, '$1[REDACTED]'),
  },
  {
    name: 'assigned-secret',
    // KEY=value / "api_key": "value" / TOKEN: value
    pattern: /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?)\b(\s*[:=]\s*)(['"]?)([^\s'"`,;]{6,})\3/gi,
    replace: (m: string) => m.replace(/([:=]\s*['"]?)([^\s'"`,;]{6,})/, '$1[REDACTED]'),
  },
];

const EMAIL_RULE: Rule = {
  name: 'email',
  pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  replace: '[EMAIL]',
};

/**
 * Paths are stripped to their basename rather than removed. `named_target`
 * asks whether the prompt names a specific file, so the filename has to
 * survive; only the directories that identify the machine and the person go.
 */
const PATH_RULES: Rule[] = [
  {
    name: 'home',
    pattern: /(?:\/Users\/|\/home\/|C:\\Users\\)[^\s'"`)\]]+/g,
    replace: (m: string) => {
      const base = m.split(/[/\\]/).filter(Boolean).pop() ?? '';
      return base && /[.\w]/.test(base) ? `~/…/${base}` : '~/…';
    },
  },
  {
    name: 'absolute',
    pattern: /(?<![\w~])\/(?:[A-Za-z0-9._\-]+\/){2,}[A-Za-z0-9._\-]*/g,
    replace: (m: string) => {
      const base = m.split('/').filter(Boolean).pop() ?? '';
      return base ? `…/${base}` : '…/';
    },
  },
];

function applyRules(text: string, rules: Rule[]): string {
  let out = text;
  for (const rule of rules) {
    out = typeof rule.replace === 'function'
      ? out.replace(rule.pattern, rule.replace as (m: string) => string)
      : out.replace(rule.pattern, rule.replace);
  }
  return out;
}

/** Strip credentials, emails and identifying path segments. */
export function redact(text: string): string {
  return applyRules(applyRules(text, CREDENTIAL_RULES), [EMAIL_RULE, ...PATH_RULES]);
}

/** Credential-shaped strings only. Applied at every privacy level, including `raw`. */
export function stripCredentials(text: string): string {
  return applyRules(text, CREDENTIAL_RULES);
}

export interface Features {
  chars: number;
  words: number;
  lines: number;
  hasCodeFence: boolean;
  hasFilePath: boolean;
  hasQuestionMark: boolean;
  hasErrorWord: boolean;
}

/**
 * `metadata_only`: derived features, never the text. These are logged in place
 * of the prompt and are not enough to reconstruct it.
 */
export function features(text: string): Features {
  return {
    chars: text.length,
    words: text.trim().split(/\s+/).filter(Boolean).length,
    lines: text.split('\n').length,
    hasCodeFence: /```/.test(text),
    hasFilePath: /[\w\-/]+\.[a-z]{1,5}\b/i.test(text),
    hasQuestionMark: text.includes('?'),
    hasErrorWord: /\b(error|exception|traceback|failed|stack ?trace)\b/i.test(text),
  };
}

/** Apply the configured privacy level to a prompt about to be stored or sent. */
export function applyPrivacy(text: string, privacy: Privacy): { text: string | null; features: Features } {
  const f = features(text);
  if (privacy === 'metadata_only') return { text: null, features: f };
  if (privacy === 'raw') return { text: stripCredentials(text), features: f };
  return { text: redact(text), features: f };
}
