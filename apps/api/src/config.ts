import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
function positive(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value))
    throw new Error(`${name} must be a positive integer.`);
  return value;
}
export function getConfig() {
  return {
    dataDir: path.resolve(repoRoot, process.env.DATA_DIR || 'data'),
    port: positive('PORT', 3001),
    apiKey: process.env.TYPESAFE_API_KEY || '',
    cosmosConnectionString: process.env.COSMOS_CONNECTION_STRING?.trim() || '',
    model: process.env.TYPESAFE_MODEL || 'jev-latest',
    maxUploadBytes: positive('MAX_UPLOAD_MIB', 100) * 1024 * 1024,
    maxExpandedBytes: positive('MAX_EXPANDED_MIB', 500) * 1024 * 1024,
    maxFiles: positive('MAX_ARCHIVE_FILES', 10000),
    concurrency: positive('RUN_CONCURRENCY', 4),
    requestsPerSecond: positive('RUN_REQUESTS_PER_SECOND', 10),
  };
}
export type Config = ReturnType<typeof getConfig>;
