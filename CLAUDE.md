# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CPA Quota — a private read-only dashboard for `CLIProxyAPI` / `CPA-backend` quota and usage data. Users connect via CPA URL + management key; the server fetches quota/usage from CPA's management API and displays it in a single-page React app. The last successful overview snapshot is also served publicly at `/` (no auth required), while admin access is at `/admin`.

## Commands

```bash
# Development (starts Vite dev server on :4178 + Express API on :4179)
npm install
SESSION_SECRET=dev-secret npm run dev

# Build (client to dist/client, server to dist/server)
npm run build

# Production
SESSION_SECRET=prod-secret NODE_ENV=production npm start

# Type checking (both client and server)
npm run type-check
```

No test framework is configured in this project.

## Architecture

**Monorepo-style client/server split** sharing types via `src/shared/`.

### `src/client/` — React SPA (Vite + React 19)
- Single `App.tsx` component with two routing modes: `/admin` (login + full control) and `/` (public read-only snapshot)
- All API calls go through a typed `api<T>()` helper with `credentials: 'include'`
- No routing library — uses `window.location.pathname` to distinguish admin vs public
- Styling is pure CSS in `index.css` with CSS custom properties (no CSS framework)

### `src/server/` — Express 5 API (Node, ESM)
- **`index.ts`** — Express app with auth middleware, all API routes (`/api/session`, `/api/login`, `/api/logout`, `/api/overview`, `/api/refresh`, `/api/public-overview`). In production, also serves the built SPA as static files with SPA fallback.
- **`session.ts`** — In-memory session store (Map) with HMAC-signed cookies. Sessions hold CPA credentials. Two TTL tiers: 1 day (default) or 30 days (remember me).
- **`cpaClient.ts`** — Axios client wrapping CPA's `/v0/management` REST API. Provides `listAuthFiles`, `downloadAuthFile`, `getUsage`, `apiCall`. The `apiCall` method is used for per-provider quota fetching (Claude, Codex, Gemini CLI, Kimi, Antigravity).
- **`overview.ts`** — Core data pipeline (~985 lines). Orchestrates: fetch auth files → fetch usage → per-account quota fetching (via provider-specific API calls through CPA's `apiCall` proxy) → grouping by provider → computing aggregates. Contains TTL-based in-memory caches for usage and quota data.
- **`config.ts`** — Reads env vars: `PORT` (4179), `SESSION_SECRET`, `USAGE_TTL_SECONDS` (30), `QUOTA_TTL_SECONDS` (300), `COOKIE_NAME`, `publicDir`.

### `src/shared/types.ts` — Shared TypeScript interfaces
- `OverviewResponse`, `OverviewProvider`, `OverviewAccount`, `OverviewQuota`, `OverviewUsage`, etc.
- `ProviderId` union type: `'claude' | 'codex' | 'gemini-cli' | 'kimi' | 'antigravity'`

### Key data flow
1. Client logs in with CPA URL + management key → server validates by calling `listAuthFiles`
2. Authenticated `/api/overview` call → `buildOverview()` fetches all auth files + usage in parallel, then fetches per-account quota concurrently
3. Each provider has a dedicated quota fetcher (`fetchClaudeQuotaWithClient`, `fetchCodexQuotaWithClient`, etc.) that calls the provider's API through CPA's `apiCall` proxy (the `$TOKEN$` placeholder is replaced server-side by CPA)
4. Results are cached in-memory with configurable TTL; `/api/refresh` with `{ scope }` forces cache bypass
5. Last successful overview is stored in `publicOverview` variable and served unauthenticated at `/api/public-overview`

## Deployment

- `deploy/cpa-quota.service` — systemd unit, reads `.env.production`, runs `node dist/server/server/index.js`
- `deploy/nginx.quota.bbroot.com.conf` — reverse proxy to `:4180`
- Server TypeScript compiles with `tsconfig.server.json` (NodeNext modules), output to `dist/server/`
- Client builds via Vite to `dist/client/`

## TypeScript Configuration

Two separate configs:
- `tsconfig.json` — Client: ES2022 target, Bundler module resolution, JSX react-jsx, covers `src/client` + `src/shared`
- `tsconfig.server.json` — Server: ES2022 target, NodeNext module resolution, covers `src/server` + `src/shared`
- Server imports use `.js` extension (NodeNext requirement): `import { foo } from './bar.js'`
