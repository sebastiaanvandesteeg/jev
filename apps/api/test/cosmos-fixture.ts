import type { CosmosQuery, Json } from '@jev/shared';
import type { CosmosAdapter } from '../src/cosmos.js';

export const fixtureConnectionString =
  'AccountEndpoint=https://fixture.documents.azure.com/;AccountKey=fixture-secret-do-not-expose;';
export const fixtureQuery: CosmosQuery = {
  databaseId: 'workbench',
  containerId: 'messages',
  query: 'SELECT * FROM c',
  limit: 1000,
};
export function cosmosFixture(
  records: Json[] = [
    { id: '001', message: 'Please help' },
    { id: '002', message: 'All done' },
  ],
) {
  const queries: CosmosQuery[] = [];
  let closed = false;
  const adapter: CosmosAdapter = {
    accountHost: 'fixture.documents.azure.com',
    databases: async () => ['workbench', 'empty'],
    containers: async (database) => (database === 'workbench' ? ['messages'] : []),
    async *query(input, signal) {
      queries.push(input);
      for (const record of records) {
        signal.throwIfAborted();
        yield record;
      }
    },
    close() {
      closed = true;
    },
  };
  return { adapter, queries, isClosed: () => closed };
}
