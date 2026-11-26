'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Collection } = require('./collection');

// DocStore — a directory-backed database of collections.
//
// Durability model (deliberately simple, crash-safe by construction):
//   * every mutation appends one JSON line to `journal.jsonl` *before*
//     it is applied in memory, so a crash loses nothing already returned;
//   * `snapshot()` writes the full state to `snapshot.json` (temp file +
//     atomic rename) and truncates the journal;
//   * on open, the snapshot loads first, then the journal replays on top.
// A torn final journal line (crash mid-write) is skipped, not fatal.

class DocStore {
  constructor(dir) {
    if (!dir || typeof dir !== 'string') throw new Error('store dir is required');
    this.dir = dir;
    this.snapshotPath = path.join(dir, 'snapshot.json');
    this.journalPath = path.join(dir, 'journal.jsonl');
    this.collections = new Map(); // name -> Collection
    this._journalFd = null;
  }

  open() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.snapshotPath)) this._loadSnapshot();
    if (fs.existsSync(this.journalPath)) this._replayJournal();
    this._journalFd = fs.openSync(this.journalPath, 'a');
    return this;
  }

  _loadSnapshot() {
    const data = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
    for (const collData of data.collections || []) {
      const coll = Collection.fromJSON(collData);
      this.collections.set(coll.name, coll);
      for (const field of collData.indexes || []) coll.createIndex(field);
    }
  }

  _replayJournal() {
    const text = fs.readFileSync(this.journalPath, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        break; // torn tail from a crash mid-write: stop here, keep the rest
      }
      this._apply(entry, false);
    }
  }

  _append(entry) {
    fs.writeSync(this._journalFd, `${JSON.stringify(entry)}\n`);
  }

  /** Apply one journal entry; `journal` controls whether it is recorded. */
  _apply(entry, journal = true) {
    if (journal) this._append(entry);
    switch (entry.op) {
      case 'createCollection': {
        if (!this.collections.has(entry.name)) {
          this.collections.set(entry.name, new Collection(entry.name));
        }
        break;
      }
      case 'dropCollection':
        this.collections.delete(entry.name);
        break;
      case 'insert':
        this._coll(entry.coll).insert(entry.doc);
        break;
      case 'update': {
        const coll = this._coll(entry.coll);
        if (entry.many) coll.updateMany(entry.filter, entry.update);
        else coll.updateOne(entry.filter, entry.update);
        break;
      }
      case 'replace':
        this._coll(entry.coll).replaceOne(entry.filter, entry.doc);
        break;
      case 'delete': {
        const coll = this._coll(entry.coll);
        if (entry.many) coll.deleteMany(entry.filter);
        else coll.deleteOne(entry.filter);
        break;
      }
      case 'createIndex':
        this._coll(entry.coll).createIndex(entry.field);
        break;
      case 'dropIndex':
        this._coll(entry.coll).dropIndex(entry.field);
        break;
      default:
        throw new Error(`unknown journal op ${entry.op}`);
    }
  }

  _coll(name) {
    const coll = this.collections.get(name);
    if (!coll) throw new Error(`no such collection: ${name}`);
    return coll;
  }

  createCollection(name) {
    if (this.collections.has(name)) throw new Error(`collection already exists: ${name}`);
    this._apply({ op: 'createCollection', name });
    return this.collections.get(name);
  }

  /** Get a collection, creating it on first use. */
  collection(name) {
    if (!this.collections.has(name)) this.createCollection(name);
    return this.collections.get(name);
  }

  dropCollection(name) {
    if (!this.collections.has(name)) throw new Error(`no such collection: ${name}`);
    this._apply({ op: 'dropCollection', name });
    return { dropped: true, name };
  }

  listCollections() {
    return [...this.collections.keys()].sort();
  }

  insert(coll, doc) {
    const inserted = this._coll(coll).insert(doc);
    this._append({ op: 'insert', coll, doc: inserted });
    return inserted;
  }

  insertMany(coll, docs) {
    return docs.map((d) => this.insert(coll, d));
  }

  find(coll, filter = {}, options = {}) {
    return this._coll(coll).find(filter, options);
  }

  findOne(coll, filter = {}, options = {}) {
    return this._coll(coll).findOne(filter, options);
  }

  findById(coll, id) {
    return this._coll(coll).findById(id);
  }

  count(coll, filter = {}) {
    return this._coll(coll).count(filter);
  }

  updateOne(coll, filter, update) {
    const result = this._coll(coll).updateOne(filter, update);
    if (result.matched > 0) this._append({ op: 'update', coll, filter, update, many: false });
    return result;
  }

  updateMany(coll, filter, update) {
    const result = this._coll(coll).updateMany(filter, update);
    if (result.matched > 0) this._append({ op: 'update', coll, filter, update, many: true });
    return result;
  }

  replaceOne(coll, filter, doc) {
    const result = this._coll(coll).replaceOne(filter, doc);
    if (result.matched > 0) this._append({ op: 'replace', coll, filter, doc });
    return result;
  }

  deleteOne(coll, filter) {
    const result = this._coll(coll).deleteOne(filter);
    if (result.deleted > 0) this._append({ op: 'delete', coll, filter, many: false });
    return result;
  }

  deleteMany(coll, filter = {}) {
    const result = this._coll(coll).deleteMany(filter);
    if (result.deleted > 0) this._append({ op: 'delete', coll, filter, many: true });
    return result;
  }

  createIndex(coll, field) {
    const result = this._coll(coll).createIndex(field);
    if (result.created) this._append({ op: 'createIndex', coll, field });
    return result;
  }

  dropIndex(coll, field) {
    const result = this._coll(coll).dropIndex(field);
    if (result.dropped) this._append({ op: 'dropIndex', coll, field });
    return result;
  }

  listIndexes(coll) {
    return this._coll(coll).listIndexes();
  }

  /** Write a full snapshot and truncate the journal. Safe to call anytime. */
  snapshot() {
    const data = {
      version: 1,
      collections: [...this.collections.values()].map((c) => c.toJSON()),
    };
    const tmp = `${this.snapshotPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, this.snapshotPath);
    fs.ftruncateSync(this._journalFd, 0);
    return { collections: data.collections.length };
  }

  /** Snapshot and release the journal handle. */
  close() {
    if (this._journalFd === null) return;
    try {
      this.snapshot();
    } finally {
      fs.closeSync(this._journalFd);
      this._journalFd = null;
    }
  }
}

module.exports = { DocStore };
