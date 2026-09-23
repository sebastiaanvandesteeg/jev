import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Document = Record<string, Json>;
const label = z.string().trim().min(1).max(100);
const instructions = z.string().trim().min(1, 'Write a question first.').max(32000);
const questionBase = {
  id: z
    .string()
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/,
      'Use a letter followed by letters, numbers, or underscores.',
    ),
  instructions,
};
export const questionSchema = z.discriminatedUnion('type', [
  z.object({
    ...questionBase,
    type: z.literal('noul'),
    criteria: z.object({ true: z.string(), false: z.string() }).optional(),
  }),
  z.object({
    ...questionBase,
    type: z.literal('choice'),
    criteria: z
      .record(label, z.string().nullable())
      .refine(
        (v) => Object.keys(v).length >= 2 && Object.keys(v).length <= 255,
        'Add between 2 and 255 categories.',
      ),
  }),
  z.object({
    ...questionBase,
    type: z.literal('score'),
    criteria: z.array(z.string().trim().min(1)).min(2).max(10),
  }),
]);
export type Question = z.infer<typeof questionSchema>;
const probability = z.number().min(0).max(1);
export const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(probability),
    confidence: probability,
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    legend: z.record(z.unknown()),
    probabilities: z.record(probability),
    confidence: probability,
  }),
]);
export type Answer = z.infer<typeof answerSchema>;
export const responseSchema = z.object({
  model: z.string(),
  answers: z.record(answerSchema),
  usage: z.object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
  }),
});
export type JevResponse = z.infer<typeof responseSchema>;

export const filterSchema = z.object({
  search: z.string().max(1000).default(''),
  sourceId: z.string().default(''),
});
export type RecordFilter = z.infer<typeof filterSchema>;
export const runConfigSchema = z.object({
  name: z.string().trim().min(1).max(150),
  model: z.string().trim().min(1).max(100).default('jev-latest'),
  questions: z
    .array(questionSchema)
    .min(1)
    .max(30)
    .refine((q) => new Set(q.map((v) => v.id)).size === q.length, 'Question IDs must be unique.'),
  fields: z.array(z.string()).max(500).nullable().default(null),
  context: z.string().max(64000).default(''),
  filter: filterSchema.default({}),
  selection: z
    .discriminatedUnion('mode', [
      z.object({
        mode: z.literal('sample'),
        count: z.number().int().min(1).max(10000).default(10),
      }),
      z.object({ mode: z.literal('all') }),
      z.object({
        mode: z.literal('selected'),
        ids: z.array(z.number().int().positive()).min(1).max(10000),
      }),
    ])
    .default({ mode: 'sample', count: 10 }),
});
export type RunConfig = z.infer<typeof runConfigSchema>;
export const datasetRenameSchema = z.object({
  name: z.string().trim().min(1, 'Enter a dataset name.').max(150),
});
export const COSMOS_MAX_RECORDS = 10000;
export const COSMOS_DEFAULT_RECORDS = 1000;
export const cosmosDatabaseSchema = z.object({ databaseId: z.string().min(1).max(255) });
export const cosmosQuerySchema = cosmosDatabaseSchema.extend({
  containerId: z.string().min(1).max(255),
  query: z.string().trim().min(1, 'Enter a SQL query.').max(32000),
  limit: z.number().int().min(1).max(COSMOS_MAX_RECORDS).default(COSMOS_DEFAULT_RECORDS),
});
export const cosmosImportSchema = cosmosQuerySchema.extend({
  name: z.string().trim().min(1).max(150),
});
export type CosmosQuery = z.infer<typeof cosmosQuerySchema>;
export type CosmosImport = z.infer<typeof cosmosImportSchema>;
export interface CosmosPreview {
  records: Document[];
  limitReached: boolean;
}
export interface CosmosOrigin {
  kind: 'cosmos';
  accountHost: string;
  databaseId: string;
  containerId: string;
  query: string;
  limit: number;
  completedAt: string | null;
}
export const asDocument = (value: Json): Document =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { value };

export type DatasetStatus = 'importing' | 'needs_selection' | 'ready' | 'failed';
export interface Dataset {
  id: string;
  name: string;
  archiveName: string;
  bytes: number;
  createdAt: string;
  status: DatasetStatus;
  recordCount: number;
  processedFiles: number;
  totalFiles: number;
  fields: string[];
  warnings: string[];
  error: string | null;
  origin: CosmosOrigin | null;
}
export interface SourceFile {
  id: string;
  datasetId: string;
  path: string;
  format: string;
  recordCount: number;
  arrayPaths: string[];
  arrayPointer: string | null;
  needsSelection: boolean;
}
export interface DatasetDetail extends Dataset {
  sources: SourceFile[];
}
export interface DataRecord {
  id: number;
  datasetId: string;
  sourceId: string;
  sourcePath: string;
  position: number;
  data: Document;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export type RunStatus =
  'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export interface Run {
  id: string;
  datasetId: string;
  name: string;
  status: RunStatus;
  config: RunConfig;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error: string | null;
}
export interface RunResult {
  recordId: number;
  sourcePath: string;
  position: number;
  data: Document;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  response: JevResponse | null;
  error: string | null;
  durationMs: number;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface QuestionSummary {
  id: string;
  type: Question['type'];
  count: number;
  average: number | null;
  categories: { name: string; count: number }[];
}
export interface RunDetail extends Run {
  summaries: QuestionSummary[];
  models: string[];
}
export interface AppConfig {
  hasApiKey: boolean;
  hasCosmosConnection: boolean;
  cosmosMaxRecords: number;
  cosmosDefaultRecords: number;
  model: string;
  maxUploadBytes: number;
  concurrency: number;
  requestsPerSecond: number;
}
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
export interface RequestPreview {
  model: string;
  state: { record: Document; context?: string };
  questions: Record<string, WithoutId<Question>>;
}

/** The same pure projection drives the preview and the actual SDK request. */
export function buildRequest(record: Document, config: RunConfig): RequestPreview {
  const projected =
    config.fields === null
      ? record
      : Object.fromEntries(
          config.fields.filter((k) => Object.hasOwn(record, k)).map((k) => [k, record[k]]),
        );
  return {
    model: config.model,
    state: { record: projected, ...(config.context ? { context: config.context } : {}) },
    questions: Object.fromEntries(config.questions.map(({ id, ...question }) => [id, question])),
  };
}

export const starters: { name: string; description: string; question: Question }[] = [
  {
    name: 'Classify records',
    description: 'Organize your data into useful categories.',
    question: {
      id: 'category',
      type: 'choice',
      instructions: 'What is the main purpose of this record?',
      criteria: {
        request: 'Asks for information, help, or an action.',
        update: 'Communicates a status or progress update.',
        issue: 'Reports a problem or something that went wrong.',
        other: 'None of these categories fit.',
      },
    },
  },
  {
    name: 'Detect a condition',
    description: 'Find records that need a closer look.',
    question: {
      id: 'needs_attention',
      type: 'noul',
      instructions:
        'Does this record describe an unresolved problem that requires someone to take action?',
      criteria: {
        true: 'An unresolved problem and need for action are present.',
        false: 'No unresolved problem is described, or the problem has already been resolved.',
      },
    },
  },
  {
    name: 'Rank by relevance',
    description: 'Score how closely each record matches a topic.',
    question: {
      id: 'relevance',
      type: 'score',
      instructions: 'How relevant is this record to the topic described in `context`?',
      criteria: [
        'Does not address the topic.',
        'Mentions the topic but provides little useful detail.',
        'Directly addresses the topic with useful, specific information.',
      ],
    },
  },
];
