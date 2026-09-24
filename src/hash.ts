import { createHash } from 'node:crypto';

/** Content address for a prompt. Identical text is never scored twice. */
export function promptHash(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex').slice(0, 16);
}

/** Strip the attachment preamble Claude Code prepends to a prompt with files. */
export function stripPreamble(text: string): string {
  return text
    .replace(/^\s*<system_instruction>[\s\S]*?<\/system_instruction>\s*/g, '')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
    .trim();
}

/**
 * A key for recognising the same prompt in the hook's input and in the
 * transcript, which do not hold it byte for byte: the transcript can split it
 * into several text blocks, and a preamble may sit on either side. Only the
 * hash crosses between the two, never the text.
 */
export function promptMatchKey(text: string): string {
  return promptHash(stripPreamble(text).replace(/\s+/g, ' '));
}
