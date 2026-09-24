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
  { name: 'anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: '[KEY]' },
  { name: 'openai', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, replace: '[KEY]' },
  { name: 'github', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: '[KEY]' },
  { name: 'aws', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: '[KEY]' },
  { name: 'google', pattern: /\bAIza[A-Za-z0-9_-]{30,}/g, replace: '[KEY]' },
  { name: 'slack', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: '[KEY]' },
  { name: 'stripe', pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: '[KEY]' },
  { name: 'npm', pattern: /\bnpm_[A-Za-z0-9]{30,}/g, replace: '[KEY]' },
  { name: 'github-fine-grained', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g, replace: '[KEY]' },
  { name: 'sendgrid', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, replace: '[KEY]' },
  {
    name: 'webhook-url',
    // The URL is the credential: anyone holding it can post to the channel.
    pattern: /https:\/\/(?:hooks\.slack\.com\/services|discord(?:app)?\.com\/api\/webhooks)\/[^\s'"`)\]]+/g,
    replace: '[WEBHOOK]',
  },
  {
    name: 'url-credentials',
    // scheme://user:password@host. Agent replies quote connection strings
    // back from .env files and config; the user and host are kept, the
    // password is not. Runs before the email rule, which would otherwise
    // swallow "password@host" by accident and leave the next one in place.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:)[^\s@/'"`]+@/gi,
    replace: '$1[REDACTED]@',
  },
  { name: 'azure-sas', pattern: /([?&]sig=)[A-Za-z0-9%+/=]{16,}/g, replace: '$1[REDACTED]' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: '[JWT]' },
  { name: 'bearer', pattern: /\b[Bb]earer\s+[A-Za-z0-9._-]{12,}/g, replace: 'Bearer [KEY]' },
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
    pattern:
      /\b(value|secret|password|passwd|token|api[ _-]?key|client[ _-]?secret)\b['"]?\s*(?::|=|-\s|is\s)\s*(['"`]?)([^\s'"`,;/\\]{12,})\2/gi,
    replace: (m: string) => m.replace(/((?::|=|-\s|\bis\s)\s*['"`]?)([^\s'"`,;/\\]{12,})/i, '$1[REDACTED]'),
  },
  {
    name: 'labelled-password',
    // Passwords are short more often than keys are, so the length floor is
    // lower than for the generic labels above; the label itself is specific.
    // The optional quote after the label covers a JSON key: "password": "x".
    // Prose counts too: "the password is x" was found in real history.
    pattern: /\b(password|passwd|pwd)\b['"]?(?:\s*[:=]|\s+is)\s*(['"`]?)([^\s'"`,;]{6,})\2/gi,
    replace: (m: string) => m.replace(/((?:[:=]|\bis)\s*['"`]?)([^\s'"`,;]{6,})/i, '$1[REDACTED]'),
  },
  {
    name: 'assigned-secret',
    // KEY=value / "api_key": "value" / TOKEN: value / DB_PASS=value. The short
    // suffixes need an underscore before them, so bypass: or oauth: in code is
    // not taken for a secret.
    pattern:
      /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?|(?:[A-Za-z0-9]+_)+(?:PASS|PWD|AUTH))\b(\s*[:=]\s*)(['"]?)([^\s'"`,;]{6,})\3/gi,
    replace: (m: string) => m.replace(/([:=]\s*['"]?)([^\s'"`,;]{6,})/, '$1[REDACTED]'),
  },
  {
    name: 'long-hex',
    // Hashes, hex tokens and hex-encoded keys: 16 or more hex characters with a
    // digit among them. Commit SHAs go too; the marker still tells the scorer a
    // specific identifier was named. UUIDs survive: their hex runs are shorter.
    // An 0x prefix is how hex private keys are usually written.
    pattern: /(?<![\w-])(?:0x)?(?=[0-9a-f]*\d)[0-9a-f]{16,}(?![\w-])/gi,
    replace: '[HEX]',
  },
  {
    name: 'random-token',
    // A secret with no known prefix and no label. Last, so the named rules
    // above get first say. See looksRandom for what separates it from a long
    // identifier.
    pattern: /(?<![\w/.~+=-])[A-Za-z0-9_+=-]{20,}(?![\w/.~+=-])/g,
    replace: (m: string) => (m.split(/[-_+=]/).some(looksRandom) ? '[KEY]' : m),
  },
];

/**
 * Whether one chunk of a token reads as random rather than as words.
 *
 * Measured on real prompts and agent replies before it was written: the long
 * mixed tokens there are mostly migration names (a CamelCase word and a
 * 13-digit timestamp), slugs and constant names, and all of them contain a run
 * of five or more lowercase letters. Keys and tokens rarely do, and they switch
 * between letters, digits and case constantly.
 */
function looksRandom(chunk: string): boolean {
  if (chunk.length < 16) return false;
  if (/[a-z]{5,}/.test(chunk)) return false;
  const digits = (chunk.match(/\d/g) ?? []).length;
  const lower = (chunk.match(/[a-z]/g) ?? []).length;
  const upper = (chunk.match(/[A-Z]/g) ?? []).length;
  if (digits < 2 || lower < 2 || upper < 2) return false;
  const kind = (c: string): number => (/\d/.test(c) ? 0 : /[a-z]/.test(c) ? 1 : 2);
  let switches = 0;
  for (let i = 1; i < chunk.length; i += 1) if (kind(chunk[i]!) !== kind(chunk[i - 1]!)) switches += 1;
  return switches >= chunk.length / 3;
}

const EMAIL_RULE: Rule = {
  name: 'email',
  pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
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
    pattern: /(?<![\w~])\/(?:[A-Za-z0-9._-]+\/){2,}[A-Za-z0-9._-]*/g,
    replace: (m: string) => {
      const base = m.split('/').filter(Boolean).pop() ?? '';
      return base ? `…/${base}` : '…/';
    },
  },
];

function applyRules(text: string, rules: Rule[]): string {
  let out = text;
  for (const rule of rules) {
    // The branches look identical because String.replace has separate overloads
    // for a string and a function replacement, and the union satisfies neither.
    out =
      typeof rule.replace === 'function'
        ? out.replace(rule.pattern, rule.replace)
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
