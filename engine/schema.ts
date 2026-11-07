// Tiny JSON Schema subset for fetcher `inputs`: type, enum, required, properties,
// additionalProperties:false, items, minimum, maximum, minLength, pattern, default.
import { isPlainObject } from './paths.ts';
import type { Schema } from './types.ts';

function typeOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeOf(v) === t;
}

/** Fill in `default`s (recursively for object properties). Returns a new value. */
export function applyDefaults(schema: Schema | undefined, value: unknown): unknown {
  if (!schema) return value;
  if (value === undefined && 'default' in schema) value = structuredClone(schema.default);
  if (isPlainObject(value) && isPlainObject(schema.properties)) {
    const out: Record<string, unknown> = { ...value };
    for (const [k, sub] of Object.entries(schema.properties)) {
      const v = applyDefaults(sub, out[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

/** @returns human-readable errors (empty when valid) */
export function validate(schema: Schema | undefined, value: unknown, path = 'input'): string[] {
  if (!schema) return [];
  const errors: string[] = [];
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join(' | ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must have at least ${schema.minLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: must match /${schema.pattern}/`);
  }
  if (isPlainObject(value)) {
    for (const r of schema.required ?? []) {
      if (value[r] === undefined) errors.push(`${path}.${r}: is required`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      const sub = props[k];
      if (sub) errors.push(...validate(sub, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: unknown property`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  return errors;
}
