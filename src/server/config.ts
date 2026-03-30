import path from 'node:path';

const requireValue = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
};

const optionalNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const appConfig = {
  port: optionalNumber('PORT', 4179),
  sessionSecret: requireValue('SESSION_SECRET', 'change-me-before-production'),
  usageTtlMs: optionalNumber('USAGE_TTL_SECONDS', 30) * 1000,
  quotaTtlMs: optionalNumber('QUOTA_TTL_SECONDS', 300) * 1000,
  cookieName: process.env.COOKIE_NAME?.trim() || 'quota_session',
  publicDir: path.resolve(process.cwd(), 'dist/client'),
};
