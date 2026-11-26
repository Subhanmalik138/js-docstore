'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('../src/collection');

function seed() {
  const c = new Collection('users');
  c.insertMany([
    { name: 'ana', age: 31, tags: ['node'], score: 10 },
    { name: 'bo', age: 25, tags: ['go', 'node'], score: 20 },
    { name: 'cy', age: 31, tags: [], score: 30 },
  ]);
  return c;
}

test('insert assigns _id, rejects duplicates, clones on read', () => {
  const c = new Collection('t');
  const inserted = c.insert({ name: 'x' });
  assert.equal(typeof inserted._id, 'string');
  assert.equal(inserted._id.length, 36);
  assert.throws(() => c.insert({ _id: inserted._id, name: 'y' }), /duplicate _id/);
  assert.throws(() => c.insert('nope'), /plain object/);
  // mutating a returned doc must not corrupt the store
  const found = c.findById(inserted._id);
  found.name = 'mutated';
  assert.equal(c.findById(inserted._id).name, 'x');
});

test('find with filter, sort, skip, limit, projection', () => {
  const c = seed();
  assert.equal(c.find({ age: 31 }).length, 2);
  assert.equal(c.find({ age: { $gt: 25 } }).length, 2);
  assert.deepEqual(c.find({}, { sort: { score: -1 } }).map((d) => d.name), ['cy', 'bo', 'ana']);
  assert.deepEqual(c.find({}, { sort: { score: 1 }, skip: 1, limit: 1 }).map((d) => d.name), ['bo']);
  assert.deepEqual(c.find({ name: 'ana' }, { projection: { name: 1 } }), [{ _id: c.findOne({ name: 'ana' })._id, name: 'ana' }]);
  assert.equal(c.findOne({ name: 'bo' }).age, 25);
  assert.equal(c.findOne({ name: 'nobody' }), null);
  assert.equal(c.count(), 3);
  assert.equal(c.count({ age: 31 }), 2);
});

test('update operators: $set $unset $inc $push $pull $addToSet', () => {
  const c = seed();
  const r = c.updateOne({ name: 'ana' }, { $set: { 'address.city': 'Lahore' }, $inc: { score: 5 } });
  assert.deepEqual(r, { matched: 1, modified: 1 });
  assert.equal(c.findOne({ name: 'ana' }).address.city, 'Lahore');
  assert.equal(c.findOne({ name: 'ana' }).score, 15);

  c.updateOne({ name: 'bo' }, { $unset: { score: '' } });
  assert.equal(c.findOne({ name: 'bo' }).score, undefined);

  c.updateOne({ name: 'ana' }, { $push: { tags: 'js' } });
  assert.deepEqual(c.findOne({ name: 'ana' }).tags, ['node', 'js']);
  c.updateOne({ name: 'ana' }, { $push: { tags: { $each: ['ts', 'py'] } } });
  assert.equal(c.findOne({ name: 'ana' }).tags.length, 4);

  c.updateOne({ name: 'bo' }, { $pull: { tags: 'go' } });
  assert.deepEqual(c.findOne({ name: 'bo' }).tags, ['node']);
  c.updateOne({ name: 'bo' }, { $addToSet: { tags: 'node' } });
  c.updateOne({ name: 'bo' }, { $addToSet: { tags: 'rust' } });
  assert.deepEqual(c.findOne({ name: 'bo' }).tags, ['node', 'rust']);

  assert.throws(() => c.updateOne({ name: 'ana' }, { $set: 5 }), /\$set requires an object/);
  assert.throws(() => c.updateOne({ name: 'ana' }, { bogus: 1 }), /unsupported update operator/);
  assert.throws(() => c.updateOne({ name: 'ana' }, { $inc: { score: 'x' } }), /\$inc value must be a number/);
});

test('updateMany touches every match; deleteOne/deleteMany', () => {
  const c = seed();
  const r = c.updateMany({ age: 31 }, { $inc: { score: 1 } });
  assert.deepEqual(r, { matched: 2, modified: 2 });
  assert.equal(c.deleteOne({ name: 'bo' }).deleted, 1);
  assert.equal(c.deleteOne({ name: 'bo' }).deleted, 0);
  assert.equal(c.deleteMany({ age: 31 }).deleted, 2);
  assert.equal(c.count(), 0);
});

test('replaceOne keeps _id and swaps the document', () => {
  const c = seed();
  const before = c.findOne({ name: 'ana' });
  const r = c.replaceOne({ name: 'ana' }, { name: 'ana', age: 32 });
  assert.deepEqual(r, { matched: 1, modified: 1 });
  const after = c.findById(before._id);
  assert.equal(after._id, before._id);
  assert.equal(after.age, 32);
  assert.equal(after.tags, undefined);
  assert.deepEqual(c.replaceOne({ name: 'ghost' }, { name: 'ghost' }), { matched: 0, modified: 0 });
});

test('toJSON/fromJSON round-trip preserves documents', () => {
  const c = seed();
  const restored = Collection.fromJSON(c.toJSON());
  assert.equal(restored.count(), 3);
  assert.deepEqual(restored.find({ age: 31 }).map((d) => d.name).sort(), ['ana', 'cy']);
});
