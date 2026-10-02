import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, Page, BrowserContext } from '@playwright/test';
import { config } from '../config.js';
import { DocumentReaderResult, SheetRecord } from '../types/record.js';
import { WorkflowError } from '../types/status.js';
import { normalizeInvoiceForSearch, normalizeNameForComparison } from '../utils/normalize.js';

export interface SiteAutomationResult {
  documentReaderResult: DocumentReaderResult;
  ktpTempPath: string;
  invoiceUrl: string;
}

export class SiteAutomation {
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(config.PLAYWRIGHT_STORAGE_STATE), { recursive: true });
    try {
      const browser = await chromium.launch({ headless: config.PLAYWRIGHT_HEADLESS, slowMo: 50 });
      this.context = await browser.newContext({
        storageState: await storageStateIfExists(config.PLAYWRIGHT_STORAGE_STATE),
        acceptDownloads: true,
      });
      this.page = await this.context.newPage();
    } catch (error) {
      throw new WorkflowError(
        error instanceof Error ? `Browser failed to launch: ${error.message}` : 'Browser failed to launch',
        'NEEDS_REVIEW',
        'START_BROWSER',
        error,
      );
    }
  }

  async saveAuthenticatedState(): Promise<void> {
    const page = this.requirePage();
    await page.goto(config.WEBSITE_INVOICES_URL, { waitUntil: 'domcontentloaded' });
    console.log('Log in manually if prompted. Press Enter here after Website A is authenticated.');
    await waitForEnter();
    await this.context?.storageState({ path: config.PLAYWRIGHT_STORAGE_STATE });
  }

  async processToVerification(record: SheetRecord): Promise<SiteAutomationResult> {
    const page = this.requirePage();
    const invoiceUrl = await this.openInvoice(page, record.invoiceNumber);
    await this.openTourPack(page);
    await this.openManifestTab(page);
    await this.selectManifestCustomer(page, record.firstManifestName);
    const ktpTempPath = await this.downloadKtp(page, record.invoiceNumber);
    await this.uploadKtp(page, ktpTempPath);
    await this.runDocumentReader(page);
    const documentReaderResult = await this.readDocumentReaderResult(page);

    return { documentReaderResult, ktpTempPath, invoiceUrl };
  }

  async captureScreenshot(invoiceNumber: string, step: string): Promise<string | null> {
    const page = this.page;
    if (!page) return null;
    await fs.mkdir('artifacts/screenshots', { recursive: true });
    const safeInvoice = invoiceNumber.replace(/[^\w.-]+/g, '_');
    const screenshotPath = `artifacts/screenshots/${safeInvoice}-${step}-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  }

  async close(): Promise<void> {
    await this.context?.browser()?.close();
  }

  private async openInvoice(page: Page, invoiceNumber: string): Promise<string> {
    await page.goto(config.WEBSITE_INVOICES_URL, { waitUntil: 'domcontentloaded' });
    const searchValue = normalizeInvoiceForSearch(invoiceNumber);
    await page.locator('input[placeholder="Pencarian"]').fill(searchValue);
    await page.keyboard.press('Enter').catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);

    const invoiceLink = page
      .locator('a')
      .filter({ hasText: searchValue })
      .or(page.locator(`a[href*="${searchValue}"]`))
      .first();

    await invoiceLink.waitFor({ state: 'visible', timeout: 15000 });
    const href = await invoiceLink.getAttribute('href');
    await invoiceLink.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(750);

    if (page.url() === config.WEBSITE_INVOICES_URL && href) {
      await page.goto(new URL(href, config.WEBSITE_BASE_URL).toString());
    }

    return page.url();
  }

  private async openTourPack(page: Page): Promise<void> {
    const tourPackLink = page.locator('a[href*="/tour-pack/"][href*="detail-tour-pack"]').first();
    await tourPackLink.waitFor({ state: 'visible', timeout: 15000 });
    await tourPackLink.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(750);
  }

  private async openManifestTab(page: Page): Promise<void> {
    const manifestTab = page.getByRole('tab', { name: /manifest/i }).or(page.getByText(/^Manifest$/i)).first();
    await manifestTab.waitFor({ state: 'visible', timeout: 15000 });
    await manifestTab.click();
    await page.waitForTimeout(750);
  }

  private async selectManifestCustomer(page: Page, firstManifestName: string): Promise<void> {
    const normalizedTarget = normalizeNameForComparison(firstManifestName);
    const candidate = page.locator('tr, .card, .list-group-item, [role="row"]').filter({
      hasText: new RegExp(escapeRegExp(firstManifestName.split(',')[0]), 'i'),
    });

    const count = await candidate.count();
    for (let index = 0; index < count; index += 1) {
      const row = candidate.nth(index);
      const text = await row.innerText();
      if (normalizeNameForComparison(text).includes(normalizedTarget.split(' ')[0])) {
        const clickable = row.locator('a, button').filter({ hasText: /detail|edit|lihat|pilih|scan|ktp/i }).first();
        if ((await clickable.count()) > 0) {
          await clickable.click();
        } else {
          await row.click();
        }
        await page.waitForTimeout(750);
        return;
      }
    }

    throw new WorkflowError(
      `Could not find manifest customer for ${firstManifestName}`,
      'NEEDS_REVIEW',
      'SELECT_MANIFEST_CUSTOMER',
    );
  }

  private async downloadKtp(page: Page, invoiceNumber: string): Promise<string> {
    await fs.mkdir('tmp/ktp', { recursive: true });
    const filePath = `tmp/ktp/${invoiceNumber.replace(/[^\w.-]+/g, '_')}-ktp`;

    const ktpLink = page.locator('a[href*="ktp" i], a[href*=".jpg" i], a[href*=".jpeg" i], a[href*=".png" i]').first();
    if ((await ktpLink.count()) > 0) {
      const href = await ktpLink.getAttribute('href');
      if (href) {
        const response = await page.request.get(new URL(href, config.WEBSITE_BASE_URL).toString());
        if (!response.ok()) {
          throw new WorkflowError('KTP download request failed', 'DOWNLOAD_FAILED', 'DOWNLOAD_KTP');
        }
        const contentType = response.headers()['content-type'] ?? '';
        const extension = contentType.includes('png') ? '.png' : '.jpg';
        const finalPath = `${filePath}${extension}`;
        await fs.writeFile(finalPath, await response.body());
        return finalPath;
      }
    }

    const ktpImage = page.locator('img[src*="ktp" i], img[src*=".jpg" i], img[src*=".jpeg" i], img[src*=".png" i]').first();
    const src = await ktpImage.getAttribute('src');
    if (!src) {
      throw new WorkflowError('Could not find KTP image/link', 'DOWNLOAD_FAILED', 'DOWNLOAD_KTP');
    }

    const response = await page.request.get(new URL(src, config.WEBSITE_BASE_URL).toString());
    if (!response.ok()) {
      throw new WorkflowError('KTP image download failed', 'DOWNLOAD_FAILED', 'DOWNLOAD_KTP');
    }

    const contentType = response.headers()['content-type'] ?? '';
    const extension = contentType.includes('png') ? '.png' : '.jpg';
    const finalPath = `${filePath}${extension}`;
    await fs.writeFile(finalPath, await response.body());
    return finalPath;
  }

  private async uploadKtp(page: Page, ktpTempPath: string): Promise<void> {
    const input = page.locator('input[type="file"][accept*=".jpg"], input[type="file"][accept*=".jpeg"], input[type="file"][accept*=".png"]').first();
    await input.setInputFiles(ktpTempPath);

    const cropButton = page.getByRole('button', { name: /crop|potong|simpan/i }).first();
    if ((await cropButton.count()) > 0 && (await cropButton.isVisible().catch(() => false))) {
      await cropButton.click();
      await page.waitForTimeout(500);
    }
  }

  private async runDocumentReader(page: Page): Promise<void> {
    const reader = page.getByRole('button', { name: /document reader|mrz/i }).or(page.getByText(/Document Reader \(MRZ\)/i)).first();
    await reader.waitFor({ state: 'visible', timeout: 15000 });
    await reader.click();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(3000);
  }

  private async readDocumentReaderResult(page: Page): Promise<DocumentReaderResult> {
    const fields = await readIdentityFields(page);
    return {
      name: fields['Nama Lengkap'] ?? fields.Name ?? fields.Nama,
      nik: fields['NIK KTP'] ?? fields.NIK,
      birthPlace: fields['Tempat Lahir'],
      birthDate: fields['Tanggal Lahir'],
      address: fields['Alamat sesuai KTP'] ?? fields.Alamat,
      motherName: fields['Nama Ibu Kandung'],
      rawFields: fields,
    };
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('SiteAutomation is not initialized');
    return this.page;
  }
}

async function readIdentityFields(page: Page): Promise<Record<string, string>> {
  const labels = [
    'Nama Lengkap',
    'Name',
    'Nama',
    'NIK KTP',
    'NIK',
    'Tempat Lahir',
    'Tanggal Lahir',
    'Alamat sesuai KTP',
    'Alamat',
    'Nama Ibu Kandung',
  ];

  const result: Record<string, string> = {};
  for (const label of labels) {
    const value = await readFieldByLabel(page, label);
    if (value) result[label] = value;
  }
  return result;
}

async function readFieldByLabel(page: Page, label: string): Promise<string> {
  const byLabel = page.getByLabel(label, { exact: false }).first();
  if ((await byLabel.count()) > 0) {
    const value = await byLabel.inputValue().catch(() => '');
    if (value.trim()) return value.trim();
  }

  const labelLocator = page.locator('label, .form-group, .row, tr').filter({ hasText: new RegExp(escapeRegExp(label), 'i') }).first();
  if ((await labelLocator.count()) === 0) return '';
  const control = labelLocator.locator('input, textarea, select').first();
  if ((await control.count()) === 0) return '';
  return (await control.inputValue().catch(() => '')).trim();
}

async function storageStateIfExists(storageStatePath: string) {
  try {
    await fs.access(storageStatePath);
    return storageStatePath;
  } catch {
    return undefined;
  }
}

async function waitForEnter(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
