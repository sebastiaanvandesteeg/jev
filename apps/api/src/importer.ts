import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { parse } from 'csv-parse';
import { asDocument, type CosmosOrigin, type Json, type SourceFile } from '@jev/shared';
import type { Config } from './config.js';
import { Store } from './store.js';
import { HttpError, messageOf } from './errors.js';
import { inspectJson, readJson } from './json-reader.js';

export function validateEntry(
  entry: Pick<Entry, 'fileName' | 'generalPurposeBitFlag' | 'externalFileAttributes'>,
) {
  const name = entry.fileName;
  if (
    name.includes('\\') ||
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[a-zA-Z]:/.test(name) ||
    name.split('/').some((p) => p === '..')
  )
    throw new Error(`Unsafe archive path: ${name}`);
  if ((entry.generalPurposeBitFlag & 1) !== 0)
    throw new Error(`Encrypted files are not supported: ${name}`);
  if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
    throw new Error(`Symbolic links are not supported: ${name}`);
}
function openZip(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => (error ? reject(error) : resolve(zip!)),
    ),
  );
}
const formats: Record<string, string> = {
  '.json': 'json',
  '.jsonl': 'jsonl',
  '.ndjson': 'jsonl',
  '.csv': 'csv',
  '.txt': 'text',
  '.md': 'text',
};
export class Importer {
  private jobs = new Set<Promise<void>>();
  private pending = new Set<string>();
  constructor(
    private store: Store,
    private config: Config,
  ) {}
  archive(id: string, extension = '.zip') {
    return path.join(this.config.dataDir, 'archives', `${id}${extension}`);
  }
  sourceFile(datasetId: string, sourceId: string) {
    return path.join(this.config.dataDir, 'staging', datasetId, sourceId);
  }
  deleteDataset(id: string) {
    const dataset = this.store.dataset(id);
    if (dataset.status === 'importing' || this.pending.has(id))
      throw new HttpError(409, 'Wait for this dataset to finish importing before deleting it.');
    // Keep deletion synchronous so no import or queued run can start during cleanup.
    // Only generated workspace paths are removed, never original source filenames.
    try {
      rmSync(path.join(this.config.dataDir, 'staging', id), { recursive: true, force: true });
      for (const extension of ['.zip', '.json', '.csv'])
        rmSync(this.archive(id, extension), { force: true });
    } catch {
      throw new HttpError(
        500,
        'Could not remove the local import files. Check data directory permissions and try again.',
      );
    }
    this.store.deleteDataset(id);
  }
  async accept(tempFile: string, archiveName: string, bytes: number, name?: string) {
    const extension = path.extname(archiveName).toLowerCase();
    if (!['.zip', '.json', '.csv'].includes(extension)) {
      await rm(tempFile, { force: true });
      throw new HttpError(400, 'Upload a JSON file, CSV file, or ZIP archive.');
    }
    const id = randomUUID();
    const originalFile = this.archive(id, extension);
    await mkdir(path.dirname(originalFile), { recursive: true });
    await rename(tempFile, originalFile);
    this.store.exec(
      'INSERT INTO datasets(id,name,archiveName,bytes,createdAt) VALUES(?,?,?,?,?)',
      id,
      name?.trim() || archiveName.slice(0, -extension.length),
      archiveName,
      bytes,
      new Date().toISOString(),
    );
    this.launch(id, () =>
      extension === '.zip'
        ? this.extract(id)
        : this.importFile(id, archiveName, formats[extension], originalFile),
    );
    return this.store.dataset(id);
  }
  acceptRecords(name: string, origin: CosmosOrigin, records: AsyncIterable<Json>) {
    const id = randomUUID();
    const sourceId = randomUUID();
    const sourcePath = `cosmos://${origin.accountHost}/${encodeURIComponent(origin.databaseId)}/${encodeURIComponent(origin.containerId)}`;
    this.store.transaction(() => {
      this.store.exec(
        'INSERT INTO datasets(id,name,archiveName,bytes,createdAt,origin,totalFiles) VALUES(?,?,?,?,?,?,1)',
        id,
        name,
        `${origin.databaseId} / ${origin.containerId}`,
        0,
        new Date().toISOString(),
        JSON.stringify(origin),
      );
      this.store.exec(
        'INSERT INTO sources(id,datasetId,path,format) VALUES(?,?,?,?)',
        sourceId,
        id,
        sourcePath,
        'cosmos',
      );
    });
    this.launch(id, () => this.normalize(id, records));
    return this.store.dataset(id);
  }
  private launch(id: string, task: () => Promise<void>) {
    if (this.pending.has(id)) throw new HttpError(409, 'This import is already running.');
    this.pending.add(id);
    const job = task()
      .catch(async (error) => {
        this.store.transaction(() => {
          this.store.exec('DELETE FROM records WHERE datasetId=?', id);
          this.store.exec('UPDATE sources SET recordCount=0 WHERE datasetId=?', id);
          this.store.exec(
            "UPDATE datasets SET status='failed', recordCount=0, fields='[]', processedFiles=0, bytes=CASE WHEN origin IS NULL THEN bytes ELSE 0 END, error=? WHERE id=?",
            messageOf(error),
            id,
          );
        });
        await rm(path.join(this.config.dataDir, 'staging', id), { recursive: true, force: true });
      })
      .finally(() => {
        this.pending.delete(id);
        this.jobs.delete(job);
      });
    this.jobs.add(job);
  }
  async idle() {
    await Promise.all(this.jobs);
  }
  private async stageSource(
    id: string,
    sourcePath: string,
    format: string,
    stream: NodeJS.ReadableStream,
    countBytes: (bytes: number) => void,
  ) {
    const sourceId = randomUUID();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const guard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          countBytes(chunk.length);
        } catch (error) {
          return callback(error as Error);
        }
        try {
          decoder.decode(chunk, { stream: true });
          callback(null, chunk);
        } catch {
          callback(new Error(`${sourcePath}: expected UTF-8 text.`));
        }
      },
      flush(callback) {
        try {
          decoder.decode();
          callback();
        } catch {
          callback(new Error(`${sourcePath}: incomplete UTF-8 sequence.`));
        }
      },
    });
    const file = this.sourceFile(id, sourceId);
    await pipeline(stream, guard, createWriteStream(file, { flags: 'wx' }));
    let arrayPaths: string[] = [],
      arrayPointer: string | null = null;
    if (format === 'json') {
      try {
        const info = await inspectJson(file);
        arrayPaths = info.arrayPaths;
        arrayPointer = info.rootArray ? '' : null;
      } catch (error) {
        throw new Error(`${sourcePath}: ${messageOf(error)}`);
      }
    }
    this.store.exec(
      'INSERT INTO sources(id,datasetId,path,format,arrayPaths,arrayPointer,needsSelection) VALUES(?,?,?,?,?,?,?)',
      sourceId,
      id,
      sourcePath,
      format,
      JSON.stringify(arrayPaths),
      arrayPointer,
      arrayPaths.length ? 1 : 0,
    );
  }
  private async importFile(id: string, filename: string, format: string, originalFile: string) {
    await mkdir(path.join(this.config.dataDir, 'staging', id), { recursive: true });
    this.store.exec('UPDATE datasets SET totalFiles=1 WHERE id=?', id);
    let size = 0;
    await this.stageSource(id, filename, format, createReadStream(originalFile), (bytes) => {
      size += bytes;
      if (size > this.config.maxUploadBytes) throw new Error('File exceeds its upload size limit.');
    });
    this.store.exec('UPDATE datasets SET processedFiles=1 WHERE id=?', id);
    await this.finishPreparation(id);
  }
  private async extract(id: string) {
    await mkdir(path.join(this.config.dataDir, 'staging', id), { recursive: true });
    const zip = await openZip(this.archive(id));
    if (zip.entryCount > this.config.maxFiles) {
      zip.close();
      throw new Error(`Archive exceeds ${this.config.maxFiles.toLocaleString()} entries.`);
    }
    this.store.exec('UPDATE datasets SET totalFiles=? WHERE id=?', zip.entryCount, id);
    let expanded = 0,
      declared = 0,
      files = 0;
    const warnings: string[] = [];
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const fail = (error: unknown) => {
        if (!finished) {
          finished = true;
          zip.close();
          reject(error);
        }
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (!finished) {
          finished = true;
          resolve();
        }
      });
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          validateEntry(entry);
          files++;
          if (files > this.config.maxFiles) throw new Error('Archive contains too many entries.');
          declared += entry.uncompressedSize;
          if (declared > this.config.maxExpandedBytes)
            throw new Error(
              `Expanded archive exceeds ${this.config.maxExpandedBytes / 1024 / 1024} MiB.`,
            );
          const format = formats[path.extname(entry.fileName).toLowerCase()];
          if (!entry.fileName.endsWith('/') && format) {
            const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
              zip.openReadStream(entry, (err, s) => (err ? rej(err) : res(s!))),
            );
            await this.stageSource(id, entry.fileName, format, stream, (bytes) => {
              expanded += bytes;
              if (expanded > this.config.maxExpandedBytes)
                throw new Error('Expanded archive exceeds its size limit.');
            });
          } else if (!entry.fileName.endsWith('/'))
            warnings.push(`Skipped unsupported file: ${entry.fileName}`);
          this.store.exec(
            'UPDATE datasets SET processedFiles=?, warnings=? WHERE id=?',
            files,
            JSON.stringify(warnings),
            id,
          );
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
    await this.finishPreparation(id);
  }
  private async finishPreparation(id: string) {
    const sources = this.store.sources(id);
    if (!sources.length)
      throw new Error(
        'No supported data files found. Include JSON, JSONL, CSV, TXT, or Markdown files.',
      );
    if (sources.some((s) => s.needsSelection))
      this.store.exec("UPDATE datasets SET status='needs_selection' WHERE id=?", id);
    else await this.normalize(id);
  }
  continue(id: string, selections: Record<string, string | null>) {
    const dataset = this.store.dataset(id);
    if (dataset.status !== 'needs_selection')
      throw new HttpError(409, 'This dataset is not waiting for array selection.');
    if (this.pending.has(id))
      throw new HttpError(409, 'The import is finishing its current stage. Try again shortly.');
    for (const source of dataset.sources.filter((s) => s.needsSelection)) {
      if (!Object.hasOwn(selections, source.id))
        throw new HttpError(400, `Choose how to import ${source.path}.`);
      const pointer = selections[source.id];
      if (pointer !== null && !source.arrayPaths.includes(pointer))
        throw new HttpError(400, `Invalid array selection for ${source.path}.`);
    }
    this.store.transaction(() => {
      for (const source of dataset.sources.filter((s) => s.needsSelection))
        this.store.exec(
          'UPDATE sources SET arrayPointer=?, needsSelection=0 WHERE id=?',
          selections[source.id],
          source.id,
        );
      this.store.exec("UPDATE datasets SET status='importing', processedFiles=0 WHERE id=?", id);
    });
    this.launch(id, () => this.normalize(id));
    return this.store.dataset(id);
  }
  private async *readSource(source: SourceFile): AsyncGenerator<Json> {
    const file = this.sourceFile(source.datasetId, source.id);
    if (source.format === 'json') yield* readJson(file, source.arrayPointer);
    else if (source.format === 'jsonl') {
      const stream = createReadStream(file);
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let lineNumber = 0;
      try {
        for await (const line of lines) {
          lineNumber++;
          if (!line.trim()) continue;
          try {
            yield JSON.parse(line.replace(/^\uFEFF/, ''));
          } catch {
            throw new Error(`Invalid JSON on line ${lineNumber}.`);
          }
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    } else if (source.format === 'csv') {
      const sourceStream = createReadStream(file);
      const parser = parse({
        columns: (headers: string[]) => {
          if (headers.some((h) => !h.trim()) || new Set(headers).size !== headers.length)
            throw new Error('CSV headers must be nonempty and unique.');
          return headers;
        },
        bom: true,
        skip_empty_lines: true,
        relax_column_count: false,
      });
      sourceStream.on('error', (e) => parser.destroy(e));
      sourceStream.pipe(parser);
      try {
        for await (const row of parser) yield row;
      } finally {
        sourceStream.destroy();
        parser.destroy();
      }
    } else yield { text: await readFile(file, 'utf8') };
  }
  private async normalize(id: string, records?: AsyncIterable<Json>) {
    const sources = this.store.sources(id);
    const origin = this.store.dataset(id).origin;
    const fields = new Set<string>();
    let count = 0,
      completed = 0,
      bytes = 0;
    this.store.exec(
      'UPDATE datasets SET processedFiles=0, totalFiles=? WHERE id=?',
      sources.length,
      id,
    );
    const insert = this.store.db.prepare(
      'INSERT INTO records(datasetId,sourceId,position,data) VALUES(?,?,?,?)',
    );
    for (const source of sources) {
      let position = 0;
      let batch: { position: number; data: string }[] = [];
      const flush = () => {
        this.store.transaction(() => {
          for (const row of batch) insert.run(id, source.id, row.position, row.data);
        });
        count += batch.length;
        batch = [];
        this.store.exec('UPDATE datasets SET recordCount=? WHERE id=?', count, id);
        if (origin) this.store.exec('UPDATE datasets SET bytes=? WHERE id=?', bytes, id);
      };
      try {
        for await (const raw of records ?? this.readSource(source)) {
          const document = asDocument(raw);
          const data = JSON.stringify(document);
          if (origin) {
            bytes += Buffer.byteLength(data);
            if (bytes > this.config.maxUploadBytes)
              throw new Error(
                'Query results exceed the dataset size limit. Select fewer fields or narrow the query.',
              );
          }
          position++;
          for (const key of Object.keys(document)) fields.add(key);
          batch.push({ position, data });
          if (batch.length >= 250) {
            flush();
            await setImmediate();
          }
        }
        flush();
      } catch (error) {
        throw new Error(`${source.path}, record ${position + 1}: ${messageOf(error)}`);
      }
      this.store.exec('UPDATE sources SET recordCount=? WHERE id=?', position, source.id);
      this.store.exec('UPDATE datasets SET processedFiles=? WHERE id=?', ++completed, id);
    }
    if (!count)
      throw new Error(origin ? 'Query returned no results.' : 'The archive contained no records.');
    if (origin) {
      origin.completedAt = new Date().toISOString();
      this.store.exec(
        'UPDATE datasets SET origin=?, warnings=? WHERE id=?',
        JSON.stringify(origin),
        JSON.stringify(
          count === origin.limit
            ? [
                `Import stopped at the requested limit of ${count.toLocaleString()} results. Additional results may exist.`,
              ]
            : [],
        ),
        id,
      );
    }
    this.store.exec(
      "UPDATE datasets SET status='ready', fields=?, recordCount=? WHERE id=?",
      JSON.stringify([...fields].sort()),
      count,
      id,
    );
    await rm(path.join(this.config.dataDir, 'staging', id), { recursive: true, force: true });
  }
}
