import fs from 'node:fs';
import path from 'node:path';
import { appConfig } from './config.js';

type SchedulerCreds = { cpaBaseUrl: string; cpaManagementKey: string };

const CREDS_DIR = path.resolve(process.cwd(), '.data');
const CREDS_FILE = path.join(CREDS_DIR, 'scheduler-credentials.json');

export const saveSchedulerCredentials = (creds: SchedulerCreds): void => {
  try {
    fs.mkdirSync(CREDS_DIR, { recursive: true });
    fs.writeFileSync(CREDS_FILE, JSON.stringify(creds), 'utf8');
  } catch {
    // best-effort; scheduler can still fall back to session
  }
};

export const loadSchedulerCredentials = (): SchedulerCreds | null => {
  // Priority 1: environment variables
  if (appConfig.schedulerCpaBaseUrl && appConfig.schedulerCpaManagementKey) {
    return { cpaBaseUrl: appConfig.schedulerCpaBaseUrl, cpaManagementKey: appConfig.schedulerCpaManagementKey };
  }
  // Priority 2: persisted file
  try {
    const raw = fs.readFileSync(CREDS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SchedulerCreds>;
    if (parsed.cpaBaseUrl && parsed.cpaManagementKey) {
      return { cpaBaseUrl: parsed.cpaBaseUrl, cpaManagementKey: parsed.cpaManagementKey };
    }
  } catch {
    // file doesn't exist or is invalid — fall through
  }
  return null;
};
