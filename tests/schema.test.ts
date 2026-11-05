import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strictSchema } from '../supabase/functions/_shared/schema.ts';

test('strictSchema closes every nested object, including array items', () => {
  const s = strictSchema({
    type: 'object',
    properties: {
      a: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      list: { type: 'array', items: { type: 'object', properties: { c: { type: 'number' } }, required: ['c'] } },
      properties: { type: 'string' },
    },
    required: ['a', 'list', 'properties'],
  }) as any;
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.a.additionalProperties, false);
  assert.equal(s.properties.list.items.additionalProperties, false);
  assert.equal(s.properties.properties.type, 'string');
  assert.deepEqual(s.required, ['a', 'list', 'properties']);
});
