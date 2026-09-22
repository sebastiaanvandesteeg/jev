import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Clock3,
  Copy,
  FlaskConical,
  Play,
  Square,
  Timer,
  Zap,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  buildRequest,
  type Answer,
  type Page,
  type Run,
  type RunDetail,
  type RunResult,
} from '@jev/shared';
import { api, date, navigate, number, queryString } from './api';
import { Badge, ErrorNote, JsonView, Loading, Modal, Pagination } from './components';

export function RunHistory({ datasetId }: { datasetId: string }) {
  const runs = useQuery({
    queryKey: ['runs', datasetId],
    queryFn: () => api<Run[]>(`/datasets/${datasetId}/runs`),
    refetchInterval: 2000,
  });
  return (
    <section>
      <div className="section-heading">
        <div>
          <h2>Every experiment, kept in context.</h2>
          <p>Revisit answers, inspect your settings, and build on what you learned.</p>
        </div>
        <button className="primary" onClick={() => navigate(`datasets/${datasetId}/experiment`)}>
          <FlaskConical size={16} />
          New experiment
        </button>
      </div>
      <ErrorNote error={runs.error} />
      {runs.isLoading ? (
        <Loading />
      ) : !runs.data?.length ? (
        <div className="empty-panel">
          <Clock3 size={30} />
          <h3>Your experiments will live here</h3>
          <p>Run your first question to start building a history of discoveries.</p>
          <button
            className="secondary"
            onClick={() => navigate(`datasets/${datasetId}/experiment`)}
          >
            Create an experiment <ArrowRight size={15} />
          </button>
        </div>
      ) : (
        <div className="table-panel">
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Experiment</th>
                  <th>Status</th>
                  <th>Records</th>
                  <th>Questions</th>
                  <th>Input tokens</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.data.map((run) => (
                  <tr key={run.id} onClick={() => navigate(`datasets/${datasetId}/runs/${run.id}`)}>
                    <td>
                      <strong>{run.name}</strong>
                      <small className="table-subtext">{run.config.model}</small>
                    </td>
                    <td>
                      <Badge status={run.status} />
                    </td>
                    <td>
                      {number(run.succeeded + run.failed)} / {number(run.total)}
                    </td>
                    <td>{run.config.questions.length}</td>
                    <td>{number(run.inputTokens)}</td>
                    <td>{date(run.createdAt)}</td>
                    <td>
                      <ArrowRight size={16} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
function AnswerCell({ answer }: { answer?: Answer }) {
  if (!answer) return <span className="null-value">—</span>;
  if (answer.type === 'noul') {
    const outcome = answer.noul === 0.5 ? 'yes / no' : answer.noul > 0.5 ? 'yes' : 'no';
    const probability = Math.max(answer.noul, 1 - answer.noul);
    return (
      <div
        className="answer-cell"
        title={`P(yes): ${(answer.noul * 100).toFixed(1)}% · P(no): ${((1 - answer.noul) * 100).toFixed(1)}%`}
      >
        <strong>{`${(probability * 100).toFixed(1)}% ${outcome}`}</strong>
        <div className="probability-track">
          <i style={{ width: `${probability * 100}%` }} />
        </div>
      </div>
    );
  }
  const value = answer.type === 'choice' ? answer.choice : answer.score.toFixed(2);
  return (
    <div className="answer-cell">
      <strong>{value}</strong>
      <small>{Math.round(answer.confidence * 100)}% confidence</small>
    </div>
  );
}
export function RunView({ id, datasetId }: { id: string; datasetId: string }) {
  const client = useQueryClient();
  const run = useQuery({
    queryKey: ['run', id],
    queryFn: () => api<RunDetail>(`/runs/${id}`),
    refetchInterval: (q) =>
      ['queued', 'running'].includes(q.state.data?.status || '') ? 2000 : false,
  });
  const [page, setPage] = useState(1);
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [minimum, setMinimum] = useState('');
  const [confidence, setConfidence] = useState('');
  const [direction, setDirection] = useState('desc');
  const [detail, setDetail] = useState<RunResult | null>(null);
  const filters = { question, status, category, minimum, confidence, direction };
  const isActive = ['queued', 'running'].includes(run.data?.status || '');
  const results = useQuery({
    queryKey: ['results', id, filters, page],
    queryFn: () => api<Page<RunResult>>(`/runs/${id}/results?${queryString({ ...filters, page })}`),
    refetchInterval: isActive ? 2000 : false,
  });
  useEffect(() => {
    if (run.data && !isActive) void client.invalidateQueries({ queryKey: ['results', id] });
  }, [isActive, run.data?.status, id, client]);
  useEffect(() => setPage(1), [question, status, category, minimum, confidence, direction]);
  const action = useMutation({
    mutationFn: (action: string) => api(`/runs/${id}/${action}`, {}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['run', id] });
      void client.invalidateQueries({ queryKey: ['runs', datasetId] });
    },
  });
  if (run.isLoading) return <Loading />;
  if (!run.data) return <ErrorNote error={run.error} />;
  const r = run.data;
  const selectedQuestion = r.config.questions.find((q) => q.id === question);
  const done = r.succeeded + r.failed;
  return (
    <section>
      <button className="back-link" onClick={() => navigate(`datasets/${datasetId}/runs`)}>
        <ArrowLeft size={14} />
        All runs
      </button>
      <div className="section-heading run-heading">
        <div>
          <div className="title-with-badge">
            <h2>{r.name}</h2>
            <Badge status={r.status} />
          </div>
          <p>
            Created {date(r.createdAt)} · {r.config.questions.length} questions per record
          </p>
        </div>
        <div className="button-row">
          {isActive && (
            <button
              className="secondary"
              disabled={action.isPending}
              onClick={() => action.mutate('cancel')}
            >
              <Square size={13} />
              Cancel run
            </button>
          )}
          {r.status === 'interrupted' && (
            <button
              className="secondary"
              disabled={action.isPending}
              onClick={() => action.mutate('resume')}
            >
              <Play size={14} />
              Resume run
            </button>
          )}
          <button
            className="primary"
            onClick={() => navigate(`datasets/${datasetId}/experiment?from=${id}`)}
          >
            <Copy size={15} />
            Use this configuration again
          </button>
        </div>
      </div>
      <ErrorNote error={action.error || r.error} />
      {r.status === 'interrupted' && (
        <p className="muted">
          Completed results are preserved. Resuming sends only unfinished records; a request
          interrupted before its result was saved may be charged again.
        </p>
      )}
      <div className="run-stat-grid">
        <div>
          <span>Records processed</span>
          <strong>
            {number(done)}
            <small> / {number(r.total)}</small>
          </strong>
          <progress value={done} max={r.total} />
        </div>
        <div>
          <span>Successful answers</span>
          <strong>{number(r.succeeded)}</strong>
          <small>
            {r.failed ? `${number(r.failed)} failed records` : 'Results saved as they arrive'}
          </small>
        </div>
        <div>
          <span>
            <Zap size={13} />
            Tokens used
          </span>
          <strong>{number(r.inputTokens)}</strong>
          <small>{number(r.outputTokens)} output tokens</small>
        </div>
        <div>
          <span>
            <Timer size={13} />
            Total request time
          </span>
          <strong>
            {(r.durationMs / 1000).toFixed(1)}
            <small> s</small>
          </strong>
          <small>Sum across concurrent requests</small>
        </div>
      </div>
      {!!r.succeeded && (
        <div className="summary-grid">
          {r.summaries.map((summary) => {
            const q = r.config.questions.find((q) => q.id === summary.id)!;
            const numeric = q.type !== 'choice';
            const max = q.type === 'score' ? q.criteria.length - 1 : 1;
            const data = numeric
              ? [{ name: 'Average', value: summary.average || 0 }]
              : summary.categories.map((c) => ({ name: c.name, value: c.count }));
            return (
              <div className="panel summary-card" key={summary.id}>
                <div className="summary-title">
                  <strong>{summary.id}</strong>
                  <span className={`primitive-chip ${summary.type}`}>{summary.type}</span>
                </div>
                <p>
                  {numeric
                    ? summary.type === 'noul'
                      ? `Mean probability of yes: ${((summary.average || 0) * 100).toFixed(1)}%`
                      : `Mean score: ${(summary.average || 0).toFixed(2)} / ${max}`
                    : `${summary.categories.length} categories across ${summary.count} records`}
                </p>
                <div className="chart-container">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={data}
                      layout="vertical"
                      margin={{ top: 0, right: 15, bottom: 0, left: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e8ecef" />
                      <XAxis
                        type="number"
                        domain={numeric ? [0, max] : [0, 'auto']}
                        tick={{ fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                        allowDecimals={numeric}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={70}
                        tick={{ fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip />
                      <Bar
                        dataKey="value"
                        fill="#518478"
                        radius={[0, 4, 4, 0]}
                        maxBarSize={17}
                        isAnimationActive={false}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="section-heading results-heading">
        <div>
          <h2>Record results</h2>
          <p>
            Filter saved answers without another Jev request. Open a row for probabilities and the
            exact input.
          </p>
        </div>
        <div className="button-row">
          <a
            className="secondary"
            href={`/api/runs/${id}/export?${queryString({ ...filters, format: 'csv' })}`}
          >
            <ArrowDownToLine size={14} />
            CSV
          </a>
          <a
            className="secondary"
            href={`/api/runs/${id}/export?${queryString({ ...filters, format: 'json' })}`}
          >
            <ArrowDownToLine size={14} />
            JSON
          </a>
        </div>
      </div>
      <div className="table-panel">
        <div className="table-toolbar result-toolbar">
          <select
            aria-label="Filter result status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="succeeded">Successful</option>
            <option value="failed">Failed</option>
            <option value="pending">Pending</option>
            <option value="running">Running</option>
          </select>
          <select
            aria-label="Sort and filter by question"
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
              setCategory('');
              setMinimum('');
              setConfidence('');
            }}
          >
            <option value="">Record order</option>
            {r.config.questions.map((q) => (
              <option key={q.id} value={q.id}>
                {q.id}
              </option>
            ))}
          </select>
          {selectedQuestion && (
            <>
              <select
                aria-label="Sort direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                <option value="desc">
                  {selectedQuestion.type === 'noul' ? 'Most likely yes first' : 'Highest first'}
                </option>
                <option value="asc">
                  {selectedQuestion.type === 'noul' ? 'Most likely no first' : 'Lowest first'}
                </option>
              </select>
              {selectedQuestion.type === 'choice' ? (
                <select
                  aria-label="Filter category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">All categories</option>
                  {Object.keys(selectedQuestion.criteria).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <label className="inline-field">
                  Min {selectedQuestion.type === 'noul' ? 'P(yes)' : 'score'}
                  <input
                    aria-label="Minimum value"
                    type="number"
                    min={0}
                    max={
                      selectedQuestion.type === 'noul' ? 1 : selectedQuestion.criteria.length - 1
                    }
                    step="0.05"
                    placeholder="Any"
                    value={minimum}
                    onChange={(e) => setMinimum(e.target.value)}
                  />
                </label>
              )}
              {selectedQuestion.type !== 'noul' && (
                <label className="inline-field">
                  Min confidence
                  <input
                    aria-label="Minimum confidence"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    placeholder="Any"
                    value={confidence}
                    onChange={(e) => setConfidence(e.target.value)}
                  />
                </label>
              )}
            </>
          )}
        </div>
        <ErrorNote error={results.error} />
        {results.isLoading ? (
          <Loading />
        ) : (
          <div className="table-scroll">
            <table className="results-table">
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Status</th>
                  {r.config.questions.map((q) => (
                    <th key={q.id}>
                      {q.id}
                      <span className="table-subtext">
                        {q.type === 'noul'
                          ? 'Most likely outcome'
                          : q.type === 'score'
                            ? `Score · 0–${q.criteria.length - 1}`
                            : 'Category'}
                      </span>
                    </th>
                  ))}
                  <th>Request time</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {results.data?.items.map((row) => (
                  <tr key={row.recordId} onClick={() => setDetail(row)}>
                    <td>
                      <strong>#{row.recordId}</strong>
                      <span className="record-snippet">
                        {String(
                          row.data.title ??
                            row.data.subject ??
                            row.data.text ??
                            row.data.message ??
                            JSON.stringify(row.data),
                        )}
                      </span>
                    </td>
                    <td>
                      <Badge status={row.status} />
                    </td>
                    {r.config.questions.map((q) => (
                      <td key={q.id}>
                        <AnswerCell answer={row.response?.answers[q.id]} />
                      </td>
                    ))}
                    <td>
                      {row.status === 'succeeded' || row.status === 'failed'
                        ? `${row.durationMs} ms`
                        : '—'}
                    </td>
                    <td className="source-cell">{row.sourcePath}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!results.data?.items.length && (
              <div className="empty-inline">No results match these filters.</div>
            )}
          </div>
        )}
        <Pagination page={page} pageSize={25} total={results.data?.total || 0} onChange={setPage} />
      </div>
      <details className="panel configuration-panel">
        <summary>
          Saved configuration <span>{r.models.length ? r.models.join(', ') : r.config.model}</span>
        </summary>
        <JsonView value={r.config} />
      </details>
      {detail && (
        <Modal wide title={`Result · Record #${detail.recordId}`} onClose={() => setDetail(null)}>
          <div className="result-detail-meta">
            <Badge status={detail.status} />
            <span>
              {detail.sourcePath} · Source record {detail.position}
            </span>
          </div>
          <ErrorNote error={detail.error} />
          <h3>Jev response</h3>
          {detail.response ? (
            <JsonView value={detail.response} />
          ) : (
            <p className="muted">No response has been saved for this record.</p>
          )}
          <h3>Exact input request</h3>
          <JsonView value={buildRequest(detail.data, r.config)} />
          <details>
            <summary>Original record</summary>
            <JsonView value={detail.data} />
          </details>
        </Modal>
      )}
    </section>
  );
}
