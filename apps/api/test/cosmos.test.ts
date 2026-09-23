import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { type Json, starters } from '@jev/shared';
import { type FeedOptions } from '@azure/cosmos';
import {
  CosmosConnection,
  CosmosError,
  createCosmosAdapter,
  type CosmosClientPort,
} from '../src/cosmos.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { cosmosFixture, fixtureConnectionString, fixtureQuery } from './cosmos-fixture.js';
import { setup, until, importEntries } from './helpers.js';

async function collect<T>(items: AsyncIterable<T>) {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

test('SDK adapter forwards selections and SQL, follows empty pages, and stops at the result limit', async () => {
  let documentFetches = 0;
  let disposed = false;
  const calls: unknown[] = [];
  const iterator = <T>(batches: T[][], documents = false) => {
    let index = 0;
    return {
      hasMoreResults: () => index < batches.length,
      async fetchNext() {
        if (documents) documentFetches++;
        return { resources: batches[index++] };
      },
    };
  };
  const sdk: CosmosClientPort = {
    databases: { readAll: () => iterator([[{ id: 'first' }], [], [{ id: 'workbench' }]]) },
    database(id) {
      calls.push(id);
      return {
        containers: { readAll: () => iterator([[], [{ id: 'messages' }]]) },
        container(containerId) {
          calls.push(containerId);
          return {
            items: {
              query(sql, options: FeedOptions) {
                calls.push(sql, options);
                return iterator<Json>(
                  [
                    [],
                    [{ id: 'same', nested: { yes: true } }, { id: 'same' }, 3],
                    [{ id: 'never fetched' }],
                  ],
                  true,
                );
              },
            },
          };
        },
      };
    },
    dispose() {
      disposed = true;
    },
  };
  const adapter = createCosmosAdapter(fixtureConnectionString, (value) => {
    assert.equal(value, fixtureConnectionString);
    return sdk;
  });
  const signal = new AbortController().signal;
  assert.equal(adapter.accountHost, 'fixture.documents.azure.com');
  assert.deepEqual(await adapter.databases(signal), ['first', 'workbench']);
  assert.deepEqual(await adapter.containers('workbench', signal), ['messages']);
  const query = 'SELECT c.id, c.nested FROM c WHERE c.active = true';
  assert.deepEqual(await collect(adapter.query({ ...fixtureQuery, query, limit: 2 }, signal)), [
    { id: 'same', nested: { yes: true } },
    { id: 'same' },
  ]);
  assert.equal(documentFetches, 2);
  assert.deepEqual(calls.slice(0, 4), ['workbench', 'workbench', 'messages', query]);
  assert.deepEqual(calls[4], {
    abortSignal: signal,
    maxItemCount: 2,
    bufferItems: false,
    maxDegreeOfParallelism: 1,
  });
  adapter.close();
  assert.equal(disposed, true);
});

test('SDK page requests receive the abort signal and stop when cancelled', async () => {
  const abort = new AbortController();
  const sdk: CosmosClientPort = {
    databases: {
      readAll(options) {
        assert.equal(options.abortSignal, abort.signal);
        return { hasMoreResults: () => true, fetchNext: () => new Promise(() => {}) };
      },
    },
    database() {
      throw new Error('Not used');
    },
    dispose() {},
  };
  const adapter = createCosmosAdapter(fixtureConnectionString, () => sdk);
  const pending = adapter.databases(abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  adapter.close();
});

test('connection deadlines and shutdown abort unresponsive operations without leaking SDK errors', async () => {
  const fixture = cosmosFixture();
  let received: AbortSignal | undefined;
  const adapter = {
    ...fixture.adapter,
    async databases(signal: AbortSignal): Promise<string[]> {
      received = signal;
      return new Promise(() => {});
    },
    async *query(_input: unknown, signal: AbortSignal): AsyncGenerator<Json> {
      received = signal;
      await delay(500, undefined, { signal });
      yield 1;
    },
  };
  const connection = new CosmosConnection(fixtureConnectionString, adapter, {
    requestMs: 10,
    importMs: 15,
  });
  // Keep the test process alive while the service's unref'ed deadline timer runs.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      connection.list(),
      (error: unknown) => error instanceof CosmosError && error.status === 504,
    );
    assert.equal(received?.aborted, true);
    await assert.rejects(collect(connection.records(fixtureQuery)), /timed out/);
    assert.equal(received?.aborted, true);
    const pending = connection.list();
    connection.close();
    await assert.rejects(pending, /interrupted/);
    assert.equal(fixture.isClosed(), true);
  } finally {
    connection.close();
    clearTimeout(keepAlive);
  }
});

test('Cosmos HTTP discovery, preview, snapshot, experiment and export preserve query results', async () => {
  const documents: Json[] = [
    { id: 'same', text: 'first', nested: { tags: ['a'] } },
    { id: 'same', text: 'second' },
    null,
    ['a', 2],
    7,
  ];
  const fixture = cosmosFixture(documents);
  const w = await setup(
    undefined,
    { cosmosConnectionString: fixtureConnectionString },
    fixture.adapter,
  );
  try {
    const config = await request(w.app).get('/api/config').expect(200);
    assert.equal(config.body.hasCosmosConnection, true);
    assert.equal(config.body.cosmosMaxRecords, 10000);
    assert.equal(config.body.cosmosDefaultRecords, 1000);
    assert.ok(!config.text.includes('AccountKey'));
    assert.ok(!config.text.includes('fixture-secret'));
    assert.deepEqual((await request(w.app).get('/api/cosmos/databases').expect(200)).body, [
      'workbench',
      'empty',
    ]);
    assert.deepEqual(
      (await request(w.app).get('/api/cosmos/containers?databaseId=workbench').expect(200)).body,
      ['messages'],
    );
    const preview = await request(w.app).post('/api/cosmos/preview').send(fixtureQuery).expect(200);
    assert.equal(w.store.datasets().length, 0);
    assert.equal(preview.body.records.length, 5);
    assert.deepEqual(preview.body.records.slice(2), [
      { value: null },
      { value: ['a', 2] },
      { value: 7 },
    ]);
    assert.equal(fixture.queries[0].limit, 10);
    const input = {
      ...fixtureQuery,
      name: 'Cosmos test',
      query: 'SELECT VALUE c FROM c',
      limit: 5,
    };
    const started = await request(w.app).post('/api/cosmos/import').send(input).expect(202);
    await w.importer.idle();
    const dataset = w.store.dataset(started.body.id);
    assert.equal(dataset.status, 'ready', dataset.error ?? '');
    assert.equal(dataset.recordCount, 5);
    assert.equal(dataset.origin?.query, input.query);
    assert.ok(dataset.origin?.completedAt);
    assert.equal(dataset.origin?.accountHost, 'fixture.documents.azure.com');
    assert.equal(dataset.sources[0].format, 'cosmos');
    assert.equal(dataset.sources[0].recordCount, 5);
    assert.match(dataset.warnings[0], /Additional results may exist/);
    assert.deepEqual(dataset.fields, ['id', 'nested', 'text', 'value']);
    assert.deepEqual(
      w.store.records(dataset.id, { search: '', sourceId: '' }).items.map((row) => row.data),
      preview.body.records,
    );
    assert.equal(
      dataset.bytes,
      preview.body.records.reduce(
        (sum: number, row: unknown) => sum + Buffer.byteLength(JSON.stringify(row)),
        0,
      ),
    );
    assert.ok(!(await readdir(w.config.dataDir)).includes('archives'));
    assert.ok(!JSON.stringify(dataset).includes('fixture-secret'));
    const run = await request(w.app)
      .post(`/api/datasets/${dataset.id}/runs`)
      .send({ name: 'Cosmos experiment', questions: [starters[0].question] })
      .expect(202);
    await until(
      () => w.store.run(run.body.id),
      (run) => run.status === 'completed',
    );
    const exported = await request(w.app)
      .get(`/api/runs/${run.body.id}/export?format=json`)
      .expect(200);
    assert.equal(exported.body.results.length, 5);
    assert.ok(!exported.text.includes('fixture-secret'));
    const second = await request(w.app).post('/api/cosmos/import').send(input).expect(202);
    await w.importer.idle();
    assert.notEqual(second.body.id, dataset.id);
    assert.equal(fixture.queries.length, 3);
  } finally {
    await w.cleanup();
  }
});

test('preview and import enforce independent record limits', async () => {
  const fixture = cosmosFixture(Array.from({ length: 30 }, (_, id) => ({ id })));
  const w = await setup(
    undefined,
    { cosmosConnectionString: fixtureConnectionString },
    fixture.adapter,
  );
  try {
    const preview = await request(w.app).post('/api/cosmos/preview').send(fixtureQuery).expect(200);
    assert.equal(preview.body.records.length, 10);
    assert.equal(preview.body.limitReached, true);
    const small = await request(w.app)
      .post('/api/cosmos/preview')
      .send({ ...fixtureQuery, limit: 2 })
      .expect(200);
    assert.equal(small.body.records.length, 2);
    const started = await request(w.app)
      .post('/api/cosmos/import')
      .send({ ...fixtureQuery, name: 'Limited', limit: 3 })
      .expect(202);
    await w.importer.idle();
    assert.equal(w.store.dataset(started.body.id).recordCount, 3);
  } finally {
    await w.cleanup();
  }
});

test('unconfigured or malformed credentials do not break file imports, and request contracts reject invalid input', async () => {
  for (const connection of ['', 'AccountEndpoint=not-a-url;AccountKey=secret-do-not-print;']) {
    const w = await setup(undefined, { cosmosConnectionString: connection });
    try {
      assert.equal(
        (await request(w.app).get('/api/config')).body.hasCosmosConnection,
        Boolean(connection),
      );
      const response = await request(w.app).get('/api/cosmos/databases').expect(503);
      assert.ok(!response.text.includes('secret-do-not-print'));
      await request(w.app)
        .post('/api/cosmos/import')
        .send({ ...fixtureQuery, name: 'Missing credentials' })
        .expect(503);
      assert.equal(w.store.datasets().length, 0);
      for (const input of [
        { ...fixtureQuery, limit: 10001 },
        { ...fixtureQuery, limit: 0 },
        { ...fixtureQuery, limit: 1.5 },
        { ...fixtureQuery, query: '' },
        { ...fixtureQuery, databaseId: '' },
      ])
        await request(w.app).post('/api/cosmos/preview').send(input).expect(400);
      await request(w.app).get('/api/cosmos/containers').expect(400);
      await request(w.app)
        .get('/api/cosmos/databases')
        .set('Origin', 'https://untrusted.example')
        .expect(403);
      const dataset = await importEntries(w, {
        'file.json': '[{"text":"File imports still work"}]',
      });
      assert.equal(dataset.status, 'ready');
      assert.equal(dataset.origin, null);
    } finally {
      await w.cleanup();
    }
  }
});

test('SDK errors are sanitized on every HTTP path and failed imports remove already persisted batches', async (context) => {
  const logs: unknown[][] = [];
  context.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
  for (const [code, expected] of [
    [400, 400],
    [401, 401],
    [403, 403],
    [404, 404],
    [429, 429],
    [408, 504],
    [500, 502],
  ]) {
    const fixture = cosmosFixture();
    const failure = Object.assign(new Error(`unsafe ${fixtureConnectionString}`), {
      code,
      diagnostics: fixtureConnectionString,
    });
    const adapter = {
      ...fixture.adapter,
      databases: async () => {
        throw failure;
      },
      containers: async () => {
        throw failure;
      },
      async *query() {
        for (let id = 0; id < 260; id++) yield { id };
        throw failure;
      },
    };
    const w = await setup(undefined, { cosmosConnectionString: fixtureConnectionString }, adapter);
    try {
      const databaseError = await request(w.app).get('/api/cosmos/databases').expect(expected);
      const containerError = await request(w.app)
        .get('/api/cosmos/containers?databaseId=workbench')
        .expect(expected);
      // Preview only reads ten rows; use a failing first-page adapter separately below.
      const started = await request(w.app)
        .post('/api/cosmos/import')
        .send({ ...fixtureQuery, name: 'Failure' })
        .expect(202);
      await w.importer.idle();
      const dataset = w.store.dataset(started.body.id);
      assert.equal(dataset.status, 'failed');
      assert.equal(dataset.recordCount, 0);
      assert.equal(dataset.bytes, 0);
      assert.equal(dataset.sources[0].recordCount, 0);
      assert.equal(w.store.records(dataset.id, { search: '', sourceId: '' }).total, 0);
      assert.ok(dataset.error);
      assert.ok(
        ![databaseError.text, containerError.text, JSON.stringify(dataset)]
          .join('')
          .includes('fixture-secret'),
      );
    } finally {
      await w.cleanup();
    }
  }
  const fixture = cosmosFixture();
  const adapter = {
    ...fixture.adapter,
    async *query(): AsyncGenerator<Json> {
      throw new Error(fixtureConnectionString);
    },
  };
  const w = await setup(undefined, { cosmosConnectionString: fixtureConnectionString }, adapter);
  try {
    const preview = await request(w.app).post('/api/cosmos/preview').send(fixtureQuery).expect(502);
    assert.ok(!preview.text.includes('fixture-secret'));
    assert.deepEqual(logs, []);
  } finally {
    await w.cleanup();
  }
});

test('empty queries and byte limits leave no partial snapshot', async () => {
  for (const documents of [
    [],
    [{ text: 'x'.repeat(101) }],
    Array.from({ length: 260 }, () => ({ text: 'x' })),
  ]) {
    const w = await setup(
      undefined,
      {
        cosmosConnectionString: fixtureConnectionString,
        maxUploadBytes:
          documents.length > 1 ? Buffer.byteLength(JSON.stringify(documents[0])) * 255 : 100,
      },
      cosmosFixture(documents).adapter,
    );
    try {
      const preview = await request(w.app).post('/api/cosmos/preview').send(fixtureQuery);
      assert.equal(preview.status, documents.length === 1 ? 413 : 200);
      const started = await request(w.app)
        .post('/api/cosmos/import')
        .send({ ...fixtureQuery, name: 'Empty or large' })
        .expect(202);
      await w.importer.idle();
      const dataset = w.store.dataset(started.body.id);
      assert.equal(dataset.status, 'failed');
      assert.equal(dataset.recordCount, 0);
      assert.equal(dataset.bytes, 0);
      assert.match(dataset.error!, documents.length ? /size limit/ : /Query returned no results/);
      assert.equal(w.store.records(dataset.id, { search: '', sourceId: '' }).total, 0);
    } finally {
      await w.cleanup();
    }
  }
});

test('shutdown aborts an active import, cleans partial records, and persists failure before closing SQLite', async () => {
  const fixture = cosmosFixture();
  let signal: AbortSignal | undefined;
  const w = await setup(
    undefined,
    { cosmosConnectionString: fixtureConnectionString },
    {
      ...fixture.adapter,
      async *query(_input, currentSignal) {
        signal = currentSignal;
        for (let id = 0; id < 260; id++) yield { id };
        await delay(60000, undefined, { signal: currentSignal });
        yield { id: 260 };
      },
    },
  );
  try {
    const started = await request(w.app)
      .post('/api/cosmos/import')
      .send({ ...fixtureQuery, name: 'Shutdown' })
      .expect(202);
    await until(
      () => w.store.dataset(started.body.id),
      (dataset) => dataset.recordCount >= 250,
    );
    await w.close();
    assert.equal(signal?.aborted, true);
    const reopened = new Store(w.config.dataDir);
    try {
      assert.equal(reopened.dataset(started.body.id).status, 'failed');
      assert.equal(reopened.dataset(started.body.id).recordCount, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('migration preserves old datasets; restart clears interrupted Cosmos imports and preserves completed snapshots', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-cosmos-migration-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'workbench.sqlite'));
    old.exec(`CREATE TABLE datasets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, archiveName TEXT NOT NULL, bytes INTEGER NOT NULL,
      createdAt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'importing', recordCount INTEGER NOT NULL DEFAULT 0,
      processedFiles INTEGER NOT NULL DEFAULT 0, totalFiles INTEGER NOT NULL DEFAULT 0,
      fields TEXT NOT NULL DEFAULT '[]', warnings TEXT NOT NULL DEFAULT '[]', error TEXT
    ); INSERT INTO datasets(id,name,archiveName,bytes,createdAt,status) VALUES('old','Existing','existing.json',2,'2026-01-01','ready'); PRAGMA user_version=1;`);
    old.close();
    const migrated = new Store(dir);
    assert.equal(migrated.dataset('old').name, 'Existing');
    assert.equal(migrated.dataset('old').origin, null);
    assert.equal(migrated.get('PRAGMA user_version')?.user_version, 2);
    migrated.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const w = await setup(
    undefined,
    { cosmosConnectionString: fixtureConnectionString },
    cosmosFixture().adapter,
  );
  try {
    const ids: string[] = [];
    for (const name of ['complete', 'interrupted']) {
      const started = await request(w.app)
        .post('/api/cosmos/import')
        .send({ ...fixtureQuery, name })
        .expect(202);
      await w.importer.idle();
      ids.push(started.body.id);
    }
    w.store.exec("UPDATE datasets SET status='importing' WHERE id=?", ids[1]);
    await w.close();
    const reopened = createApp({ ...w.config, cosmosConnectionString: '' });
    try {
      const saved = await request(reopened.app).get(`/api/datasets/${ids[0]}`).expect(200);
      assert.equal(saved.body.status, 'ready');
      assert.equal(saved.body.recordCount, 2);
      assert.equal(saved.body.origin.query, fixtureQuery.query);
      const records = await request(reopened.app)
        .get(`/api/datasets/${ids[0]}/records`)
        .expect(200);
      assert.equal(records.body.total, 2);
      assert.equal(
        (await request(reopened.app).get('/api/config')).body.hasCosmosConnection,
        false,
      );
      assert.equal(reopened.store.dataset(ids[1]).status, 'failed');
      assert.equal(reopened.store.dataset(ids[1]).recordCount, 0);
      assert.equal(reopened.store.dataset(ids[1]).bytes, 0);
      assert.match(reopened.store.dataset(ids[1]).error!, /Cosmos DB/);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});
