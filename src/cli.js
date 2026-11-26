'use strict';

const fs = require('node:fs');
const { DocStore } = require('./store');
const { createServer } = require('./server');

// docstore <dir> <command> [args...]
//
//   collections                  list collections
//   insert <coll> <json>         insert one document
//   get <coll> <id>              fetch a document by _id
//   find <coll> [filter] [--limit N] [--sort <json>] [--pretty]
//   update <coll> <id> <update-json>
//   delete <coll> <id>
//   index <coll> <field>         create an equality index
//   indexes <coll>               list indexes
//   export <coll> [file]         dump a collection as JSON lines
//   import <coll> <file>         load JSON lines into a collection
//   snapshot                     write a snapshot now
//   serve [--port 3000]          start the HTTP API (keeps the store open)

const USAGE = `Usage: docstore <dir> <command> [args...]

Commands:
  collections                      list collections
  insert <coll> <json>             insert one document
  get <coll> <id>                  fetch a document by _id
  find <coll> [filter] [--limit N] [--sort <json>] [--pretty]
  update <coll> <id> <update-json>
  delete <coll> <id>
  index <coll> <field>             create an equality index
  indexes <coll>                   list indexes
  export <coll> [file]             dump a collection as JSON lines
  import <coll> <file>             load JSON lines into a collection
  snapshot                         write a snapshot now
  serve [--port 3000]              start the HTTP API`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

function flags(args) {
  const out = { rest: [], limit: 0, sort: undefined, pretty: false, port: 3000 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') out.limit = Number(args[++i]);
    else if (args[i] === '--sort') out.sort = parseJson(args[++i], '--sort');
    else if (args[i] === '--pretty') out.pretty = true;
    else if (args[i] === '--port') out.port = Number(args[++i]);
    else out.rest.push(args[i]);
  }
  return out;
}

function print(value, pretty) {
  console.log(pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
}

function main(argv) {
  const [dir, command, ...rest] = argv;
  if (!dir || !command || command === 'help' || command === '--help') {
    console.log(USAGE);
    if (!dir || !command) process.exitCode = 1;
    return;
  }

  if (command === 'serve') {
    const opts = flags(rest);
    const store = new DocStore(dir).open();
    const server = createServer(store);
    server.listen(opts.port, () => {
      console.log(`DocStore listening on http://localhost:${opts.port} (dir: ${dir})`);
    });
    const shutdown = () => {
      server.close(() => {
        store.close();
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  const store = new DocStore(dir).open();
  try {
    switch (command) {
      case 'collections':
        print({ collections: store.listCollections() });
        break;
      case 'insert': {
        const [coll, json] = rest;
        if (!coll || !json) throw new Error('usage: insert <coll> <json>');
        print(store.insert(coll, parseJson(json, 'document')));
        break;
      }
      case 'get': {
        const [coll, id] = rest;
        if (!coll || !id) throw new Error('usage: get <coll> <id>');
        const doc = store.findById(coll, id);
        if (!doc) throw new Error(`no document ${id}`);
        print(doc);
        break;
      }
      case 'find': {
        const opts = flags(rest);
        const [coll, filterJson] = opts.rest;
        if (!coll) throw new Error('usage: find <coll> [filter] [--limit N] [--sort <json>]');
        const filter = filterJson ? parseJson(filterJson, 'filter') : {};
        print(store.find(coll, filter, { limit: opts.limit, sort: opts.sort }), opts.pretty);
        break;
      }
      case 'update': {
        const [coll, id, json] = rest;
        if (!coll || !id || !json) throw new Error('usage: update <coll> <id> <update-json>');
        const result = store.updateOne(coll, { _id: id }, parseJson(json, 'update'));
        if (result.matched === 0) throw new Error(`no document ${id}`);
        print({ ...result, doc: store.findById(coll, id) });
        break;
      }
      case 'delete': {
        const [coll, id] = rest;
        if (!coll || !id) throw new Error('usage: delete <coll> <id>');
        const result = store.deleteOne(coll, { _id: id });
        if (result.deleted === 0) throw new Error(`no document ${id}`);
        print(result);
        break;
      }
      case 'index': {
        const [coll, field] = rest;
        if (!coll || !field) throw new Error('usage: index <coll> <field>');
        print(store.createIndex(coll, field));
        break;
      }
      case 'indexes': {
        const [coll] = rest;
        if (!coll) throw new Error('usage: indexes <coll>');
        print({ indexes: store.listIndexes(coll) });
        break;
      }
      case 'export': {
        const [coll, file] = rest;
        if (!coll) throw new Error('usage: export <coll> [file]');
        const lines = store.find(coll, {}).map((d) => JSON.stringify(d)).join('\n');
        if (file) fs.writeFileSync(file, `${lines}\n`);
        else console.log(lines);
        break;
      }
      case 'import': {
        const [coll, file] = rest;
        if (!coll || !file) throw new Error('usage: import <coll> <file>');
        const docs = fs.readFileSync(file, 'utf8').split('\n')
          .filter((l) => l.trim())
          .map((l) => parseJson(l, 'import line'));
        print({ inserted: store.insertMany(coll, docs).length });
        break;
      }
      case 'snapshot':
        print(store.snapshot());
        break;
      default:
        throw new Error(`unknown command ${command}\n${USAGE}`);
    }
  } catch (err) {
    fail(err.message);
  } finally {
    store.close();
  }
}

module.exports = { main };

if (require.main === module) main(process.argv.slice(2));
