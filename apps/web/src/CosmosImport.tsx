import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cosmosQuerySchema, type AppConfig, type CosmosPreview, type Dataset } from '@jev/shared';
import { api, bytes, navigate, number, queryString } from './api';
import { ErrorNote, JsonView, Loading, Modal } from './components';
import { AzureResourceIcon } from './AzureResourceIcon';

export function CosmosImportDialog({
  config,
  onClose,
}: {
  config?: AppConfig;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [databaseId, setDatabaseId] = useState('');
  const [containerId, setContainerId] = useState('');
  const [query, setQuery] = useState('SELECT * FROM c');
  const [limit, setLimit] = useState(config?.cosmosDefaultRecords ?? 1000);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<CosmosPreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const databases = useQuery({
    queryKey: ['cosmos', 'databases'],
    queryFn: ({ signal }) => api<string[]>('/cosmos/databases', undefined, signal),
    enabled: Boolean(config?.hasCosmosConnection),
    retry: false,
  });
  const containers = useQuery({
    queryKey: ['cosmos', 'containers', databaseId],
    queryFn: ({ signal }) =>
      api<string[]>(`/cosmos/containers?${queryString({ databaseId })}`, undefined, signal),
    enabled: Boolean(config?.hasCosmosConnection && databaseId),
    retry: false,
  });
  const input = { databaseId, containerId, query, limit };
  const valid = cosmosQuerySchema.safeParse(input).success;
  function changed() {
    setPreview(null);
    setError(null);
  }
  async function execute(action: 'preview' | 'import') {
    const controller = new AbortController();
    request.current = controller;
    setBusy(action);
    setError(null);
    try {
      if (action === 'preview') {
        setPreview(null);
        const result = await api<CosmosPreview>('/cosmos/preview', input, controller.signal);
        if (!controller.signal.aborted) setPreview(result);
      } else {
        const result = await api<Dataset>('/cosmos/import', { ...input, name }, controller.signal);
        if (controller.signal.aborted) return;
        void client.invalidateQueries({ queryKey: ['datasets'] });
        onClose();
        navigate(`datasets/${result.id}`);
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(error);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }
  return (
    <Modal
      title={
        <span className="azure-dialog-title">
          <span className="azure-service-tile">
            <AzureResourceIcon size={30} />
          </span>
          <span>
            <span className="azure-service-provider">Microsoft Azure</span>
            Import from Cosmos DB
          </span>
        </span>
      }
      wide
      onClose={() => {
        if (busy !== 'import') onClose();
      }}
    >
      {!config ? (
        <Loading />
      ) : !config.hasCosmosConnection ? (
        <div className="cosmos-setup">
          <p>
            Add your Azure Cosmos DB for NoSQL read-only connection string to the project’s root{' '}
            <code>.env</code> file:
          </p>
          <pre className="json-view">COSMOS_CONNECTION_STRING=your-read-only-connection-string</pre>
          <p>
            Restart the backend, then open this dialog again. The connection string stays on the
            server.
          </p>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && name.trim() && !busy) void execute('import');
          }}
        >
          <p className="muted">
            Save query results as a local dataset. Your Cosmos DB data stays unchanged.
          </p>
          <ErrorNote error={databases.error || containers.error} />
          {(databases.isError || containers.isError) && (
            <button
              type="button"
              className="secondary"
              disabled={Boolean(busy)}
              onClick={() => {
                if (databases.isError) void databases.refetch();
                if (containers.isError) void containers.refetch();
              }}
            >
              Retry connection
            </button>
          )}
          <fieldset className="cosmos-fields" disabled={Boolean(busy)}>
            <div className="cosmos-row">
              <label className="field-label">
                <span className="azure-resource-label">
                  <AzureResourceIcon resource="database" size={16} /> Database
                </span>
                <select
                  value={databaseId}
                  onChange={(event) => {
                    setDatabaseId(event.target.value);
                    setContainerId('');
                    setName('');
                    changed();
                  }}
                >
                  <option value="">
                    {databases.isFetching ? 'Loading databases…' : 'Choose a database'}
                  </option>
                  {databases.data?.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                <span className="azure-resource-label">
                  <AzureResourceIcon resource="container" size={16} /> Container
                </span>
                <select
                  value={containerId}
                  disabled={!databaseId || containers.isFetching}
                  onChange={(event) => {
                    setContainerId(event.target.value);
                    setName(`${event.target.value} snapshot`);
                    changed();
                  }}
                >
                  <option value="">
                    {containers.isFetching ? 'Loading containers…' : 'Choose a container'}
                  </option>
                  {containers.data?.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {databases.data?.length === 0 && (
              <p className="muted">No databases were found in this account.</p>
            )}
            {databaseId && containers.data?.length === 0 && (
              <p className="muted">No containers were found in this database.</p>
            )}
            <label className="field-label">
              SQL query
              <textarea
                className="cosmos-sql"
                rows={5}
                value={query}
                maxLength={32000}
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  changed();
                }}
              />
            </label>
            <div className="cosmos-row">
              <label className="field-label">
                Dataset name
                <input
                  value={name}
                  maxLength={150}
                  required
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="field-label">
                Maximum results
                <input
                  type="number"
                  min={1}
                  max={config.cosmosMaxRecords}
                  required
                  value={Number.isNaN(limit) ? '' : limit}
                  onChange={(event) => {
                    setLimit(event.target.valueAsNumber);
                    changed();
                  }}
                />
              </label>
            </div>
          </fieldset>
          <p className="muted cosmos-notice">
            Up to {number(config.cosmosMaxRecords)} results and {bytes(config.maxUploadBytes)} per
            dataset. Queries consume Cosmos DB request units; the result limit does not cap query
            cost.
          </p>
          <ErrorNote error={error} />
          {busy && <Loading label={busy === 'preview' ? 'Reading preview…' : 'Starting import…'} />}
          {preview && (
            <section aria-label="Query preview">
              <h3>Query preview</h3>
              {preview.records.length ? (
                <>
                  <p className="muted">
                    Showing {preview.records.length} result{preview.records.length === 1 ? '' : 's'}
                    {preview.limitReached ? ' · Additional results may exist' : ''}.
                  </p>
                  <JsonView value={preview.records} />
                </>
              ) : (
                <p className="muted">Query returned no results.</p>
              )}
            </section>
          )}
          <p className="muted cosmos-notice">
            Preview and import run the query separately, so results can change. Running a Jev
            experiment sends your selected fields to TypeSafe.
          </p>
          <div className="modal-actions cosmos-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy === 'import'}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!valid || Boolean(busy)}
              onClick={() => void execute('preview')}
            >
              Preview
            </button>
            <button
              type="submit"
              className="primary"
              disabled={!valid || !name.trim() || Boolean(busy)}
            >
              <AzureResourceIcon size={18} /> Import dataset
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
