import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { appConfig } from './config.js';
import { buildOverview } from './overview.js';
import { clearSession, createSession, getSession, getAnyActiveSession, isAuthenticated, setSessionCookie } from './session.js';
import { createCpaClient, normalizeCpaBaseUrl } from './cpaClient.js';
import type { OverviewResponse, SessionResponse, AlertConfigResponse, AlertConfig, AlertTestResponse } from '../shared/types.js';
import { getAlertConfig, updateAlertConfig, startAlertScheduler, sendTestWebhook } from './alert.js';
import { saveSchedulerCredentials, loadSchedulerCredentials } from './credentials.js';

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
  saveSchedulerCredentials({ cpaBaseUrl, cpaManagementKey });
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

app.get('/api/alert', authRequired, (_req, res) => {
  const payload: AlertConfigResponse = { config: getAlertConfig() };
  res.json(payload);
});

app.post('/api/alert', authRequired, (req, res) => {
  const patch: Partial<AlertConfig> = {};
  if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
  if (typeof req.body?.channel === 'string') patch.channel = req.body.channel;
  if (typeof req.body?.custom_url === 'string') patch.custom_url = req.body.custom_url.trim();
  if (typeof req.body?.feishu_token === 'string') patch.feishu_token = req.body.feishu_token.trim();
  if (typeof req.body?.telegram_bot_token === 'string') patch.telegram_bot_token = req.body.telegram_bot_token.trim();
  if (typeof req.body?.telegram_chat_id === 'string') patch.telegram_chat_id = req.body.telegram_chat_id.trim();
  if (typeof req.body?.qmsg_key === 'string') patch.qmsg_key = req.body.qmsg_key.trim();
  if (Array.isArray(req.body?.thresholds)) {
    const arr = req.body.thresholds.filter((v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100);
    if (arr.length > 0) patch.thresholds = arr;
  }
  if (req.body?.refresh_interval_seconds !== undefined) patch.refresh_interval_seconds = req.body.refresh_interval_seconds;
  const updated = updateAlertConfig(patch);
  const payload: AlertConfigResponse = { config: updated };
  res.json(payload);
});

app.post('/api/alert/test', authRequired, async (_req, res) => {
  const result = await sendTestWebhook();
  const payload: AlertTestResponse = result;
  res.json(payload);
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
  startAlertScheduler(
    async () => loadSchedulerCredentials() ?? getAnyActiveSession(),
    (overview) => {
      publicOverview = overview;
    },
  );
});
