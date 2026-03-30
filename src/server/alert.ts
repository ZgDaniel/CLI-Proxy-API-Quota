import type { AlertConfig, OverviewResponse } from '../shared/types.js';

const DEFAULT_CONFIG: AlertConfig = {
  enabled: false,
  webhook_url: '',
  threshold: 50,
  check_interval_seconds: 300,
};

let config: AlertConfig = { ...DEFAULT_CONFIG };
let timer: ReturnType<typeof setInterval> | null = null;
let onTick: (() => Promise<{ cpaBaseUrl: string; cpaManagementKey: string } | null>) | null = null;

const alertedWindows = new Map<string, string>();

export const getAlertConfig = (): AlertConfig => ({ ...config });

export const updateAlertConfig = (patch: Partial<AlertConfig>): AlertConfig => {
  if (patch.enabled !== undefined) {
    config.enabled = patch.enabled;
    restartTimer();
  }
  if (patch.webhook_url !== undefined) config.webhook_url = patch.webhook_url;
  if (patch.threshold !== undefined) {
    const v = Number(patch.threshold);
    if (Number.isFinite(v) && v > 0 && v <= 100) config.threshold = v;
  }
  if (patch.check_interval_seconds !== undefined) {
    const allowed = [60, 300, 600, 1800, 3600, 18000];
    const v = Number(patch.check_interval_seconds);
    if (allowed.includes(v)) {
      config.check_interval_seconds = v;
      restartTimer();
    }
  }
  return { ...config };
};

type AlertItem = {
  provider: { name: string };
  account: { label: string | null; name: string; email: string | null };
  item: { label: string; remaining_percent: number | null; reset_at: string | null };
};

const collectAlerts = (overview: OverviewResponse): AlertItem[] => {
  const alerts: AlertItem[] = [];
  for (const provider of overview.providers) {
    if (!provider.active) continue;
    for (const account of provider.accounts) {
      if (account.disabled) continue;
      for (const item of account.quota.items) {
        if (item.remaining_percent === null) continue;
        if (item.remaining_percent <= config.threshold) {
          const dedupeKey = `${account.auth_index}:${item.id}`;
          const windowKey = item.reset_at ?? '';
          if (alertedWindows.get(dedupeKey) === windowKey) continue;
          alertedWindows.set(dedupeKey, windowKey);
          alerts.push({ provider: { name: provider.name }, account: { label: account.label, name: account.name, email: account.email }, item: { label: item.label, remaining_percent: item.remaining_percent, reset_at: item.reset_at } });
        }
      }
    }
  }
  return alerts;
};

const sendWebhook = async (alerts: AlertItem[]): Promise<void> => {
  if (!config.webhook_url) return;

  const lines = alerts.map((a) => {
    const pct = a.item.remaining_percent !== null ? `${Math.round(a.item.remaining_percent)}%` : '?';
    const reset = a.item.reset_at ? ` | 重置: ${a.item.reset_at}` : '';
    const accountLabel = a.account.label || a.account.name;
    return `[${a.provider.name}] ${accountLabel} — ${a.item.label}: 剩余 ${pct}${reset}`;
  });

  const payload = {
    title: `配额告警 (${alerts.length} 条)`,
    content: lines.join('\n'),
    alerts: alerts.map((a) => ({
      provider: a.provider.name,
      account: a.account.label || a.account.name,
      quota: a.item.label,
      remaining_percent: a.item.remaining_percent,
      reset_at: a.item.reset_at,
    })),
  };

  try {
    await fetch(config.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Webhook delivery failed:', error instanceof Error ? error.message : error);
  }
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
    await sendWebhook(alerts);
  }
};

const restartTimer = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
  if (config.enabled && config.check_interval_seconds > 0) {
    timer = setInterval(() => {
      void tick();
    }, config.check_interval_seconds * 1000);
  }
};

export const startAlertScheduler = (
  credentialProvider: () => Promise<{ cpaBaseUrl: string; cpaManagementKey: string } | null>,
): void => {
  onTick = credentialProvider;
  restartTimer();
};
