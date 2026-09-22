import { createApp } from './app.js';
import { getConfig } from './config.js';

const config = getConfig();
const workbench = createApp(config);
const server = workbench.app.listen(config.port, '127.0.0.1', () => {
  console.log(`Jev workbench API: http://127.0.0.1:${config.port}`);
  console.log(
    config.apiKey
      ? 'TypeSafe API key configured.'
      : 'Import and explore freely. Add TYPESAFE_API_KEY to .env to run Jev.',
  );
});
server.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
  void workbench.close();
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await workbench.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
