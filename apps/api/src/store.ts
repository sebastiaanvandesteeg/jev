import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  DataRecord,
  Dataset,
  DatasetDetail,
  Page,
  RecordFilter,
  Run,
  RunConfig,
  RunDetail,
  RunResult,
  SourceFile,
} from '@jev/shared';
import { HttpError } from './errors.js';

type Row = Record<string, any>;
export class Store {
  db: DatabaseSync;
  constructor(public dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, archiveName TEXT NOT NULL, bytes INTEGER NOT NULL,
        createdAt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'importing', recordCount INTEGER NOT NULL DEFAULT 0,
        processedFiles INTEGER NOT NULL DEFAULT 0, totalFiles INTEGER NOT NULL DEFAULT 0,
        fields TEXT NOT NULL DEFAULT '[]', warnings TEXT NOT NULL DEFAULT '[]', error TEXT
      );
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, datasetId TEXT NOT NULL REFERENCES datasets(id), path TEXT NOT NULL, format TEXT NOT NULL,
        recordCount INTEGER NOT NULL DEFAULT 0, arrayPaths TEXT NOT NULL DEFAULT '[]', arrayPointer TEXT,
        needsSelection INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT, datasetId TEXT NOT NULL REFERENCES datasets(id),
        sourceId TEXT NOT NULL REFERENCES sources(id), position INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_dataset ON records(datasetId, id);
      CREATE INDEX IF NOT EXISTS records_source ON records(sourceId, id);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, datasetId TEXT NOT NULL REFERENCES datasets(id), name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', config TEXT NOT NULL, createdAt TEXT NOT NULL,
        startedAt TEXT, finishedAt TEXT, total INTEGER NOT NULL,
        succeeded INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
        durationMs INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_dataset ON runs(datasetId, createdAt);
      CREATE TABLE IF NOT EXISTS run_records (
        runId TEXT NOT NULL REFERENCES runs(id), recordId INTEGER NOT NULL REFERENCES records(id),
        status TEXT NOT NULL DEFAULT 'pending', response TEXT, error TEXT,
        durationMs INTEGER NOT NULL DEFAULT 0, startedAt TEXT, finishedAt TEXT,
        PRIMARY KEY(runId, recordId)
      );
      CREATE INDEX IF NOT EXISTS run_records_status ON run_records(runId, status, recordId);
    `);
    // Additive migration: existing file datasets have no external origin.
    if (!this.all('PRAGMA table_info(datasets)').some((column) => column.name === 'origin'))
      this.db.exec('ALTER TABLE datasets ADD COLUMN origin TEXT');
    this.db.exec('PRAGMA user_version = 2');
  }
  all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params);
  }
  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params);
  }
  exec(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  recover() {
    this.transaction(() => {
      this.exec(
        "UPDATE runs SET status='interrupted', error='The server stopped before this run finished. Resume to process unfinished records.' WHERE status IN ('queued','running')",
      );
      this.exec("UPDATE run_records SET status='pending', startedAt=NULL WHERE status='running'");
      const imports = this.all("SELECT id FROM datasets WHERE status='importing'");
      for (const { id } of imports) {
        this.exec('DELETE FROM records WHERE datasetId=?', id);
        this.exec('UPDATE sources SET recordCount=0 WHERE datasetId=?', id);
        this.exec(
          "UPDATE datasets SET status='failed', recordCount=0, fields='[]', processedFiles=0, bytes=CASE WHEN origin IS NULL THEN bytes ELSE 0 END, error=CASE WHEN origin IS NULL THEN 'The server stopped during import. Upload the file again.' ELSE 'The server stopped during the Cosmos DB import. Run the query again to create a new snapshot.' END WHERE id=?",
          id,
        );
      }
    });
  }
  datasets(): Dataset[] {
    return this.all('SELECT * FROM datasets ORDER BY createdAt DESC').map(this.decodeDataset);
  }
  decodeDataset(row: Row): Dataset {
    return {
      ...row,
      fields: JSON.parse(row.fields),
      warnings: JSON.parse(row.warnings),
      origin: row.origin ? JSON.parse(row.origin) : null,
    } as Dataset;
  }
  dataset(id: string): DatasetDetail {
    const row = this.get('SELECT * FROM datasets WHERE id=?', id);
    if (!row) throw new HttpError(404, 'Dataset not found.');
    return { ...this.decodeDataset(row), sources: this.sources(id) };
  }
  renameDataset(id: string, name: string): DatasetDetail {
    this.dataset(id);
    this.exec('UPDATE datasets SET name=? WHERE id=?', name, id);
    return this.dataset(id);
  }
  deleteDataset(id: string) {
    this.transaction(() => {
      this.exec(
        'DELETE FROM run_records WHERE runId IN (SELECT id FROM runs WHERE datasetId=?)',
        id,
      );
      this.exec('DELETE FROM runs WHERE datasetId=?', id);
      this.exec('DELETE FROM records WHERE datasetId=?', id);
      this.exec('DELETE FROM sources WHERE datasetId=?', id);
      this.exec('DELETE FROM datasets WHERE id=?', id);
    });
  }
  sources(id: string): SourceFile[] {
    return this.all('SELECT * FROM sources WHERE datasetId=? ORDER BY path', id).map(
      (row) =>
        ({
          ...row,
          arrayPaths: JSON.parse(row.arrayPaths),
          needsSelection: Boolean(row.needsSelection),
        }) as SourceFile,
    );
  }
  recordWhere(datasetId: string, filter: RecordFilter, alias = 'r') {
    const clauses = [`${alias}.datasetId=?`];
    const params: SQLInputValue[] = [datasetId];
    if (filter.sourceId) {
      clauses.push(`${alias}.sourceId=?`);
      params.push(filter.sourceId);
    }
    if (filter.search) {
      clauses.push(`instr(lower(${alias}.data), lower(?)) > 0`);
      params.push(filter.search);
    }
    return { sql: clauses.join(' AND '), params };
  }
  records(datasetId: string, filter: RecordFilter, page = 1, pageSize = 25): Page<DataRecord> {
    const where = this.recordWhere(datasetId, filter);
    const total = this.get(
      `SELECT count(*) AS n FROM records r WHERE ${where.sql}`,
      ...where.params,
    )!.n;
    const items = this.all(
      `SELECT r.*, s.path AS sourcePath FROM records r JOIN sources s ON s.id=r.sourceId WHERE ${where.sql} ORDER BY r.id LIMIT ? OFFSET ?`,
      ...where.params,
      pageSize,
      (page - 1) * pageSize,
    ).map((row) => ({ ...row, data: JSON.parse(row.data) }) as DataRecord);
    return { items, total, page, pageSize };
  }
  selectIds(datasetId: string, config: RunConfig, sample = true): number[] {
    const where = this.recordWhere(datasetId, config.filter);
    if (config.selection.mode === 'selected') {
      const chosen = config.selection.ids;
      const rows = this.all(
        `SELECT r.id FROM records r WHERE ${where.sql} AND r.id IN (SELECT value FROM json_each(?)) ORDER BY r.id`,
        ...where.params,
        JSON.stringify(chosen),
      );
      if (rows.length !== new Set(chosen).size)
        throw new HttpError(
          400,
          'Some selected records are outside this dataset or its current filter.',
        );
      return rows.map((r) => r.id);
    }
    const suffix =
      config.selection.mode === 'sample' && sample ? 'ORDER BY random() LIMIT ?' : 'ORDER BY r.id';
    const params =
      config.selection.mode === 'sample' && sample
        ? [...where.params, config.selection.count]
        : where.params;
    return this.all(`SELECT r.id FROM records r WHERE ${where.sql} ${suffix}`, ...params).map(
      (r) => r.id,
    );
  }
  runs(datasetId: string): Run[] {
    return this.all('SELECT * FROM runs WHERE datasetId=? ORDER BY createdAt DESC', datasetId).map(
      (r) => this.decodeRun(r),
    );
  }
  decodeRun(row: Row): Run {
    return { ...row, config: JSON.parse(row.config) } as Run;
  }
  run(id: string): Run {
    const row = this.get('SELECT * FROM runs WHERE id=?', id);
    if (!row) throw new HttpError(404, 'Run not found.');
    return this.decodeRun(row);
  }
  runDetail(id: string): RunDetail {
    const run = this.run(id);
    const summaries = run.config.questions.map((q) => {
      const records = this.all(
        `SELECT a.value AS answer FROM run_records rr, json_each(rr.response, '$.answers') a WHERE rr.runId=? AND rr.status='succeeded' AND a.key=?`,
        id,
        q.id,
      );
      let sum = 0;
      const counts = new Map<string, number>();
      for (const row of records) {
        const answer = JSON.parse(row.answer);
        if (answer.type === 'choice')
          counts.set(answer.choice, (counts.get(answer.choice) || 0) + 1);
        else sum += answer.type === 'noul' ? answer.noul : answer.score;
      }
      return {
        id: q.id,
        type: q.type,
        count: records.length,
        average: q.type !== 'choice' && records.length ? sum / records.length : null,
        categories: Array.from(counts, ([name, count]) => ({ name, count })),
      };
    });
    const models = this.all(
      "SELECT DISTINCT json_extract(response, '$.model') AS model FROM run_records WHERE runId=? AND status='succeeded'",
      id,
    ).map((r) => r.model);
    return { ...run, summaries, models };
  }
  resultsWhere(runId: string, options: ResultOptions) {
    const clauses = ['rr.runId=?'];
    const params: SQLInputValue[] = [runId];
    if (options.status) {
      clauses.push('rr.status=?');
      params.push(options.status);
    }
    // json_each keys are bound values, including keys containing punctuation.
    const answer = `(SELECT value FROM json_each(rr.response, '$.answers') WHERE key=?)`;
    if (options.question && options.category) {
      clauses.push(`json_extract(${answer}, '$.choice')=?`);
      params.push(options.question, options.category);
    }
    if (options.question && options.minimum !== undefined) {
      clauses.push(
        `coalesce(json_extract(${answer}, '$.noul'), json_extract(${answer}, '$.score')) >= ?`,
      );
      params.push(options.question, options.question, options.minimum);
    }
    if (options.question && options.confidence !== undefined) {
      clauses.push(`json_extract(${answer}, '$.confidence') >= ?`);
      params.push(options.question, options.confidence);
    }
    return { sql: clauses.join(' AND '), params };
  }
  results(runId: string, options: ResultOptions = {}): Page<RunResult> {
    const page = options.page || 1,
      pageSize = options.pageSize || 25;
    const where = this.resultsWhere(runId, options);
    let order = 'rr.recordId';
    const orderParams: SQLInputValue[] = [];
    if (options.question) {
      order = `coalesce(json_extract((SELECT value FROM json_each(rr.response, '$.answers') WHERE key=?), '$.noul'), json_extract((SELECT value FROM json_each(rr.response, '$.answers') WHERE key=?), '$.score'), json_extract((SELECT value FROM json_each(rr.response, '$.answers') WHERE key=?), '$.choice')) ${options.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, rr.recordId`;
      orderParams.push(options.question, options.question, options.question);
    }
    const total = this.get(
      `SELECT count(*) AS n FROM run_records rr WHERE ${where.sql}`,
      ...where.params,
    )!.n;
    const rows = this.all(
      `SELECT rr.*, r.data, r.position, s.path AS sourcePath FROM run_records rr JOIN records r ON r.id=rr.recordId JOIN sources s ON s.id=r.sourceId WHERE ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...where.params,
      ...orderParams,
      pageSize,
      (page - 1) * pageSize,
    );
    return {
      items: rows.map(
        (row) =>
          ({
            ...row,
            data: JSON.parse(row.data),
            response: row.response ? JSON.parse(row.response) : null,
          }) as RunResult,
      ),
      total,
      page,
      pageSize,
    };
  }
}
export interface ResultOptions {
  page?: number;
  pageSize?: number;
  status?: string;
  question?: string;
  category?: string;
  minimum?: number;
  confidence?: number;
  direction?: 'asc' | 'desc';
}
