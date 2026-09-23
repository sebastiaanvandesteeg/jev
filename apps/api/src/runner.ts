import { randomUUID } from 'node:crypto';
import { buildRequest, responseSchema, type RunConfig } from '@jev/shared';
import { Store } from './store.js';
import type { Config } from './config.js';
import type { Provider } from './provider.js';
import { HttpError, messageOf } from './errors.js';

export class Runner {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<
    string,
    { runId: string; datasetId: string; controller: AbortController; promise: Promise<void> }
  >();
  private stopped = false;
  constructor(
    private store: Store,
    private config: Config,
    private provider: Provider,
  ) {}
  start() {
    this.timer ??= setInterval(() => this.tick(), Math.ceil(1000 / this.config.requestsPerSecond));
    this.timer.unref();
  }
  create(datasetId: string, config: RunConfig) {
    if (!this.config.apiKey)
      throw new HttpError(
        409,
        'Add TYPESAFE_API_KEY to .env and restart the backend to run Jev experiments.',
      );
    const dataset = this.store.dataset(datasetId);
    if (dataset.status !== 'ready')
      throw new HttpError(409, 'Wait for this dataset to finish importing.');
    if (config.fields?.length === 0) throw new HttpError(400, 'Select at least one input field.');
    if (config.fields?.some((f) => !dataset.fields.includes(f)))
      throw new HttpError(400, 'An input field does not exist in this dataset.');
    const ids = this.store.selectIds(datasetId, config);
    if (!ids.length) throw new HttpError(400, 'No records match this selection.');
    const id = randomUUID();
    this.store.transaction(() => {
      this.store.exec(
        'INSERT INTO runs(id,datasetId,name,config,createdAt,total) VALUES(?,?,?,?,?,?)',
        id,
        datasetId,
        config.name,
        JSON.stringify(config),
        new Date().toISOString(),
        ids.length,
      );
      const statement = this.store.db.prepare(
        'INSERT INTO run_records(runId,recordId) VALUES(?,?)',
      );
      for (const recordId of ids) statement.run(id, recordId);
    });
    return this.store.run(id);
  }
  cancel(id: string) {
    const run = this.store.run(id);
    if (!['queued', 'running', 'interrupted'].includes(run.status))
      throw new HttpError(409, 'This run has already finished.');
    this.store.exec(
      "UPDATE runs SET status='cancelled', finishedAt=? WHERE id=?",
      new Date().toISOString(),
      id,
    );
    this.abortRun(id);
    return this.store.run(id);
  }
  resume(id: string) {
    if (!this.config.apiKey)
      throw new HttpError(409, 'Configure TYPESAFE_API_KEY before resuming.');
    const run = this.store.run(id);
    if (run.status !== 'interrupted')
      throw new HttpError(409, 'Only interrupted runs can be resumed.');
    if (run.succeeded + run.failed === run.total) {
      this.store.exec(
        'UPDATE runs SET status=?, finishedAt=?, error=NULL WHERE id=?',
        run.failed ? (run.succeeded ? 'partial' : 'failed') : 'completed',
        new Date().toISOString(),
        id,
      );
      return this.store.run(id);
    }
    this.store.exec("UPDATE runs SET status='queued', finishedAt=NULL, error=NULL WHERE id=?", id);
    return this.store.run(id);
  }
  private abortRun(id: string) {
    for (const task of this.active.values()) if (task.runId === id) task.controller.abort();
  }
  isDatasetBusy(datasetId: string) {
    return (
      [...this.active.values()].some((task) => task.datasetId === datasetId) ||
      Boolean(
        this.store.get(
          "SELECT 1 FROM runs WHERE datasetId=? AND status IN ('queued','running') LIMIT 1",
          datasetId,
        ),
      )
    );
  }
  private tick() {
    if (this.stopped || this.active.size >= this.config.concurrency) return;
    const next = this.store
      .get(`SELECT rr.runId, rr.recordId, r.data, runs.config, runs.datasetId FROM run_records rr
      JOIN runs ON runs.id=rr.runId JOIN records r ON r.id=rr.recordId
      WHERE rr.status='pending' AND runs.status IN ('queued','running') ORDER BY runs.createdAt, rr.recordId LIMIT 1`);
    if (!next) return;
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.exec(
        "UPDATE runs SET status='running', startedAt=coalesce(startedAt,?) WHERE id=?",
        now,
        next.runId,
      );
      this.store.exec(
        "UPDATE run_records SET status='running', startedAt=? WHERE runId=? AND recordId=?",
        now,
        next.runId,
        next.recordId,
      );
    });
    const controller = new AbortController();
    const key = `${next.runId}:${next.recordId}`;
    const promise = this.evaluate(
      next.runId,
      next.recordId,
      next.data,
      JSON.parse(next.config),
      controller.signal,
    ).finally(() => {
      this.active.delete(key);
      this.finishIfDone(next.runId);
    });
    this.active.set(key, { runId: next.runId, datasetId: next.datasetId, controller, promise });
  }
  private async evaluate(
    runId: string,
    recordId: number,
    data: string,
    config: RunConfig,
    signal: AbortSignal,
  ) {
    const start = performance.now();
    try {
      const request = buildRequest(JSON.parse(data), config);
      const response = responseSchema.parse(await this.provider.evaluate(request, signal));
      for (const q of config.questions) {
        const answer = response.answers[q.id];
        if (!answer || answer.type !== q.type)
          throw new Error(`Jev returned an invalid answer for ${q.id}.`);
        if (
          q.type === 'choice' &&
          answer.type === 'choice' &&
          !Object.hasOwn(q.criteria, answer.choice)
        )
          throw new Error(`Jev returned an unknown category for ${q.id}.`);
        if (
          q.type === 'score' &&
          answer.type === 'score' &&
          (answer.score < 0 || answer.score > q.criteria.length - 1)
        )
          throw new Error(`Jev returned a score outside the rubric for ${q.id}.`);
      }
      const duration = Math.round(performance.now() - start);
      this.store.transaction(() => {
        this.store.exec(
          "UPDATE run_records SET status='succeeded', response=?, durationMs=?, finishedAt=?, error=NULL WHERE runId=? AND recordId=?",
          JSON.stringify(response),
          duration,
          new Date().toISOString(),
          runId,
          recordId,
        );
        this.store.exec(
          'UPDATE runs SET succeeded=succeeded+1, inputTokens=inputTokens+?, outputTokens=outputTokens+?, durationMs=durationMs+? WHERE id=?',
          response.usage.input_tokens,
          response.usage.output_tokens,
          duration,
          runId,
        );
      });
    } catch (error) {
      if (signal.aborted) {
        this.store.exec(
          "UPDATE run_records SET status='pending', startedAt=NULL WHERE runId=? AND recordId=?",
          runId,
          recordId,
        );
        return;
      }
      const status =
        error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      let message = messageOf(error);
      if (/context|token.*limit|too.long|maximum.*token/i.test(message))
        message += ' Reduce the selected input fields or shared context. No content was truncated.';
      const duration = Math.round(performance.now() - start);
      this.store.transaction(() => {
        this.store.exec(
          "UPDATE run_records SET status='failed', error=?, durationMs=?, finishedAt=? WHERE runId=? AND recordId=?",
          message,
          duration,
          new Date().toISOString(),
          runId,
          recordId,
        );
        this.store.exec(
          'UPDATE runs SET failed=failed+1, durationMs=durationMs+? WHERE id=?',
          duration,
          runId,
        );
        if (status === 401 || status === 403)
          this.store.exec(
            "UPDATE runs SET status='failed', error='TypeSafe authentication failed. Check TYPESAFE_API_KEY and start a new run.', finishedAt=? WHERE id=?",
            new Date().toISOString(),
            runId,
          );
      });
      if (status === 401 || status === 403) this.abortRun(runId);
    }
  }
  private finishIfDone(id: string) {
    const run = this.store.run(id);
    if (run.status !== 'running') return;
    if (run.succeeded + run.failed === run.total)
      this.store.exec(
        'UPDATE runs SET status=?, finishedAt=? WHERE id=?',
        run.failed ? (run.succeeded ? 'partial' : 'failed') : 'completed',
        new Date().toISOString(),
        id,
      );
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const task of this.active.values()) task.controller.abort();
    await Promise.all([...this.active.values()].map((t) => t.promise));
    this.store.exec(
      "UPDATE runs SET status='interrupted', error='The server stopped. Resume to process unfinished records.' WHERE status IN ('queued','running')",
    );
  }
}
