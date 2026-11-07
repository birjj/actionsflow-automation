// Small helpers for walking and comparing JSON values.
// Paths are dotted ("address.city", "tags.0"). Keys that contain dots are not addressable.
import type { Change } from './types.ts';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep equality for JSON values. A missing value and `null` are treated as equal. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** Read a dotted path. Returns undefined if any segment is missing. Never walks the prototype chain. */
export function getPath(obj: unknown, path: string | null | undefined): unknown {
  if (path === '' || path == null) return obj;
  let cur: unknown = obj;
  for (const key of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** True if `path` equals an ignored path or lives underneath one. */
export function isIgnored(path: string, ignore: readonly string[]): boolean {
  return ignore.some((ig) => path === ig || path.startsWith(ig + '.'));
}

/**
 * Leaf-level differences between two JSON values. Objects are walked recursively;
 * arrays and primitives are compared as a whole. Ignored paths are skipped.
 */
export function collectChanges(
  before: unknown,
  after: unknown,
  ignore: readonly string[] = [],
  prefix = '',
): Change[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const changes: Change[] = [];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (isIgnored(p, ignore)) continue;
      changes.push(...collectChanges(before[k], after[k], ignore, p));
    }
    return changes;
  }
  if (deepEqual(before, after)) return [];
  return [{ path: prefix, from: before ?? null, to: after ?? null }];
}
