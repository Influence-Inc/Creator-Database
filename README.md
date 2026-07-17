# Creator Database Backend

A production-ready backend service that builds and maintains a **centralized
Creator Database** by collecting creator information from four sources:

1. **Instantly outreach dashboard** — creator/lead rows synced from campaigns.
2. **Instantly email threads** — parsed by the **Claude API** into structured
   deal data (rates, deliverables, deadlines, negotiation status).
3. **Outreach signed contracts** — pushed by the Outreach backend when a creator
   signs, including the full signing submission: address, phone, gender, drawn
   signature, bank/payout details, deliverables, usage rights, and platform.
4. **influence-stats / ReelMetrics** — per-campaign performance polled from
   `GET /api/bot/campaigns`: views in each post and combined, likes/comments,
   risk level, CPM (booked + realized), budget, and deliverables completion.

There is **no frontend** — this is a headless REST + background-worker service,
designed to be deployed on **Railway** with a PostgreSQL database.

The core invariant: **one master record per creator**. New outreach and creator
replies update that master record instead of creating duplicates.

---

## Table of contents

- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Data model](#data-model)
- [Identity resolution & merge logic](#identity-resolution--merge-logic)
- [Background jobs](#background-jobs)
- [Claude extraction](#claude-extraction)
- [REST API](#rest-api)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Testing](#testing)
- [Railway deployment](#railway-deployment)
- [Project structure](#project-structure)
- [Extending the system](#extending-the-system)

---

## Architecture

```
 Instantly dashboard ──▶ Outreach Import (Job 1) ──┐
                                                   ├─▶  Creator merge  ──▶  PostgreSQL
 Instantly email     ──▶ Email Fetcher  (Job 2) ──▶ email_history        (master record)
 threads                        │                              │
                                ▼                              ▼
                         Claude Extraction (Job 3) ──▶ structured JSON ──▶ Creator merge

 REST API  ◀────────────────────────────────────────────  PostgreSQL
 (future frontend / integrations)
```

Every write to a creator flows through a single merge path
(`CreatorsService.upsertFromSource`) that:

1. Resolves the creator's identity (email → instagram → name).
2. Updates only the fields the source actually provides (never clobbers known
   data with nulls).
3. Records every field change in an append-only **activity log**.

## Tech stack

- **Node.js 20 + TypeScript**
- **NestJS** (clean, modular, dependency-injected architecture)
- **PostgreSQL** + **Prisma ORM**
- **Claude API** (`@anthropic-ai/sdk`) for email extraction
- **Cron background workers** (`@nestjs/schedule`)
- **REST API** with validation, pagination, search, filtering, sorting
- **Docker** + **Railway** deployment
- **Jest** unit & e2e tests (Instantly and Claude fully mocked)

## Data model

Prisma schema: [`prisma/schema.prisma`](./prisma/schema.prisma).

| Table            | Purpose                                                              |
| ---------------- | ------------------------------------------------------------------- |
| `creators`       | The master record. Identity, campaign, performance, commercial, deliverables, communication, deliverability, risk level, negotiation status. `email` and `instagramUsername` are unique. |
| `campaigns`      | One row per Instantly campaign (synced during Job 1).               |
| `contracts`      | One row per signed contract (pushed by the Outreach backend). Terms + the full signer submission: address, phone, gender, signature image, and bank/payout details. |
| `creator_stats`  | One row per creator per influence-stats campaign (synced during Job 4). Combined + per-post views/likes/comments, risk, CPM, budget, deliverables. |
| `email_history`  | Every fetched email message + its Claude extraction. `contentHash` detects edited threads; `processedAt = null` marks a thread as needing extraction. |
| `activity_logs`  | Append-only audit: `creator, changedField, oldValue, newValue, source, timestamp`. |
| `failed_jobs`    | Dead-letter queue for jobs that fail after their retries.           |
| `sync_runs`      | Observability record for every background/manual sync run.          |

Negotiation status is an enum: `PENDING`, `NEGOTIATING`, `ACCEPTED`,
`REJECTED`, `COMPLETED`. Activity source is an enum:
`INSTANTLY_DASHBOARD`, `CLAUDE_EXTRACTION`, `EMAIL_SYNC`, `MANUAL_API`,
`SYSTEM`.

## Identity resolution & merge logic

Creators are uniquely identified in **priority order**:

1. **Email**
2. **Instagram username**
3. **Creator name** (fallback)

When a source provides creator data:

```
if a creator with that email exists      -> update it
else if that instagram handle exists      -> update it
else if that creator name exists          -> update it
else                                       -> create a new creator
```

Merge rules (implemented in
[`creators.service.ts`](./src/modules/creators/creators.service.ts)):

- Only **provided** fields are applied — a `null`/absent field never
  overwrites an existing value.
- **Identity keys** (email, instagram) are only *filled when empty*, never
  overwritten, and never stolen from another creator (a pre-check avoids
  unique-constraint clashes). Manual `PATCH` edits may overwrite identity.
- Every changed field is written to the activity log with its old/new value
  and the source that changed it.
- Concurrent create races (two syncs, same creator) are handled with a
  transaction + unique-constraint retry.

Identity values are normalized before matching (emails lower-cased, instagram
handles stripped of `@`/URL and lower-cased, currencies upper-cased) — see
[`normalize.ts`](./src/common/utils/normalize.ts).

## Background jobs

Three cron jobs run on independent, configurable schedules (and can be
triggered manually via the API). Overlapping runs are skipped, and scheduling
can be disabled entirely with `ENABLE_SCHEDULER=false`.

| Job | Default cadence | What it does |
| --- | --------------- | ------------ |
| **Job 1 — Outreach sync** | every 30 min | Upserts campaigns, walks each campaign's leads, maps them to creators, merges. |
| **Job 2 — Email sync**    | every 10 min | Fetches recent email threads into `email_history`. New/edited messages land with `processedAt = null`. |
| **Job 3 — Claude extraction** | every 10 min | Runs Claude **only** for threads with unprocessed messages (new emails, new replies, edited threads). Never re-analyses unchanged threads. |

Reliability:

- Instantly calls retry transient failures (5xx / 429 / network / timeout)
  with exponential backoff and fail fast on 4xx.
- Claude calls retry (configurable) and tolerate malformed responses.
- Per-item failures are **dead-lettered** (`failed_jobs`) and the run
  continues; a permanently un-extractable thread is marked
  processed-with-error so it never hot-loops.

## Claude extraction

Claude reads a full email thread and returns **JSON only** (no markdown, no
prose) matching a fixed schema. The prompt (see
[`claude.prompts.ts`](./src/integrations/claude/claude.prompts.ts)) teaches it
to read natural negotiation language:

| Email text | Extraction |
| --- | --- |
| "We can do 2 reels for 40k" | `accepted_rate: 40000`, `deliverables.reels: 2` |
| "Deadline works for July 18" | `deadline: "2026-07-18"` |
| "We guarantee 2M views" | `guaranteed_views: 2000000` |
| "We'll do 3 videos" | `deliverables.videos: 3` |

The service parses defensively (isolates the JSON object even if the model adds
fences/prose), coerces shorthand (`"40k"`, `"2M"`) into typed numbers, resolves
partial dates, maps free-text status to the enum, and dead-letters on failure.

**Model:** defaults to `claude-opus-4-8` (configurable via `CLAUDE_MODEL`).
Cost-sensitive deployments can switch to `claude-haiku-4-5` or
`claude-sonnet-5`.

## REST API

Base URL: the deployed service root. All list endpoints support pagination,
search, filtering and sorting.

| Method & path | Description |
| --- | --- |
| `GET /health` | Liveness + DB connectivity (200 up / 503 down). |
| `GET /creators` | List creators. Query: `page`, `limit`, `search`, `status`, `campaignId`, `campaignName`, `manager`, `instagram`, `email`, `sortBy`, `sortOrder`. |
| `POST /creators` | Manual create-or-merge (requires one identity field). |
| `GET /creator/:id` | Fetch one creator. |
| `PATCH /creator/:id` | Manual update (may overwrite identity). |
| `GET /creator/:id/activity` | Change history for a creator. |
| `GET /campaigns` | List campaigns (with creator counts). Query: `page`, `limit`, `search`, `sortBy`, `sortOrder`. |
| `GET /campaigns/:id` | Fetch one campaign. |
| `GET /statistics` | Aggregate dashboard metrics. |
| `POST /sync/outreach` | Run Job 1 now → returns run summary. |
| `POST /sync/emails` | Run Job 2 now → returns run summary. |
| `POST /sync/claude` | Run Job 3 now → returns run summary. |

**Search** matches (case-insensitive) creator name, instagram, email, campaign
and manager. **Sort** is whitelisted to safe columns.

`GET /statistics` returns: total creators, counts by status
(negotiating/accepted/completed/…), average CPM, average accepted rate, average
guaranteed views, campaign count, upcoming deadlines, and pending deliverables.

List responses are wrapped:

```json
{
  "data": [ ... ],
  "meta": { "total": 42, "page": 1, "limit": 20, "totalPages": 3,
            "hasNextPage": true, "hasPreviousPage": false }
}
```

## Local development

Prerequisites: Node 20+, a PostgreSQL database.

```bash
# 1. Install deps
npm install

# 2. Configure
cp .env.example .env      # then fill in DATABASE_URL, INSTANTLY_API_KEY, CLAUDE_API_KEY

# 3. Generate the Prisma client + apply migrations
npm run prisma:generate
npm run prisma:migrate:deploy      # or `prisma:migrate:dev` while iterating

# 4. (optional) seed a demo creator/campaign
npm run db:seed

# 5. Run
npm run start:dev                  # watch mode
# or
npm run build && npm run start:prod
```

Health check: `curl http://localhost:3000/health`.

Trigger a sync manually: `curl -X POST http://localhost:3000/sync/outreach`.

## Environment variables

See [`.env.example`](./.env.example) for the annotated list. Key variables:

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | PostgreSQL connection string. |
| `INSTANTLY_API_KEY` | ✅ (prod) | Instantly v2 API key. |
| `CLAUDE_API_KEY` | ✅ (prod) | Anthropic API key. |
| `PORT` | — | HTTP port (Railway injects it). |
| `LOG_LEVEL` | — | `debug`/`info`/`warn`/`error`. |
| `CLAUDE_MODEL` | — | Extraction model (default `claude-opus-4-8`). |
| `ENABLE_SCHEDULER` | — | `false` to run the API without cron workers. |
| `CRON_OUTREACH_SYNC` / `CRON_EMAIL_SYNC` / `CRON_CLAUDE_EXTRACTION` | — | Cron expressions per job. |
| `INSTANTLY_CAMPAIGN_IDS` | — | Restrict sync to specific campaigns. |
| `RAILWAY_ENVIRONMENT` | — | Set automatically by Railway. |

Startup validation fails fast if a required variable is missing.

## Testing

```bash
npm test          # unit tests
npm run test:e2e  # end-to-end HTTP tests
npm run test:cov  # coverage
```

- **Unit tests** cover the merge/identity logic, statistics aggregation,
  normalization utilities, Claude parsing/mapping, and Instantly
  parsing/mapping. The **Claude and Instantly APIs are fully mocked** — no
  network or credentials required.
- **E2E tests** boot the real application (global validation pipe, exception
  filter, routing) with Prisma and the statistics service stubbed, and assert
  health, statistics, validation, and 404 behaviour.

## Railway deployment

The service ships with everything Railway needs:

- **[`Dockerfile`](./Dockerfile)** — multi-stage build; the runtime image runs
  `prisma migrate deploy` then boots the server.
- **[`railway.json`](./railway.json)** — Dockerfile builder, `/health`
  healthcheck, restart-on-failure.
- **Prisma migrations** — versioned in `prisma/migrations/`, applied
  automatically on deploy.

Steps:

1. Create a Railway project and add the **PostgreSQL** plugin (provides
   `DATABASE_URL`).
2. Point Railway at this repo; it builds from the Dockerfile.
3. Set the production variables (`INSTANTLY_API_KEY`, `CLAUDE_API_KEY`,
   `CLAUDE_MODEL`, cron schedules, …) in the service's **Variables** tab.
4. Deploy. Migrations apply on boot; `/health` gates readiness.

## Project structure

```
src/
  main.ts                     app bootstrap (pipes, filters, logger)
  app.module.ts               root module
  config/                     typed config + env validation
  common/
    prisma/                   PrismaService (+ health probe)
    logger/                   structured JSON logger
    filters/                  global exception filter (maps Prisma errors)
    interceptors/             request logging
    dto/                      pagination helpers
    utils/                    normalization + parsing helpers
  integrations/
    instantly/               Instantly HTTP client, types, mappers
    claude/                  Claude client, prompts, types, mapper
  modules/
    creators/                controller / service (merge) / repository / DTOs
    campaigns/               controller / service
    statistics/              controller / service
    activity-log/            audit service
    email-history/           message store + edit detection
    sync/                    Job 1/2/3 services, scheduler, dead-letter, run tracking
    health/                  health controller
prisma/
  schema.prisma              data model
  migrations/                versioned SQL migrations
  seed.ts                    optional demo seed
test/                        e2e tests
```

Architecture follows clean separation: **controllers** (thin, no business
logic) → **services** (business logic, DI) → **repositories** (Prisma access).
Integrations, DTOs, validators and workers are isolated in their own layers.

## Extending the system

The architecture is designed so new modules drop in without touching the core.
Straightforward additions:

- **Payments / invoices / contracts** — new Prisma models + modules, related to
  `Creator`.
- **Slack / WhatsApp notifications** — subscribe to sync results or activity-log
  writes.
- **Campaign ROI / analytics** — read models over the existing aggregates.
- **AI negotiation assistant** — reuse `ClaudeService` with a new prompt.

New data sources implement the same `CreatorUpsertInput` contract and call
`CreatorsService.upsertFromSource(input, source)` — they automatically get
dedup, field-level merge, and audit logging for free.
