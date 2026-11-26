'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DocStore } = require('../src/store');
const { createServer } = require('../src/server');

async function withServer(t, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docstore-http-'));
  const store = new DocStore(dir).open();
  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  t.after(() => {
    server.close();
    store.close();
  });
  await fn(base);
}

async function req(base, method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('full CRUD flow over HTTP', async (t) => {
  await withServer(t, async (base) => {
    assert.deepEqual((await req(base, 'GET', '/health')).body.status, 'ok');

    const created = await req(base, 'POST', '/collections', { name: 'books' });
    assert.equal(created.status, 201);
    const dup = await req(base, 'POST', '/collections', { name: 'books' });
    assert.equal(dup.status, 400);

    const inserted = await req(base, 'POST', '/collections/books/docs', { title: 'Dune', pages: 412 });
    assert.equal(inserted.status, 201);
    const id = inserted.body._id;
    assert.equal(typeof id, 'string');

    const got = await req(base, 'GET', `/collections/books/docs/${id}`);
    assert.equal(got.body.title, 'Dune');

    const patched = await req(base, 'PATCH', `/collections/books/docs/${id}`, { $set: { pages: 500 } });
    assert.equal(patched.body.doc.pages, 500);

    const replaced = await req(base, 'PUT', `/collections/books/docs/${id}`, { title: 'Dune Messiah', pages: 256 });
    assert.equal(replaced.body.doc.title, 'Dune Messiah');
    assert.equal(replaced.body.doc._id, id);

    const missing = await req(base, 'GET', '/collections/books/docs/nope');
    assert.equal(missing.status, 404);

    const deleted = await req(base, 'DELETE', `/collections/books/docs/${id}`);
    assert.equal(deleted.body.deleted, 1);
    assert.equal((await req(base, 'GET', `/collections/books/docs/${id}`)).status, 404);
  });
});

test('query endpoint, indexes and collection listing over HTTP', async (t) => {
  await withServer(t, async (base) => {
    const batch = await req(base, 'POST', '/collections/notes/docs', {
      docs: [
        { tag: 'a', n: 1 },
        { tag: 'b', n: 2 },
        { tag: 'a', n: 3 },
      ],
    });
    assert.equal(batch.body.count, 3);

    const q = await req(base, 'POST', '/collections/notes/query', {
      filter: { tag: 'a' },
      sort: { n: -1 },
    });
    assert.deepEqual(q.body.docs.map((d) => d.n), [3, 1]);

    const idx = await req(base, 'POST', '/collections/notes/indexes', { field: 'tag' });
    assert.equal(idx.body.created, true);
    const listed = await req(base, 'GET', '/collections/notes/indexes');
    assert.deepEqual(listed.body.indexes, ['tag']);

    const viaGet = await req(base, 'GET', '/collections/notes/docs?filter=%7B%22tag%22%3A%22b%22%7D');
    assert.equal(viaGet.body.docs.length, 1);
    assert.equal(viaGet.body.docs[0].n, 2);

    const colls = await req(base, 'GET', '/collections');
    assert.deepEqual(colls.body.collections, ['notes']);

    const bad = await req(base, 'GET', '/collections/ghost/docs');
    assert.equal(bad.status, 404);
    const badJson = await req(base, 'POST', '/collections/notes/docs', undefined);
    assert.equal(badJson.status, 201); // empty body inserts an empty doc
  });
});
