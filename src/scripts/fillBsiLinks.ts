import fs from 'node:fs/promises';
import { google } from 'googleapis';
import { config } from '../config.js';
import { createGoogleAuth } from '../google/auth.js';
import { normalizeInvoiceForSearch } from '../utils/normalize.js';
import { resolveWebsiteSite } from '../utils/siteConfig.js';

const SITE_HEADER = 'Site';
const INVOICE_HEADER = 'Nomor Invoice';
const BSI_OPENING_HEADER = 'form bsi pembukaan';
const POWER_OF_ATTORNEY_HEADER = 'form surat kuasa';

const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('--dryrun');
const overwrite = process.argv.includes('--overwrite');
const limit = parsePositiveIntegerArg('--limit');

const sheets = google.sheets({ version: 'v4', auth: createGoogleAuth() });

interface InvoiceApiItem {
  number?: unknown;
  slug?: unknown;
}

try {
  await fillBsiLinks();
} catch (error) {
  printGoogleError(error);
  process.exitCode = 1;
}

async function fillBsiLinks(): Promise<void> {
  const rows = await getVisibleRows();
  if (rows.length < 2) {
    console.log('No rows found.');
    return;
  }

  const headers = rows[0].values;
  const siteIndex = findHeaderIndex(headers, SITE_HEADER);
  const invoiceIndex = findHeaderIndex(headers, INVOICE_HEADER);
  const openingIndex = findHeaderIndex(headers, BSI_OPENING_HEADER);
  const powerIndex = findHeaderIndex(headers, POWER_OF_ATTORNEY_HEADER);
  if (siteIndex === -1) throw new Error(`Missing required column: ${SITE_HEADER}`);
  if (invoiceIndex === -1) throw new Error(`Missing required column: ${INVOICE_HEADER}`);
  if (openingIndex === -1) throw new Error(`Missing required column: ${BSI_OPENING_HEADER}`);
  if (powerIndex === -1) throw new Error(`Missing required column: ${POWER_OF_ATTORNEY_HEADER}`);

  const tokenCache = new Map<string, string>();
  const updates: Array<{ range: string; values: string[][] }> = [];
  let filled = 0;
  let skippedExisting = 0;
  let skippedMissingInvoice = 0;
  let skippedMissingSlug = 0;

  for (const visibleRow of rows.slice(1)) {
    if (limit && filled >= limit) break;

    const rowNumber = visibleRow.rowNumber;
    const row = visibleRow.values;
    const site = String(row[siteIndex] ?? '').trim();
    const invoiceNumber = String(row[invoiceIndex] ?? '').trim();
    const existingOpeningUrl = String(row[openingIndex] ?? '').trim();
    const existingPowerUrl = String(row[powerIndex] ?? '').trim();

    if (!overwrite && existingOpeningUrl && existingPowerUrl) {
      skippedExisting += 1;
      continue;
    }

    if (!invoiceNumber) {
      skippedMissingInvoice += 1;
      continue;
    }

    const siteConfig = resolveWebsiteSite(site);
    let token = tokenCache.get(siteConfig.key);
    if (!token) {
      token = await readWebsiteAuthToken(site);
      tokenCache.set(siteConfig.key, token);
    }

    const slug = await fetchInvoiceSlug(token, site, invoiceNumber);
    if (!slug) {
      skippedMissingSlug += 1;
      console.log(`Skipped row ${rowNumber}: invoice slug not found from API for ${invoiceNumber}`);
      continue;
    }

    const openingUrl = `${siteConfig.baseUrl}/print/form-bsi-pembukaan-rek-jamaah/${slug}`;
    const powerUrl = `${siteConfig.baseUrl}/print/form-surat-kuasa/${slug}`;

    if (overwrite || !existingOpeningUrl) {
      updates.push({
        range: `${config.MAIN_SHEET_NAME}!${columnLetter(openingIndex + 1)}${rowNumber}`,
        values: [[openingUrl]],
      });
    }
    if (overwrite || !existingPowerUrl) {
      updates.push({
        range: `${config.MAIN_SHEET_NAME}!${columnLetter(powerIndex + 1)}${rowNumber}`,
        values: [[powerUrl]],
      });
    }
    filled += 1;
  }

  if (isDryRun && updates.length > 0) {
    console.log('Dry run only. No spreadsheet updates were made.');
    for (const update of updates.slice(0, 20)) {
      console.log(`${update.range}: ${update.values[0].join(' | ')}`);
    }
    if (updates.length > 20) {
      console.log(`...and ${updates.length - 20} more row(s).`);
    }
  } else if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.MAIN_SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates,
      },
    });
  }

  console.log(`${isDryRun ? 'Would fill' : 'Filled'} BSI links for ${filled} row(s).`);
  console.log(`Skipped ${skippedExisting} row(s) with existing BSI link values.`);
  console.log(`Skipped ${skippedMissingInvoice} row(s) without invoice number.`);
  console.log(`Skipped ${skippedMissingSlug} row(s) without API invoice slug.`);
}

async function fetchInvoiceSlug(token: string, siteValue: string, invoiceNumber: string): Promise<string> {
  const site = resolveWebsiteSite(siteValue);
  const url = new URL('/admin_api/invoices', site.baseUrl);
  url.searchParams.set('per_page', '10');
  url.searchParams.set('search[invoice_number]', normalizeInvoiceForSearch(invoiceNumber));

  const body = await fetchJson<{ data?: InvoiceApiItem[] }>(url, token);
  const targetInvoice = normalizeInvoiceForSearch(invoiceNumber).toUpperCase();
  const invoice = (body.data ?? []).find((item) =>
    normalizeInvoiceForSearch(String(item.number ?? '')).toUpperCase() === targetInvoice,
  ) ?? body.data?.[0];

  return String(invoice?.slug ?? '').trim();
}

async function fetchJson<T>(url: URL, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Token token=${token}`,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`API ${url.pathname} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function readWebsiteAuthToken(siteValue: string): Promise<string> {
  const site = resolveWebsiteSite(siteValue);
  const storagePath = config.PLAYWRIGHT_STORAGE_STATE;
  const raw = await fs.readFile(storagePath, 'utf8');
  const state = JSON.parse(raw) as { origins?: Array<{ origin?: string; localStorage?: Array<{ name?: string; value?: string }> }> };
  for (const origin of state.origins ?? []) {
    if (origin.origin && new URL(origin.origin).origin !== new URL(site.baseUrl).origin) continue;
    const credential = origin.localStorage?.find((item) => item.name === 'currentCredential')?.value;
    if (!credential) continue;
    const parsed = JSON.parse(credential) as { auth_token?: unknown; jwt?: unknown };
    const token = typeof parsed.auth_token === 'string' ? parsed.auth_token : typeof parsed.jwt === 'string' ? parsed.jwt : '';
    if (token) return token;
  }
  throw new Error(`Could not read Website auth token from ${storagePath}. Run SITE=${site.key} npm run auth:website first.`);
}

async function getVisibleRows(): Promise<Array<{ rowNumber: number; values: string[] }>> {
  const response = await sheets.spreadsheets.get({
    spreadsheetId: config.MAIN_SPREADSHEET_ID,
    ranges: [`${config.MAIN_SHEET_NAME}!A:ZZ`],
    includeGridData: true,
    fields: 'sheets(properties(title),data(rowData(values(formattedValue)),rowMetadata(hiddenByFilter,hiddenByUser)))',
  });

  const sheet = response.data.sheets?.find((candidate) => candidate.properties?.title === config.MAIN_SHEET_NAME);
  const grid = sheet?.data?.[0];
  const rowData = grid?.rowData ?? [];
  const rowMetadata = grid?.rowMetadata ?? [];
  const visibleRows: Array<{ rowNumber: number; values: string[] }> = [];

  for (let index = 0; index < rowData.length; index += 1) {
    const metadata = rowMetadata[index];
    if (metadata?.hiddenByFilter || metadata?.hiddenByUser) continue;

    const values = rowData[index]?.values?.map((cell) => String(cell.formattedValue ?? '').trim()) ?? [];
    visibleRows.push({ rowNumber: index + 1, values });
  }

  return visibleRows;
}

function parsePositiveIntegerArg(name: string): number | null {
  const prefix = `${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return null;

  const value = Number(arg.slice(prefix.length));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function findHeaderIndex(headers: string[], headerName: string): number {
  const target = normalizeHeader(headerName);
  return headers.findIndex((header) => normalizeHeader(header) === target);
}

function normalizeHeader(value: string): string {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function columnLetter(columnNumber: number): string {
  let current = columnNumber;
  let result = '';
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function printGoogleError(error: unknown): void {
  const details = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = String(details.code ?? '');
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'ETIMEDOUT' || message.includes('oauth2.googleapis.com/token')) {
    console.error('Google auth token refresh failed or timed out.');
    console.error('Try again once, or refresh ADC with:');
    console.error('gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/spreadsheets');
    console.error(`Detail: ${code || message}`);
    return;
  }

  console.error(message);
}
