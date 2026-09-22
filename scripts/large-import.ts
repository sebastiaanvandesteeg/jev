import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { ZipFile } from 'yazl';
import { Store } from '../apps/api/src/store.js';
import { Importer } from '../apps/api/src/importer.js';
import { getConfig } from '../apps/api/src/config.js';

const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-large-'));
const config = { ...getConfig(), dataDir: path.join(dir, 'data') };
const store = new Store(config.dataDir);
const importer = new Importer(store, config);
try {
  const file = path.join(dir, 'large.json');
  const stream = createWriteStream(file);
  stream.write('[');
  let inputBytes = 1,
    rows = 0;
  const target = 100 * 1024 * 1024;
  while (inputBytes < target) {
    const row =
      (rows ? ',' : '') +
      JSON.stringify({
        id: rows,
        content: randomBytes(3000).toString('base64'),
        nested: { ok: true },
      });
    inputBytes += Buffer.byteLength(row);
    if (!stream.write(row)) await once(stream, 'drain');
    rows++;
  }
  stream.end(']');
  await once(stream, 'finish');
  const zip = new ZipFile();
  const zipPath = path.join(dir, 'large.zip');
  zip.addFile(file, 'large.json');
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(zipPath));
  const zipBytes = (await stat(zipPath)).size;
  assert.ok(zipBytes < config.maxUploadBytes);
  const start = performance.now();
  let maxRss = process.memoryUsage().rss;
  let heartbeats = 0;
  const timer = setInterval(() => {
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
    heartbeats++;
  }, 50);
  const d = await importer.accept(zipPath, 'large.zip', zipBytes);
  await importer.idle();
  clearInterval(timer);
  const imported = store.dataset(d.id);
  assert.equal(imported.status, 'ready', imported.error || 'Import failed');
  assert.equal(imported.recordCount, rows);
  const first = store.records(d.id, { search: '', sourceId: '' }, 1, 25);
  const last = store.records(d.id, { search: '', sourceId: '' }, Math.ceil(rows / 25), 25);
  assert.equal(first.items.length, 25);
  assert.equal(first.items[0].data.id, 0);
  assert.equal(last.items.at(-1)?.data.id, rows - 1);
  assert.equal(first.total, rows);
  assert.ok(heartbeats > 10, 'Import should yield to the event loop.');
  console.log(
    JSON.stringify(
      {
        inputMiB: +(inputBytes / 1024 / 1024).toFixed(2),
        zipMiB: +(zipBytes / 1024 / 1024).toFixed(2),
        records: rows,
        seconds: +((performance.now() - start) / 1000).toFixed(2),
        peakRssMiB: Math.round(maxRss / 1024 / 1024),
        eventLoopHeartbeats: heartbeats,
        pagination: 'passed',
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  await rm(dir, { recursive: true, force: true });
}
