import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { readFile, readdir, stat } from 'node:fs/promises';
import { runConfigSchema, starters } from '@jev/shared';
import { csvCell } from '../src/app.js';
import { setup, until, zipFile } from './helpers.js';

test('HTTP upload → preview → run → results → export uses validated contracts', async () => {
  const w = await setup();
  try {
    const file = await zipFile(w.dir, {
      'data.json': '[{"id":"001","text":"hello"},{"id":"002","text":"world"}]',
    });
    const uploaded = await request(w.app)
      .post('/api/datasets')
      .field('name', 'API test')
      .attach('file', file)
      .expect(202);
    await w.importer.idle();
    const id = uploaded.body.id;
    assert.equal((await request(w.app).get(`/api/datasets/${id}`).expect(200)).body.recordCount, 2);
    const records = await request(w.app)
      .get(`/api/datasets/${id}/records?page=2&pageSize=1`)
      .expect(200);
    assert.equal(records.body.items[0].data.id, '002');
    await request(w.app).get(`/api/datasets/${id}/records?page=-1`).expect(400);
    const config = runConfigSchema.parse({
      name: 'HTTP run',
      questions: starters.map((s) => s.question),
      fields: ['text'],
    });
    const preview = await request(w.app)
      .post(`/api/datasets/${id}/preview`)
      .send(config)
      .expect(200);
    assert.equal(preview.body.count, 2);
    assert.deepEqual(preview.body.request.state.record, { text: 'hello' });
    await request(w.app)
      .post(`/api/datasets/${id}/runs`)
      .send({ ...config, questions: [] })
      .expect(400);
    const started = await request(w.app).post(`/api/datasets/${id}/runs`).send(config).expect(202);
    await until(
      () => w.store.run(started.body.id),
      (r) => r.status === 'completed',
    );
    const runId = started.body.id;
    const results = await request(w.app)
      .get(`/api/runs/${runId}/results?question=needs_attention&minimum=0.9`)
      .expect(200);
    assert.equal(results.body.total, 0);
    const json = await request(w.app).get(`/api/runs/${runId}/export?format=json`).expect(200);
    assert.equal(json.body.results.length, 2);
    assert.equal(json.body.run.config.name, 'HTTP run');
    const csv = await request(w.app).get(`/api/runs/${runId}/export?format=csv`).expect(200);
    assert.match(csv.text, /category.value/);
    assert.match(csv.text, /jev-test-pinned/);
    const history = await request(w.app).get(`/api/datasets/${id}/runs`).expect(200);
    assert.equal(history.body.length, 1);
    await request(w.app).post(`/api/runs/${runId}/resume`).send({}).expect(409);
    await request(w.app).get('/api/datasets/missing').expect(404);
    await request(w.app).get('/api/config').set('Origin', 'https://untrusted.example').expect(403);
    assert.ok((await stat(w.importer.archive(id))).size);
  } finally {
    await w.cleanup();
  }
});
test('upload limits and missing files return useful HTTP errors', async () => {
  const w = await setup(undefined, { maxUploadBytes: 100 });
  try {
    await request(w.app).post('/api/datasets').expect(400);
    const file = await zipFile(w.dir, { 'a.txt': 'A'.repeat(1000) }, { compress: false });
    const response = await request(w.app).post('/api/datasets').attach('file', file).expect(400);
    assert.match(response.body.error, /no larger/);
  } finally {
    await w.cleanup();
  }
});
test('CSV exports quote fields and neutralize spreadsheet formulas', () => {
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"');
  assert.equal(csvCell(0.8), '"0.8"');
});

test('direct JSON and CSV uploads retain original files and normalize into usable datasets', async () => {
  const w = await setup();
  try {
    const fixtures = [
      {
        filename: 'documents.JSON',
        extension: '.json',
        content: '[{"id":"001","nested":{"active":true}},{"id":"002","nested":{"active":false}}]',
        expected: { id: '001', nested: { active: true } },
      },
      {
        filename: 'contacts.csv',
        extension: '.csv',
        content: 'id,message\n001,"Hello, world"\n002,"Second\nline"\n',
        expected: { id: '001', message: 'Hello, world' },
      },
    ];
    for (const fixture of fixtures) {
      const response = await request(w.app)
        .post('/api/datasets')
        .attach('file', Buffer.from(fixture.content), {
          filename: fixture.filename,
          contentType: 'application/octet-stream',
        })
        .expect(202);
      await w.importer.idle();
      const d = w.store.dataset(response.body.id);
      assert.equal(d.status, 'ready', d.error || 'Import did not finish');
      assert.equal(d.name, fixture.filename.slice(0, -fixture.extension.length));
      assert.equal(d.archiveName, fixture.filename);
      assert.equal(d.recordCount, 2);
      assert.equal(d.sources.length, 1);
      assert.equal(d.sources[0].path, fixture.filename);
      const records = await request(w.app).get(`/api/datasets/${d.id}/records`).expect(200);
      assert.deepEqual(records.body.items[0].data, fixture.expected);
      assert.deepEqual(
        records.body.items.map((r: { position: number }) => r.position),
        [1, 2],
      );
      assert.equal(
        await readFile(w.importer.archive(d.id, fixture.extension), 'utf8'),
        fixture.content,
      );
      const run = await request(w.app)
        .post(`/api/datasets/${d.id}/runs`)
        .send({ name: 'Direct upload experiment', questions: [starters[0].question] })
        .expect(202);
      await until(
        () => w.store.run(run.body.id),
        (r) => r.status === 'completed',
      );
      assert.equal(w.store.run(run.body.id).succeeded, 2);
    }
  } finally {
    await w.cleanup();
  }
});

test('direct wrapper JSON supports explicit array selection and standalone JSON objects', async () => {
  const w = await setup();
  try {
    const response = await request(w.app)
      .post('/api/datasets')
      .attach('file', Buffer.from('{"Documents":[{"id":1},{"id":2}],"count":2}'), 'export.json')
      .expect(202);
    await w.importer.idle();
    const d = w.store.dataset(response.body.id);
    assert.equal(d.status, 'needs_selection');
    await request(w.app)
      .post(`/api/datasets/${d.id}/import`)
      .send({ selections: { [d.sources[0].id]: '/Documents' } })
      .expect(202);
    await w.importer.idle();
    assert.equal(w.store.dataset(d.id).recordCount, 2);
    const single = await request(w.app)
      .post('/api/datasets')
      .field('name', 'Single document')
      .attach('file', Buffer.from('{"id":"one","text":"A single document"}'), 'single.json')
      .expect(202);
    await w.importer.idle();
    assert.equal(w.store.dataset(single.body.id).name, 'Single document');
    assert.equal(w.store.dataset(single.body.id).recordCount, 1);
  } finally {
    await w.cleanup();
  }
});

test('direct imports reject unsupported extensions, malformed data and invalid encoding', async () => {
  const w = await setup();
  try {
    await request(w.app)
      .post('/api/datasets')
      .attach('file', Buffer.from('hello'), 'unsupported.txt')
      .expect(400);
    assert.equal(w.store.datasets().length, 0);
    assert.deepEqual(await readdir(`${w.config.dataDir}/uploads`), []);
    for (const [filename, content] of [
      ['bad.json', Buffer.from('[{"id":')],
      ['bad.csv', Buffer.from('id,text\n1,hello,extra')],
      ['encoding.csv', Buffer.from([0xc3, 0x28])],
    ] as const) {
      const response = await request(w.app)
        .post('/api/datasets')
        .attach('file', content, filename)
        .expect(202);
      await w.importer.idle();
      const d = w.store.dataset(response.body.id);
      assert.equal(d.status, 'failed');
      assert.equal(d.recordCount, 0);
      assert.ok(d.error?.includes(filename));
    }
  } finally {
    await w.cleanup();
  }
});

test('the multipart upload size limit also applies to direct JSON and CSV', async () => {
  const w = await setup(undefined, { maxUploadBytes: 100 });
  try {
    for (const filename of ['large.json', 'large.csv']) {
      const response = await request(w.app)
        .post('/api/datasets')
        .attach('file', Buffer.from('x'.repeat(101)), filename)
        .expect(400);
      assert.match(response.body.error, /Uploaded files must be no larger/);
    }
    assert.equal(w.store.datasets().length, 0);
  } finally {
    await w.cleanup();
  }
});
