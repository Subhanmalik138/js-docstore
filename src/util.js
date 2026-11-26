'use strict';

const crypto = require('node:crypto');

/** True for plain `{}` objects only — not arrays, null, class instances. */
function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** JSON-safe deep clone. Documents are JSON by definition, so this is exact. */
function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** Order-insensitive deep equality for JSON values. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k)
      && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Read a dotted path (`address.city`, `tags.0`) from a document. */
function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Write a dotted path, creating intermediate objects as needed. */
function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** Delete a dotted path. Missing intermediate objects are a no-op. */
function deletePath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
}

function newId() {
  return crypto.randomUUID();
}

// Total order used for comparisons and sorting: missing < null < number
// < string < boolean < object < array. Keeps sort deterministic even for
// mixed-type fields.
const TYPE_ORDER = ['missing', 'null', 'number', 'string', 'boolean', 'object', 'array'];

function typeOf(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function compareValues(a, b) {
  const ta = TYPE_ORDER.indexOf(typeOf(a));
  const tb = TYPE_ORDER.indexOf(typeOf(b));
  if (ta !== tb) return ta - tb;
  if (typeof a === 'number') return a - b;
  if (typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return 0;
}

module.exports = {
  isPlainObject,
  deepClone,
  deepEqual,
  getPath,
  setPath,
  deletePath,
  newId,
  typeOf,
  compareValues,
};
