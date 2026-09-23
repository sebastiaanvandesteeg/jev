import { CosmosClient, type FeedOptions } from '@azure/cosmos';
import { asDocument, type CosmosPreview, type CosmosQuery, type Json } from '@jev/shared';
import { HttpError } from './errors.js';

export interface CosmosAdapter {
  accountHost: string;
  databases(signal: AbortSignal): Promise<string[]>;
  containers(databaseId: string, signal: AbortSignal): Promise<string[]>;
  query(input: CosmosQuery, signal: AbortSignal): AsyncIterable<Json>;
  close(): void;
}
interface PageIterator<T> {
  hasMoreResults(): boolean;
  fetchNext(): Promise<{ resources: T[] }>;
}
// Only these read operations are available to the adapter, including in tests.
export interface CosmosClientPort {
  databases: { readAll(options: FeedOptions): PageIterator<{ id: string }> };
  database(id: string): {
    containers: { readAll(options: FeedOptions): PageIterator<{ id: string }> };
    container(id: string): {
      items: { query(query: string, options: FeedOptions): PageIterator<Json> };
    };
  };
  dispose(): void;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function* pages<T>(iterator: PageIterator<T>, signal: AbortSignal, limit = Infinity) {
  let count = 0;
  while (iterator.hasMoreResults() && count < limit) {
    signal.throwIfAborted();
    const { resources } = await abortable(iterator.fetchNext(), signal);
    for (const item of resources) {
      signal.throwIfAborted();
      yield item;
      if (++count >= limit) return;
    }
  }
}

export function createCosmosAdapter(
  connectionString: string,
  createClient: (connectionString: string) => CosmosClientPort = (value) => new CosmosClient(value),
): CosmosAdapter {
  const endpoint = connectionString.match(/(?:^|;)\s*AccountEndpoint=([^;]+)/i)?.[1];
  let accountHost: string;
  let client: CosmosClientPort;
  try {
    const url = new URL(endpoint || '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error();
    if (!/(?:^|;)\s*AccountKey=\S+/i.test(connectionString)) throw new Error();
    accountHost = url.hostname;
    client = createClient(connectionString);
  } catch {
    throw new CosmosError(
      503,
      'COSMOS_CONNECTION_STRING is invalid. Use a NoSQL read-only connection string and restart the backend.',
    );
  }
  const options = (signal: AbortSignal): FeedOptions => ({
    abortSignal: signal,
    maxItemCount: 100,
    bufferItems: false,
    maxDegreeOfParallelism: 1,
  });
  return {
    accountHost,
    async databases(signal) {
      const ids: string[] = [];
      for await (const item of pages(client.databases.readAll(options(signal)), signal))
        ids.push(item.id);
      return ids;
    },
    async containers(databaseId, signal) {
      const ids: string[] = [];
      for await (const item of pages(
        client.database(databaseId).containers.readAll(options(signal)),
        signal,
      ))
        ids.push(item.id);
      return ids;
    },
    async *query(input, signal) {
      const iterator = client
        .database(input.databaseId)
        .container(input.containerId)
        .items.query(input.query, {
          ...options(signal),
          maxItemCount: Math.min(100, input.limit),
        });
      yield* pages(iterator, signal, input.limit);
    },
    close: () => client.dispose(),
  };
}

// Only messages created here may cross the SDK boundary; never pass through SDK diagnostics.
export class CosmosError extends HttpError {}
function safeError(error: unknown, signal?: AbortSignal): CosmosError {
  if (signal?.aborted) {
    return signal.reason?.name === 'TimeoutError'
      ? new CosmosError(504, 'The Cosmos DB request timed out. Narrow the query and try again.')
      : new CosmosError(503, 'The Cosmos DB request was interrupted. Run the query again.');
  }
  if (error instanceof CosmosError) return error;
  const code =
    error && typeof error === 'object'
      ? Number('statusCode' in error ? error.statusCode : 'code' in error ? error.code : 0)
      : 0;
  if (code === 400)
    return new CosmosError(
      400,
      'Cosmos DB rejected the query. Check the SQL syntax, field names, and required indexes.',
    );
  if (code === 401)
    return new CosmosError(
      401,
      'Cosmos DB authentication failed. Check the read-only connection string and restart the backend.',
    );
  if (code === 403)
    return new CosmosError(
      403,
      'Cosmos DB denied access. Check the account firewall, network access, and read permissions.',
    );
  if (code === 404)
    return new CosmosError(
      404,
      'The Cosmos DB database or container was not found. Refresh the selection and try again.',
    );
  if (code === 429)
    return new CosmosError(
      429,
      'Cosmos DB is throttling requests. Wait briefly or narrow the query before trying again.',
    );
  if (code === 408 || code === 504)
    return new CosmosError(504, 'The Cosmos DB request timed out. Narrow the query and try again.');
  return new CosmosError(
    502,
    'Could not read from Cosmos DB. Check the connection string, network, and account availability.',
  );
}

export class CosmosConnection {
  private adapter?: CosmosAdapter;
  private shutdown = new AbortController();
  constructor(
    private connectionString: string,
    adapter?: CosmosAdapter,
    private deadlines = { requestMs: 60000, importMs: 300000 },
  ) {
    this.adapter = adapter;
  }
  get configured() {
    return Boolean(this.connectionString);
  }
  private getAdapter() {
    if (this.shutdown.signal.aborted)
      throw new CosmosError(503, 'The Cosmos DB connection is closing.');
    if (!this.configured)
      throw new CosmosError(
        503,
        'Add COSMOS_CONNECTION_STRING to the root .env and restart the backend.',
      );
    return (this.adapter ??= createCosmosAdapter(this.connectionString));
  }
  get accountHost() {
    return this.getAdapter().accountHost;
  }
  private operation(duration: number) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('Deadline exceeded', 'TimeoutError')),
      duration,
    );
    timer.unref();
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
    return {
      signal,
      dispose: () => {
        clearTimeout(timer);
        controller.abort();
      },
    };
  }
  async list(databaseId?: string): Promise<string[]> {
    const operation = this.operation(this.deadlines.requestMs);
    try {
      const adapter = this.getAdapter();
      return await abortable(
        databaseId === undefined
          ? adapter.databases(operation.signal)
          : adapter.containers(databaseId, operation.signal),
        operation.signal,
      );
    } catch (error) {
      throw safeError(error, operation.signal);
    } finally {
      operation.dispose();
    }
  }
  async *records(input: CosmosQuery, preview = false): AsyncGenerator<Json> {
    const operation = this.operation(preview ? this.deadlines.requestMs : this.deadlines.importMs);
    const limit = preview ? Math.min(10, input.limit) : input.limit;
    try {
      const iterator = this.getAdapter()
        .query({ ...input, limit }, operation.signal)
        [Symbol.asyncIterator]();
      try {
        for (let count = 0; count < limit; count++) {
          operation.signal.throwIfAborted();
          const item = await abortable(iterator.next(), operation.signal);
          if (item.done) break;
          yield item.value;
        }
      } finally {
        // Release the iterator without waiting on an unresponsive remote operation.
        // The outer finally aborts outstanding SDK work and clears the deadline.
        if (iterator.return) void iterator.return().catch(() => {});
      }
      operation.signal.throwIfAborted();
    } catch (error) {
      throw safeError(error, operation.signal);
    } finally {
      operation.dispose();
    }
  }
  async preview(input: CosmosQuery, maxBytes: number): Promise<CosmosPreview> {
    const records: CosmosPreview['records'] = [];
    let bytes = 0;
    for await (const value of this.records(input, true)) {
      const document = asDocument(value);
      bytes += Buffer.byteLength(JSON.stringify(document));
      if (bytes > maxBytes)
        throw new CosmosError(
          413,
          'Query results exceed the dataset size limit. Select fewer fields or narrow the query.',
        );
      records.push(document);
    }
    return { records, limitReached: records.length === Math.min(10, input.limit) };
  }
  close() {
    this.shutdown.abort();
    this.adapter?.close();
  }
}
