// Mustache-lite: "{{path.to.value}}" lookups only (no logic). Missing values render as "".
// Objects/arrays render as JSON. Lookups never touch the prototype chain.
import { getPath } from './paths.ts';

export function render(template: string, context: unknown): string {
  return String(template).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match: string, path: string) => {
    const v = getPath(context, path);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}
