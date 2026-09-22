import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { Braces, Columns3, FlaskConical, Search } from 'lucide-react';
import type { DataRecord, DatasetDetail, Page, RecordFilter } from '@jev/shared';
import { api, queryString } from './api';
import { ErrorNote, JsonView, Loading, Modal, Pagination } from './components';

export function DataView({
  dataset,
  filter,
  setFilter,
  selected,
  setSelected,
  onExperiment,
}: {
  dataset: DatasetDetail;
  filter: RecordFilter;
  setFilter: (f: RecordFilter) => void;
  selected: number[];
  setSelected: (s: number[]) => void;
  onExperiment: () => void;
}) {
  const [page, setPage] = useState(1);
  const [visible, setVisible] = useState(
    [
      ...new Set([
        ...['id', 'title', 'subject', 'message', 'text'].filter((f) => dataset.fields.includes(f)),
        ...dataset.fields,
      ]),
    ].slice(0, 7),
  );
  const [record, setRecord] = useState<DataRecord | null>(null);
  const data = useQuery({
    queryKey: ['records', dataset.id, filter, page],
    queryFn: () =>
      api<Page<DataRecord>>(`/datasets/${dataset.id}/records?${queryString({ ...filter, page })}`),
  });
  useEffect(() => {
    setPage(1);
  }, [filter]);
  function toggle(id: number) {
    setSelected(selected.includes(id) ? selected.filter((n) => n !== id) : [...selected, id]);
  }
  const columns = useMemo<ColumnDef<DataRecord>[]>(
    () => [
      {
        id: 'select',
        header: () => (
          <input
            type="checkbox"
            aria-label="Select this page"
            checked={
              !!data.data?.items.length && data.data.items.every((r) => selected.includes(r.id))
            }
            onChange={(e) =>
              setSelected(
                e.target.checked
                  ? [...new Set([...selected, ...(data.data?.items.map((r) => r.id) || [])])]
                  : selected.filter((id) => !data.data?.items.some((r) => r.id === id)),
              )
            }
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select record ${row.original.id}`}
            checked={selected.includes(row.original.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => toggle(row.original.id)}
          />
        ),
      },
      {
        id: 'row',
        header: '#',
        cell: ({ row }) => <span className="row-number">{row.original.id}</span>,
      },
      ...visible.map((field) => ({
        id: `field:${field}`,
        header: field,
        cell: ({ row }: { row: { original: DataRecord } }) => {
          const value = row.original.data[field];
          if (value === undefined || value === null)
            return <span className="null-value">{value === null ? 'null' : '—'}</span>;
          if (typeof value === 'object')
            return (
              <span className="object-value">
                <Braces size={12} />
                {Array.isArray(value)
                  ? `Array (${value.length})`
                  : `Object (${Object.keys(value).length})`}
              </span>
            );
          return (
            <span title={String(value)} className={typeof value === 'number' ? 'numeric-cell' : ''}>
              {String(value)}
            </span>
          );
        },
      })),
      {
        id: 'source',
        header: 'Source file',
        cell: ({ row }) => (
          <span className="source-cell" title={row.original.sourcePath}>
            {row.original.sourcePath}
          </span>
        ),
      },
    ],
    [visible, selected, data.data],
  );
  const table = useReactTable({
    data: data.data?.items || [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  return (
    <section>
      <div className="section-heading">
        <div>
          <h2>A closer look at your data</h2>
          <p>{dataset.fields.length} detected fields. Open any row to see the complete record.</p>
        </div>
        <button className="primary" onClick={onExperiment}>
          <FlaskConical size={16} />
          {selected.length ? `Experiment on ${selected.length} selected` : 'Create experiment'}
        </button>
      </div>
      <div className="table-panel">
        <div className="table-toolbar">
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="Search records"
              placeholder="Search records…"
              value={filter.search}
              onChange={(e) => setFilter({ ...filter, search: e.target.value })}
            />
          </div>
          <select
            className="source-select"
            aria-label="Filter by source"
            value={filter.sourceId}
            onChange={(e) => setFilter({ ...filter, sourceId: e.target.value })}
          >
            <option value="">All source files</option>
            {dataset.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.path} ({s.recordCount})
              </option>
            ))}
          </select>
          <details className="column-picker">
            <summary>
              <Columns3 size={15} /> Columns
            </summary>
            <div className="column-menu">
              {dataset.fields.map((field) => (
                <label key={field}>
                  <input
                    type="checkbox"
                    checked={visible.includes(field)}
                    onChange={(e) =>
                      setVisible(
                        e.target.checked ? [...visible, field] : visible.filter((f) => f !== field),
                      )
                    }
                  />
                  {field}
                </label>
              ))}
            </div>
          </details>
        </div>
        {!!selected.length && (
          <div className="selection-bar">
            {selected.length} records selected{' '}
            <button onClick={() => setSelected([])}>Clear selection</button>
          </div>
        )}
        <ErrorNote error={data.error} />
        {data.isLoading ? (
          <Loading />
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                {table.getHeaderGroups().map((group) => (
                  <tr key={group.id}>
                    {group.headers.map((header) => (
                      <th key={header.id}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setRecord(row.original)}
                    className={selected.includes(row.original.id) ? 'selected-row' : ''}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.data?.items.length && (
              <div className="empty-inline">No records match these filters.</div>
            )}
          </div>
        )}
        <Pagination page={page} pageSize={25} total={data.data?.total || 0} onChange={setPage} />
      </div>
      <div className="data-footnote">
        <Braces size={14} />
        Nested objects and arrays are preserved. Input fields can be chosen when creating an
        experiment.
      </div>
      {record && (
        <Modal title={`Record #${record.id}`} wide onClose={() => setRecord(null)}>
          <p className="muted">
            {record.sourcePath} · Source record {record.position}
          </p>
          <JsonView value={record.data} />
        </Modal>
      )}
    </section>
  );
}
