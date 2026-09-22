# Jev Dataset Workbench

A local Vite + React application with a Node/Express backend for exploring structured exports and asking focused Jev questions about their records. Upload JSON or CSV directly, or combine data files in a ZIP. Original uploads, normalized records, and experiment history persist on your machine.

## Start

Requires **Node 24+** and npm. There is no external database or Docker dependency.

```sh
npm install
cp .env.example .env
npm run dev
```

Open **http://127.0.0.1:5173**. The API runs at **http://127.0.0.1:3001**. Add your TypeSafe key to the root `.env` file and restart the backend when you want to execute experiments:

```dotenv
TYPESAFE_API_KEY=your-key-here
```

Importing, inspecting data, building questions, and reading saved results work without a key. The UI disables inference and explains the setup. Keys stay in the backend environment and are never included in browser bundles, datasets, or run snapshots.

For a single production process:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:3001**. Node serves both the API and the built frontend. The app is designed for one local user and one backend process; it has no authentication and binds to loopback.

## Try the included data

1. Import [`examples/exploration.zip`](examples/exploration.zip), or click **Get sample data** in the app. It contains 15 synthetic messages across JSON, CSV, and plain text.
2. Open a record to inspect its complete JSON. Use the source filter and column picker to explore different files.
3. Open **New experiment**. The first example classifies records. Add a detection or relevance question using the starter cards.
4. Select the fields to send, add shared context, and preview an example request.
5. Start with the default random sample of 10 records. The selected record IDs are saved with that run.
6. Inspect per-record probabilities, category counts, mean scores, timing, and token usage. Filters and charts use saved results and do not call Jev again.
7. Export JSON or CSV, or choose **Use this configuration again** to create a new run.

`npm run example` regenerates the sample ZIP. All example data is synthetic.

## Imports

Each upload is one dataset. JSON and CSV files can be uploaded directly; ZIP archives combine all supported files into one table. Every record retains its source filename and position, and gets a separate internal ID. Repeated Cosmos document IDs are allowed. Original uploads are retained, including directly uploaded JSON and CSV files. Wrapped JSON uses the same array-selection flow whether uploaded directly or inside a ZIP.

| File                | Interpretation                                                                 |
| ------------------- | ------------------------------------------------------------------------------ |
| `.json`, root array | One record per array element                                                   |
| `.json`, object     | One record; if it contains arrays, choose an array or keep the complete object |
| `.jsonl`, `.ndjson` | One record per nonempty JSON line                                              |
| `.csv`              | First row is the header; values stay strings, including leading zeros          |
| `.txt`, `.md`       | One record per file, with a `text` field                                       |

JSON objects retain their nested values. Scalar or array records are wrapped in a `value` field. For wrapper exports such as `{"Documents":[...]}`, select `/Documents` when prompted. Nested selections use JSON Pointer, so keys containing dots and slashes are unambiguous. Arrays inside array elements are preserved rather than offered as separate collections.

Text files must be UTF-8. CSV supports quoted commas and multiline cells; inconsistent columns and duplicate or blank headers fail the import. JSON nesting is limited to 256 levels. Unsupported files inside ZIPs are listed as notices. If a supported file is malformed, the dataset fails with a location and all partially imported records are removed. Upload a corrected file or archive as a new dataset.

Defaults: **100 MiB per uploaded file**, **500 MiB expanded archive**, **10,000 archive entries**. Path traversal, absolute paths, symlinks, encrypted files, and expansion-limit violations are rejected. Source filenames are metadata, never extraction destinations: staging files have generated IDs. Direct uploads, archive entries, and JSON arrays stream into bounded insert batches. A single document or text file still needs to fit in process memory. JSONL, NDJSON, TXT, and Markdown files remain supported inside ZIP archives.

## Jev integration

The backend uses the official **`@typesafe-ai/sdk`**, pinned to **0.6.0** in the manifest and lockfile. See the [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript), [question primitives](https://docs.typesafe.ai/primitives), and [model reference](https://docs.typesafe.ai/models).

`TypeSafeClient.systemOne()` receives one state per record and all independent questions together. The server builds these using the SDK's `choice()`, `noul()`, and `score()` helpers:

- **Choice:** a category, its probability distribution, and confidence.
- **Noul:** probability of yes, from 0 to 1. It has no separate confidence field.
- **Score:** a position on your ordered, zero-based rubric, its distribution, and confidence. A three-level rubric ranges from 0 to 2, including fractional scores.

The request state is `{ record: <selected fields>, context?: <shared reference text> }`. The preview and server use the same projection function. Input selection is by top-level field; selecting a nested object includes the complete object. Nothing is silently truncated. Provider context-limit failures are saved per record with guidance to reduce the selected fields or reference context.

The default model is `jev-latest`; each response's actual model version is retained. No chat/text-generation model is included. Summaries, filters, counts, and averages are computed by the application. Averages cover successful records only, and a confidence value is not a correctness guarantee.

## Persistence and execution

The gitignored `data/` directory contains:

- `workbench.sqlite` (plus SQLite WAL files): datasets, source metadata, immutable normalized records, run snapshots, and raw response data.
- `archives/`: retained uploads, named by dataset UUID with their original `.zip`, `.json`, or `.csv` extension.
- `staging/`: temporary extracted content while importing or waiting for array selection.
- `uploads/`: incoming multipart upload staging.

Stop the server before copying the entire directory for a backup. Do not run two backend processes against the same data directory.

Runs use a durable SQLite queue with **four concurrent requests** and **ten request starts per second** by default. SDK retries use its built-in backoff; retries can add network attempts beyond the application-level start rate. Results and token usage persist as each request finishes. Browser navigation and refreshes do not stop runs.

- Record errors lead to a partial or failed run. Authentication errors stop further work on that run.
- Cancellation aborts active requests and leaves completed results available.
- Server shutdown/restart marks queued or active runs interrupted. Explicit resumption processes unfinished records and preserves saved successes and failures.
- An in-flight request whose response was not saved before interruption can be sent again on resume. This is not an exactly-once billing guarantee.
- Interrupted imports fail with instructions to upload again. Imports waiting for wrapper-array choices can continue after restart.

Changing filters does not trigger inference. Reusing a configuration creates a new run; a random-sample configuration chooses a new sample. Saved run membership remains visible in the original results.

## Configuration

All values are read from the backend environment. The root `.env` is loaded by the start scripts; `DATA_DIR` resolves relative to the repository root.

| Variable                  | Default                                |
| ------------------------- | -------------------------------------- |
| `TYPESAFE_API_KEY`        | Empty; required only for inference     |
| `TYPESAFE_MODEL`          | `jev-latest`                           |
| `PORT`                    | `3001` (also used by Vite's API proxy) |
| `DATA_DIR`                | `./data`                               |
| `MAX_UPLOAD_MIB`          | `100`                                  |
| `MAX_EXPANDED_MIB`        | `500`                                  |
| `MAX_ARCHIVE_FILES`       | `10000`                                |
| `RUN_CONCURRENCY`         | `4`                                    |
| `RUN_REQUESTS_PER_SECOND` | `10`                                   |

## Development and verification

```sh
npm run typecheck       # All application workspaces
npm test                # Import, SDK adapter, queue, recovery, and HTTP tests
npm run test:e2e         # Production build + Chromium browser workflow, with a fake provider
npm run test:large       # Temporary 100 MiB fixture, import + pagination + responsiveness
npm run test:live        # Opt-in: one real request with synthetic data, when a key is configured
npm run build
```

For browser tests, install Chromium once if it is not present: `npx playwright install chromium`. Screenshots and failure traces are written to `test-results/` and ignored by Git. The fake provider is wired only into the standalone test server, never the normal application. The live smoke test skips when the key is absent.

The large fixture uses random content rather than a tiny archive of repeated bytes. One observed local run imported **25,913 records / 100 MiB JSON (74.65 MiB ZIP)** in **1.32 seconds**, with peak process RSS around **178 MiB**. These are local measurements, not universal performance guarantees.

Workspaces:

- `apps/web`: React interface, TanStack Query/Table, Recharts, and Vite.
- `apps/api`: Express, streaming import, SQLite store, durable runner, TypeSafe adapter.
- `packages/shared`: Zod-validated contracts, typed answers, request projection, starter questions.

## API

Responses are JSON unless exporting. Invalid input returns `{ "error": "..." }` with an appropriate HTTP status. Records/results are paginated using `page` and `pageSize` (maximum 100).

| Method     | Endpoint                                | Purpose                                                                                  |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| GET        | `/api/config`                           | Connection readiness and public limits; never the key                                    |
| GET / POST | `/api/datasets`                         | List datasets / upload multipart `file` and optional `name`                              |
| GET        | `/api/datasets/:id`                     | Metadata, import progress, fields, sources, notices                                      |
| POST       | `/api/datasets/:id/import`              | Continue with `{ selections: { sourceId: jsonPointerOrNull } }`                          |
| GET        | `/api/datasets/:id/records`             | Records; optional `search`, `sourceId`, pagination                                       |
| POST       | `/api/datasets/:id/preview`             | Validate configuration and preview request/count, without inference                      |
| GET / POST | `/api/datasets/:id/runs`                | History / start a run using the shared `RunConfig` contract                              |
| GET        | `/api/runs/:id`                         | Progress, configuration, aggregate summaries, returned models                            |
| GET        | `/api/runs/:id/results`                 | Results; optional `status`, `question`, `category`, `minimum`, `confidence`, `direction` |
| POST       | `/api/runs/:id/cancel`                  | Cancel outstanding work                                                                  |
| POST       | `/api/runs/:id/resume`                  | Resume an interrupted run                                                                |
| GET        | `/api/runs/:id/export?format=json\|csv` | Stream results with the same result filters                                              |
| GET        | `/api/example`                          | Download the example archive                                                             |

JSON exports include the configuration and original records with raw answers. CSV exports include result values, confidence where applicable, probability distributions, source identifiers, model, usage, and errors. Cells are quoted and spreadsheet formula prefixes escaped.

Direct Cosmos connections, cross-record joins, document editing, team hosting/authentication, generated chat answers, PDFs, and Office file extraction are outside v1.
