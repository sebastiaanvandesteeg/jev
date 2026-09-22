import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { runConfigSchema, starters, type RequestPreview } from '@jev/shared';
import { createApp } from '../src/app.js';
import { createProvider } from '../src/provider.js';
import { answer, importEntries, setup, until } from './helpers.js';

const config = (extra: object = {}) =>
  runConfigSchema.parse({
    name: 'Example run',
    questions: starters.map((s) => s.question),
    ...extra,
  });
test('all primitives use projected records, persist inputs and results, and aggregate without new calls', async () => {
  const seen: RequestPreview[] = [];
  const w = await setup({
    evaluate: async (request) => {
      seen.push(request);
      return answer(request);
    },
  });
  try {
    const d = await importEntries(w, {
      'records.json': JSON.stringify(
        Array.from({ length: 12 }, (_, i) => ({ id: i, text: `Message ${i}`, ignored: 'private' })),
      ),
    });
    const c = config({ fields: ['text'], context: 'Account access' });
    const run = w.runner.create(d.id, c);
    // Caller mutations must not alter the durable snapshot.
    c.context = 'changed later';
    const finished = await until(
      () => w.store.run(run.id),
      (r) => r.status === 'completed',
    );
    assert.equal(finished.total, 10);
    assert.equal(seen.length, 10);
    assert.equal(finished.inputTokens, 1230);
    assert.equal(seen[0].state.context, 'Account access');
    assert.deepEqual(Object.keys(seen[0].state.record), ['text']);
    assert.equal(Object.keys(seen[0].questions).length, 3);
    const details = w.store.runDetail(run.id);
    assert.deepEqual(details.models, ['jev-test-pinned']);
    assert.ok(Math.abs(details.summaries[1].average! - 0.8) < 1e-12);
    const results = w.store.results(run.id);
    assert.equal(results.total, 10);
    assert.equal(new Set(results.items.map((r) => r.recordId)).size, 10);
    assert.equal(w.store.results(run.id, { question: 'needs_attention', minimum: 0.9 }).total, 0);
    assert.equal(
      w.store.results(run.id, { question: 'category', category: 'request', confidence: 0.9 }).total,
      10,
    );
    assert.equal(seen.length, 10);
  } finally {
    await w.cleanup();
  }
});
test('filters and explicit selections cannot reach records outside the dataset', async () => {
  const w = await setup();
  try {
    const d = await importEntries(w, { 'a.json': '[{"text":"keep"},{"text":"other"}]' });
    const other = await importEntries(w, { 'b.json': '[{"text":"foreign"}]' });
    const foreignId = w.store.records(other.id, { sourceId: '', search: '' }).items[0].id;
    assert.throws(
      () => w.runner.create(d.id, config({ selection: { mode: 'selected', ids: [foreignId] } })),
      /outside/,
    );
    const run = w.runner.create(
      d.id,
      config({ filter: { search: 'keep' }, selection: { mode: 'all' } }),
    );
    assert.equal(run.total, 1);
    await until(
      () => w.store.run(run.id),
      (r) => r.status === 'completed',
    );
    assert.throws(() => w.runner.create(d.id, config({ fields: [] })), /at least one/);
    assert.throws(() => w.runner.create(d.id, config({ fields: ['missing'] })), /does not exist/);
  } finally {
    await w.cleanup();
  }
});
test('partial failures preserve successful answers and report context errors without truncation', async () => {
  const seen: string[] = [];
  const w = await setup({
    evaluate: async (request) => {
      seen.push(String(request.state.record.text));
      if (request.state.record.fail) throw new Error('Context token limit exceeded');
      return answer(request);
    },
  });
  try {
    const text = 'whole record '.repeat(1000);
    const d = await importEntries(w, {
      'data.json': JSON.stringify([{ text: 'works' }, { text, fail: true }]),
    });
    const run = w.runner.create(d.id, config({ selection: { mode: 'all' } }));
    const finished = await until(
      () => w.store.run(run.id),
      (r) => r.status === 'partial',
    );
    assert.equal(finished.succeeded, 1);
    assert.equal(finished.failed, 1);
    assert.equal(seen[1], text);
    assert.match(
      w.store.results(run.id, { status: 'failed' }).items[0].error!,
      /No content was truncated/,
    );
  } finally {
    await w.cleanup();
  }
});
test('authentication errors stop further requests', async () => {
  let calls = 0;
  const w = await setup({
    evaluate: async () => {
      calls++;
      throw Object.assign(new Error('Unauthorized'), { status: 401 });
    },
  });
  try {
    const d = await importEntries(w, { 'data.json': '[{"id":1},{"id":2},{"id":3}]' });
    const run = w.runner.create(d.id, config());
    const failed = await until(
      () => w.store.run(run.id),
      (r) => r.status === 'failed',
    );
    assert.equal(calls, 1);
    assert.match(failed.error!, /authentication/);
    assert.equal(failed.failed, 1);
  } finally {
    await w.cleanup();
  }
});
test('cancel aborts active work, stops pending work and retains completed records', async () => {
  let calls = 0;
  const w = await setup({
    evaluate: async (request, signal) => {
      calls++;
      if (calls > 1) await setTimeout(10000, undefined, { signal });
      return answer(request);
    },
  });
  try {
    const d = await importEntries(w, { 'data.json': '[{"id":1},{"id":2},{"id":3}]' });
    const run = w.runner.create(d.id, config());
    await until(
      () => calls,
      (n) => n === 2,
    );
    w.runner.cancel(run.id);
    await setTimeout(30);
    assert.equal(w.store.run(run.id).status, 'cancelled');
    assert.equal(w.store.run(run.id).succeeded, 1);
    assert.equal(calls, 2);
    assert.equal(w.store.results(run.id, { status: 'pending' }).total, 2);
  } finally {
    await w.cleanup();
  }
});
test('restart preserves history and explicit resume evaluates only unfinished records', async () => {
  let calls = 0;
  const w = await setup({
    evaluate: async (request, signal) => {
      calls++;
      if (calls > 1) await setTimeout(10000, undefined, { signal });
      return answer(request);
    },
  });
  const d = await importEntries(w, { 'data.json': '[{"id":1},{"id":2},{"id":3}]' });
  const run = w.runner.create(d.id, config());
  await until(
    () => calls,
    (n) => n === 2,
  );
  await w.close();
  const resumedIds: unknown[] = [];
  const reopened = createApp(w.config, {
    evaluate: async (request) => {
      resumedIds.push(request.state.record.id);
      return answer(request);
    },
  });
  try {
    assert.equal(reopened.store.dataset(d.id).recordCount, 3);
    assert.equal(reopened.store.run(run.id).status, 'interrupted');
    assert.equal(reopened.store.run(run.id).succeeded, 1);
    reopened.runner.resume(run.id);
    await until(
      () => reopened.store.run(run.id),
      (r) => r.status === 'completed',
    );
    assert.deepEqual(resumedIds, [2, 3]);
    assert.equal(reopened.store.run(run.id).succeeded, 3);
  } finally {
    await reopened.close();
    const { rm } = await import('node:fs/promises');
    await rm(w.dir, { recursive: true, force: true });
  }
});
test('missing key allows import and browsing but prevents inference', async () => {
  const w = await setup(undefined, { apiKey: '' });
  try {
    const d = await importEntries(w, { 'a.txt': 'hello' });
    assert.equal(w.store.dataset(d.id).status, 'ready');
    assert.throws(() => w.runner.create(d.id, config()), /TYPESAFE_API_KEY/);
  } finally {
    await w.cleanup();
  }
});
test('official SDK adapter sends one typed request with all helpers and reads the returned model', async () => {
  const original = globalThis.fetch;
  let wire: any;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.typesafe.ai/v1/systemone');
    wire = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-key');
    return new Response(JSON.stringify(answer(wire)), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const { buildRequest } = await import('@jev/shared');
    const request = buildRequest({ text: 'synthetic data' }, config());
    const response = await createProvider('synthetic-key').evaluate(
      request,
      new AbortController().signal,
    );
    assert.deepEqual(wire, request);
    assert.equal(response.model, 'jev-test-pinned');
  } finally {
    globalThis.fetch = original;
  }
});

test('recovery finalizes a run whose final answer was saved just before interruption', async () => {
  const w = await setup();
  try {
    const d = await importEntries(w, { 'data.txt': 'One record' });
    const run = w.runner.create(d.id, config());
    await until(
      () => w.store.run(run.id),
      (r) => r.status === 'completed',
    );
    w.store.exec("UPDATE runs SET status='interrupted', finishedAt=NULL WHERE id=?", run.id);
    const resumed = w.runner.resume(run.id);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.succeeded, 1);
  } finally {
    await w.cleanup();
  }
});

test('crash recovery removes in-progress imports while preserving pending wrapper choices', async () => {
  const w = await setup();
  try {
    const pending = await importEntries(w, { 'wrapper.json': '{"Documents":[{"id":1}]}' });
    const importing = await importEntries(w, { 'data.json': '[{"id":2}]' });
    w.store.exec("UPDATE datasets SET status='importing' WHERE id=?", importing.id);
    w.store.recover();
    assert.equal(w.store.dataset(importing.id).status, 'failed');
    assert.equal(w.store.dataset(importing.id).recordCount, 0);
    assert.equal(w.store.dataset(pending.id).status, 'needs_selection');
    w.importer.continue(pending.id, { [pending.sources[0].id]: '/Documents' });
    await w.importer.idle();
    assert.equal(w.store.dataset(pending.id).status, 'ready');
  } finally {
    await w.cleanup();
  }
});
