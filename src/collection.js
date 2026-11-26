'use strict';

const { deepClone, deepEqual, getPath, setPath, deletePath, isPlainObject, newId } = require('./util');
const { matchDocument, compareDocs, projectDoc } = require('./query');

// A collection is an in-memory table of JSON documents, keyed by `_id`.
// All reads return deep clones so callers can never mutate stored state.
// Index support lives in ./index.js and is wired in by the store layer.

const UPDATE_OPERATORS = new Set(['$set', '$unset', '$inc', '$push', '$pull', '$addToSet']);

class Collection {
  constructor(name) {
    if (!name || typeof name !== 'string') {
      throw new Error('collection name must be a non-empty string');
    }
    this.name = name;
    this.docs = new Map(); // _id -> document
    this.indexes = new Map(); // field -> Index (see index.js)
  }

  /** Insert one document. Assigns a UUID `_id` when missing. */
  insert(doc) {
    if (!isPlainObject(doc)) throw new Error('document must be a plain object');
    const stored = deepClone(doc);
    if (stored._id === undefined || stored._id === null) stored._id = newId();
    if (typeof stored._id !== 'string' && typeof stored._id !== 'number') {
      throw new Error('_id must be a string or number');
    }
    if (this.docs.has(stored._id)) throw new Error(`duplicate _id ${stored._id}`);
    this.docs.set(stored._id, stored);
    for (const index of this.indexes.values()) index.add(stored);
    return deepClone(stored);
  }

  insertMany(docs) {
    if (!Array.isArray(docs)) throw new Error('insertMany requires an array');
    return docs.map((d) => this.insert(d));
  }

  /** Candidate `_id`s from equality indexes, or null when no index applies. */
  _candidateIds(filter) {
    let candidates = null;
    for (const [field, cond] of Object.entries(filter)) {
      if (field.startsWith('$')) continue;
      const index = this.indexes.get(field);
      if (!index) continue;
      let value;
      if (isPlainObject(cond) && Object.keys(cond).length === 1 && cond.$eq !== undefined) {
        value = cond.$eq;
      } else if (!isPlainObject(cond) || cond instanceof RegExp) {
        value = cond;
      } else {
        continue;
      }
      if (typeof value === 'object' && value !== null) continue;
      const ids = index.lookup(value);
      candidates = candidates === null
        ? ids
        : new Set([...candidates].filter((id) => ids.has(id)));
      if (candidates.size === 0) break;
    }
    return candidates;
  }

  find(filter = {}, options = {}) {
    const { sort, skip = 0, limit = 0, projection } = options;
    const candidates = this._candidateIds(filter);
    const pool = candidates === null
      ? this.docs.values()
      : [...candidates].map((id) => this.docs.get(id)).filter(Boolean);
    let results = [];
    for (const doc of pool) {
      if (matchDocument(doc, filter)) results.push(doc);
    }
    if (sort) results.sort((a, b) => compareDocs(a, b, sort));
    if (skip > 0) results = results.slice(skip);
    if (limit > 0) results = results.slice(0, limit);
    return results.map((d) => projectDoc(d, projection));
  }

  findOne(filter = {}, options = {}) {
    const [doc] = this.find(filter, { ...options, limit: 1 });
    return doc === undefined ? null : doc;
  }

  findById(id) {
    const doc = this.docs.get(id);
    return doc === undefined ? null : deepClone(doc);
  }

  count(filter = {}) {
    if (Object.keys(filter).length === 0) return this.docs.size;
    let n = 0;
    for (const doc of this.docs.values()) if (matchDocument(doc, filter)) n++;
    return n;
  }

  /** Apply one update document (`$set`, `$unset`, `$inc`, `$push`, `$pull`, `$addToSet`). */
  static applyUpdate(doc, update) {
    if (!isPlainObject(update)) throw new Error('update must be an object');
    for (const op of Object.keys(update)) {
      if (!UPDATE_OPERATORS.has(op)) {
        throw new Error(`unsupported update operator ${op}`);
      }
    }
    for (const [op, changes] of Object.entries(update)) {
      if (!isPlainObject(changes)) throw new Error(`${op} requires an object`);
      for (const [field, value] of Object.entries(changes)) {
        switch (op) {
          case '$set':
            setPath(doc, field, deepClone(value));
            break;
          case '$unset':
            deletePath(doc, field);
            break;
          case '$inc': {
            if (typeof value !== 'number') throw new Error('$inc value must be a number');
            const cur = getPath(doc, field);
            if (cur !== undefined && typeof cur !== 'number') {
              throw new Error(`$inc target ${field} is not a number`);
            }
            setPath(doc, field, (cur === undefined ? 0 : cur) + value);
            break;
          }
          case '$push': {
            const cur = getPath(doc, field);
            if (cur === undefined) {
              setPath(doc, field, isPlainObject(value) && value.$each !== undefined
                ? deepClone(value.$each) : [deepClone(value)]);
            } else if (Array.isArray(cur)) {
              if (isPlainObject(value) && value.$each !== undefined) {
                if (!Array.isArray(value.$each)) throw new Error('$each requires an array');
                cur.push(...deepClone(value.$each));
              } else {
                cur.push(deepClone(value));
              }
            } else {
              throw new Error(`$push target ${field} is not an array`);
            }
            break;
          }
          case '$pull': {
            const cur = getPath(doc, field);
            if (Array.isArray(cur)) {
              setPath(doc, field, cur.filter((el) => !deepEqual(el, value)));
            }
            break;
          }
          case '$addToSet': {
            const cur = getPath(doc, field);
            if (cur === undefined) {
              setPath(doc, field, [deepClone(value)]);
            } else if (Array.isArray(cur)) {
              if (!cur.some((el) => deepEqual(el, value))) cur.push(deepClone(value));
            } else {
              throw new Error(`$addToSet target ${field} is not an array`);
            }
            break;
          }
          default:
            break;
        }
      }
    }
  }

  _updateMatched(matched, update) {
    let modified = 0;
    for (const doc of matched) {
      const before = JSON.stringify(doc);
      for (const index of this.indexes.values()) index.remove(doc);
      Collection.applyUpdate(doc, update);
      for (const index of this.indexes.values()) index.add(doc);
      if (JSON.stringify(doc) !== before) modified++;
    }
    return modified;
  }

  updateOne(filter, update) {
    const doc = this.findOne(filter);
    if (!doc) return { matched: 0, modified: 0 };
    const stored = this.docs.get(doc._id);
    return { matched: 1, modified: this._updateMatched([stored], update) };
  }

  updateMany(filter, update) {
    const matched = [];
    for (const doc of this.docs.values()) {
      if (matchDocument(doc, filter)) matched.push(doc);
    }
    return { matched: matched.length, modified: this._updateMatched(matched, update) };
  }

  /** Replace a document wholesale, keeping its `_id`. */
  replaceOne(filter, replacement) {
    if (!isPlainObject(replacement)) throw new Error('replacement must be a plain object');
    const doc = this.findOne(filter);
    if (!doc) return { matched: 0, modified: 0 };
    const stored = this.docs.get(doc._id);
    const next = deepClone(replacement);
    next._id = stored._id;
    for (const index of this.indexes.values()) index.remove(stored);
    this.docs.set(stored._id, next);
    for (const index of this.indexes.values()) index.add(next);
    return { matched: 1, modified: 1 };
  }

  deleteOne(filter) {
    const doc = this.findOne(filter);
    if (!doc) return { deleted: 0 };
    const stored = this.docs.get(doc._id);
    for (const index of this.indexes.values()) index.remove(stored);
    this.docs.delete(doc._id);
    return { deleted: 1 };
  }

  deleteMany(filter = {}) {
    let deleted = 0;
    for (const doc of [...this.docs.values()]) {
      if (matchDocument(doc, filter)) {
        for (const index of this.indexes.values()) index.remove(doc);
        this.docs.delete(doc._id);
        deleted++;
      }
    }
    return { deleted };
  }

  /** Plain-object snapshot for persistence (docs + indexed fields). */
  toJSON() {
    return {
      name: this.name,
      docs: [...this.docs.values()].map((d) => deepClone(d)),
      indexes: [...this.indexes.keys()],
    };
  }

  static fromJSON(data) {
    const coll = new Collection(data.name);
    for (const doc of data.docs || []) coll.docs.set(doc._id, deepClone(doc));
    return coll;
  }
}

module.exports = { Collection };
