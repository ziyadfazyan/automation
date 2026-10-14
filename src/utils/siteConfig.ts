import { config } from '../config.js';

export interface WebsiteSiteConfig {
  key: string;
  baseUrl: string;
  invoicesUrl: string;
}

const SITE_URLS: Record<string, string> = {
  arminarekacabang015: 'https://arminarekacabang015.com',
  jalanhaji: 'https://jalanhaji.com',
  naffartour: 'https://naffartour.id',
};

export function resolveWebsiteSite(siteValue?: string): WebsiteSiteConfig {
  const key = normalizeSiteKey(siteValue);
  const baseUrl = SITE_URLS[key] ?? config.WEBSITE_BASE_URL;
  return {
    key,
    baseUrl,
    invoicesUrl: `${baseUrl}/app_v2/#/admin/transactions/invoices?page`,
  };
}

function normalizeSiteKey(value?: string): string {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\..*$/, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();

  if (normalized.includes('arminarekacabang015')) return 'arminarekacabang015';
  if (normalized.includes('jalanhaji')) return 'jalanhaji';
  if (normalized.includes('naffartour')) return 'naffartour';
  return normalized;
}
