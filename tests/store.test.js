'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DocStore } = require('../src/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docstore-test-'));
}

test('data survives close and reopen via snapshot', () => {
  const dir = tmpDir();
  const s = new DocStore(dir).open();
  s.createCollection('users');
  s.insert('users', { name: 'ana', age: 31 });
  s.insert('users', { name: 'bo', age: 25 });
  s.createIndex('users', 'age');
  s.close();

  const s2 = new DocStore(dir).open();
  assert.deepEqual(s2.listCollections(), ['users']);
  assert.equal(s2.count('users'), 2);
  assert.deepEqual(s2.listIndexes('users'), ['age']);
  assert.equal(s2.findOne('users', { name: 'ana' }).age, 31);
  s2.close();
});

test('journal replays mutations made after the last snapshot', () => {
  const dir = tmpDir();
  const s = new DocStore(dir).open();
  s.insert('users', { name: 'ana', age: 31 });
  s.snapshot(); // journal truncated here
  s.insert('users', { name: 'bo', age: 25 });
  s.updateOne('users', { name: 'bo' }, { $inc: { age: 1 } });
  s.deleteOne('users', { name: 'ana' });
  s.close(); // close() snapshots again, so force a journal-only state:
  // reopen, mutate without closing, then open a fresh handle on the same dir
  const s2 = new DocStore(dir).open();
  s2.insert('users', { name: 'cy', age: 40 });
  s2.createIndex('users', 'age');
  // simulate a crash: no close(), journal still holds the inserts
  const s3 = new DocStore(dir).open();
  assert.equal(s3.count('users'), 2);
  assert.deepEqual(s3.find('users', {}).map((d) => d.name).sort(), ['bo', 'cy']);
  assert.equal(s3.findOne('users', { name: 'bo' }).age, 26);
  assert.deepEqual(s3.listIndexes('users'), ['age']);
  s3.close();
});

test('a torn journal tail is skipped, earlier entries still replay', () => {
  const dir = tmpDir();
  const s = new DocStore(dir).open();
  s.insert('users', { name: 'ana', age: 31 });
  s.close();
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"op":"insert","coll":"users","doc":{"name":"tor');
  const s2 = new DocStore(dir).open();
  assert.equal(s2.count('users'), 1);
  assert.equal(s2.findOne('users', { name: 'ana' }).age, 31);
  s2.close();
});

test('dropCollection and createCollection round-trip through the journal', () => {
  const dir = tmpDir();
  const s = new DocStore(dir).open();
  s.insert('temp', { x: 1 });
  s.dropCollection('temp');
  s.insert('keep', { y: 2 });
  const s2 = new DocStore(dir).open();
  assert.deepEqual(s2.listCollections(), ['keep']);
  assert.throws(() => s2.count('temp'), /no such collection/);
  s2.close();
});

test('snapshot() compacts the journal', () => {
  const dir = tmpDir();
  const s = new DocStore(dir).open();
  s.insert('users', { name: 'ana' });
  s.snapshot();
  assert.equal(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), '');
  assert.ok(fs.existsSync(path.join(dir, 'snapshot.json')));
  s.close();
});
