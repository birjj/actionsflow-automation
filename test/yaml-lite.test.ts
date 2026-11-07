import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStructured, parseYaml } from '../engine/yaml-lite.ts';

test('JSON passes straight through', () => {
  assert.deepEqual(parseStructured('{"a": [1, 2], "b": null}'), { a: [1, 2], b: null });
});

test('block maps, nesting, scalars, comments', () => {
  const y = `
# a comment
species: cat   # trailing
max_age_months: 24
indoor: true
nothing:
nested:
  deep:
    n: -1.5
url: https://example.org/a#frag
quoted: "a: b # not a comment"
single: 'it''s'
`;
  assert.deepEqual(parseYaml(y), {
    species: 'cat', max_age_months: 24, indoor: true, nothing: null,
    nested: { deep: { n: -1.5 } }, url: 'https://example.org/a#frag',
    quoted: 'a: b # not a comment', single: "it's",
  });
});

test('flow collections', () => {
  assert.deepEqual(parseYaml('entities: [alpha, beta, "g, amma"]\nm: { type: string, n: 3 }'), {
    entities: ['alpha', 'beta', 'g, amma'], m: { type: 'string', n: 3 },
  });
  assert.deepEqual(parseYaml('p: { a: [1, {b: 2}], c: {} }'), { p: { a: [1, { b: 2 }], c: {} } });
});

test('block sequences: scalars, same-indent, maps, nested', () => {
  assert.deepEqual(parseYaml('a:\n  - x\n  - y\nb:\n- 1\n- 2'), { a: ['x', 'y'], b: [1, 2] });
  assert.deepEqual(
    parseYaml('items:\n  - id: a\n    url: https://x/a\n  - id: b\n    tags: [t1]\n'),
    { items: [{ id: 'a', url: 'https://x/a' }, { id: 'b', tags: ['t1'] }] },
  );
  assert.deepEqual(parseYaml('- - 1\n  - 2\n- 3'), [[1, 2], 3]);
});

test('manifest-shaped document', () => {
  const m = parseYaml(`name: adoptable-cats
run: node --experimental-strip-types main.ts
inputs:
  type: object
  required: [species]
  properties:
    species: { type: string }
ignore: [fetched_at]`) as {
    run: string;
    inputs: { required: string[]; properties: { species: unknown } };
  };
  assert.equal(m.run, 'node --experimental-strip-types main.ts');
  assert.deepEqual(m.inputs.required, ['species']);
  assert.deepEqual(m.inputs.properties.species, { type: 'string' });
});

test('clear errors for unsupported or broken input', () => {
  assert.throws(() => parseYaml('a: |\n  text'), /block scalars/);
  assert.throws(() => parseYaml('a: 1\na: 2'), /duplicate key/);
  assert.throws(() => parseYaml('\ta: 1'), /tabs/);
  assert.throws(() => parseYaml('a: 1\n  b: 2'), /indentation/);
  assert.throws(() => parseYaml('a: [1, 2'), /flow/);
  assert.throws(() => parseYaml('__proto__: 1'), /__proto__/);
});

test('empty input', () => {
  assert.equal(parseStructured(''), undefined);
  assert.equal(parseStructured('  \n# only a comment\n'), undefined);
});
