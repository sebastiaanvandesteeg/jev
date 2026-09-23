// This standalone test server is the only place a fake provider is wired into an HTTP listener.
import { rm, mkdtemp } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/api/src/app.js';
import { getConfig } from '../apps/api/src/config.js';
import { answer } from '../apps/api/test/helpers.js';
import { cosmosFixture, fixtureConnectionString } from '../apps/api/test/cosmos-fixture.js';

const cosmos = cosmosFixture();

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'jev-e2e-'));
const w = createApp(
  {
    ...getConfig(),
    dataDir,
    apiKey: 'synthetic-e2e-only',
    cosmosConnectionString: fixtureConnectionString,
    requestsPerSecond: 30,
  },
  {
    evaluate: async (request, signal) => {
      await setTimeout(30, undefined, { signal });
      return answer(request);
    },
  },
  {
    ...cosmos.adapter,
    async *query(input, signal) {
      if (input.query === 'INVALID SQL')
        throw Object.assign(new Error('Synthetic SQL error'), { code: 400 });
      if (input.query.includes('WHERE')) {
        if (input.limit !== 10) await setTimeout(1200, undefined, { signal });
        yield { id: '001', message: 'Filtered message' };
      } else yield* cosmos.adapter.query(input, signal);
    },
  },
);
const server = w.app.listen(4173, '127.0.0.1');
async function close() {
  server.close();
  await w.close();
  await rm(dataDir, { recursive: true, force: true });
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
