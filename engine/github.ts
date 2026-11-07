// Minimal GitHub Actions plumbing (outputs, step summary). Silent no-ops outside Actions.
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export function setOutput(name: string, value: string | number | boolean): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delim = `EOF_${randomBytes(12).toString('hex')}`;
  appendFileSync(file, `${name}<<${delim}\n${String(value)}\n${delim}\n`);
}

export function appendSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, markdown + '\n');
}

export const warning = (msg: string): void => console.log(`::warning::${String(msg).replace(/\n/g, ' ')}`);
