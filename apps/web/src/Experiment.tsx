import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Braces,
  ChevronDown,
  CircleHelp,
  Eye,
  FlaskConical,
  Layers3,
  ListFilter,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import {
  runConfigSchema,
  starters,
  type AppConfig,
  type DatasetDetail,
  type Question,
  type RecordFilter,
  type RequestPreview,
  type Run,
  type RunConfig,
} from '@jev/shared';
import { api, number } from './api';
import { ErrorNote, IconButton, JsonView, Loading, Modal } from './components';

interface DraftQuestion {
  id: string;
  type: Question['type'];
  instructions: string;
  choices: { label: string; description: string }[];
  levels: string[];
  yes: string;
  no: string;
}
function draft(q: Question): DraftQuestion {
  return {
    id: q.id,
    type: q.type,
    instructions: q.instructions,
    choices:
      q.type === 'choice'
        ? Object.entries(q.criteria).map(([label, description]) => ({
            label,
            description: description || '',
          }))
        : [
            { label: 'match', description: 'The record matches the condition.' },
            { label: 'other', description: 'The record does not match.' },
          ],
    levels:
      q.type === 'score'
        ? q.criteria
        : [
            'No relevant evidence.',
            'Some relevant evidence.',
            'Clear and specific relevant evidence.',
          ],
    yes: q.type === 'noul' ? q.criteria?.true || '' : '',
    no: q.type === 'noul' ? q.criteria?.false || '' : '',
  };
}
function question(d: DraftQuestion): Question {
  const base = { id: d.id, instructions: d.instructions };
  if (d.type === 'choice')
    return {
      ...base,
      type: 'choice',
      criteria: Object.fromEntries(d.choices.map((c) => [c.label.trim(), c.description || null])),
    };
  if (d.type === 'score') return { ...base, type: 'score', criteria: d.levels };
  return { ...base, type: 'noul', criteria: { true: d.yes, false: d.no } };
}
const descriptions = {
  choice: 'Pick one category. The result includes probabilities for each option.',
  noul: 'Ask whether something is true. The result is the probability of yes, from 0 to 1.',
  score: 'Measure one dimension using an ordered rubric. Results can fall between levels.',
};
export function Experiment({
  dataset,
  filter,
  selected,
  fromRun,
  appConfig,
  onStarted,
}: {
  dataset: DatasetDetail;
  filter: RecordFilter;
  selected: number[];
  fromRun: string | null;
  appConfig?: AppConfig;
  onStarted: (run: Run) => void;
}) {
  const [name, setName] = useState('My first experiment');
  const [model, setModel] = useState(appConfig?.model || 'jev-latest');
  const [questions, setQuestions] = useState<DraftQuestion[]>([draft(starters[0].question)]);
  const [fields, setFields] = useState<string[] | null>(null);
  const [context, setContext] = useState('');
  const [selection, setSelection] = useState<RunConfig['selection']>(
    selected.length ? { mode: 'selected', ids: selected } : { mode: 'sample', count: 10 },
  );
  const [runFilter, setRunFilter] = useState(filter);
  const [showPreview, setShowPreview] = useState(false);
  const [loadedRun, setLoadedRun] = useState<string | null>(null);
  useEffect(() => {
    if (!fromRun && appConfig?.model) setModel(appConfig.model);
  }, [appConfig?.model, fromRun]);
  const previous = useQuery({
    queryKey: ['run', fromRun],
    queryFn: () => api<Run>(`/runs/${fromRun}`),
    enabled: !!fromRun,
  });
  useEffect(() => {
    if (previous.data && loadedRun !== fromRun) {
      const c = previous.data.config;
      setName(`${c.name} · next run`);
      setModel(c.model);
      setQuestions(c.questions.map(draft));
      setFields(c.fields);
      setContext(c.context);
      setSelection(c.selection);
      setRunFilter(c.filter);
      setLoadedRun(fromRun);
    }
  }, [previous.data, fromRun, loadedRun]);
  const validation = useMemo(
    () =>
      runConfigSchema.safeParse({
        name,
        model,
        questions: questions.map(question),
        fields,
        context,
        selection,
        filter: runFilter,
      }),
    [name, model, questions, fields, context, selection, runFilter],
  );
  const duplicateCategories = questions.some(
    (q) =>
      q.type === 'choice' &&
      new Set(q.choices.map((c) => c.label.trim())).size !== q.choices.length,
  );
  const validationError = duplicateCategories
    ? 'Each category needs a unique name.'
    : fields?.length === 0
      ? 'Choose at least one input field.'
      : validation.success
        ? ''
        : validation.error.issues[0]?.message;
  const [previewConfig, setPreviewConfig] = useState<RunConfig | null>(null);
  useEffect(() => {
    const timer = setTimeout(
      () => setPreviewConfig(validation.success && !validationError ? validation.data : null),
      250,
    );
    return () => clearTimeout(timer);
  }, [validation, validationError]);
  const preview = useQuery({
    queryKey: ['preview', dataset.id, previewConfig],
    queryFn: () =>
      api<{
        count: number;
        matchingCount: number;
        recordId: number | null;
        request: RequestPreview | null;
      }>(`/datasets/${dataset.id}/preview`, previewConfig),
    enabled: !!previewConfig,
  });
  const run = useMutation({
    mutationFn: () =>
      api<Run>(`/datasets/${dataset.id}/runs`, validation.success ? validation.data : null),
    onSuccess: onStarted,
  });
  const previewCurrent =
    validation.success && JSON.stringify(validation.data) === JSON.stringify(previewConfig);
  function add(index: number) {
    const next = draft(starters[index].question);
    while (questions.some((q) => q.id === next.id)) next.id += '_2';
    setQuestions([...questions, next]);
  }
  function update(index: number, q: DraftQuestion) {
    setQuestions(questions.map((v, i) => (i === index ? q : v)));
  }
  if (fromRun && previous.isLoading) return <Loading label="Loading previous configuration…" />;
  return (
    <section>
      <div className="section-heading">
        <div>
          <h2>A small question can tell you a lot.</h2>
          <p>Choose what Jev should judge, then try it on a few records.</p>
        </div>
        <span className="subtle-label">
          <Sparkles size={14} /> Guided experiment
        </span>
      </div>
      <ErrorNote error={previous.error} />
      <div className="starter-grid">
        {starters.map((s, i) => (
          <button
            key={s.name}
            className={`starter-card starter-${s.question.type}`}
            onClick={() => add(i)}
          >
            <span className="starter-icon">
              {i === 0 ? (
                <Layers3 size={18} />
              ) : i === 1 ? (
                <CircleHelp size={18} />
              ) : (
                <SlidersHorizontal size={18} />
              )}
            </span>
            <span>
              <strong>{s.name}</strong>
              <small>{s.description}</small>
            </span>
            <Plus size={16} />
          </button>
        ))}
      </div>
      <div className="experiment-layout">
        <div className="experiment-main">
          <div className="panel">
            <label className="field-label">
              Experiment name
              <input value={name} maxLength={150} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          {questions.map((q, index) => (
            <div className="panel question-panel" key={index}>
              <div className="question-heading">
                <span className="question-number">{String(index + 1).padStart(2, '0')}</span>
                <h3>Question {index + 1}</h3>
                <select
                  aria-label={`Type for question ${index + 1}`}
                  value={q.type}
                  onChange={(e) =>
                    update(index, { ...q, type: e.target.value as Question['type'] })
                  }
                >
                  <option value="choice">Choice · classify</option>
                  <option value="noul">Noul · detect</option>
                  <option value="score">Score · rank</option>
                </select>
                <IconButton
                  label={`Remove question ${index + 1}`}
                  onClick={() => setQuestions(questions.filter((_, i) => i !== index))}
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
              <p className="question-help">{descriptions[q.type]}</p>
              <label className="field-label">
                What should Jev decide?
                <textarea
                  rows={3}
                  value={q.instructions}
                  onChange={(e) => update(index, { ...q, instructions: e.target.value })}
                />
              </label>
              {q.type === 'choice' && (
                <div className="criteria-editor">
                  <div className="field-caption">
                    CATEGORIES <span>Include an “other” option when useful</span>
                  </div>
                  {q.choices.map((c, i) => (
                    <div className="choice-row" key={i}>
                      <input
                        aria-label={`Category ${i + 1} name for question ${index + 1}`}
                        placeholder="Category"
                        value={c.label}
                        onChange={(e) =>
                          update(index, {
                            ...q,
                            choices: q.choices.map((v, n) =>
                              n === i ? { ...v, label: e.target.value } : v,
                            ),
                          })
                        }
                      />
                      <input
                        aria-label={`Category ${i + 1} description for question ${index + 1}`}
                        placeholder="When this category applies"
                        value={c.description}
                        onChange={(e) =>
                          update(index, {
                            ...q,
                            choices: q.choices.map((v, n) =>
                              n === i ? { ...v, description: e.target.value } : v,
                            ),
                          })
                        }
                      />
                      <IconButton
                        label={`Remove category ${i + 1}`}
                        onClick={() =>
                          update(index, { ...q, choices: q.choices.filter((_, n) => n !== i) })
                        }
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  ))}
                  <button
                    className="text-button"
                    onClick={() =>
                      update(index, {
                        ...q,
                        choices: [...q.choices, { label: '', description: '' }],
                      })
                    }
                  >
                    <Plus size={14} />
                    Add category
                  </button>
                </div>
              )}
              {q.type === 'score' && (
                <div className="criteria-editor">
                  <div className="field-caption">
                    RUBRIC <span>Low to high · describe concrete situations</span>
                  </div>
                  {q.levels.map((level, i) => (
                    <div className="level-row" key={i}>
                      <span>{i}</span>
                      <input
                        aria-label={`Level ${i} for question ${index + 1}`}
                        value={level}
                        onChange={(e) =>
                          update(index, {
                            ...q,
                            levels: q.levels.map((v, n) => (n === i ? e.target.value : v)),
                          })
                        }
                      />
                      <IconButton
                        label={`Remove level ${i}`}
                        onClick={() =>
                          update(index, { ...q, levels: q.levels.filter((_, n) => n !== i) })
                        }
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  ))}
                  <button
                    className="text-button"
                    disabled={q.levels.length >= 10}
                    onClick={() => update(index, { ...q, levels: [...q.levels, ''] })}
                  >
                    <Plus size={14} />
                    Add level
                  </button>
                </div>
              )}
              {q.type === 'noul' && (
                <div className="noul-criteria">
                  <label className="field-label">
                    Yes means <small>optional</small>
                    <textarea
                      rows={2}
                      value={q.yes}
                      onChange={(e) => update(index, { ...q, yes: e.target.value })}
                    />
                  </label>
                  <label className="field-label">
                    No means <small>optional</small>
                    <textarea
                      rows={2}
                      value={q.no}
                      onChange={(e) => update(index, { ...q, no: e.target.value })}
                    />
                  </label>
                </div>
              )}
              <details className="advanced">
                <summary>
                  Question identifier <code>{q.id}</code>
                </summary>
                <label className="field-label">
                  ID in results
                  <input
                    value={q.id}
                    onChange={(e) => update(index, { ...q, id: e.target.value })}
                  />
                </label>
              </details>
            </div>
          ))}
          {!questions.length && (
            <div className="empty-inline">Choose a starter above to add your first question.</div>
          )}
          <div className="panel">
            <h3>Shared reference context</h3>
            <p className="muted">
              Add a topic, policy, or definition that every record should be evaluated against.
            </p>
            <textarea
              aria-label="Shared reference context"
              rows={4}
              placeholder="For example: Find messages about problems with account access…"
              value={context}
              onChange={(e) => setContext(e.target.value)}
            />
          </div>
        </div>
        <aside className="run-settings">
          <div className="panel">
            <h3>
              <ListFilter size={17} /> Run settings
            </h3>
            <label className="field-label">
              Records to evaluate
              <select
                aria-label="Records to evaluate"
                value={selection.mode}
                onChange={(e) =>
                  setSelection(
                    e.target.value === 'all'
                      ? { mode: 'all' }
                      : e.target.value === 'selected'
                        ? { mode: 'selected', ids: selected }
                        : { mode: 'sample', count: 10 },
                  )
                }
              >
                <option value="sample">Random sample</option>
                <option value="all">All matching records</option>
                <option
                  value="selected"
                  disabled={!selected.length && selection.mode !== 'selected'}
                >
                  Selected records{selected.length ? ` (${selected.length})` : ''}
                </option>
              </select>
            </label>
            {selection.mode === 'sample' && (
              <label className="field-label">
                Sample size
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={selection.count}
                  onChange={(e) => setSelection({ mode: 'sample', count: Number(e.target.value) })}
                />
              </label>
            )}
            {(runFilter.search || runFilter.sourceId) && (
              <div className="filter-context">
                Using your data filters.
                <button
                  className="text-button"
                  onClick={() => setRunFilter({ search: '', sourceId: '' })}
                >
                  Clear filters
                </button>
              </div>
            )}
            <div className="settings-divider" />
            <div className="field-caption">INPUT FIELDS</div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={fields === null}
                onChange={(e) => setFields(e.target.checked ? null : [...dataset.fields])}
              />
              Include all fields
            </label>
            {fields !== null && (
              <div className="field-checklist">
                {dataset.fields.map((field) => (
                  <label className="checkbox-label" key={field}>
                    <input
                      type="checkbox"
                      checked={fields.includes(field)}
                      onChange={(e) =>
                        setFields(
                          e.target.checked ? [...fields, field] : fields.filter((f) => f !== field),
                        )
                      }
                    />
                    {field}
                  </label>
                ))}
              </div>
            )}
            <p className="tiny-muted">
              Each selected record is sent to TypeSafe with these fields and your questions.
            </p>
            <details className="advanced">
              <summary>
                Model <ChevronDown size={13} />
              </summary>
              <label className="field-label">
                Model name
                <input value={model} onChange={(e) => setModel(e.target.value)} />
              </label>
            </details>
            <div className="settings-divider" />
            <div className="run-totals">
              <span>
                Records <b>{previewCurrent && preview.data ? number(preview.data.count) : '—'}</b>
              </span>
              <span>
                Questions per record <b>{questions.length}</b>
              </span>
              <span>
                Jev requests{' '}
                <b>{previewCurrent && preview.data ? number(preview.data.count) : '—'}</b>
              </span>
            </div>
            <button
              className="secondary full-width"
              disabled={!preview.data?.request || !previewCurrent}
              onClick={() => setShowPreview(true)}
            >
              <Eye size={15} />
              Preview a request
            </button>
            {!appConfig?.hasApiKey && (
              <div className="key-notice">
                <strong>Connect Jev to run</strong>
                <span>
                  Add <code>TYPESAFE_API_KEY</code> to your <code>.env</code> file and restart the
                  backend. You can keep exploring your data.
                </span>
              </div>
            )}
            <ErrorNote error={validationError || preview.error || run.error} />
            <button
              className="primary full-width run-button"
              disabled={
                !appConfig?.hasApiKey ||
                !!validationError ||
                !previewCurrent ||
                !preview.data?.count ||
                preview.isFetching ||
                run.isPending
              }
              onClick={() => run.mutate()}
            >
              <FlaskConical size={16} />
              {run.isPending ? 'Starting…' : 'Run experiment'}
              <ArrowRight size={15} />
            </button>
            <p className="tiny-muted centered">
              Your questions and results are saved in run history.
            </p>
          </div>
          <div className="tip-card">
            <Sparkles size={17} />
            <strong>Start small. Learn, then scale.</strong>
            <p>
              Try a few records first. Refine your categories or rubric before running across the
              full dataset.
            </p>
          </div>
        </aside>
      </div>
      {showPreview && (
        <Modal title="Request preview" wide onClose={() => setShowPreview(false)}>
          <p className="muted">
            Example record #{preview.data?.recordId}. Each evaluated record gets this request
            structure. A random sample is chosen and saved when you start.
          </p>
          <JsonView value={preview.data?.request} />
        </Modal>
      )}
    </section>
  );
}
