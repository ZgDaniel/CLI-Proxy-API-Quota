# CPA Quota

Private read-only dashboard for `CLIProxyAPI` / `CPA-backend` quota and usage data.

## What It Does

- Lets the visitor connect with `CPA URL + CPA management key`
- Displays only providers that have uploaded auth files
- Groups accounts by provider
- Shows quota and usage in one page
- Caches quota and usage server-side to reduce refresh pressure

## Environment

Copy `.env.example` into your deployment environment.

- `SESSION_SECRET`: secret used to sign session cookies
- `USAGE_TTL_SECONDS`: usage cache TTL, default `30`
- `QUOTA_TTL_SECONDS`: quota cache TTL, default `300`

## Development

```bash
npm install
SESSION_SECRET=dev-secret \
npm run dev
```

Client: `http://localhost:4178`

Server: `http://localhost:4179`

## Production

```bash
npm install
npm run build
SESSION_SECRET=prod-secret \
NODE_ENV=production \
npm start
```
