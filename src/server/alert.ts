import type { AlertConfig, AlertChannel, OverviewResponse } from '../shared/types.js';

const DEFAULT_CONFIG: AlertConfig = {
  enabled: false,
  channel: 'custom',
  custom_url: '',
  feishu_token: '',
  telegram_bot_token: '',
  telegram_chat_id: '',
  qmsg_key: '',
  thresholds: [50],
  refresh_interval_seconds: 300,
};

let config: AlertConfig = { ...DEFAULT_CONFIG };
let timer: ReturnType<typeof setInterval> | null = null;
let onTick: (() => Promise<{ cpaBaseUrl: string; cpaManagementKey: string } | null>) | null = null;
let onOverview: ((overview: OverviewResponse) => void) | null = null;

// key: `${auth_index}:${item_id}:${threshold}` → value: reset_at
const alertedWindows = new Map<string, string>();

export const getAlertConfig = (): AlertConfig => ({ ...config });

export const updateAlertConfig = (patch: Partial<AlertConfig>): AlertConfig => {
  if (patch.enabled !== undefined) {
    config.enabled = patch.enabled;
    restartTimer();
  }
  if (patch.channel !== undefined) {
    const valid: AlertChannel[] = ['custom', 'feishu', 'telegram', 'qmsg'];
    if (valid.includes(patch.channel)) config.channel = patch.channel;
  }
  if (patch.custom_url !== undefined) config.custom_url = patch.custom_url;
  if (patch.feishu_token !== undefined) config.feishu_token = patch.feishu_token;
  if (patch.telegram_bot_token !== undefined) config.telegram_bot_token = patch.telegram_bot_token;
  if (patch.telegram_chat_id !== undefined) config.telegram_chat_id = patch.telegram_chat_id;
  if (patch.qmsg_key !== undefined) config.qmsg_key = patch.qmsg_key;
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

// ── Channel senders ──

const sendCustom = async (url: string, payload: unknown): Promise<{ ok: boolean; error?: string }> => {
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

const extractFeishuToken = (raw: string): string => {
  // If user pasted the full webhook URL, extract the token part
  const match = raw.match(/hook\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : raw;
};

const sendFeishu = async (rawToken: string, content: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    const token = extractFeishuToken(rawToken);
    const url = `https://open.feishu.cn/open-apis/bot/v2/hook/${token}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: content } }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const msg = typeof body.msg === 'string' ? body.msg : '';
      return { ok: false, error: `HTTP ${res.status}${msg ? `: ${msg}` : ''}` };
    }
    // Feishu returns HTTP 200 with code != 0 for business errors
    const code = typeof body.code === 'number' ? body.code : -1;
    if (code !== 0) {
      const msg = typeof body.msg === 'string' ? body.msg : 'unknown error';
      return { ok: false, error: `飞书返回错误 (${code}): ${msg}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
};

const sendTelegram = async (botToken: string, chatId: string, content: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: content, parse_mode: 'HTML' }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const desc = typeof body.description === 'string' ? body.description : '';
      return { ok: false, error: `HTTP ${res.status}${desc ? `: ${desc}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
};

const sendQmsg = async (key: string, content: string): Promise<{ ok: boolean; error?: string }> => {
  try {
    const url = `https://qmsg.zendee.cn/send/${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `msg=${encodeURIComponent(content)}`,
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    // Qmsg returns HTTP 200 with success:false for business errors
    if (body.success === false) {
      const reason = typeof body.reason === 'string' ? body.reason : 'unknown error';
      return { ok: false, error: `Qmsg 返回错误: ${reason}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
};

// ── Dispatch ──

const dispatchAlert = async (content: string): Promise<{ ok: boolean; error?: string }> => {
  switch (config.channel) {
    case 'feishu':
      if (!config.feishu_token) return { ok: false, error: '未配置飞书 Token' };
      return sendFeishu(config.feishu_token, content);
    case 'telegram':
      if (!config.telegram_bot_token || !config.telegram_chat_id) return { ok: false, error: '未配置 Telegram Bot Token 或 Chat ID' };
      return sendTelegram(config.telegram_bot_token, config.telegram_chat_id, content);
    case 'qmsg':
      if (!config.qmsg_key) return { ok: false, error: '未配置 Qmsg Key' };
      return sendQmsg(config.qmsg_key, content);
    default:
      if (!config.custom_url) return { ok: false, error: '未配置 Webhook URL' };
      return sendCustom(config.custom_url, {
        title: '配额告警',
        content,
      });
  }
};

const validateChannelConfig = (): { ok: boolean; error?: string } => {
  switch (config.channel) {
    case 'feishu':
      if (!config.feishu_token) return { ok: false, error: '未配置飞书 Token' };
      return { ok: true };
    case 'telegram':
      if (!config.telegram_bot_token || !config.telegram_chat_id) return { ok: false, error: '未配置 Telegram Bot Token 或 Chat ID' };
      return { ok: true };
    case 'qmsg':
      if (!config.qmsg_key) return { ok: false, error: '未配置 Qmsg Key' };
      return { ok: true };
    default:
      if (!config.custom_url) return { ok: false, error: '未配置 Webhook URL' };
      return { ok: true };
  }
};

export const sendTestWebhook = async (): Promise<{ ok: boolean; error?: string }> => {
  const validation = validateChannelConfig();
  if (!validation.ok) return validation;

  const testContent = '这是一条测试消息，用于验证通知渠道连接是否正常。';
  return dispatchAlert(testContent);
};

const tick = async (): Promise<void> => {
  if (!onTick) return;
  const creds = await onTick();
  if (!creds) return;

  const { buildOverview } = await import('./overview.js');
  const overview = await buildOverview(creds).catch(() => null);
  if (!overview) return;

  onOverview?.(overview);

  if (!config.enabled) return;

  const alerts = collectAlerts(overview);
  if (alerts.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`[alert] ${alerts.length} quota alert(s) triggered, sending via ${config.channel}…`);
    const lines = alerts.map((a) => {
      const pct = `${Math.round(a.item.remaining_percent)}%`;
      return `[${a.provider.name}] ${a.account.label || a.account.name} — ${a.item.label}: 剩余 ${pct}（阈值 ${a.threshold}%）`;
    });
    const content = `配额告警 (${alerts.length} 条)\n\n${lines.join('\n')}`;
    await dispatchAlert(content);
  }
};

const restartTimer = (): void => {
  if (timer) clearInterval(timer);
  timer = null;
  if (onTick && config.refresh_interval_seconds > 0) {
    timer = setInterval(() => {
      void tick();
    }, config.refresh_interval_seconds * 1000);
  }
};

export const startAlertScheduler = (
  credentialProvider: () => Promise<{ cpaBaseUrl: string; cpaManagementKey: string } | null>,
  overviewListener?: (overview: OverviewResponse) => void,
): void => {
  onTick = credentialProvider;
  onOverview = overviewListener ?? null;
  restartTimer();
};

export const getRefreshIntervalMs = (): number => config.refresh_interval_seconds * 1000;
