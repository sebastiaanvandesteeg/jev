// Opt-in only: requires an explicit database, container and small query.
import { CosmosConnection } from '../apps/api/src/cosmos.js';
import { getConfig } from '../apps/api/src/config.js';
import { cosmosQuerySchema } from '@jev/shared';

const config = getConfig();
const databaseId = process.env.COSMOS_SMOKE_DATABASE;
const containerId = process.env.COSMOS_SMOKE_CONTAINER;
const query = process.env.COSMOS_SMOKE_QUERY;
if (!config.cosmosConnectionString || !databaseId || !containerId || !query) {
  console.log(
    'Skipped: set COSMOS_CONNECTION_STRING, COSMOS_SMOKE_DATABASE, COSMOS_SMOKE_CONTAINER and COSMOS_SMOKE_QUERY to opt in.',
  );
} else {
  const connection = new CosmosConnection(config.cosmosConnectionString);
  try {
    const result = await connection.preview(
      cosmosQuerySchema.parse({ databaseId, containerId, query, limit: 1 }),
      config.maxUploadBytes,
    );
    console.log(
      `Cosmos DB read succeeded: ${result.records.length} result(s). No document content is printed or saved.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cosmos DB smoke test failed.');
    process.exitCode = 1;
  } finally {
    connection.close();
  }
}
