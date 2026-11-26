'use strict';

const http = require('node:http');

// Minimal REST API over a DocStore — zero dependencies, Node's http only.
//
//   GET    /health
//   GET    /collections
//   POST   /collections                     { name }
//   DELETE /collections/:name
//   GET    /collections/:name/docs?filter=&sort=&skip=&limit=&projection=
//   POST   /collections/:name/docs          { ...doc } | { docs: [...] }
//   POST   /collections/:name/query         { filter, sort, skip, limit, projection }
//   GET    /collections/:name/docs/:id
//   PATCH  /collections/:name/docs/:id      { $set: {...}, ... }
//   PUT    /collections/:name/docs/:id      { ...replacement }
//   DELETE /collections/:name/docs/:id
//   GET    /collections/:name/indexes
//   POST   /collections/:name/indexes       { field }
//   DELETE /collections/:name/indexes/:field
//
// Query-string values for filter/sort/projection are JSON-encoded.

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseJsonParam(value, name) {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`query parameter ${name} is not valid JSON`);
  }
}

function createServer(store) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method;

      if (method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok', collections: store.listCollections().length });
      }

      if (parts[0] === 'collections' && parts.length === 1) {
        if (method === 'GET') return send(res, 200, { collections: store.listCollections() });
        if (method === 'POST') {
          const body = await readBody(req);
          if (!body.name) throw new Error('name is required');
          store.createCollection(body.name);
          return send(res, 201, { created: true, name: body.name });
        }
      }

      if (parts[0] === 'collections' && parts.length >= 2) {
        const name = decodeURIComponent(parts[1]);
        if (parts.length === 2 && method === 'DELETE') {
          return send(res, 200, store.dropCollection(name));
        }

        // /collections/:name/indexes
        if (parts[2] === 'indexes') {
          if (method === 'GET' && parts.length === 3) {
            return send(res, 200, { indexes: store.listIndexes(name) });
          }
          if (method === 'POST' && parts.length === 3) {
            const body = await readBody(req);
            if (!body.field) throw new Error('field is required');
            return send(res, 201, store.createIndex(name, body.field));
          }
          if (method === 'DELETE' && parts.length === 4) {
            return send(res, 200, store.dropIndex(name, decodeURIComponent(parts[3])));
          }
        }

        // /collections/:name/query
        if (parts[2] === 'query' && method === 'POST' && parts.length === 3) {
          const body = await readBody(req);
          const docs = store.find(name, body.filter || {}, {
            sort: body.sort,
            skip: body.skip,
            limit: body.limit,
            projection: body.projection,
          });
          return send(res, 200, { docs, count: docs.length });
        }

        // /collections/:name/docs[/:id]
        if (parts[2] === 'docs') {
          if (parts.length === 3) {
            if (method === 'GET') {
              const docs = store.find(name, parseJsonParam(url.searchParams.get('filter'), 'filter') || {}, {
                sort: parseJsonParam(url.searchParams.get('sort'), 'sort'),
                skip: Number(url.searchParams.get('skip') || 0),
                limit: Number(url.searchParams.get('limit') || 0),
                projection: parseJsonParam(url.searchParams.get('projection'), 'projection'),
              });
              return send(res, 200, { docs, count: docs.length });
            }
            if (method === 'POST') {
              const body = await readBody(req);
              if (Array.isArray(body.docs)) {
                const docs = store.insertMany(name, body.docs);
                return send(res, 201, { docs, count: docs.length });
              }
              return send(res, 201, store.insert(name, body));
            }
          }
          if (parts.length === 4) {
            const id = decodeURIComponent(parts[3]);
            if (method === 'GET') {
              const doc = store.findById(name, id);
              if (!doc) return send(res, 404, { error: `no document ${id}` });
              return send(res, 200, doc);
            }
            if (method === 'PATCH') {
              const body = await readBody(req);
              const result = store.updateOne(name, { _id: id }, body);
              if (result.matched === 0) return send(res, 404, { error: `no document ${id}` });
              return send(res, 200, { ...result, doc: store.findById(name, id) });
            }
            if (method === 'PUT') {
              const body = await readBody(req);
              const result = store.replaceOne(name, { _id: id }, body);
              if (result.matched === 0) return send(res, 404, { error: `no document ${id}` });
              return send(res, 200, { ...result, doc: store.findById(name, id) });
            }
            if (method === 'DELETE') {
              const result = store.deleteOne(name, { _id: id });
              if (result.deleted === 0) return send(res, 404, { error: `no document ${id}` });
              return send(res, 200, result);
            }
          }
        }
      }

      return send(res, 404, { error: `no route ${method} ${url.pathname}` });
    } catch (err) {
      const status = err.message.startsWith('no such collection') ? 404 : 400;
      return send(res, status, { error: err.message });
    }
  });
  return server;
}

module.exports = { createServer };
