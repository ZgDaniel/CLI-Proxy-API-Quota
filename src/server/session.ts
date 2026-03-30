import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { appConfig } from './config.js';

type SessionRecord = {
  expiresAt: number;
  cpaBaseUrl: string;
  cpaManagementKey: string;
};

const sessions = new Map<string, SessionRecord>();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const purgeExpired = () => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
};

const sign = (payload: string) =>
  crypto.createHmac('sha256', appConfig.sessionSecret).update(payload).digest('hex');

const serialize = (token: string) => `${token}.${sign(token)}`;

const deserialize = (value: string | undefined): string | null => {
  if (!value) return null;
  const [token, signature] = value.split('.');
  if (!token || !signature) return null;
  if (sign(token) !== signature) return null;
  return token;
};

export const createSession = (input: {
  rememberMe: boolean;
  cpaBaseUrl: string;
  cpaManagementKey: string;
}): string => {
  purgeExpired();
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, {
    expiresAt: Date.now() + (input.rememberMe ? THIRTY_DAYS_MS : ONE_DAY_MS),
    cpaBaseUrl: input.cpaBaseUrl,
    cpaManagementKey: input.cpaManagementKey,
  });
  return serialize(token);
};

export const clearSession = (req: Request, res: Response) => {
  const raw = req.cookies?.[appConfig.cookieName] as string | undefined;
  const token = deserialize(raw);
  if (token) {
    sessions.delete(token);
  }
  res.clearCookie(appConfig.cookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
};

export const setSessionCookie = (res: Response, value: string, rememberMe: boolean) => {
  res.cookie(appConfig.cookieName, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: rememberMe ? THIRTY_DAYS_MS : ONE_DAY_MS,
    path: '/',
  });
};

export const getAnyActiveSession = (): { cpaBaseUrl: string; cpaManagementKey: string } | null => {
  purgeExpired();
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.expiresAt > now) {
      return { cpaBaseUrl: session.cpaBaseUrl, cpaManagementKey: session.cpaManagementKey };
    }
  }
  return null;
};

export const isAuthenticated = (req: Request): boolean => {
  return getSession(req) !== null;
};

export const getSession = (
  req: Request
): { cpaBaseUrl: string; cpaManagementKey: string; expiresAt: number } | null => {
  purgeExpired();
  const raw = req.cookies?.[appConfig.cookieName] as string | undefined;
  const token = deserialize(raw);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return {
    cpaBaseUrl: session.cpaBaseUrl,
    cpaManagementKey: session.cpaManagementKey,
    expiresAt: session.expiresAt,
  };
};
