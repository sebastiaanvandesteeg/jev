import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import { ZipFile } from 'yazl';
import { setTimeout } from 'node:timers/promises';
import type { JevResponse, RequestPreview } from '@jev/shared';
import { getConfig, type Config } from '../src/config.js';
import { createApp } from '../src/app.js';
import type { Provider } from '../src/provider.js';
import type { CosmosAdapter } from '../src/cosmos.js';

export async function zipFile(
  directory: string,
  entries: Record<string, string | Buffer>,
  options: { compress?: boolean } = {},
) {
  const file = path.join(directory, `fixture-${crypto.randomUUID()}.zip`);
  const zip = new ZipFile();
  for (const [name, content] of Object.entries(entries))
    zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name, options);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(file));
  return file;
}
export function answer(request: RequestPreview): JevResponse {
  return {
    model: 'jev-test-pinned',
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => [
        id,
        q.type === 'noul'
          ? { type: 'noul', noul: 0.8 }
          : q.type === 'choice'
            ? {
                type: 'choice',
                choice: Object.keys(q.criteria)[0],
                probabilities: Object.fromEntries(
                  Object.keys(q.criteria).map((key, i) => [key, i === 0 ? 1 : 0]),
                ),
                confidence: 1,
              }
            : {
                type: 'score',
                score: 1.2,
                confidence: 0.7,
                legend: Object.fromEntries(q.criteria.map((value, i) => [i, value])),
                probabilities: { 0: 0, 1: 0.8, 2: 0.2 },
              },
      ]),
    ),
    usage: { input_tokens: 123, output_tokens: 9 },
  };
}
export async function setup(
  provider: Provider = { evaluate: async (request) => answer(request) },
  overrides: Partial<Config> = {},
  cosmosAdapter?: CosmosAdapter,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-test-'));
  const config = {
    ...getConfig(),
    dataDir: path.join(dir, 'data'),
    apiKey: 'test-key',
    cosmosConnectionString: '',
    concurrency: 1,
    requestsPerSecond: 200,
    ...overrides,
  };
  const workbench = createApp(config, provider, cosmosAdapter);
  return {
    ...workbench,
    config,
    dir,
    async cleanup() {
      await workbench.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export async function importEntries(
  workbench: Awaited<ReturnType<typeof setup>>,
  entries: Record<string, string | Buffer>,
) {
  const file = await zipFile(workbench.dir, entries);
  const dataset = await workbench.importer.accept(file, 'fixture.zip', (await stat(file)).size);
  await workbench.importer.idle();
  return workbench.store.dataset(dataset.id);
}
export async function until<T>(
  read: () => T,
  matches: (value: T) => boolean,
  timeout = 6000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (matches(value)) return value;
    await setTimeout(10);
  }
  throw new Error(`Timed out waiting for condition: ${JSON.stringify(read())}`);
}
