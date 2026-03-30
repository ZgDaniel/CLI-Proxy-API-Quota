export type ProviderId = 'claude' | 'codex' | 'gemini-cli' | 'kimi' | 'antigravity';

export interface OverviewWindowStats {
  requests: number;
  tokens: number;
  failed_requests: number;
  success_rate: number;
}

export interface OverviewModelUsage {
  model: string;
  requests: number;
  tokens: number;
  failed_requests: number;
}

export interface OverviewQuotaItem {
  id: string;
  label: string;
  remaining_percent: number | null;
  used_percent: number | null;
  remaining_amount: number | null;
  used_amount: number | null;
  limit_amount: number | null;
  unit: string | null;
  reset_at: string | null;
  reset_label: string;
  status: 'ok' | 'warning' | 'exhausted' | 'unknown';
  meta?: Record<string, unknown>;
}

export interface OverviewQuotaExtra {
  id: string;
  label: string;
  used_amount: number | null;
  limit_amount: number | null;
  unit: string | null;
  status: 'ok' | 'warning' | 'exhausted' | 'unknown';
}

export interface OverviewQuota {
  plan: {
    code: string | null;
    label: string | null;
  };
  items: OverviewQuotaItem[];
  extra: OverviewQuotaExtra[];
  raw_status: 'success' | 'error' | 'idle';
  error: string;
}

export interface OverviewUsage {
  last_1h: OverviewWindowStats;
  last_24h: OverviewWindowStats;
  last_7d: OverviewWindowStats;
  models: OverviewModelUsage[];
}

export interface OverviewAccount {
  auth_index: string;
  name: string;
  label: string | null;
  provider: ProviderId;
  email: string | null;
  active: boolean;
  disabled: boolean;
  runtime_only: boolean;
  status: string;
  status_message: string;
  unavailable: boolean;
  source: string;
  priority: number | null;
  last_refresh: string | null;
  next_retry_after: string | null;
  quota_state: {
    exceeded: boolean;
    reason: string;
    next_recover_at: string | null;
  };
  quota: OverviewQuota;
  usage: OverviewUsage;
}

export interface OverviewProvider {
  id: ProviderId;
  name: string;
  active: boolean;
  visible: boolean;
  configured_account_count: number;
  enabled_account_count: number;
  quota_exhausted_count: number;
  usage: OverviewUsage;
  accounts: OverviewAccount[];
}

export interface OverviewResponse {
  generated_at: string;
  cache: {
    usage_refreshed_at: string | null;
    quota_refreshed_at: string | null;
    usage_ttl_seconds: number;
    quota_ttl_seconds: number;
    stale: boolean;
  };
  summary: {
    provider_count: number;
    active_provider_count: number;
    account_count: number;
    active_account_count: number;
    total_requests_24h: number;
    total_tokens_24h: number;
    quota_exhausted_accounts: number;
  };
  providers: OverviewProvider[];
}

export interface SessionResponse {
  authenticated: boolean;
}

export type AlertChannel = 'custom' | 'feishu' | 'telegram' | 'qmsg';

export interface AlertConfig {
  enabled: boolean;
  channel: AlertChannel;
  custom_url: string;
  feishu_token: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
  qmsg_key: string;
  thresholds: number[];
  refresh_interval_seconds: number;
}

export interface AlertConfigResponse {
  config: AlertConfig;
}

export interface AlertTestResponse {
  ok: boolean;
  error?: string;
}
