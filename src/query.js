'use strict';

const { deepClone, deepEqual, getPath, setPath, deletePath, isPlainObject, typeOf, compareValues } = require('./util');

// MongoDB-style query language, implemented from scratch:
//   { age: { $gte: 18 }, status: 'active' }        — field conditions
//   { $and: [...], $or: [...], $nor: [...], $not: {...} }
//   { 'address.city': 'Lahore' }                   — dotted paths
//   { tags: 'node' }                               — matches array membership
// Field operators: $eq $ne $gt $gte $lt $lte $in $nin $exists $regex
//                  $all $size $elemMatch $type

function isOperatorObject(condition) {
  return isPlainObject(condition)
    && Object.keys(condition).some((k) => k.startsWith('$'));
}

function compareAny(value, operand, predicate) {
  if (Array.isArray(value)) return value.some((el) => predicate(compareValues(el, operand)));
  return predicate(compareValues(value, operand));
}

function applyOperator(op, operand, value, condition) {
  switch (op) {
    case '$eq':
      return Array.isArray(value)
        ? value.some((el) => deepEqual(el, operand))
        : deepEqual(value, operand);
    case '$ne':
      return !applyOperator('$eq', operand, value, condition);
    case '$gt':
      return compareAny(value, operand, (c) => c > 0);
    case '$gte':
      return compareAny(value, operand, (c) => c >= 0);
    case '$lt':
      return compareAny(value, operand, (c) => c < 0);
    case '$lte':
      return compareAny(value, operand, (c) => c <= 0);
    case '$in': {
      if (!Array.isArray(operand)) throw new Error('$in requires an array operand');
      const haystack = Array.isArray(value) ? value : [value];
      return haystack.some((v) => operand.some((o) => deepEqual(v, o)));
    }
    case '$nin':
      return !applyOperator('$in', operand, value, condition);
    case '$exists':
      return (value !== undefined) === Boolean(operand);
    case '$regex': {
      const flags = typeof condition.$options === 'string' ? condition.$options : '';
      const re = new RegExp(operand, flags);
      const haystack = Array.isArray(value) ? value : [value];
      return haystack.some((v) => typeof v === 'string' && re.test(v));
    }
    case '$options':
      return true; // consumed by $regex
    case '$all': {
      if (!Array.isArray(value) || !Array.isArray(operand)) return false;
      return operand.every((o) => value.some((v) => deepEqual(v, o)));
    }
    case '$size':
      return Array.isArray(value) && value.length === operand;
    case '$elemMatch': {
      if (!Array.isArray(value)) return false;
      return value.some((el) => isPlainObject(el) && matchDocument(el, operand));
    }
    case '$type':
      return typeOf(value) === operand;
    default:
      throw new Error(`unsupported query operator ${op}`);
  }
}

function valueMatches(value, condition) {
  if (condition instanceof RegExp) {
    return typeof value === 'string' && condition.test(value);
  }
  if (isOperatorObject(condition)) {
    return Object.entries(condition)
      .every(([op, operand]) => applyOperator(op, operand, value, condition));
  }
  // Plain value: equality, or membership when the field holds an array.
  if (Array.isArray(value)) return value.some((el) => deepEqual(el, condition));
  return deepEqual(value, condition);
}

/** True when `doc` satisfies the query object. */
function matchDocument(doc, query) {
  if (!isPlainObject(query)) throw new Error('query must be an object');
  return Object.entries(query).every(([key, cond]) => {
    switch (key) {
      case '$and':
        if (!Array.isArray(cond)) throw new Error('$and requires an array');
        return cond.every((q) => matchDocument(doc, q));
      case '$or':
        if (!Array.isArray(cond)) throw new Error('$or requires an array');
        return cond.some((q) => matchDocument(doc, q));
      case '$nor':
        if (!Array.isArray(cond)) throw new Error('$nor requires an array');
        return !cond.some((q) => matchDocument(doc, q));
      case '$not':
        return !matchDocument(doc, cond);
      default:
        if (key.startsWith('$')) throw new Error(`unsupported top-level operator ${key}`);
        return valueMatches(getPath(doc, key), cond);
    }
  });
}

/**
 * Compare two docs against a sort spec like `{ age: -1, name: 1 }`.
 * Ties break on `_id` so pagination order is stable.
 */
function compareDocs(a, b, sort) {
  for (const [field, dir] of Object.entries(sort)) {
    const c = compareValues(getPath(a, field), getPath(b, field));
    if (c !== 0) return dir < 0 ? -c : c;
  }
  return compareValues(a._id, b._id);
}

/**
 * Apply a MongoDB-style projection. Inclusion mode (`{ name: 1 }`) keeps
 * `_id` unless explicitly excluded; exclusion mode (`{ secret: 0 }`)
 * removes the listed fields. Mixing modes (other than `_id: 0`) is an error.
 */
function projectDoc(doc, projection) {
  if (!projection) return deepClone(doc);
  const entries = Object.entries(projection);
  const hasInclude = entries.some(([, v]) => v === 1 || v === true);
  const hasExclude = entries.some(([, v]) => v === 0 || v === false);
  if (hasInclude && hasExclude) {
    const bad = entries.filter(([k, v]) => (v === 0 || v === false) && k !== '_id');
    if (bad.length > 0) throw new Error('cannot mix inclusion and exclusion in projection');
  }
  if (hasInclude) {
    const out = {};
    if (projection._id !== 0 && doc._id !== undefined) out._id = deepClone(doc._id);
    for (const [field, v] of entries) {
      if (field === '_id' || !(v === 1 || v === true)) continue;
      const value = getPath(doc, field);
      if (value !== undefined) setPath(out, field, deepClone(value));
    }
    return out;
  }
  const out = deepClone(doc);
  for (const [field, v] of entries) {
    if (v === 0 || v === false) deletePath(out, field);
  }
  return out;
}

module.exports = { matchDocument, compareDocs, projectDoc, isOperatorObject };
