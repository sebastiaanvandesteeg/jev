import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { z } from 'zod';
import {
  buildRequest,
  filterSchema,
  runConfigSchema,
  datasetRenameSchema,
  cosmosDatabaseSchema,
  cosmosQuerySchema,
  cosmosImportSchema,
  COSMOS_MAX_RECORDS,
  COSMOS_DEFAULT_RECORDS,
} from '@jev/shared';
import { type Config, repoRoot } from './config.js';
import { Store } from './store.js';
import { Importer } from './importer.js';
import { Runner } from './runner.js';
import { createProvider, type Provider } from './provider.js';
import { HttpError, messageOf } from './errors.js';
import { CosmosConnection, type CosmosAdapter } from './cosmos.js';

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const resultQuery = pageQuery.extend({
  status: z.enum(['pending', 'running', 'succeeded', 'failed']).optional(),
  question: z.string().max(64).optional(),
  category: z.string().optional(),
  minimum: z.coerce.number().optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  direction: z.enum(['asc', 'desc']).default('desc'),
});
export function csvCell(value: unknown) {
  let text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createApp(config: Config, provider?: Provider, cosmosAdapter?: CosmosAdapter) {
  const store = new Store(config.dataDir);
  store.recover();
  const importer = new Importer(store, config);
  const cosmos = new CosmosConnection(config.cosmosConnectionString, cosmosAdapter);
  const runner = new Runner(store, config, provider || createProvider(config.apiKey));
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host))
      return next(new HttpError(403, 'This workbench is available on localhost only.'));
    if (req.headers.origin) {
      try {
        if (!['127.0.0.1', 'localhost'].includes(new URL(req.headers.origin).hostname))
          throw new Error();
      } catch {
        return next(new HttpError(403, 'Cross-origin requests are not allowed.'));
      }
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  const uploadDir = path.join(config.dataDir, 'uploads');
  mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 1, fieldSize: 1024 },
  });
  app.get('/api/config', (_req, res) =>
    res.json({
      hasApiKey: Boolean(config.apiKey),
      hasCosmosConnection: cosmos.configured,
      cosmosMaxRecords: COSMOS_MAX_RECORDS,
      cosmosDefaultRecords: COSMOS_DEFAULT_RECORDS,
      model: config.model,
      maxUploadBytes: config.maxUploadBytes,
      concurrency: config.concurrency,
      requestsPerSecond: config.requestsPerSecond,
    }),
  );
  app.get('/api/cosmos/databases', async (_req, res) => res.json(await cosmos.list()));
  app.get('/api/cosmos/containers', async (req, res) => {
    const { databaseId } = cosmosDatabaseSchema.parse(req.query);
    res.json(await cosmos.list(databaseId));
  });
  app.post('/api/cosmos/preview', async (req, res) => {
    res.json(await cosmos.preview(cosmosQuerySchema.parse(req.body), config.maxUploadBytes));
  });
  app.post('/api/cosmos/import', (req, res) => {
    const { name, ...query } = cosmosImportSchema.parse(req.body);
    const origin = {
      kind: 'cosmos' as const,
      accountHost: cosmos.accountHost,
      ...query,
      completedAt: null,
    };
    res.status(202).json(importer.acceptRecords(name, origin, cosmos.records(query)));
  });
  app.get('/api/datasets', (_req, res) => res.json(store.datasets()));
  app.post('/api/datasets', upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose a JSON, CSV, or ZIP file.');
    const name = typeof req.body.name === 'string' ? req.body.name.slice(0, 150) : undefined;
    res
      .status(202)
      .json(await importer.accept(req.file.path, req.file.originalname, req.file.size, name));
  });
  app.get('/api/datasets/:id', (req, res) => res.json(store.dataset(req.params.id)));
  app.patch('/api/datasets/:id', (req, res) => {
    const { name } = datasetRenameSchema.parse(req.body);
    res.json(store.renameDataset(req.params.id, name));
  });
  app.delete('/api/datasets/:id', (req, res) => {
    store.dataset(req.params.id);
    if (runner.isDatasetBusy(req.params.id))
      throw new HttpError(
        409,
        'An experiment is still active. Wait for it to finish, or cancel it in Run history and wait for it to stop before deleting this dataset.',
      );
    importer.deleteDataset(req.params.id);
    res.status(204).end();
  });
  app.post('/api/datasets/:id/import', (req, res) => {
    const body = z.object({ selections: z.record(z.string().nullable()) }).parse(req.body);
    res.status(202).json(importer.continue(req.params.id, body.selections));
  });
  app.get('/api/datasets/:id/records', (req, res) => {
    store.dataset(req.params.id);
    const { page, pageSize } = pageQuery.parse(req.query);
    res.json(store.records(req.params.id, filterSchema.parse(req.query), page, pageSize));
  });
  app.get('/api/datasets/:id/runs', (req, res) => {
    store.dataset(req.params.id);
    res.json(store.runs(req.params.id));
  });
  app.post('/api/datasets/:id/preview', (req, res) => {
    const config = runConfigSchema.parse(req.body),
      dataset = store.dataset(req.params.id);
    if (dataset.status !== 'ready') throw new HttpError(409, 'Dataset is not ready.');
    const ids = store.selectIds(dataset.id, config, false);
    const count =
      config.selection.mode === 'sample'
        ? Math.min(ids.length, config.selection.count)
        : ids.length;
    const row = ids.length ? store.get('SELECT data FROM records WHERE id=?', ids[0]) : undefined;
    res.json({
      count,
      matchingCount: ids.length,
      recordId: ids[0] ?? null,
      request: row ? buildRequest(JSON.parse(row.data), config) : null,
    });
  });
  app.post('/api/datasets/:id/runs', (req, res) =>
    res.status(202).json(runner.create(req.params.id, runConfigSchema.parse(req.body))),
  );
  app.get('/api/runs/:id', (req, res) => res.json(store.runDetail(req.params.id)));
  app.get('/api/runs/:id/results', (req, res) => {
    store.run(req.params.id);
    res.json(store.results(req.params.id, resultQuery.parse(req.query)));
  });
  app.post('/api/runs/:id/cancel', (req, res) => res.json(runner.cancel(req.params.id)));
  app.post('/api/runs/:id/resume', (req, res) =>
    res.status(202).json(runner.resume(req.params.id)),
  );
  app.get('/api/runs/:id/export', async (req, res) => {
    const run = store.runDetail(req.params.id);
    const format = z.enum(['json', 'csv']).default('json').parse(req.query.format);
    const options = resultQuery.parse(req.query);
    res.setHeader('Content-Disposition', `attachment; filename="jev-run-${run.id}.${format}"`);
    res.type(format === 'json' ? 'application/json' : 'text/csv');
    const columns = [
      'recordId',
      'sourcePath',
      'position',
      'status',
      'model',
      'durationMs',
      'inputTokens',
      'outputTokens',
      'error',
      ...run.config.questions.flatMap((q) => [
        `${q.id}.value`,
        `${q.id}.confidence`,
        `${q.id}.probabilities`,
      ]),
    ];
    res.write(
      format === 'json'
        ? `{"run":${JSON.stringify(run)},"results":[`
        : columns.map(csvCell).join(',') + '\r\n',
    );
    let page = 1,
      first = true;
    while (!res.destroyed) {
      const result = store.results(run.id, { ...options, page, pageSize: 250 });
      for (const row of result.items) {
        if (res.destroyed) return;
        let output: string;
        if (format === 'json') {
          output = (first ? '' : ',') + JSON.stringify(row);
          first = false;
        } else {
          const values: unknown[] = [
            row.recordId,
            row.sourcePath,
            row.position,
            row.status,
            row.response?.model,
            row.durationMs,
            row.response?.usage.input_tokens,
            row.response?.usage.output_tokens,
            row.error,
          ];
          for (const q of run.config.questions) {
            const a = row.response?.answers[q.id];
            values.push(
              a ? (a.type === 'noul' ? a.noul : a.type === 'choice' ? a.choice : a.score) : '',
              a && a.type !== 'noul' ? a.confidence : '',
              a && a.type !== 'noul' ? a.probabilities : '',
            );
          }
          output = values.map(csvCell).join(',') + '\r\n';
        }
        if (!res.write(output))
          await new Promise<void>((resolve) => {
            const ready = () => {
              res.off('drain', ready);
              res.off('close', ready);
              resolve();
            };
            res.once('drain', ready);
            res.once('close', ready);
          });
      }
      if (page * 250 >= result.total) break;
      page++;
      await setImmediate();
    }
    res.end(format === 'json' ? ']}' : '');
  });
  app.get('/api/example', (_req, res, next) => {
    const file = path.join(repoRoot, 'examples', 'exploration.zip');
    if (!existsSync(file))
      return next(new HttpError(404, 'Run npm run example to generate the sample archive.'));
    res.download(file, 'exploration.zip');
  });
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'API endpoint not found.')));
  const webDir = path.join(repoRoot, 'apps/web/dist');
  app.use(express.static(webDir));
  app.get('/{*splat}', (_req, res) => {
    if (existsSync(path.join(webDir, 'index.html'))) res.sendFile(path.join(webDir, 'index.html'));
    else
      res.status(404).send('Frontend not built. Run npm run dev and open http://127.0.0.1:5173.');
  });
  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError)
      return void res
        .status(400)
        .json({ error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error instanceof multer.MulterError)
      return void res.status(400).json({
        error:
          error.code === 'LIMIT_FILE_SIZE'
            ? `Uploaded files must be no larger than ${config.maxUploadBytes / 1024 / 1024} MiB.`
            : error.message,
      });
    const status =
      error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error(error);
    res.status(status).json({
      error:
        status === 500
          ? 'The server could not complete this request. Check the backend log.'
          : messageOf(error),
    });
  };
  app.use(errors);
  runner.start();
  return {
    app,
    store,
    importer,
    runner,
    async close() {
      cosmos.close();
      await runner.stop();
      await importer.idle();
      store.close();
    },
  };
}
