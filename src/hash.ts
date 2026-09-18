import { createHash } from 'node:crypto';

/** Content address for a prompt. Identical text is never scored twice. */
export function promptHash(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex').slice(0, 16);
}
