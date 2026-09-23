import { lazy, Suspense, useEffect, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Braces,
  Check,
  ChevronRight,
  Database,
  FileArchive,
  FlaskConical,
  Folder,
  HardDrive,
  Layers3,
  Plus,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import type { AppConfig, Dataset, DatasetDetail, RecordFilter } from '@jev/shared';
import { api, bytes, date, navigate, number } from './api';
import { Badge, ErrorNote, Loading, Modal } from './components';
import { DataView } from './DataView';
import { CosmosImportDialog } from './CosmosImport';
import { AzureResourceIcon } from './AzureResourceIcon';
import { DatasetActions } from './DatasetActions';
const Experiment = lazy(() =>
  import('./Experiment').then((module) => ({ default: module.Experiment })),
);
const RunHistory = lazy(() => import('./Runs').then((module) => ({ default: module.RunHistory })));
const RunView = lazy(() => import('./Runs').then((module) => ({ default: module.RunView })));

function useRoute() {
  const [route, setRoute] = useState(location.hash.slice(2));
  useEffect(() => {
    const update = () => setRoute(location.hash.slice(2));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}
export function App() {
  const route = useRoute();
  const [path, search = ''] = route.split('?');
  const parts = path.split('/');
  const datasetId = parts[0] === 'datasets' ? parts[1] : undefined;
  const [upload, setUpload] = useState(false);
  const [cosmosImport, setCosmosImport] = useState(false);
  const datasets = useQuery({
    queryKey: ['datasets'],
    queryFn: () => api<Dataset[]>('/datasets'),
    refetchInterval: 2000,
  });
  const settings = useQuery({
    queryKey: ['config'],
    queryFn: () => api<AppConfig>('/config'),
    refetchInterval: 10000,
  });
  const active = datasets.data?.find((d) => d.id === datasetId);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="#/" className="brand">
          <span className="brand-symbol">
            <Layers3 size={23} strokeWidth={2.4} />
          </span>
          <span>
            jev<span className="brand-period">.</span>
          </span>
          <span className="brand-tag">WORKBENCH</span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">P</span>
          <div>
            Personal workspace
            <small>
              <span className="green-dot" /> Local storage
            </small>
          </div>
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <button className={`nav-item ${!datasetId ? 'active' : ''}`} onClick={() => navigate('')}>
          <Database size={18} /> Datasets{' '}
          <span className="nav-count">{datasets.data?.length || 0}</span>
        </button>
        <button className="nav-item" onClick={() => setUpload(true)}>
          <Plus size={18} /> Import dataset
        </button>
        <button className="nav-item" onClick={() => setCosmosImport(true)}>
          <AzureResourceIcon /> Import from Cosmos DB
        </button>
        <div className="nav-caption dataset-caption">YOUR DATASETS</div>
        <div className="sidebar-datasets">
          {datasets.data?.map((d) => (
            <button
              key={d.id}
              className={`dataset-nav ${d.id === datasetId ? 'active' : ''}`}
              onClick={() => navigate(`datasets/${d.id}`)}
            >
              {d.origin ? <AzureResourceIcon size={16} /> : <Folder size={15} />}
              <span>{d.name}</span>
              {d.status === 'ready' && <small>{number(d.recordCount)}</small>}
            </button>
          ))}
          {!datasets.data?.length && (
            <p className="sidebar-empty">
              Your next discovery starts
              <br />
              with a dataset.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className={`connection-light ${settings.data?.hasApiKey ? 'on' : ''}`} />
            <div>
              Jev connection
              <small>
                {settings.data?.hasApiKey ? 'API key configured' : 'API key not configured'}
              </small>
            </div>
          </div>
          <a href="https://docs.typesafe.ai/introduction" target="_blank" rel="noreferrer">
            <BookOpen size={16} /> TypeSafe documentation <ArrowRight size={14} />
          </a>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <a href="#/">Datasets</a>
            {active && (
              <>
                <ChevronRight size={14} />
                <span className="current-crumb">{active.name}</span>
              </>
            )}
          </div>
          <span className="local-pill">
            <HardDrive size={13} /> On your machine
          </span>
        </header>
        <main>
          <Suspense fallback={<Loading />}>
            {datasetId ? (
              <DatasetPage
                key={datasetId}
                id={datasetId}
                tab={parts[2] || 'data'}
                runId={parts[3]}
                fromRun={new URLSearchParams(search).get('from')}
                config={settings.data}
              />
            ) : (
              <Library
                datasets={datasets.data || []}
                loading={datasets.isLoading}
                error={datasets.error}
                onUpload={() => setUpload(true)}
                onCosmosImport={() => setCosmosImport(true)}
              />
            )}
          </Suspense>
        </main>
        <footer className="app-footer">
          <span>
            Built for curious minds. Powered by{' '}
            <a href="https://typesafe.ai" target="_blank" rel="noreferrer">
              TypeSafe
            </a>
            .
          </span>
          <span>
            <span className="green-dot" /> Local workspace
          </span>
        </footer>
      </div>
      {upload && (
        <UploadDialog
          maxBytes={settings.data?.maxUploadBytes || 100 * 1024 * 1024}
          onClose={() => setUpload(false)}
        />
      )}
      {cosmosImport && (
        <CosmosImportDialog config={settings.data} onClose={() => setCosmosImport(false)} />
      )}
    </div>
  );
}
function Library({
  datasets,
  loading,
  error,
  onUpload,
  onCosmosImport,
}: {
  datasets: Dataset[];
  loading: boolean;
  error: unknown;
  onUpload: () => void;
  onCosmosImport: () => void;
}) {
  const [search, setSearch] = useState('');
  return (
    <div className="page library-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR DATA, NEW POSSIBILITIES</div>
          <h1>Dataset library</h1>
          <p>A place to explore, ask small questions, and find useful answers.</p>
        </div>
        <div className="library-import-actions">
          <button className="secondary" onClick={onCosmosImport}>
            <AzureResourceIcon size={20} /> Import from Cosmos DB
          </button>
          <button className="primary" onClick={onUpload}>
            <Plus size={17} /> Import dataset
          </button>
        </div>
      </div>
      <div className="intro-panel">
        <div className="intro-copy">
          <span className="mini-label">
            <Sparkles size={14} /> MEET SYSTEM ONE
          </span>
          <h2>Turn data into decisions.</h2>
          <p>
            Classify a collection. Spot a condition. Rank what matters.
            <br />
            Bring your data and discover what Jev can do with it.
          </p>
          <div className="intro-actions">
            <button className="dark-button" onClick={onUpload}>
              Explore your first dataset <ArrowRight size={15} />
            </button>
            <a href="/api/example" download>
              <ArrowDownToLine size={15} /> Get sample data
            </a>
          </div>
        </div>
        <div className="diagram" aria-hidden="true">
          <div className="diagram-doc">
            <Braces size={22} />
            <i />
            <i />
            <i />
          </div>
          <span className="diagram-line" />
          <div className="diagram-model">
            <Layers3 size={28} />
            <span>jev</span>
          </div>
          <span className="diagram-line" />
          <div className="diagram-output">
            <span>
              <Check size={12} /> Category <b>Update</b>
            </span>
            <span>
              <Check size={12} /> Relevant <b>0.94</b>
            </span>
            <span>
              <Check size={12} /> Priority <b>2.7</b>
            </span>
          </div>
        </div>
      </div>
      <div className="section-heading">
        <div>
          <h2>
            Your datasets <span className="count-chip">{datasets.length}</span>
          </h2>
          <p>Saved locally, ready whenever you are.</p>
        </div>
        <input
          className="search-input"
          aria-label="Search datasets"
          placeholder="Search datasets…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <ErrorNote error={error} />
      {loading ? (
        <Loading />
      ) : datasets.length ? (
        <div className="dataset-grid">
          {datasets
            .filter((d) => d.name.toLowerCase().includes(search.toLowerCase()))
            .map((d) => (
              <article className="dataset-card" key={d.id}>
                <button
                  className="dataset-card-open"
                  aria-label={`Open dataset ${d.name}`}
                  onClick={() => navigate(`datasets/${d.id}`)}
                >
                  <div className="card-top">
                    <span className={`file-icon${d.origin ? ' azure-resource-tile' : ''}`}>
                      {d.origin ? <AzureResourceIcon size={26} /> : <Database size={20} />}
                    </span>
                    <Badge status={d.status} />
                  </div>
                  <h3>{d.name}</h3>
                  <p className="archive-filename">
                    {d.origin && 'Azure Cosmos DB · '}
                    {d.archiveName}
                  </p>
                  <div className="dataset-card-stats">
                    <span>
                      <b>{number(d.recordCount)}</b> records
                    </span>
                    <span>{bytes(d.bytes)}</span>
                  </div>
                </button>
                <div className="card-bottom">
                  <span>Imported {date(d.createdAt)}</span>
                  <DatasetActions dataset={d} compact />
                </div>
              </article>
            ))}
        </div>
      ) : (
        <button className="empty-upload" onClick={onUpload}>
          <span className="empty-upload-icon">
            <Upload size={24} />
          </span>
          <h3>Your first dataset belongs here</h3>
          <p>Import JSON or CSV directly, or a ZIP containing your data files.</p>
          <span className="text-link">
            Choose a file <ArrowRight size={14} />
          </span>
          <small>Up to 100 MiB · Stored on your machine</small>
        </button>
      )}
      <div className="steps">
        <div>
          <span>01</span>
          <h3>Bring your data</h3>
          <p>Upload JSON, CSV, or a ZIP. We’ll turn your data into records you can explore.</p>
        </div>
        <div>
          <span>02</span>
          <h3>Ask a focused question</h3>
          <p>Start with a small sample and an editable experiment.</p>
        </div>
        <div>
          <span>03</span>
          <h3>Discover a useful signal</h3>
          <p>Inspect probabilities, filter results, and revisit every run.</p>
        </div>
      </div>
    </div>
  );
}
function UploadDialog({ maxBytes, onClose }: { maxBytes: number; onClose: () => void }) {
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  function choose(value?: File) {
    if (!value) return;
    setError('');
    if (!/\.(zip|json|csv)$/i.test(value.name)) return setError('Choose a JSON, CSV, or ZIP file.');
    if (value.size > maxBytes) return setError(`The upload limit is ${bytes(maxBytes)}.`);
    setFile(value);
    setName(value.name.replace(/\.(zip|json|csv)$/i, ''));
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    setDrag(false);
    choose(e.dataTransfer.files[0]);
  }
  function upload() {
    if (!file) return;
    setProgress(0);
    setError('');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/datasets');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => {
      setError('Upload failed. Check that the backend is running.');
      setProgress(null);
    };
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status >= 400) throw new Error(result.error);
        void client.invalidateQueries({ queryKey: ['datasets'] });
        onClose();
        navigate(`datasets/${result.id}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Upload failed.');
        setProgress(null);
      }
    };
    const form = new FormData();
    form.append('name', name);
    form.append('file', file);
    xhr.send(form);
  }
  return (
    <Modal
      title="Import a dataset"
      onClose={() => {
        if (progress === null) onClose();
      }}
    >
      <p className="muted">
        Upload JSON or CSV directly, or combine files in a ZIP. Each upload becomes a saved dataset.
      </p>
      <label
        className={`dropzone ${drag ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={drop}
      >
        <FileArchive size={30} />
        <strong>{file ? file.name : 'Drop JSON, CSV, or ZIP here, or browse files'}</strong>
        <span>
          {file
            ? bytes(file.size)
            : `JSON or CSV · ZIP can also contain JSONL, TXT, Markdown · Up to ${bytes(maxBytes)}`}
        </span>
        <input
          type="file"
          accept=".json,.csv,.zip,application/json,text/csv,application/zip"
          disabled={progress !== null}
          aria-label="Dataset file"
          onChange={(e) => choose(e.target.files?.[0])}
        />
      </label>
      <label className="field-label">
        Dataset name
        <input
          value={name}
          maxLength={150}
          disabled={progress !== null}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Customer messages · September"
        />
      </label>
      <ErrorNote error={error} />
      {progress !== null && (
        <div className="upload-progress">
          <progress value={progress} max={100} />
          <span>{progress === 100 ? 'Starting import…' : `Uploading ${progress}%`}</span>
        </div>
      )}
      <div className="modal-actions">
        <button className="secondary" onClick={onClose} disabled={progress !== null}>
          Cancel
        </button>
        <button
          className="primary"
          onClick={upload}
          disabled={!file || !name.trim() || progress !== null}
        >
          <Upload size={16} /> Import dataset
        </button>
      </div>
    </Modal>
  );
}
function DatasetPage({
  id,
  tab,
  runId,
  fromRun,
  config,
}: {
  id: string;
  tab: string;
  runId?: string;
  fromRun: string | null;
  config?: AppConfig;
}) {
  const dataset = useQuery({
    queryKey: ['dataset', id],
    queryFn: () => api<DatasetDetail>(`/datasets/${id}`),
    refetchInterval: (q) =>
      ['importing', 'needs_selection'].includes(q.state.data?.status || '') ? 1000 : false,
  });
  const [filter, setFilter] = useState<RecordFilter>({ search: '', sourceId: '' });
  const [selected, setSelected] = useState<number[]>([]);
  if (dataset.isLoading) return <Loading />;
  if (!dataset.data)
    return (
      <div className="page">
        <ErrorNote error={dataset.error} />
      </div>
    );
  const d = dataset.data;
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">DATASET WORKSPACE</div>
          <h1>{d.name}</h1>
          <p className="dataset-subtitle">
            {d.origin ? <AzureResourceIcon size={18} /> : <FileArchive size={14} />}
            {d.archiveName}
            <span>·</span>
            {number(d.recordCount)} records<span>·</span>
            {d.sources.length} sources<span>·</span>
            {bytes(d.bytes)}
          </p>
        </div>
        <div className="dataset-heading-actions">
          <Badge status={d.status} />
          <DatasetActions dataset={d} />
        </div>
      </div>
      {d.origin && (
        <details className="cosmos-origin">
          <summary>
            <AzureResourceIcon size={18} /> Azure Cosmos DB snapshot · {d.origin.accountHost}
          </summary>
          <p>
            {d.origin.databaseId} / {d.origin.containerId} · Limit: {number(d.origin.limit)} results
            {d.origin.completedAt && ` · Saved ${date(d.origin.completedAt)}`}
          </p>
          <pre className="json-view">{d.origin.query}</pre>
          <p>This is a saved local copy. Reimport to retrieve current query results.</p>
        </details>
      )}
      {d.status !== 'ready' ? (
        <ImportStatus dataset={d} />
      ) : (
        <>
          <div className="tabs">
            <button
              className={tab === 'data' ? 'active' : ''}
              onClick={() => navigate(`datasets/${id}`)}
            >
              <Database size={16} />
              Data
            </button>
            <button
              className={tab === 'experiment' ? 'active' : ''}
              onClick={() => navigate(`datasets/${id}/experiment`)}
            >
              <FlaskConical size={16} />
              New experiment
            </button>
            <button
              className={tab === 'runs' ? 'active' : ''}
              onClick={() => navigate(`datasets/${id}/runs`)}
            >
              <Layers3 size={16} />
              Run history
            </button>
          </div>
          {tab === 'experiment' ? (
            <Experiment
              dataset={d}
              filter={filter}
              selected={selected}
              fromRun={fromRun}
              appConfig={config}
              onStarted={(run) => navigate(`datasets/${id}/runs/${run.id}`)}
            />
          ) : tab === 'runs' ? (
            runId ? (
              <RunView key={runId} id={runId} datasetId={id} />
            ) : (
              <RunHistory datasetId={id} />
            )
          ) : (
            <DataView
              dataset={d}
              filter={filter}
              setFilter={(f) => {
                setFilter(f);
                setSelected([]);
              }}
              selected={selected}
              setSelected={setSelected}
              onExperiment={() => navigate(`datasets/${id}/experiment`)}
            />
          )}
        </>
      )}
      {!!d.warnings.length && (
        <details className="import-warnings">
          <summary>
            {d.warnings.length} import notice{d.warnings.length === 1 ? '' : 's'}
          </summary>
          {d.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </details>
      )}
    </div>
  );
}
function ImportStatus({ dataset }: { dataset: DatasetDetail }) {
  const client = useQueryClient();
  const [selections, setSelections] = useState<Record<string, string | null>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function resume() {
    setBusy(true);
    try {
      const choices = Object.fromEntries(
        dataset.sources
          .filter((s) => s.needsSelection)
          .map((s) => [s.id, Object.hasOwn(selections, s.id) ? selections[s.id] : null]),
      );
      await api(`/datasets/${dataset.id}/import`, { selections: choices });
      await client.invalidateQueries({ queryKey: ['dataset', dataset.id] });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (dataset.status === 'failed')
    return (
      <div className="panel">
        <h2>
          {dataset.origin ? 'We couldn’t import from Cosmos DB' : 'We couldn’t import this file'}
        </h2>
        <ErrorNote error={dataset.error} />
        <p className="muted">
          No partial records were kept.{' '}
          {dataset.origin
            ? 'Check the connection or query and start a new Cosmos DB import.'
            : 'Correct the file and upload it again.'}
        </p>
      </div>
    );
  if (dataset.status === 'needs_selection')
    return (
      <div className="panel import-selection">
        <span className="mini-label">
          <Braces size={15} /> ONE QUICK CHOICE
        </span>
        <h2>Where are your records?</h2>
        <p className="muted">
          These JSON files contain arrays inside an object. Choose an array to turn its elements
          into records, or keep the complete object as a single record.
        </p>
        {dataset.sources
          .filter((s) => s.needsSelection)
          .map((s) => (
            <label className="field-label" key={s.id}>
              {s.path}
              <select
                aria-label={`Records in ${s.path}`}
                value={selections[s.id] ?? '__document__'}
                onChange={(e) =>
                  setSelections({
                    ...selections,
                    [s.id]: e.target.value === '__document__' ? null : e.target.value,
                  })
                }
              >
                <option value="__document__">Keep the complete object as one record</option>
                {s.arrayPaths.map((p) => (
                  <option key={p} value={p}>
                    {p} — one record per array element
                  </option>
                ))}
              </select>
            </label>
          ))}
        <ErrorNote error={error} />
        <button className="primary" disabled={busy} onClick={resume}>
          Continue import <ArrowRight size={16} />
        </button>
      </div>
    );
  return (
    <div className="panel importing">
      <Loading label={dataset.origin ? 'Reading from Cosmos DB' : 'Preparing your dataset'} />
      <p className="muted">Reading your data. You can leave this page while the import finishes.</p>
      <progress
        value={dataset.origin ? undefined : dataset.processedFiles}
        max={dataset.totalFiles || 1}
      />
      <span>
        {!dataset.origin && `${dataset.processedFiles} / ${dataset.totalFiles || '…'} files · `}
        {number(dataset.recordCount)} records read
      </span>
    </div>
  );
}
