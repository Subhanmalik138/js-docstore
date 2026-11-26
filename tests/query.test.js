'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchDocument, compareDocs, projectDoc } = require('../src/query');

const doc = {
  _id: '1',
  name: 'Ana',
  age: 31,
  active: true,
  tags: ['node', 'js'],
  address: { city: 'Lahore', zip: '54000' },
  scores: [10, 20, 30],
  history: [{ year: 2023, role: 'dev' }, { year: 2024, role: 'lead' }],
  nickname: null,
};

test('plain equality, dotted paths and array membership', () => {
  assert.equal(matchDocument(doc, {}), true);
  assert.equal(matchDocument(doc, { name: 'Ana' }), true);
  assert.equal(matchDocument(doc, { name: 'Bo' }), false);
  assert.equal(matchDocument(doc, { 'address.city': 'Lahore' }), true);
  assert.equal(matchDocument(doc, { 'address.zip': '54000' }), true);
  assert.equal(matchDocument(doc, { tags: 'node' }), true);
  assert.equal(matchDocument(doc, { tags: 'go' }), false);
  assert.equal(matchDocument(doc, { nickname: null }), true);
  assert.equal(matchDocument(doc, { missing: undefined }), true);
});

test('comparison operators', () => {
  assert.equal(matchDocument(doc, { age: { $gt: 30 } }), true);
  assert.equal(matchDocument(doc, { age: { $gte: 31 } }), true);
  assert.equal(matchDocument(doc, { age: { $lt: 31 } }), false);
  assert.equal(matchDocument(doc, { age: { $lte: 31 } }), true);
  assert.equal(matchDocument(doc, { age: { $ne: 25 } }), true);
  assert.equal(matchDocument(doc, { age: { $eq: 31 } }), true);
  assert.equal(matchDocument(doc, { scores: { $gt: 25 } }), true); // any element
  assert.equal(matchDocument(doc, { age: { $in: [25, 31] } }), true);
  assert.equal(matchDocument(doc, { age: { $nin: [25, 31] } }), false);
});

test('$exists, $regex, $type, $size, $all', () => {
  assert.equal(matchDocument(doc, { nickname: { $exists: true } }), true);
  assert.equal(matchDocument(doc, { nope: { $exists: false } }), true);
  assert.equal(matchDocument(doc, { name: { $regex: '^An' } }), true);
  assert.equal(matchDocument(doc, { name: { $regex: '^an', $options: 'i' } }), true);
  assert.equal(matchDocument(doc, { name: { $regex: '^Bo' } }), false);
  assert.equal(matchDocument(doc, { age: { $type: 'number' } }), true);
  assert.equal(matchDocument(doc, { tags: { $type: 'array' } }), true);
  assert.equal(matchDocument(doc, { nope: { $type: 'missing' } }), true);
  assert.equal(matchDocument(doc, { tags: { $size: 2 } }), true);
  assert.equal(matchDocument(doc, { tags: { $all: ['js', 'node'] } }), true);
  assert.equal(matchDocument(doc, { tags: { $all: ['js', 'go'] } }), false);
});

test('$elemMatch on arrays of documents', () => {
  assert.equal(matchDocument(doc, { history: { $elemMatch: { role: 'lead' } } }), true);
  assert.equal(matchDocument(doc, { history: { $elemMatch: { year: { $gt: 2024 } } } }), false);
});

test('logical operators', () => {
  assert.equal(matchDocument(doc, { $and: [{ age: { $gte: 30 } }, { active: true }] }), true);
  assert.equal(matchDocument(doc, { $or: [{ age: 25 }, { name: 'Ana' }] }), true);
  assert.equal(matchDocument(doc, { $or: [{ age: 25 }, { name: 'Bo' }] }), false);
  assert.equal(matchDocument(doc, { $nor: [{ age: 25 }, { name: 'Bo' }] }), true);
  assert.equal(matchDocument(doc, { $not: { age: 31 } }), false);
  assert.equal(matchDocument(doc, { $not: { age: 25 } }), true);
});

test('invalid operators throw', () => {
  assert.throws(() => matchDocument(doc, { age: { $bogus: 1 } }), /unsupported query operator/);
  assert.throws(() => matchDocument(doc, { $bogus: {} }), /unsupported top-level operator/);
});

test('sort comparator is stable and type-ordered', () => {
  const a = { _id: 'a', age: 20, name: 'zoe' };
  const b = { _id: 'b', age: 30, name: 'amy' };
  assert.equal(compareDocs(a, b, { age: 1 }) < 0, true);
  assert.equal(compareDocs(a, b, { age: -1 }) > 0, true);
  assert.equal(compareDocs(a, b, { name: 1 }) > 0, true);
  // missing sorts before present values
  assert.equal(compareDocs({ _id: 'x' }, { _id: 'y', age: 1 }, { age: 1 }) < 0, true);
  // equal sort keys fall back to _id
  assert.equal(compareDocs({ _id: 'a', age: 5 }, { _id: 'b', age: 5 }, { age: 1 }) < 0, true);
});

test('projection: inclusion, exclusion, dotted fields', () => {
  assert.deepEqual(projectDoc(doc, { name: 1 }), { _id: '1', name: 'Ana' });
  assert.deepEqual(projectDoc(doc, { name: 1, _id: 0 }), { name: 'Ana' });
  assert.deepEqual(projectDoc(doc, { 'address.city': 1 }), { _id: '1', address: { city: 'Lahore' } });
  const excluded = projectDoc(doc, { tags: 0, nickname: 0 });
  assert.equal(excluded.tags, undefined);
  assert.equal(excluded.nickname, undefined);
  assert.equal(excluded.name, 'Ana');
  assert.throws(() => projectDoc(doc, { name: 1, age: 0 }), /cannot mix/);
});
