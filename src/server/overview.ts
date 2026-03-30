import type {
  OverviewAccount,
  OverviewModelUsage,
  OverviewProvider,
  OverviewQuota,
  OverviewQuotaExtra,
  OverviewQuotaItem,
  OverviewResponse,
  OverviewUsage,
  OverviewWindowStats,
  ProviderId,
} from '../shared/types.js';
import type { RawAuthFile } from './cpaClient.js';
import { createCpaClient } from './cpaClient.js';
import { appConfig } from './config.js';

type UsageDetail = {
  authIndex: string;
  timestampMs: number;
  failed: boolean;
  totalTokens: number;
  model: string;
};

type QuotaCacheEntry = {
  updatedAt: number;
  data: OverviewQuota;
};

const providerNames: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  kimi: 'Kimi',
  antigravity: 'Antigravity',
};

const providerOrder: ProviderId[] = ['claude', 'codex', 'gemini-cli', 'kimi', 'antigravity'];

const quotaCache = new Map<string, QuotaCacheEntry>();
const usageCache = new Map<string, { updatedAt: number; details: UsageDetail[] }>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeString = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

const normalizeDateValue = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{10,13}$/.test(trimmed)) {
      const raw = Number(trimmed);
      if (Number.isFinite(raw)) {
        const ms = trimmed.length >= 13 ? raw : raw * 1000;
        const date = new Date(ms);
        return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
      }
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
  }
  return null;
};

const normalizeNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeFraction = (value: unknown): number | null => {
  const normalized = normalizeNumber(value);
  if (normalized !== null) return normalized;
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const parsed = Number(value.trim().slice(0, -1));
    return Number.isFinite(parsed) ? parsed / 100 : null;
  }
  return null;
};

const parseJson = <T>(value: unknown): T | null => {
  if (isRecord(value) || Array.isArray(value)) {
    return value as T;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
};

const formatResetLabel = (value: string | null | undefined): string => {
  if (!value) return '-';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '-';
  const deltaMs = timestamp - Date.now();
  if (deltaMs <= 0) return 'now';
  const totalMinutes = Math.floor(deltaMs / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
};

const buildWindow = (requests: number, tokens: number, failed: number): OverviewWindowStats => ({
  requests,
  tokens,
  failed_requests: failed,
  success_rate: requests > 0 ? Number(((requests - failed) / requests).toFixed(4)) : 1,
});

const emptyUsage = (): OverviewUsage => ({
  last_1h: buildWindow(0, 0, 0),
  last_24h: buildWindow(0, 0, 0),
  last_7d: buildWindow(0, 0, 0),
  models: [],
});

const emptyQuota = (): OverviewQuota => ({
  plan: { code: null, label: null },
  items: [],
  extra: [],
  raw_status: 'idle',
  error: '',
});

const detectProvider = (file: RawAuthFile): ProviderId | null => {
  const raw = normalizeString(file.provider ?? file.type)?.toLowerCase();
  if (!raw) return null;
  if (raw === 'claude') return 'claude';
  if (raw === 'codex') return 'codex';
  if (raw === 'gemini-cli') return 'gemini-cli';
  if (raw === 'kimi') return 'kimi';
  if (raw === 'antigravity') return 'antigravity';
  return null;
};

const parseIdToken = (value: unknown): Record<string, unknown> | null => {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    const parts = value.split('.');
    if (parts.length < 2) return null;
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      const json = Buffer.from(padded, 'base64').toString('utf8');
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
};

const resolveCodexPlan = (file: RawAuthFile): { code: string | null; label: string | null } => {
  const token = parseIdToken(file.id_token ?? file.metadata?.id_token ?? file.attributes?.id_token);
  const raw =
    normalizeString((token?.chatgpt_plan_type as unknown) ?? (token?.plan_type as unknown)) ??
    normalizeString(file.metadata?.plan_type) ??
    normalizeString(file.attributes?.plan_type);
  const code = raw?.toLowerCase() ?? null;
  const labelMap: Record<string, string> = { free: 'Free', plus: 'Plus', team: 'Team' };
  return { code, label: code ? labelMap[code] ?? raw ?? null : null };
};

const resolveCodexAccountId = (file: RawAuthFile): string | null => {
  const token = parseIdToken(file.id_token ?? file.metadata?.id_token ?? file.attributes?.id_token);
  return normalizeString((token?.chatgpt_account_id as unknown) ?? file.metadata?.chatgpt_account_id);
};

const resolveGeminiProjectId = (file: RawAuthFile): string | null => {
  const candidate = normalizeString(file.account ?? file.metadata?.account ?? file.attributes?.account);
  if (!candidate) return null;
  const matches = Array.from(candidate.matchAll(/\(([^()]+)\)/g));
  const last = matches[matches.length - 1]?.[1]?.trim();
  return last || null;
};

const resolveAntigravityProjectIdWithClient = async (
  cpaClient: ReturnType<typeof createCpaClient>,
  file: RawAuthFile
): Promise<string> => {
  const name = normalizeString(file.name);
  if (!name) return 'bamboo-precept-lgxtn';
  try {
    const text = await cpaClient.downloadAuthFile(name);
    const parsed = parseJson<Record<string, unknown>>(text);
    const direct = normalizeString(parsed?.project_id ?? parsed?.projectId);
    if (direct) return direct;
    const installed = isRecord(parsed?.installed) ? parsed.installed : null;
    const installedProjectId = normalizeString(installed?.project_id ?? installed?.projectId);
    if (installedProjectId) return installedProjectId;
    const web = isRecord(parsed?.web) ? parsed.web : null;
    const webProjectId = normalizeString(web?.project_id ?? web?.projectId);
    if (webProjectId) return webProjectId;
  } catch {
    return 'bamboo-precept-lgxtn';
  }
  return 'bamboo-precept-lgxtn';
};

const quotaStatusFromPercent = (remainingPercent: number | null): OverviewQuotaItem['status'] => {
  if (remainingPercent === null) return 'unknown';
  if (remainingPercent <= 0) return 'exhausted';
  if (remainingPercent <= 20) return 'warning';
  return 'ok';
};

const usageDetailTokens = (value: Record<string, unknown>): number => {
  const tokens = isRecord(value.tokens) ? value.tokens : {};
  const explicitTotal = normalizeNumber(tokens.total_tokens);
  if (explicitTotal !== null) return explicitTotal;
  return (
    (normalizeNumber(tokens.input_tokens) ?? 0) +
    (normalizeNumber(tokens.output_tokens) ?? 0) +
    (normalizeNumber(tokens.reasoning_tokens) ?? 0)
  );
};

const getUsageDetails = async (
  cpaClient: ReturnType<typeof createCpaClient>,
  cacheKey: string,
  force = false
): Promise<UsageDetail[]> => {
  const cached = usageCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.updatedAt < appConfig.usageTtlMs) {
    return cached.details;
  }
  const usage = await cpaClient.getUsage();
  const details: UsageDetail[] = [];
  const apis = isRecord(usage.usage?.apis) ? usage.usage?.apis : {};
  for (const apiEntry of Object.values(apis)) {
    if (!isRecord(apiEntry)) continue;
    const models = isRecord(apiEntry.models) ? apiEntry.models : {};
    for (const [model, modelEntry] of Object.entries(models)) {
      if (!isRecord(modelEntry)) continue;
      const rawDetails = Array.isArray(modelEntry.details) ? modelEntry.details : [];
      for (const item of rawDetails) {
        if (!isRecord(item)) continue;
        const authIndex = normalizeString(item.auth_index);
        const timestamp = normalizeString(item.timestamp);
        if (!authIndex || !timestamp) continue;
        const timestampMs = Date.parse(timestamp);
        if (Number.isNaN(timestampMs)) continue;
        details.push({
          authIndex,
          timestampMs,
          failed: item.failed === true,
          totalTokens: usageDetailTokens(item),
          model,
        });
      }
    }
  }
  usageCache.set(cacheKey, { updatedAt: Date.now(), details });
  return details;
};

const summarizeUsage = (details: UsageDetail[]): OverviewUsage => {
  const now = Date.now();
  const modelMap = new Map<string, OverviewModelUsage>();
  let req1h = 0;
  let token1h = 0;
  let failed1h = 0;
  let req24h = 0;
  let token24h = 0;
  let failed24h = 0;
  let req7d = 0;
  let token7d = 0;
  let failed7d = 0;

  for (const detail of details) {
    const age = now - detail.timestampMs;
    if (age <= 60 * 60 * 1000) {
      req1h += 1;
      token1h += detail.totalTokens;
      if (detail.failed) failed1h += 1;
    }
    if (age <= 24 * 60 * 60 * 1000) {
      req24h += 1;
      token24h += detail.totalTokens;
      if (detail.failed) failed24h += 1;
    }
    if (age <= 7 * 24 * 60 * 60 * 1000) {
      req7d += 1;
      token7d += detail.totalTokens;
      if (detail.failed) failed7d += 1;
      const entry = modelMap.get(detail.model) ?? {
        model: detail.model,
        requests: 0,
        tokens: 0,
        failed_requests: 0,
      };
      entry.requests += 1;
      entry.tokens += detail.totalTokens;
      if (detail.failed) entry.failed_requests += 1;
      modelMap.set(detail.model, entry);
    }
  }

  return {
    last_1h: buildWindow(req1h, token1h, failed1h),
    last_24h: buildWindow(req24h, token24h, failed24h),
    last_7d: buildWindow(req7d, token7d, failed7d),
    models: Array.from(modelMap.values())
      .sort((a, b) => b.requests - a.requests || b.tokens - a.tokens)
      .slice(0, 5),
  };
};

const apiCallJson = async (
  cpaClient: ReturnType<typeof createCpaClient>,
  file: RawAuthFile,
  method: string,
  url: string,
  header?: Record<string, string>,
  data?: string
) => {
  return cpaClient.apiCall({
    authIndex: normalizeString(file.auth_index) ?? undefined,
    method,
    url,
    header,
    data,
  });
};

const buildQuotaItem = (input: {
  id: string;
  label: string;
  remainingPercent?: number | null;
  usedPercent?: number | null;
  remainingAmount?: number | null;
  usedAmount?: number | null;
  limitAmount?: number | null;
  unit?: string | null;
  resetAt?: string | null;
  meta?: Record<string, unknown>;
}): OverviewQuotaItem => {
  const remainingPercent =
    input.remainingPercent === undefined || input.remainingPercent === null
      ? null
      : Math.max(0, Math.min(100, input.remainingPercent));
  const usedPercent =
    input.usedPercent === undefined ? (remainingPercent === null ? null : 100 - remainingPercent) : input.usedPercent;
  return {
    id: input.id,
    label: input.label,
    remaining_percent: remainingPercent,
    used_percent: usedPercent === null || usedPercent === undefined ? null : Math.max(0, Math.min(100, usedPercent)),
    remaining_amount: input.remainingAmount ?? null,
    used_amount: input.usedAmount ?? null,
    limit_amount: input.limitAmount ?? null,
    unit: input.unit ?? null,
    reset_at: input.resetAt ?? null,
    reset_label: formatResetLabel(input.resetAt),
    status: quotaStatusFromPercent(remainingPercent),
    meta: input.meta,
  };
};

const fetchClaudeQuotaWithClient = async (
  cpaClient: ReturnType<typeof createCpaClient>,
  file: RawAuthFile
): Promise<OverviewQuota> => {
  const [usageResponse, profileResponse] = await Promise.all([
    apiCallJson(cpaClient, file, 'GET', 'https://api.anthropic.com/api/oauth/usage', {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    }),
    apiCallJson(cpaClient, file, 'GET', 'https://api.anthropic.com/api/oauth/profile', {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    }).catch(() => ({ statusCode: 0, header: {}, bodyText: '', body: null })),
  ]);

  if (usageResponse.statusCode < 200 || usageResponse.statusCode >= 300) {
    return { ...emptyQuota(), raw_status: 'error', error: usageResponse.bodyText || `HTTP ${usageResponse.statusCode}` };
  }
  const payload = parseJson<Record<string, unknown>>(usageResponse.body ?? usageResponse.bodyText) ?? {};
  const profile = parseJson<Record<string, unknown>>(profileResponse.body ?? profileResponse.bodyText) ?? {};
  const account = isRecord(profile.account) ? profile.account : {};
  let planCode: string | null = null;
  let planLabel: string | null = null;
  if (account.has_claude_max === true) {
    planCode = 'max';
    planLabel = 'Max';
  } else if (account.has_claude_pro === true) {
    planCode = 'pro';
    planLabel = 'Pro';
  } else if (account.has_claude_max === false && account.has_claude_pro === false) {
    planCode = 'free';
    planLabel = 'Free';
  }
  const windowDefs = [
    ['five_hour', '5 小时限额'],
    ['seven_day', '周限额'],
    ['seven_day_oauth_apps', 'OAuth 应用周限额'],
    ['seven_day_opus', 'Opus 周限额'],
    ['seven_day_sonnet', 'Sonnet 周限额'],
    ['seven_day_cowork', '协作周限额'],
    ['iguana_necktie', '特殊限额'],
  ] as const;
  const items: OverviewQuotaItem[] = [];
  for (const [key, label] of windowDefs) {
    const entry = isRecord(payload[key]) ? payload[key] : null;
    if (!entry) continue;
    const utilization = normalizeNumber(entry.utilization);
    items.push(
      buildQuotaItem({
        id: key,
        label,
        remainingPercent: utilization === null ? null : 100 - utilization,
        resetAt: normalizeDateValue(entry.resets_at),
      })
    );
  }
  const extra = isRecord(payload.extra_usage) ? payload.extra_usage : null;
  const extraItems: OverviewQuotaExtra[] = [];
  if (extra?.is_enabled === true) {
    extraItems.push({
      id: 'extra-usage',
      label: 'Extra usage',
      used_amount: (normalizeNumber(extra.used_credits) ?? 0) / 100,
      limit_amount: (normalizeNumber(extra.monthly_limit) ?? 0) / 100,
      unit: 'usd',
      status: 'ok',
    });
  }
  return {
    plan: { code: planCode, label: planLabel },
    items,
    extra: extraItems,
    raw_status: 'success',
    error: '',
  };
};

const fetchCodexQuotaWithClient = async (
  cpaClient: ReturnType<typeof createCpaClient>,
  file: RawAuthFile
): Promise<OverviewQuota> => {
  const accountId = resolveCodexAccountId(file);
  if (!accountId) {
    return { ...emptyQuota(), raw_status: 'error', error: 'Missing ChatGPT account id' };
  }
  const result = await apiCallJson(cpaClient, file, 'GET', 'https://chatgpt.com/backend-api/wham/usage', {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
    'Chatgpt-Account-Id': accountId,
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { ...emptyQuota(), raw_status: 'error', error: result.bodyText || `HTTP ${result.statusCode}` };
  }
  const payload = parseJson<Record<string, unknown>>(result.body ?? result.bodyText) ?? {};
  const items: OverviewQuotaItem[] = [];
  const pushWindow = (prefix: string, label: string, entry: Record<string, unknown> | null) => {
    if (!entry) return;
    const usedPercent = normalizeNumber(entry.used_percent ?? entry.usedPercent);
    const resetAt =
      normalizeDateValue(entry.resets_at) ??
      normalizeDateValue(entry.reset_at) ??
      normalizeDateValue(entry.resetsAt) ??
      normalizeDateValue(entry.resetAt);
    items.push(
      buildQuotaItem({
        id: prefix,
        label,
        remainingPercent: usedPercent === null ? null : 100 - usedPercent,
        resetAt,
      })
    );
  };
  const rateLimit = isRecord(payload.rate_limit ?? payload.rateLimit) ? (payload.rate_limit ?? payload.rateLimit) as Record<string, unknown> : null;
  const reviewLimit = isRecord(payload.code_review_rate_limit ?? payload.codeReviewRateLimit)
    ? (payload.code_review_rate_limit ?? payload.codeReviewRateLimit) as Record<string, unknown>
    : null;
  const classifyWindow = (entry: Record<string, unknown> | null): 'five-hour' | 'weekly' | null => {
    if (!entry) return null;
    const seconds = normalizeNumber(entry.limit_window_seconds ?? entry.limitWindowSeconds);
    if (seconds === 18_000) return 'five-hour';
    if (seconds === 604_800) return 'weekly';
    return null;
  };
  const ratePrimary = isRecord(rateLimit?.primary_window ?? rateLimit?.primaryWindow)
    ? (rateLimit?.primary_window ?? rateLimit?.primaryWindow) as Record<string, unknown>
    : null;
  const rateSecondary = isRecord(rateLimit?.secondary_window ?? rateLimit?.secondaryWindow)
    ? (rateLimit?.secondary_window ?? rateLimit?.secondaryWindow) as Record<string, unknown>
    : null;
  const reviewPrimary = isRecord(reviewLimit?.primary_window ?? reviewLimit?.primaryWindow)
    ? (reviewLimit?.primary_window ?? reviewLimit?.primaryWindow) as Record<string, unknown>
    : null;
  const reviewSecondary = isRecord(reviewLimit?.secondary_window ?? reviewLimit?.secondaryWindow)
    ? (reviewLimit?.secondary_window ?? reviewLimit?.secondaryWindow) as Record<string, unknown>
    : null;
  const pickWindow = (
    windows: Array<Record<string, unknown> | null>,
    target: 'five-hour' | 'weekly',
    fallbackIndex: number
  ) => windows.find((entry) => classifyWindow(entry) === target) ?? windows[fallbackIndex] ?? null;
  pushWindow('five-hour', '5 小时限额', pickWindow([ratePrimary, rateSecondary], 'five-hour', 0));
  pushWindow('weekly', '周限额', pickWindow([ratePrimary, rateSecondary], 'weekly', 1));
  pushWindow('review-weekly', '代码审查周限额', pickWindow([reviewPrimary, reviewSecondary], 'weekly', 1));
  const additional = Array.isArray(payload.additional_rate_limits ?? payload.additionalRateLimits)
    ? (payload.additional_rate_limits ?? payload.additionalRateLimits) as unknown[]
    : [];
  additional.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const limit = isRecord(entry.rate_limit ?? entry.rateLimit) ? (entry.rate_limit ?? entry.rateLimit) as Record<string, unknown> : null;
    const name = normalizeString(entry.limit_name ?? entry.limitName ?? entry.metered_feature ?? entry.meteredFeature) ?? `扩展限额 ${index + 1}`;
    pushWindow(`extra-${index}-primary`, `${name} 5 小时限额`, isRecord(limit?.primary_window ?? limit?.primaryWindow) ? (limit?.primary_window ?? limit?.primaryWindow) as Record<string, unknown> : null);
    pushWindow(`extra-${index}-secondary`, `${name} 周限额`, isRecord(limit?.secondary_window ?? limit?.secondaryWindow) ? (limit?.secondary_window ?? limit?.secondaryWindow) as Record<string, unknown> : null);
  });
  const plan = resolveCodexPlan(file);
  return { plan, items, extra: [], raw_status: 'success', error: '' };
};

const fetchGeminiQuotaWithClient = async (
  cpaClient: ReturnType<typeof createCpaClient>,
  file: RawAuthFile
): Promise<OverviewQuota> => {
  const projectId = resolveGeminiProjectId(file);
  if (!projectId) {
    return { ...emptyQuota(), raw_status: 'error', error: 'Missing project id' };
  }
  const quotaResult = await apiCallJson(
    cpaClient,
    file,
    'POST',
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
    },
    JSON.stringify({ project: projectId })
  );
  if (quotaResult.statusCode < 200 || quotaResult.statusCode >= 300) {
    return { ...emptyQuota(), raw_status: 'error', error: quotaResult.bodyText || `HTTP ${quotaResult.statusCode}` };
  }
  const payload = parseJson<Record<string, unknown>>(quotaResult.body ?? quotaResult.bodyText) ?? {};
  const buckets = Array.isArray(payload.buckets) ? payload.buckets : [];
  const items: OverviewQuotaItem[] = [];
  for (const bucket of buckets) {
    if (!isRecord(bucket)) continue;
    const modelId = normalizeString(bucket.modelId ?? bucket.model_id);
    if (!modelId) continue;
    const fraction = normalizeFraction(bucket.remainingFraction ?? bucket.remaining_fraction);
    const remainingAmount = normalizeNumber(bucket.remainingAmount ?? bucket.remaining_amount);
    items.push(
      buildQuotaItem({
        id: modelId,
        label: modelId.replace(/_vertex$/, ''),
        remainingPercent: fraction === null ? null : fraction * 100,
        remainingAmount,
        unit: remainingAmount !== null ? 'quota' : null,
        resetAt: normalizeDateValue(bucket.resetTime ?? bucket.reset_time),
        meta: {
          token_type: normalizeString(bucket.tokenType ?? bucket.token_type),
        },
      })
    );
  }
  const assistResult = await apiCallJson(
    cpaClient,
    file,
    'POST',
    'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    {
      Authorization: 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
    },
    JSON.stringify({
      cloudaicompanionProject: projectId,
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
        duetProject: projectId,
      },
    })
  ).catch(() => ({ statusCode: 0, header: {}, bodyText: '', body: null }));
  const assistPayload = parseJson<Record<string, unknown>>(assistResult.body ?? assistResult.bodyText) ?? {};
  const currentTier = isRecord(assistPayload.paidTier ?? assistPayload.paid_tier)
    ? (assistPayload.paidTier ?? assistPayload.paid_tier) as Record<string, unknown>
    : isRecord(assistPayload.currentTier ?? assistPayload.current_tier)
      ? (assistPayload.currentTier ?? assistPayload.current_tier) as Record<string, unknown>
      : null;
  const planCode = normalizeString(currentTier?.id)?.toLowerCase() ?? null;
  const credits = Array.isArray(currentTier?.availableCredits ?? currentTier?.available_credits)
    ? (currentTier?.availableCredits ?? currentTier?.available_credits) as unknown[]
    : [];
  const credit = credits.find((entry) => isRecord(entry) && normalizeString(entry.creditType ?? entry.credit_type) === 'GOOGLE_ONE_AI');
  const extra: OverviewQuotaExtra[] = [];
  if (isRecord(credit)) {
    extra.push({
      id: 'credit-balance',
      label: 'Google One AI credits',
      used_amount: null,
      limit_amount: normalizeNumber(credit.creditAmount ?? credit.credit_amount),
      unit: 'credits',
      status: 'ok',
    });
  }
  return {
    plan: { code: planCode, label: planCode },
    items,
    extra,
    raw_status: 'success',
    error: '',
  };
};

const fetchKimiQuotaWithClient = async (
  cpaClient: ReturnType<typeof createCpaClient>,
  file: RawAuthFile
): Promise<OverviewQuota> => {
  const result = await apiCallJson(cpaClient, file, 'GET', 'https://api.kimi.com/coding/v1/usages', {
    Authorization: 'Bearer $TOKEN$',
  });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { ...emptyQuota(), raw_status: 'error', error: result.bodyText || `HTTP ${result.statusCode}` };
  }
  const payload = parseJson<Record<string, unknown>>(result.body ?? result.bodyText) ?? {};
  const items: OverviewQuotaItem[] = [];
  const summary = isRecord(payload.usage) ? payload.usage : null;
  if (summary) {
    const limit = normalizeNumber(summary.limit);
    const used = normalizeNumber(summary.used);
    items.push(
      buildQuotaItem({
        id: 'summary',
        label: 'Weekly limit',
        remainingPercent: limit && used !== null ? ((limit - used) / limit) * 100 : null,
        usedAmount: used,
        limitAmount: limit,
        unit: 'requests',
        resetAt: normalizeDateValue(summary.reset_at ?? summary.resetAt),
      })
    );
  }
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  limits.forEach((item, index) => {
    if (!isRecord(item)) return;
    const detail = isRecord(item.detail) ? item.detail : item;
    const limit = normalizeNumber(detail.limit);
    const used = normalizeNumber(detail.used);
    const window = isRecord(item.window) ? item.window : {};
    const duration = normalizeNumber(window.duration);
    const unit = normalizeString(window.timeUnit)?.toLowerCase();
    const label = duration ? `${duration}${unit === 'days' ? ' 天' : unit === 'hours' ? ' 小时' : ' 分钟'}限额` : `限额 ${index + 1}`;
    items.push(
      buildQuotaItem({
        id: `limit-${index}`,
        label,
        remainingPercent: limit && used !== null ? ((limit - used) / limit) * 100 : null,
        usedAmount: used,
        limitAmount: limit,
        unit: 'requests',
        resetAt: normalizeDateValue(detail.reset_at ?? detail.resetAt),
      })
    );
  });
  return { ...emptyQuota(), items, raw_status: 'success' };
};

const fetchAntigravityQuotaWithClient = async (
  cpaClient: ReturnType<typeof createCpaClient>,
  file: RawAuthFile
): Promise<OverviewQuota> => {
  const projectId = await resolveAntigravityProjectIdWithClient(cpaClient, file);
  const urls = [
    'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  ];
  let payload: Record<string, unknown> | null = null;
  let errorMessage = 'Failed to load Antigravity quota';
  for (const url of urls) {
    const result = await apiCallJson(
      cpaClient,
      file,
      'POST',
      url,
      {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/1.19.6 windows/amd64',
      },
      JSON.stringify({ project: projectId })
    ).catch(() => ({ statusCode: 0, header: {}, bodyText: '', body: null }));
    if (result.statusCode >= 200 && result.statusCode < 300) {
      payload = parseJson<Record<string, unknown>>(result.body ?? result.bodyText) ?? null;
      if (payload) break;
    } else if (result.bodyText) {
      errorMessage = result.bodyText;
    }
  }
  if (!payload) {
    return { ...emptyQuota(), raw_status: 'error', error: errorMessage };
  }
  const models = isRecord(payload.models) ? payload.models : {};
  const groups = [
    { id: 'claude-gpt', label: 'Claude / GPT', modelIds: ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'] },
    { id: 'gemini-pro', label: 'Gemini Pro', modelIds: ['gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'gemini-3-pro-high', 'gemini-3-pro-low'] },
    { id: 'gemini-flash', label: 'Gemini Flash', modelIds: ['gemini-2.5-flash', 'gemini-2.5-flash-thinking', 'gemini-2.5-flash-lite', 'gemini-3-flash'] },
  ];
  const items: OverviewQuotaItem[] = [];
  for (const group of groups) {
    let minFraction: number | null = null;
    let resetAt: string | null = null;
    const matched: string[] = [];
    for (const modelId of group.modelIds) {
      const entry = isRecord(models[modelId]) ? models[modelId] : null;
      if (!entry) continue;
      const quotaInfo = isRecord(entry.quotaInfo ?? entry.quota_info) ? (entry.quotaInfo ?? entry.quota_info) as Record<string, unknown> : {};
      const fraction = normalizeFraction(quotaInfo.remainingFraction ?? quotaInfo.remaining_fraction ?? quotaInfo.remaining);
      if (fraction === null) continue;
      matched.push(modelId);
      minFraction = minFraction === null ? fraction : Math.min(minFraction, fraction);
      const candidateReset = normalizeDateValue(quotaInfo.resetTime ?? quotaInfo.reset_time);
      if (!resetAt || (candidateReset && Date.parse(candidateReset) < Date.parse(resetAt))) {
        resetAt = candidateReset;
      }
    }
    if (matched.length > 0) {
      items.push(
        buildQuotaItem({
          id: group.id,
          label: group.label,
          remainingPercent: minFraction === null ? null : minFraction * 100,
          resetAt,
          meta: { models: matched },
        })
      );
    }
  }
  return { ...emptyQuota(), items, raw_status: 'success' };
};

const fetchQuota = async (
  cpaClient: ReturnType<typeof createCpaClient>,
  cachePrefix: string,
  file: RawAuthFile,
  force = false
): Promise<OverviewQuota> => {
  const authIndex = normalizeString(file.auth_index);
  if (!authIndex) return emptyQuota();
  const cacheKey = `${cachePrefix}:${authIndex}`;
  if (!force) {
    const cached = quotaCache.get(cacheKey);
    if (cached && Date.now() - cached.updatedAt < appConfig.quotaTtlMs) {
      return cached.data;
    }
  }
  let result = emptyQuota();
  const provider = detectProvider(file);
  try {
    if (provider === 'claude') result = await fetchClaudeQuotaWithClient(cpaClient, file);
    if (provider === 'codex') result = await fetchCodexQuotaWithClient(cpaClient, file);
    if (provider === 'gemini-cli') result = await fetchGeminiQuotaWithClient(cpaClient, file);
    if (provider === 'kimi') result = await fetchKimiQuotaWithClient(cpaClient, file);
    if (provider === 'antigravity') result = await fetchAntigravityQuotaWithClient(cpaClient, file);
  } catch (error) {
    result = {
      ...emptyQuota(),
      raw_status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
  quotaCache.set(cacheKey, { updatedAt: Date.now(), data: result });
  return result;
};

const mapAccount = async (
  cpaClient: ReturnType<typeof createCpaClient>,
  cachePrefix: string,
  file: RawAuthFile,
  details: UsageDetail[],
  forceQuota = false
): Promise<OverviewAccount | null> => {
  const provider = detectProvider(file);
  const authIndex = normalizeString(file.auth_index);
  const name = normalizeString(file.name);
  if (!provider || !authIndex || !name) return null;
  const fileUsage = summarizeUsage(details.filter((detail) => detail.authIndex === authIndex));
  const quota =
    file.runtime_only || file.disabled
      ? emptyQuota()
      : await fetchQuota(cpaClient, cachePrefix, file, forceQuota);
  return {
    auth_index: authIndex,
    name,
    label: normalizeString(file.label),
    provider,
    email: normalizeString(file.email),
    active: true,
    disabled: file.disabled === true,
    runtime_only: file.runtime_only === true,
    status: normalizeString(file.status) ?? 'unknown',
    status_message: normalizeString(file.status_message) ?? '',
    unavailable: file.unavailable === true,
    source: normalizeString(file.source) ?? 'memory',
    priority: normalizeNumber(file.priority),
    last_refresh: normalizeDateValue(file.last_refresh),
    next_retry_after: normalizeDateValue(file.next_retry_after),
    quota_state: {
      exceeded: file.quota?.exceeded === true,
      reason: normalizeString(file.quota?.reason) ?? '',
      next_recover_at: normalizeDateValue(file.quota?.next_recover_at),
    },
    quota,
    usage: fileUsage,
  };
};

const groupByProvider = (accounts: OverviewAccount[]): OverviewProvider[] => {
  const providers = new Map<ProviderId, OverviewProvider>();
  for (const providerId of providerOrder) {
    providers.set(providerId, {
      id: providerId,
      name: providerNames[providerId],
      active: false,
      visible: false,
      configured_account_count: 0,
      enabled_account_count: 0,
      quota_exhausted_count: 0,
      usage: emptyUsage(),
      accounts: [],
    });
  }
  for (const account of accounts) {
    const provider = providers.get(account.provider);
    if (!provider) continue;
    provider.accounts.push(account);
    provider.configured_account_count += 1;
    if (!account.disabled) provider.enabled_account_count += 1;
    if (account.quota_state.exceeded) provider.quota_exhausted_count += 1;
  }

  for (const provider of providers.values()) {
    provider.accounts.sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pb - pa;
      return a.name.localeCompare(b.name);
    });
    provider.active = provider.configured_account_count > 0;
    provider.visible = provider.active;
    provider.usage = emptyUsage();
  }
  return providerOrder.map((providerId) => providers.get(providerId) as OverviewProvider);
};

const computeProviderUsage = (provider: OverviewProvider): OverviewUsage => {
  const models = new Map<string, OverviewModelUsage>();
  for (const account of provider.accounts) {
    for (const model of account.usage.models) {
      const existing = models.get(model.model) ?? {
        model: model.model,
        requests: 0,
        tokens: 0,
        failed_requests: 0,
      };
      existing.requests += model.requests;
      existing.tokens += model.tokens;
      existing.failed_requests += model.failed_requests;
      models.set(model.model, existing);
    }
  }

  const sumWindow = (selector: (usage: OverviewUsage) => OverviewWindowStats): OverviewWindowStats => {
    let requests = 0;
    let tokens = 0;
    let failed = 0;
    for (const account of provider.accounts) {
      const window = selector(account.usage);
      requests += window.requests;
      tokens += window.tokens;
      failed += window.failed_requests;
    }
    return buildWindow(requests, tokens, failed);
  };
  return {
    last_1h: sumWindow((usage) => usage.last_1h),
    last_24h: sumWindow((usage) => usage.last_24h),
    last_7d: sumWindow((usage) => usage.last_7d),
    models: Array.from(models.values())
      .sort((a, b) => b.requests - a.requests || b.tokens - a.tokens)
      .slice(0, 5),
  };
};

export const buildOverview = async (
  connection: { cpaBaseUrl: string; cpaManagementKey: string },
  options?: { forceUsage?: boolean; forceQuota?: boolean }
): Promise<OverviewResponse> => {
  const cpaClient = createCpaClient(connection);
  const cachePrefix = Buffer.from(connection.cpaBaseUrl).toString('base64url').slice(0, 16);
  const [files, details] = await Promise.all([
    cpaClient.listAuthFiles(),
    getUsageDetails(cpaClient, cachePrefix, options?.forceUsage),
  ]);
  const usageCached = usageCache.get(cachePrefix);

  const mappedAccounts = await Promise.all(
    files
      .filter((file) => file.runtime_only !== true)
      .map((file) => mapAccount(cpaClient, cachePrefix, file, details, options?.forceQuota))
  );

  const accounts = mappedAccounts.filter((item): item is OverviewAccount => item !== null);
  const providers = groupByProvider(accounts);
  for (const provider of providers) {
    provider.usage = computeProviderUsage(provider);
  }

  const activeProviders = providers.filter((provider) => provider.active);
  const totalRequests24h = providers.reduce((sum, provider) => sum + provider.usage.last_24h.requests, 0);
  const totalTokens24h = providers.reduce((sum, provider) => sum + provider.usage.last_24h.tokens, 0);
  const exhaustedAccounts = accounts.filter((account) => account.quota_state.exceeded).length;

  return {
    generated_at: new Date().toISOString(),
    cache: {
      usage_refreshed_at: usageCached ? new Date(usageCached.updatedAt).toISOString() : null,
      quota_refreshed_at:
        Array.from(quotaCache.keys()).some((key) => key.startsWith(`${cachePrefix}:`))
          ? new Date(
              Math.max(
                ...Array.from(quotaCache.entries())
                  .filter(([key]) => key.startsWith(`${cachePrefix}:`))
                  .map(([, entry]) => entry.updatedAt)
              )
            ).toISOString()
          : null,
      usage_ttl_seconds: Math.floor(appConfig.usageTtlMs / 1000),
      quota_ttl_seconds: Math.floor(appConfig.quotaTtlMs / 1000),
      stale: false,
    },
    summary: {
      provider_count: providers.length,
      active_provider_count: activeProviders.length,
      account_count: accounts.length,
      active_account_count: accounts.filter((account) => !account.disabled).length,
      total_requests_24h: totalRequests24h,
      total_tokens_24h: totalTokens24h,
      quota_exhausted_accounts: exhaustedAccounts,
    },
    providers,
  };
};
