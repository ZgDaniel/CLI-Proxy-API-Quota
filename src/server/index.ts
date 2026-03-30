import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { appConfig } from './config.js';
import { buildOverview } from './overview.js';
import { clearSession, createSession, getSession, isAuthenticated, setSessionCookie } from './session.js';
import { createCpaClient, normalizeCpaBaseUrl } from './cpaClient.js';
import type { OverviewResponse, SessionResponse } from '../shared/types.js';

const app = express();
let publicOverview: OverviewResponse | null = null;

app.use(express.json());
app.use(cookieParser());

const authRequired = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

app.get('/api/session', (req, res) => {
  const payload: SessionResponse = { authenticated: isAuthenticated(req) };
  res.json(payload);
});

app.get('/api/public-overview', (_req, res) => {
  if (!publicOverview) {
    res.status(404).json({ error: 'Public overview is not ready yet' });
    return;
  }
  res.json(publicOverview);
});

app.post('/api/login', async (req, res) => {
  const cpaBaseUrl = typeof req.body?.base_url === 'string' ? normalizeCpaBaseUrl(req.body.base_url) : '';
  const cpaManagementKey =
    typeof req.body?.management_key === 'string' ? req.body.management_key.trim() : '';
  const rememberMe = req.body?.remember_me === true;
  if (!cpaBaseUrl || !cpaManagementKey) {
    res.status(400).json({ error: 'Missing CPA URL or management key' });
    return;
  }

  try {
    const client = createCpaClient({ cpaBaseUrl, cpaManagementKey });
    await client.listAuthFiles();
  } catch (error) {
    const message =
      error instanceof Error && 'response' in error
        ? (() => {
            const response = (error as Error & { response?: { status?: number; data?: unknown } }).response;
            const status = response?.status;
            const body =
              response?.data && typeof response.data === 'object' && response.data !== null
                ? (response.data as Record<string, unknown>)
                : null;
            const backendMessage =
              typeof body?.error === 'string'
                ? body.error
                : typeof body?.message === 'string'
                  ? body.message
                  : '';
            if (status === 401) {
              return 'CPA rejected the management key. Check the key and ensure this is the CPA backend URL.';
            }
            if (status === 403) {
              return backendMessage || 'CPA remote management is disabled or the key is not accepted.';
            }
            if (status === 404) {
              return 'Management API not found. Try the CPA backend root URL, not the panel page URL.';
            }
            return backendMessage || error.message;
          })()
        : error instanceof Error
          ? error.message
          : 'Connection failed';
    res.status(401).json({
      error: `Connection failed: ${message}`,
    });
    return;
  }

  const session = createSession({ rememberMe, cpaBaseUrl, cpaManagementKey });
  setSessionCookie(res, session, rememberMe);
  res.json({ authenticated: true });
});

app.post('/api/logout', (req, res) => {
  clearSession(req, res);
  res.json({ authenticated: false });
});

app.get('/api/overview', authRequired, async (_req, res) => {
  try {
    const session = getSession(_req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const overview = await buildOverview(session);
    publicOverview = overview;
    res.json(overview);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Failed to load overview' });
  }
});

app.post('/api/refresh', authRequired, async (req, res) => {
  const scope = typeof req.body?.scope === 'string' ? req.body.scope : 'all';
  try {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const overview = await buildOverview({
      cpaBaseUrl: session.cpaBaseUrl,
      cpaManagementKey: session.cpaManagementKey,
    }, {
      forceUsage: scope === 'all' || scope === 'usage',
      forceQuota: scope === 'all' || scope === 'quota',
    });
    publicOverview = overview;
    res.json(overview);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Failed to refresh overview' });
  }
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(appConfig.publicDir));
  app.get('/{*path}', (_req, res) => {
    res.sendFile(path.join(appConfig.publicDir, 'index.html'));
  });
}

app.listen(appConfig.port, () => {
  // eslint-disable-next-line no-console
  console.log(`CPA quota server listening on http://localhost:${appConfig.port}`);
});
