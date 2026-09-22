// This standalone test server is the only place a fake provider is wired into an HTTP listener.
import { rm, mkdtemp } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/api/src/app.js';
import { getConfig } from '../apps/api/src/config.js';
import { answer } from '../apps/api/test/helpers.js';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'jev-e2e-'));
const w = createApp(
  { ...getConfig(), dataDir, apiKey: 'synthetic-e2e-only', requestsPerSecond: 30 },
  {
    evaluate: async (request, signal) => {
      await setTimeout(30, undefined, { signal });
      return answer(request);
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
