import axios from 'axios';

export type RawAuthFile = {
  auth_index?: string;
  name?: string;
  label?: string;
  type?: string;
  provider?: string;
  email?: string;
  disabled?: boolean;
  runtime_only?: boolean;
  status?: string;
  status_message?: string;
  unavailable?: boolean;
  source?: string;
  priority?: number;
  last_refresh?: string;
  next_retry_after?: string;
  account?: string;
  id_token?: unknown;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  quota?: {
    exceeded?: boolean;
    reason?: string;
    next_recover_at?: string;
  };
};

export type UsageSnapshot = {
  usage?: {
    apis?: Record<string, { models?: Record<string, { details?: Array<Record<string, unknown>> }> }>;
  };
};

export type ApiCallResponse = {
  statusCode: number;
  header: Record<string, string[]>;
  bodyText: string;
  body: unknown;
};

export const normalizeCpaBaseUrl = (input: string): string => {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  if (trimmed.endsWith('/v0/management')) {
    return trimmed.slice(0, -'/v0/management'.length);
  }
  if (trimmed.endsWith('/management')) {
    return trimmed.slice(0, -'/management'.length);
  }
  return trimmed;
};

const normalizeBody = (input: unknown) => {
  if (input === undefined || input === null) return { bodyText: '', body: null };
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { bodyText: '', body: null };
    try {
      return { bodyText: input, body: JSON.parse(trimmed) };
    } catch {
      return { bodyText: input, body: input };
    }
  }
  return { bodyText: JSON.stringify(input), body: input };
};

export const createCpaClient = (input: { cpaBaseUrl: string; cpaManagementKey: string }) => {
  const normalizedBaseUrl = normalizeCpaBaseUrl(input.cpaBaseUrl);
  const client = axios.create({
    baseURL: `${normalizedBaseUrl}/v0/management`,
    headers: {
      Authorization: `Bearer ${input.cpaManagementKey}`,
    },
    timeout: 30_000,
  });

  return {
    async listAuthFiles(): Promise<RawAuthFile[]> {
      const response = await client.get<{ files?: RawAuthFile[] }>('/auth-files');
      return Array.isArray(response.data?.files) ? response.data.files : [];
    },

    async downloadAuthFile(name: string): Promise<string> {
      const response = await client.get<ArrayBuffer>('/auth-files/download', {
        params: { name },
        responseType: 'arraybuffer',
      });
      return Buffer.from(response.data).toString('utf8');
    },

    async getUsage(): Promise<UsageSnapshot> {
      const response = await client.get<UsageSnapshot>('/usage');
      return response.data ?? {};
    },

    async apiCall(payload: {
      authIndex?: string;
      method: string;
      url: string;
      header?: Record<string, string>;
      data?: string;
    }): Promise<ApiCallResponse> {
      const response = await client.post<Record<string, unknown>>('/api-call', payload);
      const statusCode = Number(response.data?.status_code ?? response.data?.statusCode ?? 0);
      const header = (response.data?.header ?? response.data?.headers ?? {}) as Record<string, string[]>;
      const { bodyText, body } = normalizeBody(response.data?.body);
      return { statusCode, header, bodyText, body };
    },
  };
};
