import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { importEntries, setup } from './helpers.js';
import { validateEntry } from '../src/importer.js';

test('mixed archive preserves nested JSON, duplicate document IDs, CSV quoting, text and source positions', async () => {
  const w = await setup();
  try {
    const d = await importEntries(w, {
      'nested/data.json': JSON.stringify([
        { id: 'same', nested: { list: [1, true, null, { text: 'hello' }] } },
        { id: 'same', text: 'different' },
      ]),
      'extra.jsonl': '{"id":"0007"}\n\n{"flag":true}\n',
      'rows.csv': 'id,message\n0012,"Hello, world"\n0013,"two\nlines"\n',
      'notes/readme.txt': 'A plain text record',
      'ignored.bin': 'skip',
    });
    assert.equal(d.status, 'ready');
    assert.equal(d.recordCount, 7);
    assert.equal(d.sources.length, 4);
    assert.equal(d.warnings.length, 1);
    const records = w.store.records(d.id, { sourceId: '', search: '' }, 1, 100).items;
    assert.equal(new Set(records.map((r) => r.id)).size, 7);
    const json = records.filter((r) => r.sourcePath === 'nested/data.json');
    assert.deepEqual(json[0].data.nested, { list: [1, true, null, { text: 'hello' }] });
    assert.deepEqual(
      json.map((r) => r.position),
      [1, 2],
    );
    assert.equal(records.find((r) => r.sourcePath === 'rows.csv')?.data.id, '0012');
    assert.equal(
      records.find((r) => r.sourcePath === 'rows.csv' && r.position === 2)?.data.message,
      'two\nlines',
    );
    assert.equal(
      records.find((r) => r.sourcePath.endsWith('.txt'))?.data.text,
      'A plain text record',
    );
    assert.ok((await stat(w.importer.archive(d.id))).size > 0);
    const second = w.store.records(d.id, { sourceId: '', search: '' }, 2, 2);
    assert.equal(second.items.length, 2);
    assert.equal(second.total, 7);
    assert.equal(w.store.records(d.id, { sourceId: '', search: 'different' }).total, 1);
  } finally {
    await w.cleanup();
  }
});
test('wrapper arrays require an explicit JSON Pointer selection; dotted and slash keys are safe', async () => {
  const w = await setup();
  try {
    const d = await importEntries(w, {
      'export.json': JSON.stringify({
        'meta.v1': { 'doc/list': [{ id: '1', items: [1, 2] }, { id: '2' }] },
        total: 2,
      }),
    });
    assert.equal(d.status, 'needs_selection');
    assert.deepEqual(d.sources[0].arrayPaths, ['/meta.v1/doc~1list']);
    assert.throws(
      () => w.importer.continue(d.id, { [d.sources[0].id]: '/absent' }),
      /Invalid array/,
    );
    w.importer.continue(d.id, { [d.sources[0].id]: '/meta.v1/doc~1list' });
    await w.importer.idle();
    assert.equal(w.store.dataset(d.id).recordCount, 2);
    assert.deepEqual(
      w.store.records(d.id, { sourceId: '', search: '' }).items[0].data.items,
      [1, 2],
    );
  } finally {
    await w.cleanup();
  }
});
test('complete objects, scalar arrays and prototype-shaped keys preserve their values', async () => {
  const w = await setup();
  try {
    const d = await importEntries(w, {
      'object.json': '{"id":7,"tags":["one"],"__proto__":{"safe":true}}',
      'values.json': '[null,true,3,"hello",[1,2]]',
    });
    assert.equal(d.status, 'needs_selection');
    const source = d.sources.find((s) => s.needsSelection)!;
    w.importer.continue(d.id, { [source.id]: null });
    await w.importer.idle();
    const rows = w.store.records(d.id, { sourceId: '', search: '' }).items;
    assert.equal(rows.length, 6);
    assert.deepEqual(rows.find((r) => r.sourcePath === 'object.json')?.data.__proto__, {
      safe: true,
    });
    assert.deepEqual(
      rows.filter((r) => r.sourcePath === 'values.json').map((r) => r.data.value),
      [null, true, 3, 'hello', [1, 2]],
    );
    assert.equal(({} as Record<string, unknown>).safe, undefined);
  } finally {
    await w.cleanup();
  }
});
test('a malformed file rolls back every normalized record with a source location', async () => {
  const w = await setup();
  try {
    const d = await importEntries(w, {
      'a.jsonl': Array.from({ length: 300 }, (_, i) => JSON.stringify({ i })).join('\n'),
      'b.jsonl': '{"ok":true}\nthis is invalid',
    });
    assert.equal(d.status, 'failed');
    assert.equal(d.recordCount, 0);
    assert.match(d.error!, /b.jsonl.*line 2/);
    assert.equal(w.store.get('SELECT count(*) AS n FROM records WHERE datasetId=?', d.id)!.n, 0);
  } finally {
    await w.cleanup();
  }
});
test('malformed JSON, invalid UTF-8, empty archives and mismatched CSV are rejected', async () => {
  const w = await setup();
  try {
    for (const entries of [
      { 'bad.json': '[{"id": 1},' },
      { 'bad.txt': Buffer.from([0xc3, 0x28]) },
      {},
      { 'bad.csv': 'a,b\n1,2,3' },
      { 'duplicate.csv': 'id,id\n1,2' },
      { 'deep.json': '['.repeat(260) + '1' + ']'.repeat(260) },
    ]) {
      const d = await importEntries(w, entries);
      assert.equal(d.status, 'failed');
      assert.ok(d.error);
    }
  } finally {
    await w.cleanup();
  }
});
test('archive entry policy rejects traversal, absolute paths, symlinks and encryption', () => {
  const base = { fileName: 'data.json', generalPurposeBitFlag: 0, externalFileAttributes: 0 };
  for (const fileName of ['../data.json', '/data.json', 'C:/data.json', 'a\\..\\data.json'])
    assert.throws(() => validateEntry({ ...base, fileName }), /Unsafe/);
  assert.throws(() => validateEntry({ ...base, generalPurposeBitFlag: 1 }), /Encrypted/);
  assert.throws(
    () => validateEntry({ ...base, externalFileAttributes: 0o120777 << 16 }),
    /Symbolic/,
  );
});
test('expanded size and entry count limits fail before normalization', async () => {
  const small = await setup(undefined, { maxExpandedBytes: 50 });
  try {
    const d = await importEntries(small, { 'large.txt': 'x'.repeat(1000) });
    assert.equal(d.status, 'failed');
    assert.match(d.error!, /Expanded/);
  } finally {
    await small.cleanup();
  }
  const few = await setup(undefined, { maxFiles: 1 });
  try {
    const d = await importEntries(few, { 'a.txt': 'a', 'b.txt': 'b' });
    assert.equal(d.status, 'failed');
    assert.match(d.error!, /entries/);
  } finally {
    await few.cleanup();
  }
});
