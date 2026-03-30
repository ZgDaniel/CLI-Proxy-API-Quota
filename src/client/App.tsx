import { useEffect, useState } from 'react';
import type { OverviewAccount, OverviewProvider, OverviewResponse, SessionResponse } from '../shared/types';

type LoadState = 'checking' | 'login' | 'dashboard' | 'public';

const fmtNumber = (value: number) => value.toLocaleString('en-US');
const fmtPercent = (value: number) => `${Math.round(value)}%`;
const fmtDateTime = (value: string | null) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
};
const fmtStatus = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'ready') return '就绪';
  if (normalized === 'disabled') return '已禁用';
  if (normalized === 'unknown') return '未知';
  if (normalized === 'error') return '异常';
  return value;
};

const providerAccent: Record<string, string> = {
  claude: '#e07a4f',
  codex: '#d4a24c',
  'gemini-cli': '#5b9cf5',
  kimi: '#5cb85c',
  antigravity: '#5bc0c4',
};

async function api<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function WindowStatCard(props: { label: string; requests: number; tokens: number; failed: number }) {
  return (
    <div className="window-stat">
      <span className="window-stat__label">{props.label}</span>
      <strong>{fmtNumber(props.requests)}</strong>
      <span>{fmtNumber(props.tokens)} Tokens</span>
      <span>失败 {props.failed}</span>
    </div>
  );
}

function AccountCard({
  account,
  accent,
  isPublic,
  publicLabel,
}: {
  account: OverviewAccount;
  accent: string;
  isPublic?: boolean;
  publicLabel?: string;
}) {
  return (
    <article className="account-card" style={{ ['--accent' as string]: accent }}>
      <header className="account-card__header">
        <div>
          {isPublic ? (
            publicLabel ? <h3 className="account-card__title">{publicLabel}</h3> : null
          ) : (
            <>
              <div className="account-card__eyebrow">{account.label || account.name}</div>
              <h3 className="account-card__title">{account.email || account.name}</h3>
            </>
          )}
        </div>
        {isPublic ? null : (
          <div className="account-card__statusline">
            <span className={`status-pill ${account.disabled ? 'is-muted' : 'is-live'}`}>
              {account.disabled ? '已禁用' : account.unavailable ? '异常' : '正常'}
            </span>
            {account.quota_state.exceeded ? <span className="status-pill is-warning">额度耗尽</span> : null}
          </div>
        )}
      </header>

      {isPublic ? null : (
        <div className="account-card__meta">
          <span>{fmtStatus(account.status)}</span>
          {account.status_message ? <span>{account.status_message}</span> : null}
          {account.quota.plan.label ? <span>{account.quota.plan.label}</span> : null}
          <span>刷新时间 {fmtDateTime(account.last_refresh)}</span>
        </div>
      )}

      <section className="quota-stack">
        {account.quota.items.length === 0 ? (
          <div className="empty-state">暂无配额数据。</div>
        ) : (
          account.quota.items.map((item) => {
            const fill = item.remaining_percent ?? 0;
            return (
              <div key={item.id} className="quota-row">
                <div className="quota-row__head">
                  <span>{item.label}</span>
                  <span>{item.remaining_percent === null ? '--' : fmtPercent(item.remaining_percent)}</span>
                </div>
                <div className="quota-bar">
                  <div className="quota-bar__fill" style={{ width: `${Math.max(0, Math.min(100, fill))}%` }} />
                </div>
                <div className="quota-row__foot">
                  {item.used_amount !== null && item.limit_amount !== null ? (
                    <span>{`${item.used_amount} / ${item.limit_amount} ${item.unit ?? ''}`.trim()}</span>
                  ) : (
                    <span />
                  )}
                  <span>{fmtDateTime(item.reset_at)}</span>
                </div>
              </div>
            );
          })
        )}

        {account.quota.extra.map((item) => (
          <div key={item.id} className="quota-extra">
            <span>{item.label}</span>
            <strong>
              {item.used_amount !== null && item.limit_amount !== null
                ? `${item.used_amount} / ${item.limit_amount} ${item.unit ?? ''}`.trim()
                : `${item.limit_amount ?? '--'} ${item.unit ?? ''}`.trim()}
            </strong>
          </div>
        ))}
      </section>

      {isPublic ? null : (
        <>
          <section className="usage-grid">
            <WindowStatCard
              label="1h"
              requests={account.usage.last_1h.requests}
              tokens={account.usage.last_1h.tokens}
              failed={account.usage.last_1h.failed_requests}
            />
            <WindowStatCard
              label="24h"
              requests={account.usage.last_24h.requests}
              tokens={account.usage.last_24h.tokens}
              failed={account.usage.last_24h.failed_requests}
            />
            <WindowStatCard
              label="7d"
              requests={account.usage.last_7d.requests}
              tokens={account.usage.last_7d.tokens}
              failed={account.usage.last_7d.failed_requests}
            />
          </section>

          {account.usage.models.length > 0 ? (
            <section className="model-list">
              {account.usage.models.map((model) => (
                <div key={model.model} className="model-row">
                  <span>{model.model}</span>
                  <span>{fmtNumber(model.requests)} 次请求</span>
                  <span>{fmtNumber(model.tokens)} Tokens</span>
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}
    </article>
  );
}

function ProviderSection({ provider, isPublic }: { provider: OverviewProvider; isPublic?: boolean }) {
  const accent = providerAccent[provider.id] ?? '#d3d3d3';
  const visibleAccounts = isPublic ? provider.accounts.filter((a) => !a.disabled) : provider.accounts;
  return (
    <section className="provider-panel" style={{ ['--accent' as string]: accent }}>
      <header className="provider-panel__header">
        <div>
          <p className="provider-panel__eyebrow">已配置 Provider</p>
          <h2 className="provider-panel__title">{provider.name}</h2>
        </div>
        {isPublic ? null : (
          <div className="provider-panel__summary">
            <span>{provider.configured_account_count} 个账号</span>
            <span>{provider.enabled_account_count} 个启用</span>
            <span>{provider.quota_exhausted_count} 个耗尽</span>
          </div>
        )}
      </header>

      {isPublic ? null : (
        <div className="provider-stats">
          <WindowStatCard
            label="1h"
            requests={provider.usage.last_1h.requests}
            tokens={provider.usage.last_1h.tokens}
            failed={provider.usage.last_1h.failed_requests}
          />
          <WindowStatCard
            label="24h"
            requests={provider.usage.last_24h.requests}
            tokens={provider.usage.last_24h.tokens}
            failed={provider.usage.last_24h.failed_requests}
          />
          <WindowStatCard
            label="7d"
            requests={provider.usage.last_7d.requests}
            tokens={provider.usage.last_7d.tokens}
            failed={provider.usage.last_7d.failed_requests}
          />
        </div>
      )}

      {isPublic || provider.usage.models.length === 0 ? null : (
        <section className="provider-models">
          {provider.usage.models.map((model) => (
            <div key={model.model} className="provider-models__item">
              <span>{model.model}</span>
              <strong>{fmtNumber(model.requests)}</strong>
            </div>
          ))}
        </section>
      )}

      <div className="account-grid">
        {visibleAccounts.map((account, index) => (
          <AccountCard
            key={account.auth_index}
            account={account}
            accent={accent}
            isPublic={isPublic}
            publicLabel={
              isPublic && visibleAccounts.length > 1
                ? `账号 ${index + 1}`
                : undefined
            }
          />
        ))}
      </div>
    </section>
  );
}

export function App() {
  const isAdminPage = window.location.pathname.startsWith('/admin');
  const [state, setState] = useState<LoadState>('checking');
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [managementKey, setManagementKey] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const loadOverview = async (force = false) => {
    setRefreshing(true);
    try {
      const next = force
        ? await api<OverviewResponse>('/api/refresh', {
            method: 'POST',
            body: JSON.stringify({ scope: 'all' }),
          })
        : await api<OverviewResponse>('/api/overview');
      setOverview(next);
      setError('');
      setState('dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load overview');
    } finally {
      setRefreshing(false);
    }
  };

  const loadPublicOverview = async () => {
    setRefreshing(true);
    try {
      const next = await api<OverviewResponse>('/api/public-overview');
      setOverview(next);
      setError('');
      setState('public');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load overview');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await api<SessionResponse>('/api/session');
        if (!active) return;
        if (!isAdminPage) {
          await loadPublicOverview();
          return;
        }
        if (!session.authenticated) {
          setState('login');
          return;
        }
        await loadOverview(false);
      } catch {
        if (!active) return;
        setState('login');
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (state !== 'dashboard' && state !== 'public') return;
    const timer = window.setInterval(() => {
      void (state === 'dashboard' ? loadOverview(false) : loadPublicOverview());
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [state]);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setRefreshing(true);
    try {
      await api<SessionResponse>('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          base_url: baseUrl,
          management_key: managementKey,
          remember_me: rememberMe,
        }),
      });
      setManagementKey('');
      await loadOverview(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setState('login');
    } finally {
      setRefreshing(false);
    }
  };

  const handleLogout = async () => {
    await api<SessionResponse>('/api/logout', { method: 'POST' }).catch(() => undefined);
    setOverview(null);
    setState('login');
  };

  if (state === 'checking') {
    return <div className="shell shell--center">正在检查会话...</div>;
  }

  if (isAdminPage && state === 'login') {
    return (
      <div className="shell shell--center">
        <div className="login-frame">
          <div className="login-badge">quota.bbroot.com</div>
          <h1>配额总览</h1>
          <p>
            输入 CPA 后端地址和管理密钥进行连接。密钥只会提交到服务端，并保存在服务端会话中，不会写入浏览器本地存储。
          </p>
          <form className="login-form" onSubmit={handleLogin}>
            <label>
              CPA 地址
              <input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://你的-cpa-地址 或 .../v0/management"
                autoComplete="url"
              />
            </label>
            <label>
              管理密钥
              <input
                type="password"
                value={managementKey}
                onChange={(event) => setManagementKey(event.target.value)}
                placeholder="输入管理密钥"
                autoComplete="current-password"
              />
            </label>
            <label className="remember">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
              />
              记住本次会话
            </label>
            {error ? <div className="error-box">{error}</div> : null}
            <button type="submit" disabled={refreshing || !baseUrl.trim() || !managementKey.trim()}>
              {refreshing ? '连接中...' : '进入总览'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const activeProviders = overview?.providers.filter((provider) => provider.visible) ?? [];

  if (!isAdminPage && state === 'public') {
    return (
      <div className="shell shell--public">
        {overview ? (
          <main className="provider-stack">
            {activeProviders
              .filter((provider) => provider.accounts.some((a) => !a.disabled))
              .map((provider) => (
                <ProviderSection key={provider.id} provider={provider} isPublic />
              ))}
          </main>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`shell ${isAdminPage ? 'shell--admin' : 'shell--public'}`}>
      <header className="hero">
        <div>
          <div className="hero__tag">远程 CPA 配额面板</div>
          <h1>仅展示已配置 Provider，配额与使用统计同屏查看。</h1>
          <p className="hero__desc">
            通过管理密钥连接 CPA 后端并刷新快照，成功后的最新结果会同步发布到公开页。
          </p>
        </div>
        <div className="hero__actions">
          <button onClick={() => void loadOverview(true)} disabled={refreshing}>
            {refreshing ? '刷新中...' : '强制刷新'}
          </button>
          <button className="ghost" onClick={() => void handleLogout()}>
            退出登录
          </button>
        </div>
      </header>

      {overview ? (
        <>
          <section className="summary-strip">
            <div className="summary-card">
              <span>Provider 数</span>
              <strong>{overview.summary.active_provider_count}</strong>
            </div>
            <div className="summary-card">
              <span>账号数</span>
              <strong>{overview.summary.account_count}</strong>
            </div>
            <div className="summary-card">
              <span>24 小时请求数</span>
              <strong>{fmtNumber(overview.summary.total_requests_24h)}</strong>
            </div>
            <div className="summary-card">
              <span>24 小时 Tokens</span>
              <strong>{fmtNumber(overview.summary.total_tokens_24h)}</strong>
            </div>
            <div className="summary-card">
              <span>额度耗尽账号</span>
              <strong>{overview.summary.quota_exhausted_accounts}</strong>
            </div>
          </section>

          <section className="timestamp-bar">
            <span>生成时间 {fmtDateTime(overview.generated_at)}</span>
            <span>Usage 缓存 {fmtDateTime(overview.cache.usage_refreshed_at)}</span>
            <span>Quota 缓存 {fmtDateTime(overview.cache.quota_refreshed_at)}</span>
          </section>

          {error ? <div className="error-box">{error}</div> : null}

          <main className="provider-stack">
            {activeProviders.map((provider) => (
              <ProviderSection key={provider.id} provider={provider} />
            ))}
          </main>
        </>
      ) : null}
    </div>
  );
}
