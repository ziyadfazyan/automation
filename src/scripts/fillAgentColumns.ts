import fs from 'node:fs/promises';
import { google } from 'googleapis';
import { config } from '../config.js';
import { createGoogleAuth } from '../google/auth.js';
import { extractFirstManifestName, normalizeInvoiceForSearch, normalizeNameForComparison } from '../utils/normalize.js';

const INVOICE_HEADER = 'Nomor Invoice';
const MANIFEST_HEADER = 'Manifest';
const AGENT_PJ_HEADER = 'Agen PJ';
const AGENT_PJ_PHONE_HEADER = 'No HP Agen PJ';
const STAGES_HEADER = 'Stages';
const PARENT_AGENT_HEADER = 'Agen Induk';
const PARENT_AGENT_PHONE_HEADER = 'No HP Agen Induk';

const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('--dryrun');
const limit = parsePositiveIntegerArg('--limit');
const sheets = google.sheets({ version: 'v4', auth: createGoogleAuth() });

interface VisibleRow {
  rowNumber: number;
  values: string[];
}

interface InvoiceApiItem {
  number?: string;
  admin?: AdminApiItem | null;
  profiles?: Array<{ name?: string }>;
}

interface AdminApiItem {
  id?: number;
  name?: string;
  phone?: string;
  parent_id?: number | null;
  parent?: { id?: number; name?: string } | null;
  stage?: unknown;
}

try {
  await fillAgentColumns();
} catch (error) {
  printError(error);
  process.exitCode = 1;
}

async function fillAgentColumns(): Promise<void> {
  const rows = await getVisibleRows();
  if (rows.length < 2) {
    console.log('No rows found.');
    return;
  }

  const headers = rows[0].values;
  const indexes = {
    invoice: requireHeader(headers, INVOICE_HEADER),
    manifest: requireHeader(headers, MANIFEST_HEADER),
    agentPj: requireHeader(headers, AGENT_PJ_HEADER),
    agentPjPhone: requireHeader(headers, AGENT_PJ_PHONE_HEADER),
    stages: requireHeader(headers, STAGES_HEADER),
    parentAgent: requireHeader(headers, PARENT_AGENT_HEADER),
    parentAgentPhone: requireHeader(headers, PARENT_AGENT_PHONE_HEADER),
  };
  const token = await readWebsiteAuthToken();
  const adminById = await fetchAdmins(token);
  const updates: Array<{ range: string; values: string[][] }> = [];
  let filled = 0;
  let skippedExisting = 0;
  let skippedMissingInvoice = 0;
  let skippedNotFound = 0;

  for (const visibleRow of rows.slice(1)) {
    if (limit && filled >= limit) break;

    const row = visibleRow.values;
    const invoiceNumber = String(row[indexes.invoice] ?? '').trim();
    const manifestName = extractFirstManifestName(String(row[indexes.manifest] ?? ''));
    if (!invoiceNumber) {
      skippedMissingInvoice += 1;
      continue;
    }

    const existing = {
      agentPj: String(row[indexes.agentPj] ?? '').trim(),
      agentPjPhone: String(row[indexes.agentPjPhone] ?? '').trim(),
      stages: String(row[indexes.stages] ?? '').trim(),
      parentAgent: String(row[indexes.parentAgent] ?? '').trim(),
      parentAgentPhone: String(row[indexes.parentAgentPhone] ?? '').trim(),
    };

    if (Object.values(existing).every(Boolean)) {
      skippedExisting += 1;
      continue;
    }

    const invoice = await fetchInvoice(token, invoiceNumber, manifestName);
    if (!invoice?.admin) {
      skippedNotFound += 1;
      console.log(`Skipped row ${visibleRow.rowNumber}: invoice/admin not found for ${invoiceNumber} ${manifestName}`);
      continue;
    }

    const agent = invoice.admin;
    const cachedAgent = agent.id ? adminById.get(Number(agent.id)) : undefined;
    const parentId = Number(cachedAgent?.parent_id ?? agent.parent_id ?? agent.parent?.id ?? 0);
    const parent = parentId ? adminById.get(parentId) : undefined;
    const nextValues = {
      agentPj: existing.agentPj || valueOf(cachedAgent?.name ?? agent.name),
      agentPjPhone: existing.agentPjPhone || formatPhone(cachedAgent?.phone ?? agent.phone),
      stages: existing.stages || stageName(cachedAgent?.stage ?? agent.stage),
      parentAgent: existing.parentAgent || valueOf(parent?.name ?? agent.parent?.name),
      parentAgentPhone: existing.parentAgentPhone || formatPhone(parent?.phone),
    };

    const rowUpdates = [
      [indexes.agentPj, existing.agentPj, nextValues.agentPj],
      [indexes.agentPjPhone, existing.agentPjPhone, nextValues.agentPjPhone],
      [indexes.stages, existing.stages, nextValues.stages],
      [indexes.parentAgent, existing.parentAgent, nextValues.parentAgent],
      [indexes.parentAgentPhone, existing.parentAgentPhone, nextValues.parentAgentPhone],
    ] as Array<[number, string, string]>;

    for (const [index, oldValue, newValue] of rowUpdates) {
      if (oldValue || !newValue) continue;
      updates.push({
        range: `${config.MAIN_SHEET_NAME}!${columnLetter(index + 1)}${visibleRow.rowNumber}`,
        values: [[newValue]],
      });
    }
    filled += 1;
  }

  if (isDryRun && updates.length > 0) {
    console.log('Dry run only. No spreadsheet updates were made.');
    for (const update of updates.slice(0, 30)) {
      console.log(`${update.range}: ${update.values[0][0]}`);
    }
    if (updates.length > 30) console.log(`...and ${updates.length - 30} more cell update(s).`);
  } else if (updates.length > 0) {
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.MAIN_SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates,
      },
    }), 'Google Sheets batch update');
  }

  console.log(`${isDryRun ? 'Would fill' : 'Filled'} agent columns for ${filled} row(s).`);
  console.log(`Cell updates: ${updates.length}`);
  console.log(`Skipped ${skippedExisting} row(s) with existing agent values.`);
  console.log(`Skipped ${skippedMissingInvoice} row(s) without invoice number.`);
  console.log(`Skipped ${skippedNotFound} row(s) where API data was not found.`);
}

async function fetchInvoice(token: string, invoiceNumber: string, manifestName: string): Promise<InvoiceApiItem | null> {
  const url = new URL('/admin_api/invoices', config.WEBSITE_BASE_URL);
  url.searchParams.set('per_page', '10');
  url.searchParams.set('search[invoice_number]', normalizeInvoiceForSearch(invoiceNumber));
  url.searchParams.set('include_profiles', '1');
  const body = await fetchJson<{ data?: InvoiceApiItem[] }>(url, token);
  const targetInvoice = normalizeInvoiceForSearch(invoiceNumber).toUpperCase();
  const targetName = normalizeNameForComparison(manifestName);
  const matches = (body.data ?? []).filter((item) => normalizeInvoiceForSearch(item.number ?? '').toUpperCase() === targetInvoice);
  if (matches.length <= 1 || !targetName) return matches[0] ?? null;
  return matches.find((item) =>
    (item.profiles ?? []).some((profile) => normalizeNameForComparison(profile.name).includes(targetName)),
  ) ?? matches[0] ?? null;
}

async function fetchAdmins(token: string): Promise<Map<number, AdminApiItem>> {
  const result = new Map<number, AdminApiItem>();
  let page = 1;
  let totalPage = 1;

  do {
    const url = new URL('/admin_api/admins', config.WEBSITE_BASE_URL);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '200');
    const body = await fetchJson<{ data?: AdminApiItem[]; meta?: { total_page?: number } }>(url, token);
    for (const admin of body.data ?? []) {
      if (admin.id) result.set(Number(admin.id), admin);
    }
    totalPage = Number(body.meta?.total_page ?? page);
    page += 1;
  } while (page <= totalPage);

  return result;
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

async function readWebsiteAuthToken(): Promise<string> {
  const raw = await fs.readFile(config.PLAYWRIGHT_STORAGE_STATE, 'utf8');
  const state = JSON.parse(raw) as { origins?: Array<{ localStorage?: Array<{ name?: string; value?: string }> }> };
  for (const origin of state.origins ?? []) {
    const credential = origin.localStorage?.find((item) => item.name === 'currentCredential')?.value;
    if (!credential) continue;
    const parsed = JSON.parse(credential) as { auth_token?: unknown; jwt?: unknown };
    const token = typeof parsed.auth_token === 'string' ? parsed.auth_token : typeof parsed.jwt === 'string' ? parsed.jwt : '';
    if (token) return token;
  }
  throw new Error(`Could not read Website A auth token from ${config.PLAYWRIGHT_STORAGE_STATE}. Run npm run auth:website first.`);
}

async function getVisibleRows(): Promise<VisibleRow[]> {
  const response = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: config.MAIN_SPREADSHEET_ID,
    ranges: [`${config.MAIN_SHEET_NAME}!A:ZZ`],
    includeGridData: true,
    fields: 'sheets(properties(title),data(rowData(values(formattedValue)),rowMetadata(hiddenByFilter,hiddenByUser)))',
  }), 'Google Sheets read visible rows');

  const sheet = response.data.sheets?.find((candidate) => candidate.properties?.title === config.MAIN_SHEET_NAME);
  const grid = sheet?.data?.[0];
  const rowData = grid?.rowData ?? [];
  const rowMetadata = grid?.rowMetadata ?? [];
  const visibleRows: VisibleRow[] = [];

  for (let index = 0; index < rowData.length; index += 1) {
    const metadata = rowMetadata[index];
    if (metadata?.hiddenByFilter || metadata?.hiddenByUser) continue;

    const values = rowData[index]?.values?.map((cell) => String(cell.formattedValue ?? '').trim()) ?? [];
    visibleRows.push({ rowNumber: index + 1, values });
  }

  return visibleRows;
}

async function withRetry<T>(action: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isRetryableGoogleError(error) || attempt === 5) break;
      const delayMs = attempt * 3000;
      console.error(`${label} failed (${errorMessage(error)}). Retrying in ${delayMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function isRetryableGoogleError(error: unknown): boolean {
  const message = errorMessage(error);
  const code = error && typeof error === 'object' ? String((error as Record<string, unknown>).code ?? '') : '';
  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    message.includes('oauth2.googleapis.com/token') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ECONNRESET')
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireHeader(headers: string[], headerName: string): number {
  const index = headers.findIndex((header) => normalizeHeader(header) === normalizeHeader(headerName));
  if (index === -1) throw new Error(`Missing required column: ${headerName}`);
  return index;
}

function normalizeHeader(value: string): string {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function stageName(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return valueOf(record.name ?? record.title ?? record.position ?? record.key);
  }
  return '';
}

function valueOf(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function formatPhone(value: unknown): string {
  const raw = valueOf(value);
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('62')) digits = `0${digits.slice(2)}`;
  if (digits.startsWith('8')) digits = `0${digits}`;
  return digits ? `'${digits}` : '';
}

function parsePositiveIntegerArg(name: string): number | null {
  const prefix = `${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return null;

  const value = Number(arg.slice(prefix.length));
  return Number.isInteger(value) && value > 0 ? value : null;
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

function printError(error: unknown): void {
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
