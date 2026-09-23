# Jev Dataset Workbench

## Scope

This is a local, single-user desktop web workbench for exploring datasets with TypeSafe's Jev models. Users import files or Azure Cosmos DB for NoSQL query results, inspect saved records, configure focused classification/detection/scoring questions, and compare or export experiment results.

Target desktop browsers. **Mobile development is out of scope:** do not add or optimize phone/tablet layouts, mobile navigation, native mobile apps, or mobile-specific tests unless the user explicitly changes this restriction. Leave existing mobile styles and tests alone when working on desktop features; use desktop browser verification.

The application uses one local workspace and one backend process. Entra sign-in, tenant isolation, team hosting, live cloud synchronization, and editing source documents are outside the current scope.

## Architecture and boundaries

- `apps/web` owns the React interface and browser query cache. Keep dataset, import, and run states consistent across the library, sidebar, and detail screens.
- `apps/api` owns credentials, file/Cosmos import adapters, SQLite persistence, and the durable experiment runner. External calls belong behind testable backend adapters.
- `packages/shared` owns validated API contracts, typed Jev questions/answers, and request projection. Update shared contracts when changing an API used by both applications.
- Consult [README.md](README.md) before changing import behavior, persistence/recovery, inference, environment configuration, or API endpoints; it documents the supported formats, limits, and operating model. Update the relevant section when behavior changes.

## Data and execution rules

- Keep `.env` credentials exclusively in the backend. Public configuration reports readiness and limits; credentials and raw Cosmos SDK diagnostics must stay out of browser responses, logs, provenance, exports, and fixtures.
- Cosmos access is read-only. Preview and import execute separately; imports create local snapshots. Renaming or deleting a dataset affects only the local workspace, never Azure resources or source documents.
- Preserve nested JSON, query projections, duplicate source document IDs, and the `{ value: ... }` convention for non-object records. Normalized records and saved run membership/configuration are immutable; reimporting or rerunning creates new snapshots.
- Only an explicit experiment start/resume may call TypeSafe. Imports, filters, previews, and saved-result views must not trigger inference. Keep selected-field disclosure and request previews accurate.
- Preserve existing workspaces through additive SQLite migrations. Dataset deletion must remove dependent run results, runs, records, source metadata, and managed import files, while rejecting active imports or experiments, including requests still settling after cancellation.
- Treat the configured data directory as user data. Use temporary workspaces for tests and fixtures. Keep import cleanup, restart recovery, cancellation, and shutdown behavior intact.

## Verification

Use the commands in `package.json` and the README for type checking, builds, and relevant automated tests. For persistence or API changes, cover existing data and failure paths; for UI flows, verify them in a desktop browser. The existing small-screen browser scenarios are outside the current scope; select desktop tests with `npx playwright test --grep-invert 'small viewport|small screen'` after building.

Automated tests use fake TypeSafe/Cosmos adapters and temporary data. Real provider smoke tests require explicit opt-in; do not run them as routine verification or send the user's imported records to a provider during testing.
