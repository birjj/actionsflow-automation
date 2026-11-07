import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDefaults, validate } from '../engine/schema.ts';
import { render } from '../engine/template.ts';
import type { Schema } from '../engine/types.ts';

const schema: Schema = {
  type: 'object', required: ['species'],
  properties: {
    species: { type: 'string', default: 'cat' },
    max_age_months: { type: 'number', minimum: 0 },
    tags: { type: 'array', items: { type: 'string' } },
    mode: { enum: ['a', 'b'] },
  },
};

test('defaults are applied before validation', () => {
  const v = applyDefaults(schema, {});
  assert.deepEqual(v, { species: 'cat' });
  assert.deepEqual(validate(schema, v), []);
});

test('validation errors are specific', () => {
  const errs = validate(schema, { max_age_months: -1, tags: ['a', 3], mode: 'c' });
  assert.ok(errs.some((e) => e.includes('input.species: is required')));
  assert.ok(errs.some((e) => e.includes('input.max_age_months: must be >= 0')));
  assert.ok(errs.some((e) => e.includes('input.tags[1]: expected string')));
  assert.ok(errs.some((e) => e.includes('input.mode: must be one of')));
});

test('template renders paths, indexes, objects, and missing values', () => {
  const e = { title: 'Mimi', changes: [{ from: 'up', to: 'down' }], data: { n: 1, o: { a: 1 } } };
  assert.equal(render('{{title}}: {{ changes.0.from }} → {{changes.0.to}}', e), 'Mimi: up → down');
  assert.equal(render('{{data.o}} {{data.n}} [{{nope.nothing}}]', e), '{"a":1} 1 []');
  assert.equal(render('{{constructor}} {{__proto__}}', e), ' ');
});
