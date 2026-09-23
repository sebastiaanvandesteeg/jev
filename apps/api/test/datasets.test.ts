import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runConfigSchema, starters } from '@jev/shared';
import { createApp } from '../src/app.js';
import { answer, importEntries, setup, until } from './helpers.js';
import { cosmosFixture, fixtureConnectionString, fixtureQuery } from './cosmos-fixture.js';

const experiment = () =>
  runConfigSchema.parse({ name: 'Saved experiment', questions: [starters[0].question] });

test('rename preserves contents and history; deletion removes only its dataset and survives restart', async () => {
  const w = await setup();
  let closed = false;
  try {
    const removed = await importEntries(w, {
      'data.json': '[{"id":"same","text":"one"},{"id":"same","text":"two"}]',
    });
    const kept = await importEntries(w, { 'data.json': '[{"text":"keep me"}]' });
    const removedRun = w.runner.create(removed.id, experiment());
    const keptRun = w.runner.create(kept.id, experiment());
    await until(
      () => w.store.run(keptRun.id),
      (run) => run.status === 'completed',
    );
    await until(
      () => w.store.run(removedRun.id),
      (run) => run.status === 'completed',
    );
    const beforeRecords = w.store.records(removed.id, { search: '', sourceId: '' });
    const beforeRun = w.store.runDetail(removedRun.id);
    const renamed = await request(w.app)
      .patch(`/api/datasets/${removed.id}`)
      .send({ name: '  Renamed snapshot  ' })
      .expect(200);
    assert.deepEqual(renamed.body, { ...removed, name: 'Renamed snapshot' });
    assert.deepEqual(w.store.records(removed.id, { search: '', sourceId: '' }), beforeRecords);
    assert.deepEqual(w.store.runDetail(removedRun.id), beforeRun);
    for (const body of [
      {},
      { name: '' },
      { name: '  ' },
      { name: 123 },
      { name: 'a'.repeat(151) },
    ]) {
      await request(w.app).patch(`/api/datasets/${removed.id}`).send(body).expect(400);
    }
    assert.equal(w.store.dataset(removed.id).name, 'Renamed snapshot');
    const keptName = 'é'.repeat(150);
    await request(w.app).patch(`/api/datasets/${kept.id}`).send({ name: keptName }).expect(200);
    const keptDetail = w.store.dataset(kept.id);
    const keptHistory = w.store.runDetail(keptRun.id);
    const original = path.join(w.dir, 'original.json');
    await writeFile(original, 'outside the managed workspace');
    assert.ok(existsSync(w.importer.archive(removed.id)));
    await request(w.app).delete(`/api/datasets/${removed.id}`).expect(204);
    assert.equal(existsSync(w.importer.archive(removed.id)), false);
    assert.equal(await readFile(original, 'utf8'), 'outside the managed workspace');
    assert.deepEqual(w.store.dataset(kept.id), keptDetail);
    assert.deepEqual(w.store.runDetail(keptRun.id), keptHistory);
    assert.equal(
      w.store.get('SELECT count(*) AS n FROM run_records WHERE runId=?', removedRun.id)!.n,
      0,
    );
    for (const table of ['sources', 'records', 'runs'])
      assert.equal(
        w.store.get(`SELECT count(*) AS n FROM ${table} WHERE datasetId=?`, removed.id)!.n,
        0,
      );
    assert.deepEqual(w.store.all('PRAGMA foreign_key_check'), []);
    for (const url of [
      `/api/datasets/${removed.id}`,
      `/api/datasets/${removed.id}/records`,
      `/api/datasets/${removed.id}/runs`,
      `/api/runs/${removedRun.id}`,
      `/api/runs/${removedRun.id}/results`,
    ])
      await request(w.app).get(url).expect(404);
    await request(w.app).delete(`/api/datasets/${removed.id}`).expect(404);
    await request(w.app).patch(`/api/datasets/${removed.id}`).send({ name: 'Missing' }).expect(404);
    await w.close();
    closed = true;
    const restarted = createApp(w.config);
    try {
      await request(restarted.app).get(`/api/datasets/${removed.id}`).expect(404);
      assert.deepEqual(restarted.store.dataset(kept.id), keptDetail);
      assert.deepEqual(restarted.store.runDetail(keptRun.id), keptHistory);
      assert.equal(restarted.store.records(kept.id, { search: '', sourceId: '' }).total, 1);
    } finally {
      await restarted.close();
    }
  } finally {
    if (!closed) await w.close();
    await rm(w.dir, { recursive: true, force: true });
  }
});

for (const format of ['json', 'csv'] as const) {
  test(`deletion removes a retained direct ${format.toUpperCase()} upload`, async () => {
    const w = await setup();
    try {
      const result = await request(w.app)
        .post('/api/datasets')
        .attach(
          'file',
          Buffer.from(format === 'json' ? '[{"text":"hello"}]' : 'text\nhello\n'),
          `direct.${format}`,
        )
        .expect(202);
      await w.importer.idle();
      const archive = w.importer.archive(result.body.id, `.${format}`);
      assert.ok(existsSync(archive));
      await request(w.app).delete(`/api/datasets/${result.body.id}`).expect(204);
      assert.equal(existsSync(archive), false);
    } finally {
      await w.cleanup();
    }
  });
}

test('failed imports and imports waiting for array selection can be renamed and deleted with staging cleanup', async () => {
  const w = await setup();
  try {
    for (const [content, status] of [
      ['{"Documents":[{"id":"1"}]}', 'needs_selection'],
      ['{', 'failed'],
    ]) {
      const dataset = await importEntries(w, { 'data.json': content });
      assert.equal(dataset.status, status);
      const staging = path.join(w.config.dataDir, 'staging', dataset.id);
      if (status === 'needs_selection') assert.ok(existsSync(staging));
      await request(w.app)
        .patch(`/api/datasets/${dataset.id}`)
        .send({ name: 'New name' })
        .expect(200);
      await request(w.app).delete(`/api/datasets/${dataset.id}`).expect(204);
      assert.equal(existsSync(staging), false);
      assert.equal(existsSync(w.importer.archive(dataset.id)), false);
    }
  } finally {
    await w.cleanup();
  }
});

test('Cosmos rename and deletion affect the local snapshot without querying Azure again', async () => {
  const fake = cosmosFixture();
  const w = await setup(
    undefined,
    { cosmosConnectionString: fixtureConnectionString },
    fake.adapter,
  );
  try {
    const started = await request(w.app)
      .post('/api/cosmos/import')
      .send({ ...fixtureQuery, name: 'Snapshot' })
      .expect(202);
    await w.importer.idle();
    const snapshot = w.store.dataset(started.body.id);
    const renamed = await request(w.app)
      .patch(`/api/datasets/${snapshot.id}`)
      .send({ name: 'Azure copy' })
      .expect(200);
    assert.deepEqual(renamed.body, { ...snapshot, name: 'Azure copy' });
    await request(w.app).delete(`/api/datasets/${snapshot.id}`).expect(204);
    assert.equal(fake.queries.length, 1);
    assert.equal(w.store.get('SELECT count(*) AS n FROM records')!.n, 0);
    assert.equal(w.store.get('SELECT count(*) AS n FROM sources')!.n, 0);
  } finally {
    await w.cleanup();
  }
});

test('an active streamed import can be renamed but cannot be deleted', async () => {
  const w = await setup();
  const gate = Promise.withResolvers<void>();
  try {
    const dataset = w.importer.acceptRecords(
      'Importing',
      {
        kind: 'cosmos',
        accountHost: 'fixture.documents.azure.com',
        ...fixtureQuery,
        completedAt: null,
      },
      (async function* () {
        for (let i = 0; i < 250; i++) yield { message: String(i) };
        await gate.promise;
        yield { message: 'last' };
      })(),
    );
    await until(
      () => w.store.dataset(dataset.id),
      (d) => d.recordCount === 250,
    );
    await request(w.app)
      .patch(`/api/datasets/${dataset.id}`)
      .send({ name: 'Live rename' })
      .expect(200);
    const rejected = await request(w.app).delete(`/api/datasets/${dataset.id}`).expect(409);
    assert.match(rejected.body.error, /finish importing/);
    assert.equal(w.store.dataset(dataset.id).recordCount, 250);
    gate.resolve();
    await w.importer.idle();
    assert.equal(w.store.dataset(dataset.id).name, 'Live rename');
    await request(w.app).delete(`/api/datasets/${dataset.id}`).expect(204);
  } finally {
    gate.resolve();
    await w.cleanup();
  }
});

test('a queued experiment blocks deletion until cancelled', async () => {
  const w = await setup(undefined, { requestsPerSecond: 0.01 });
  try {
    const dataset = await importEntries(w, { 'data.json': '[{"text":"pending"}]' });
    const run = w.runner.create(dataset.id, experiment());
    assert.equal(w.store.run(run.id).status, 'queued');
    await request(w.app).delete(`/api/datasets/${dataset.id}`).expect(409);
    await request(w.app).post(`/api/runs/${run.id}/cancel`).expect(200);
    await request(w.app).delete(`/api/datasets/${dataset.id}`).expect(204);
  } finally {
    await w.cleanup();
  }
});

test('running and cancelled-but-settling requests block deletion until the worker exits', async () => {
  const gate = Promise.withResolvers<void>();
  const w = await setup({
    evaluate: async (input, signal) => {
      await gate.promise;
      signal.throwIfAborted();
      return answer(input);
    },
  });
  try {
    const dataset = await importEntries(w, { 'data.json': '[{"text":"in flight"}]' });
    const run = w.runner.create(dataset.id, experiment());
    await until(
      () => w.store.run(run.id),
      (r) => r.status === 'running',
    );
    await request(w.app).delete(`/api/datasets/${dataset.id}`).expect(409);
    await request(w.app).post(`/api/runs/${run.id}/cancel`).expect(200);
    await request(w.app).delete(`/api/datasets/${dataset.id}`).expect(409);
    assert.ok(existsSync(w.importer.archive(dataset.id)));
    gate.resolve();
    await until(
      () => w.runner.isDatasetBusy(dataset.id),
      (busy) => !busy,
    );
    await request(w.app).delete(`/api/datasets/${dataset.id}`).expect(204);
    assert.deepEqual(w.store.all('PRAGMA foreign_key_check'), []);
  } finally {
    gate.resolve();
    await w.cleanup();
  }
});
