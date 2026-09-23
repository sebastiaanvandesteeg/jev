import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { datasetRenameSchema, type Dataset, type DatasetDetail } from '@jev/shared';
import { api, navigate } from './api';
import { ErrorNote, Modal } from './components';

export function DatasetActions({
  dataset,
  compact = false,
}: {
  dataset: Dataset;
  compact?: boolean;
}) {
  const [action, setAction] = useState<'rename' | 'delete' | null>(null);
  return (
    <div className="dataset-actions">
      <button
        className={compact ? 'icon-button' : 'secondary'}
        aria-label={compact ? `Rename dataset ${dataset.name}` : 'Rename dataset'}
        title="Rename dataset"
        onClick={() => setAction('rename')}
      >
        <Pencil size={15} aria-hidden="true" />
        {!compact && 'Rename'}
      </button>
      <button
        className={`${compact ? 'icon-button' : 'secondary'} delete-dataset-action`}
        aria-label={compact ? `Delete dataset ${dataset.name}` : 'Delete dataset'}
        title="Delete dataset"
        onClick={() => setAction('delete')}
      >
        <Trash2 size={15} aria-hidden="true" />
        {!compact && 'Delete'}
      </button>
      {action && (
        <DatasetActionDialog dataset={dataset} action={action} onClose={() => setAction(null)} />
      )}
    </div>
  );
}

function DatasetActionDialog({
  dataset,
  action,
  onClose,
}: {
  dataset: Dataset;
  action: 'rename' | 'delete';
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(dataset.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const renameInput = useRef<HTMLInputElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Modal opens in its effect; focus after it is visible.
    (action === 'rename' ? renameInput.current : cancelButton.current)?.focus();
  }, [action]);
  const validName = datasetRenameSchema.safeParse({ name }).success;
  const close = () => {
    if (!busy) onClose();
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || (action === 'rename' && !validName)) return;
    setBusy(true);
    setError(undefined);
    try {
      if (action === 'rename') {
        const updated = await api<DatasetDetail>(
          `/datasets/${dataset.id}`,
          { name },
          undefined,
          'PATCH',
        );
        await Promise.all([
          client.cancelQueries({ queryKey: ['datasets'] }),
          client.cancelQueries({ queryKey: ['dataset', dataset.id] }),
        ]);
        client.setQueryData(['dataset', dataset.id], updated);
        client.setQueryData<Dataset[]>(['datasets'], (datasets) =>
          datasets?.map((d) => (d.id === dataset.id ? updated : d)),
        );
      } else {
        await api<void>(`/datasets/${dataset.id}`, undefined, undefined, 'DELETE');
        if (location.hash.split('/')[2] === dataset.id) navigate('');
        const related = {
          predicate: (query: { queryKey: readonly unknown[] }) =>
            ['dataset', 'records', 'preview', 'runs'].includes(String(query.queryKey[0])) &&
            query.queryKey[1] === dataset.id,
        };
        await Promise.all([
          client.cancelQueries({ queryKey: ['datasets'] }),
          client.cancelQueries(related),
        ]);
        client.removeQueries(related);
        client.setQueryData<Dataset[]>(['datasets'], (datasets) =>
          datasets?.filter((d) => d.id !== dataset.id),
        );
      }
      void client.invalidateQueries({ queryKey: ['datasets'] });
      onClose();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={action === 'rename' ? 'Rename dataset' : 'Delete dataset?'} onClose={close}>
      <form onSubmit={save}>
        {action === 'rename' ? (
          <label className="field-label">
            Dataset name
            <input
              ref={renameInput}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={150}
              required
              disabled={busy}
            />
          </label>
        ) : (
          <div className="dataset-delete-copy">
            <p>
              Permanently delete <strong>{dataset.name}</strong>?
            </p>
            <p>
              This removes its local records, experiment history, saved results, and any retained
              import files. This cannot be undone.
            </p>
            {dataset.origin && <p>Your Azure Cosmos DB source data is unchanged.</p>}
          </div>
        )}
        <ErrorNote error={error} />
        <div className="modal-actions">
          <button
            ref={cancelButton}
            className="secondary"
            type="button"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className={action === 'delete' ? 'danger' : 'primary'}
            type="submit"
            disabled={busy || (action === 'rename' && !validName)}
          >
            {busy
              ? action === 'rename'
                ? 'Saving…'
                : 'Deleting…'
              : action === 'rename'
                ? 'Save name'
                : 'Delete dataset'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
