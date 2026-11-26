'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('../src/collection');

function seed() {
  const c = new Collection('users');
  c.insertMany([
    { name: 'ana', age: 31, tags: ['node', 'js'] },
    { name: 'bo', age: 25, tags: ['go'] },
    { name: 'cy', age: 31, tags: ['node'] },
    { name: 'dee', tags: ['rust'] }, // no age
  ]);
  return c;
}

test('index narrows equality lookups and stays correct after writes', () => {
  const c = seed();
  c.createIndex('age');
  assert.deepEqual(c.createIndex('age'), { created: false, field: 'age' });
  assert.deepEqual(c.listIndexes(), ['age']);

  const byAge = (age) => c.find({ age }).map((d) => d.name).sort();
  assert.deepEqual(byAge(31), ['ana', 'cy']);
  assert.deepEqual(byAge(25), ['bo']);
  assert.deepEqual(byAge(99), []);
  // indexed field missing on a doc: not returned, no crash
  assert.deepEqual(c.find({ age: { $eq: 25 } }).map((d) => d.name), ['bo']);
  // non-equality filters still scan and agree with the index path
  assert.deepEqual(c.find({ age: { $gt: 26 } }).map((d) => d.name).sort(), ['ana', 'cy']);
  // combined indexed + unindexed conditions intersect correctly
  assert.deepEqual(c.find({ age: 31, name: 'cy' }).map((d) => d.name), ['cy']);
});

test('array field values are indexed per element', () => {
  const c = seed();
  c.createIndex('tags');
  assert.deepEqual(c.find({ tags: 'node' }).map((d) => d.name).sort(), ['ana', 'cy']);
  assert.deepEqual(c.find({ tags: 'rust' }).map((d) => d.name), ['dee']);
});

test('index tracks updates and deletes', () => {
  const c = seed();
  c.createIndex('age');
  c.updateOne({ name: 'bo' }, { $set: { age: 31 } });
  assert.deepEqual(c.find({ age: 31 }).map((d) => d.name).sort(), ['ana', 'bo', 'cy']);
  c.deleteOne({ name: 'ana' });
  assert.deepEqual(c.find({ age: 31 }).map((d) => d.name).sort(), ['bo', 'cy']);
  c.updateOne({ name: 'cy' }, { $unset: { age: '' } });
  assert.deepEqual(c.find({ age: 31 }).map((d) => d.name), ['bo']);
});

test('dropIndex removes the index; dotted field indexes work', () => {
  const c = new Collection('t');
  c.insertMany([
    { address: { city: 'Lahore' } },
    { address: { city: 'Karachi' } },
    { address: { city: 'Lahore' } },
  ]);
  c.createIndex('address.city');
  assert.equal(c.find({ 'address.city': 'Lahore' }).length, 2);
  assert.deepEqual(c.dropIndex('address.city'), { dropped: true, field: 'address.city' });
  assert.deepEqual(c.listIndexes(), []);
  assert.equal(c.find({ 'address.city': 'Lahore' }).length, 2);
});
