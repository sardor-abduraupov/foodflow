# FoodFlow Production Runbook

FoodFlow is a React frontend + Cloudflare Worker backend.

- Frontend: inventory UI, local interaction state, media capture, Supabase image upload.
- Backend (Worker): auth/session/house APIs, D1 persistence, AI gateway, Gemini/HuggingFace failover.
- Supabase: image object storage only.

This guide explains how to run, configure, and operate the app safely.

## 1) Architecture

### Frontend runtime

- `App.tsx`
  - Main app orchestration, tabs, sync loop, background image upload jobs, shopping list interactions.
- `components/LiveAssistant.tsx`
  - Voice assistant UI/controller, direct Live mode or secure worker-backed fallback mode.
- `services/geminiService.ts`
  - Frontend API client for Worker AI routes (`/api/gemini/*`).
  - Gemini keys are not required in frontend for normal secure mode.
- `services/storageService.ts`
  - Frontend API client for auth/session/houses routes (`/api/auth/*`, `/api/houses/*`).
  - Handles sync retry and stale conflict resolution.
- `services/supabase.ts`
  - Supabase browser client initialization from `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.
- `services/uploadImage.ts`
  - Base64 -> Blob conversion, upload to Supabase bucket, return public URL.
- `services/wikimediaService.ts`
  - Keyword normalization and verified Wikimedia fallback image lookup.
- `services/productResolver.ts`
  - Canonical product normalization and category hints.

### Backend runtime

- `worker/src/index.ts`
  - HTTP router and all API handlers.
  - D1 auth/session/house CRUD.
  - AI-powered receipt, voice parsing, recipes, categorization, ranking, image generation routes.
- `worker/src/ai/gateway.ts`
  - Unified AI gateway: Gemini primary, HuggingFace fallback, normalized responses.
  - Adaptive usage profile (`free`/`paid`) + Gemini limiter/backoff.
- `worker/src/ai/providers/gemini.ts`
  - Gemini adapter with timeout + error classification.
- `worker/src/ai/providers/huggingface.ts`
  - HuggingFace text fallback adapter.
- `worker/src/ai/types.ts`
  - Shared AI request/response/error types.

### Storage

- Cloudflare D1: account/house/session/activity data.
- Supabase Storage bucket: `food-images` (public URLs for rendered item/recipe images).

## 2) Required Environment

## Frontend `.env.local`

```bash
VITE_API_BASE_URL=https://<your-worker>.workers.dev
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<supabase-anon-key>
```

Optional:

```bash
# Direct browser Gemini Live mode (not recommended for production)
VITE_ENABLE_DIRECT_GEMINI_LIVE=false
VITE_GEMINI_API_KEY=
```

## Worker secrets and vars

Required secrets:

- `GEMINI_API_KEY`
- `HUGGINGFACE_API_KEY` (recommended for failover)
- `SUPABASE_URL` (for backend image persistence)
- `SUPABASE_SERVICE_ROLE_KEY` (recommended for global shared image catalog upload)

Optional vars/secrets:

- `GEMINI_TIMEOUT_MS` (default is controlled by gateway/provider defaults)
- `GEMINI_USAGE_MODE` = `free` or `paid`
- `GEMINI_MAX_REQUESTS_PER_MINUTE` (Gemini limiter)
- `GEMINI_MAX_CONCURRENT` (Gemini limiter)
- `GEMINI_RATE_LIMIT_COOLDOWN_MS` (Gemini cooldown after pressure)
- `SUPABASE_ANON_KEY` (fallback if service role is unavailable and bucket policy allows upload)
- `SUPABASE_STORAGE_BUCKET` (default: `food-images`)
- `ALLOWED_ORIGIN` (`*` by default in `worker/wrangler.toml`)

## 3) Commands

### Install dependencies

```bash
npm install
npm --prefix worker install
```

### Run locally

Terminal 1:

```bash
npm --prefix worker run dev
```

Terminal 2:

```bash
npm run dev
```

### Build checks

```bash
npm run build
npm --prefix worker run deploy -- --dry-run
```

### D1 setup/migrations

```bash
npm --prefix worker run db:create
npm --prefix worker run db:migrate:local
npm --prefix worker run db:migrate:remote
```

### Deploy worker

```bash
npm --prefix worker run deploy
```

### Deploy frontend (Cloudflare Pages)

```bash
npm run build
npx wrangler pages deploy dist --project-name foodflow
```

## 4) Key Management

### Set or rotate Gemini key

```bash
npx wrangler secret put GEMINI_API_KEY --config worker/wrangler.toml
```

### Set or rotate HuggingFace key

```bash
npx wrangler secret put HUGGINGFACE_API_KEY --config worker/wrangler.toml
```

### Set Supabase backend image secrets (for global cross-user image cache)

```bash
npx wrangler secret put SUPABASE_URL --config worker/wrangler.toml
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config worker/wrangler.toml
# optional fallback:
npx wrangler secret put SUPABASE_ANON_KEY --config worker/wrangler.toml
```

### Verify secret names

```bash
npx wrangler secret list --config worker/wrangler.toml
```

## 5) Free vs Paid Gemini Mode

Set usage mode in Worker environment:

```bash
npx wrangler secret put GEMINI_USAGE_MODE --config worker/wrangler.toml
# value: free or paid
```

You can also place non-sensitive defaults in `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGIN = "*"
GEMINI_USAGE_MODE = "free"
GEMINI_MAX_REQUESTS_PER_MINUTE = "40"
GEMINI_MAX_CONCURRENT = "2"
GEMINI_RATE_LIMIT_COOLDOWN_MS = "25000"
```

Recommended profiles:

- `free`
  - Flash-first model remap to maximize successful free-tier usage.
  - Conservative limiter/backoff to avoid quota thrash.
- `paid`
  - Keeps higher throughput defaults.
  - Still enforces limiter/backoff so app does not overload the key.

Notes:

- The limiter is worker-instance memory based (practical protection).
- For strict global distributed rate limiting, use Durable Objects or KV-backed counters.
- Product image generation uses a global cache keyed by canonical product term (multilingual/variant normalized).
- If `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are configured in Worker, cached images are uploaded once and reused for all users.

## 6) API Endpoints

### Auth

- `POST /api/auth/login`
- `POST /api/auth/session`
- `POST /api/auth/logout`

### Houses

- `POST /api/houses/create`
- `POST /api/houses/join`
- `POST /api/houses/fetch`
- `POST /api/houses/update`
- `POST /api/houses/rename`
- `POST /api/houses/change-password`
- `POST /api/houses/delete`
- `POST /api/houses/members`
- `POST /api/houses/remove-member`
- `POST /api/houses/activity`

### AI

- `POST /api/gemini/analyze-receipt`
- `POST /api/gemini/parse-voice`
- `POST /api/gemini/smart-item`
- `POST /api/gemini/generate-recipe`
- `POST /api/gemini/parse-recipe`
- `POST /api/gemini/categorize-batch`
- `POST /api/gemini/generate-image`
- `POST /api/gemini/rank-content`

## 7) Supabase Image Storage Setup

1. Create bucket `food-images`.
2. Ensure upload policy allows frontend anon uploads for your use case.
3. Ensure public read URL works for uploaded files.
4. Put `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env.local`.

## 8) Operational Checklist

Before release:

1. `npm run build` passes.
2. `npm --prefix worker run deploy -- --dry-run` passes.
3. Worker secrets set (`GEMINI_API_KEY`, `HUGGINGFACE_API_KEY`).
4. D1 remote migrations applied.
5. Frontend points to correct Worker URL in `VITE_API_BASE_URL`.
6. Supabase bucket is reachable and writable from frontend.

After release:

1. Test login/logout + refresh session restore.
2. Test create/join/switch house.
3. Test shopping list check/delete/add/finish flow.
4. Test receipt parsing and voice parsing.
5. Test image generation fallback path.

## 9) Troubleshooting

- `process is not defined` in frontend:
  - Use `import.meta.env` only in Vite frontend code.
- `404 /api/auth/login`:
  - Frontend is pointing to wrong `VITE_API_BASE_URL` or old Worker deployment.
- Stuck on restoring session:
  - Verify `POST /api/auth/session` returns 200 for valid token.
  - Invalid/expired token should return 401 and app should reset to logged-out state.
- Live assistant key error:
  - Keep direct live mode disabled unless intentionally using browser key.
  - Default secure mode uses Worker endpoints.
