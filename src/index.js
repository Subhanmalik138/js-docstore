'use strict';

const { getPath } = require('./util');

// A single-field equality index: value -> set of `_id`s.
// Array field values are indexed per element, so `{ tags: 'node' }` can
// use an index on `tags`. `undefined` (missing field) is never indexed.
// Keys are JSON strings, which makes equality exact for JSON values.

class Index {
  constructor(field) {
    if (!field || typeof field !== 'string') {
      throw new Error('index field must be a non-empty string');
    }
    this.field = field;
    this.map = new Map(); // key -> Set<_id>
  }

  static keyOf(value) {
    return JSON.stringify(value);
  }

  add(doc) {
    const value = getPath(doc, this.field);
    if (value === undefined) return;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const key = Index.keyOf(v);
      let ids = this.map.get(key);
      if (!ids) {
        ids = new Set();
        this.map.set(key, ids);
      }
      ids.add(doc._id);
    }
  }

  remove(doc) {
    const value = getPath(doc, this.field);
    if (value === undefined) return;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const key = Index.keyOf(v);
      const ids = this.map.get(key);
      if (!ids) continue;
      ids.delete(doc._id);
      if (ids.size === 0) this.map.delete(key);
    }
  }

  /** `_id`s whose indexed value equals `value` (empty set when none). */
  lookup(value) {
    if (value === undefined || value === null) return new Set();
    if (typeof value === 'object') return new Set();
    const ids = this.map.get(Index.keyOf(value));
    return ids === undefined ? new Set() : new Set(ids);
  }

  /** Number of distinct indexed values. */
  get size() {
    return this.map.size;
  }
}

module.exports = { Index };
