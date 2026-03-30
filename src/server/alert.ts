import type { AlertConfig, OverviewResponse } from '../shared/types.js';

const DEFAULT_CONFIG: AlertConfig = {
  enabled: false,
  webhook_url: '',
  thresholds: [50],
  refresh_interval_seconds: 300,
};

let config: AlertConfig = { ...DEFAULT_CONFIG };
let timer: ReturnType<typeof setInterval> | null = null;
let onTick: (() => Promise<{ cpaBaseUrl: string; cpaManagementKey: string } | null>) | null = null;

// key: `${auth_index}:${item_id}:${threshold}` → value: reset_at
const alertedWindows = new Map<string, string>();

export const getAlertConfig = (): AlertConfig => ({ ...config });

export const updateAlertConfig = (patch: Partial<AlertConfig>): AlertConfig => {
  if (patch.enabled !== undefined) {
    config.enabled = patch.enabled;
    restartTimer();
  }
  if (patch.webhook_url !== undefined) config.webhook_url = patch.webhook_url;
  if (patch.thresholds !== undefined) {
    const arr = patch.thresholds.filter((v) => Number.isFinite(v) && v > 0 && v <= 100);
    if (arr.length > 0) config.thresholds = arr;
  }
  if (patch.refresh_interval_seconds !== undefined) {
    const allowed = [60, 300, 600, 1800, 3600, 18000];
    const v = Number(patch.refresh_interval_seconds);
    if (allowed.includes(v)) {
      config.refresh_interval_seconds = v;
      restartTimer();
    }
  }
  return { ...config };
};

type AlertItem = {
  provider: { name: string };
  account: { label: string | null; name: string };
  item: { label: string; remaining_percent: number };
  threshold: number;
};

const collectAlerts = (overview: OverviewResponse): AlertItem[] => {
  const alerts: AlertItem[] = [];
  const thresholds = [...config.thresholds].sort((a, b) => a - b);

  for (const provider of overview.providers) {
    if (!provider.active) continue;
    for (const account of provider.accounts) {
      if (account.disabled) continue;
      for (const item of account.quota.items) {
        if (item.remaining_percent === null) continue;
        const pct = item.remaining_percent;

        // Find the lowest threshold that pct crosses (≤ threshold)
        // and that hasn't been alerted for this window yet
        for (const threshold of thresholds) {
          if (pct > threshold) continue;

          const dedupeKey = `${account.auth_index}:${item.id}:${threshold}`;
          const windowKey = item.reset_at ?? '';
          if (alertedWindows.get(dedupeKey) === windowKey) break; // already alerted at this or lower threshold

          alertedWindows.set(dedupeKey, windowKey);
          alerts.push({
            provider: { name: provider.name },
            account: { label: account.label, name: account.name },
            item: { label: item.label, remaining_percent: pct },
            threshold,
          });
          break; // only alert for the lowest crossed threshold
        }
      }
    }
  }
  return alerts;
};

const sendWebhook = async (url: string, payload: unknown): Promise<{ ok: boolean; error?: string }> => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
};

export const sendTestWebhook = async (): Promise<{ ok: boolean; error?: string }> => {
  if (!config.webhook_url) return { ok: false, error: 'No webhook URL configured' };
  return sendWebhook(config.webhook_url, {
    title: '测试告警',
    content: '这是一条测试消息，用于验证 Webhook 连接是否正常。',
    alerts: [{
      provider: 'TestProvider',
      account: 'test@example.com',
      quota: '测试配额',
      remaining_percent: 25,
      threshold: 50,
      reset_at: null,
    }],
  });
};

const tick = async (): Promise<void> => {
  if (!config.enabled || !onTick) return;
  const creds = await onTick();
  if (!creds) return;

  const { buildOverview } = await import('./overview.js');
  const overview = await buildOverview(creds).catch(() => null);
  if (!overview) return;

  const alerts = collectAlerts(overview);
  if (alerts.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[alert] ${alerts.length} quota alert(s) triggered, sending webhook…`);
    const lines = alerts.map((a) => {
      const pct = `${Math.round(a.item.remaining_percent)}%`;
      return `[${a.provider.name}] ${a.account.label || a.account.name} — ${a.item.label}: 剩余 ${pct}（阈值 ${a.threshold}%）`;
    });
    await sendWebhook(config.webhook_url, {
      title: `配额告警 (${alerts.length} 条)`,
      content: lines.join('\n'),
      alerts: alerts.map((a) => ({
        provider: a.provider.name,
        account: a.account.label || a.account.name,
        quota: a.item.label,
        remaining_percent: a.item.remaining_percent,
        threshold: a.threshold,
      })),
    });
  }
};

const restartTimer = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
  if (config.enabled && config.refresh_interval_seconds > 0) {
    timer = setInterval(() => {
      void tick();
    }, config.refresh_interval_seconds * 1000);
  }
};

export const startAlertScheduler = (
  credentialProvider: () => Promise<{ cpaBaseUrl: string; cpaManagementKey: string } | null>,
): void => {
  onTick = credentialProvider;
  restartTimer();
};

export const getRefreshIntervalMs = (): number => config.refresh_interval_seconds * 1000;
