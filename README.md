# DocStore

An embedded document database for Node.js — MongoDB-style queries, secondary
indexes, journal + snapshot persistence, an HTTP API and a CLI. Zero
dependencies, just the Node standard library.

DocStore is for the jobs where a full database server is overkill but a JSON
file is too fragile: local-first tools, CLIs that need durable state, test
fixtures, prototypes that grow into real apps. Documents live in collections
on disk and survive restarts; everything else is in-memory and fast.

## Quick start

```bash
# CLI — a store is just a directory
node bin/docstore ./my-store insert users '{"name": "ana", "age": 31}'
node bin/docstore ./my-store find users '{"age": {"$gte": 30}}'
node bin/docstore ./my-store update users <id> '{"$inc": {"age": 1}}'
node bin/docstore ./my-store index users age

# HTTP API
node bin/docstore ./my-store serve --port 3000
curl -X POST localhost:3000/collections/users/docs -d '{"name": "bo", "age": 25}'
curl "localhost:3000/collections/users/docs?filter=%7B%22age%22%3A%7B%22%24gte%22%3A30%7D%7D"
```

```js
// Library
const { DocStore } = require('./src/store');

const store = new DocStore('./my-store').open();
store.insert('users', { name: 'ana', age: 31, tags: ['node'] });
store.createIndex('users', 'age');

store.find('users', { age: { $gte: 30 } }, { sort: { name: 1 } });
store.updateOne('users', { name: 'ana' }, { $set: { city: 'Lahore' } });
store.close(); // writes a snapshot, safe to reopen later
```

## Features

- **MongoDB-style queries** — `$eq $ne $gt $gte $lt $lte $in $nin $exists
  $regex $all $size $elemMatch $type`, top-level `$and $or $nor $not`,
  dotted paths (`address.city`), array-membership matching, sort / skip /
  limit / projection.
- **Updates** — `$set $unset $inc $push $pull $addToSet`, plus whole-document
  replace. All operators work on dotted paths.
- **Secondary indexes** — equality indexes (including per-element indexing
  of array fields and dotted fields) that narrow `find` to candidate
  documents; range and compound conditions still scan correctly.
- **Durable storage** — every mutation is appended to a JSONL journal
  before it is applied, and `snapshot()` writes the full state atomically
  (temp file + rename) and truncates the journal. Reopening replays the
  journal; a torn final line from a crash mid-write is skipped, not fatal.
- **HTTP API** — collections, documents, a `/query` endpoint, and index
  management over plain Node `http`.
- **CLI** — `insert / get / find / update / delete / index / export /
  import / snapshot / serve`, all operating on the same on-disk store.

## Design decisions

1. **JSON-only documents, deep-cloned on every read.** Documents are JSON
   by definition, so `JSON.parse(JSON.stringify(...))` is an exact clone.
   Cloning on read means callers can never mutate stored state by accident
   — a common source of subtle bugs in embedded stores.
2. **Journal first, snapshot second.** Writes are cheap appends; the
   snapshot is an infrequent compaction step. This is the same shape as
   SQLite's WAL and Redis's AOF: durability without paying a rewrite cost
   per mutation.
3. **Indexes are value → `_id` sets, keyed by JSON string.** Equality is
   exact for JSON values, array fields index per element, and the planner
   only uses an index for scalar equality (or `$eq`) — everything else
   falls back to a full scan, so a query is never wrong, only slower.
4. **No dependencies.** The whole engine is Node built-ins (`fs`, `http`,
   `crypto`). Nothing to install, nothing to audit, and the store directory
   is the only state — copy it and you have a backup.

## HTTP API

| Method | Route | Description |
| --- | --- | --- |
| GET | `/health` | `{ status, collections }` |
| GET | `/collections` | List collection names |
| POST | `/collections` | `{ name }` — create a collection |
| DELETE | `/collections/:name` | Drop a collection |
| GET | `/collections/:name/docs?filter=&sort=&skip=&limit=&projection=` | Find (query params are JSON) |
| POST | `/collections/:name/docs` | Insert one doc, or `{ docs: [...] }` |
| POST | `/collections/:name/query` | `{ filter, sort, skip, limit, projection }` |
| GET / PATCH / PUT / DELETE | `/collections/:name/docs/:id` | Get, update (`$set`…), replace, delete |
| GET / POST / DELETE | `/collections/:name/indexes[/:field]` | List, create (`{ field }`), drop |

Errors are JSON `{ "error": "..." }` with 400 for bad input and 404 for a
missing collection or document.

## Project layout

```
src/
  util.js        deep clone/equality, dotted paths, total value ordering
  query.js       query matcher, sort comparator, projection
  collection.js  in-memory collection: CRUD, updates, query planning
  index.js       single-field equality index (value -> _id set)
  store.js       DocStore: collections, journal + snapshot persistence
  server.js      REST API over node:http
  cli.js         docstore CLI
bin/docstore     CLI entry point
tests/           25 node:test tests (query, collection, index, store, server)
```

## Running tests

```bash
npm test   # node --test "tests/*.test.js"
```

## Tech stack

Node.js 18+ (developed on Node 24), standard library only — `node:fs`,
`node:http`, `node:crypto`, `node:test`. No npm dependencies.
