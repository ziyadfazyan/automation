import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, Page, BrowserContext, Locator } from '@playwright/test';
import { config } from '../config.js';
import { DocumentReaderResult, SheetRecord } from '../types/record.js';
import { WorkflowError } from '../types/status.js';
import { normalizeInvoiceForSearch, normalizeNameForComparison } from '../utils/normalize.js';

export interface SiteAutomationResult {
  documentReaderResult: DocumentReaderResult;
  ktpTempPath: string;
  invoiceUrl: string;
}

export interface DownloadedDocument {
  path: string;
  name: string;
  mimeType: string;
}

export class SiteAutomation {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private selectedManifestName: string | null = null;

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
    const ktpTempPath = await this.runStep(
      () => this.downloadKtp(page, record.invoiceNumber),
      'DOWNLOAD_FAILED',
      'DOWNLOAD_KTP',
      'KTP download failed',
    );
    await this.runStep(
      () => this.uploadKtp(page, ktpTempPath),
      'DOWNLOAD_FAILED',
      'UPLOAD_KTP',
      'KTP upload failed',
    );
    await this.runStep(
      () => this.runDocumentReader(page),
      'OCR_FAILED',
      'RUN_DOCUMENT_READER',
      'Document Reader failed',
    );
    const documentReaderResult = await this.runStep(
      () => this.readDocumentReaderResult(page),
      'OCR_FAILED',
      'READ_DOCUMENT_READER_RESULT',
      'Document Reader result extraction failed',
    );

    return { documentReaderResult, ktpTempPath, invoiceUrl };
  }

  private async runStep<T>(
    action: () => Promise<T>,
    status: WorkflowError['status'],
    step: WorkflowError['step'],
    message: string,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError(
        error instanceof Error ? `${message}: ${error.message}` : message,
        status,
        step,
        error,
      );
    }
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

  async submitVerifiedKtpAndDownloadDocuments(invoiceUrl: string, invoiceNumber: string): Promise<DownloadedDocument[]> {
    const page = this.requirePage();
    await this.runStep(
      () => this.submitKtpForm(page),
      'SUBMIT_FAILED',
      'SUBMIT_FORM',
      'KTP form submission failed',
    );
    await page.goto(invoiceUrl, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    return this.runStep(
      () => this.downloadRequiredDocuments(page, invoiceUrl, invoiceNumber),
      'DOWNLOAD_FAILED',
      'DOWNLOAD_DOCUMENTS',
      'Required document download failed',
    );
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

    if (!page.url().includes('/invoices/') && href) {
      await page.goto(resolveWebsiteHref(href), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(750);
    }

    return page.url();
  }

  private async submitKtpForm(page: Page): Promise<void> {
    const submitButton = page
      .locator('.modal.show .modal-footer button')
      .filter({ hasText: /kirim|simpan|submit/i })
      .last();
    await submitButton.waitFor({ state: 'visible', timeout: 15000 });
    await submitButton.click();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.locator('.modal.show').waitFor({ state: 'hidden', timeout: 30000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }

  private async downloadRequiredDocuments(page: Page, invoiceUrl: string, invoiceNumber: string): Promise<DownloadedDocument[]> {
    await fs.mkdir('artifacts/documents', { recursive: true });
    const detailUrl = extractInvoiceSlug(invoiceUrl) ? invoiceUrl : await this.openInvoice(page, invoiceNumber);
    const invoiceSlug = extractInvoiceSlug(detailUrl);
    const safeInvoice = invoiceNumber.replace(/[^\w.-]+/g, '_');

    const pengajuanUrl = new URL(`/print/pengajuan-rekening-jamaah/${invoiceSlug}`, config.WEBSITE_BASE_URL).toString();
    const pengajuan = await this.downloadUrl(
      page,
      pengajuanUrl,
      `Document Pengajuan Rekening ${safeInvoice}`,
      'artifacts/documents',
    );

    await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
    const signerLink = page.getByRole('link', { name: /download signer/i }).first();
    await signerLink.waitFor({ state: 'visible', timeout: 30000 });
    const signerHref = await signerLink.getAttribute('href');
    if (!signerHref || signerHref.includes('image-not-found')) {
      throw new WorkflowError('Signature download link is missing', 'DOWNLOAD_FAILED', 'DOWNLOAD_DOCUMENTS');
    }
    const signer = await this.downloadUrl(
      page,
      new URL(signerHref, config.WEBSITE_BASE_URL).toString(),
      `Signature ${safeInvoice}`,
      'artifacts/documents',
    );

    return [pengajuan, signer];
  }

  private async downloadUrl(page: Page, url: string, baseName: string, directory: string): Promise<DownloadedDocument> {
    const response = await page.request.get(url);
    if (!response.ok()) {
      throw new Error(`Download failed for ${url}: HTTP ${response.status()}`);
    }

    const contentType = response.headers()['content-type']?.split(';')[0]?.trim() || 'application/octet-stream';
    const extension = extensionForContentType(contentType, url);
    const fileName = `${baseName}${extension}`;
    const filePath = path.join(directory, fileName);
    await fs.writeFile(filePath, await response.body());

    return { path: filePath, name: fileName, mimeType: contentType };
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
    const searchName = manifestSearchName(firstManifestName);
    const searchInput = page.locator('input[placeholder*="Pencarian"][placeholder*="Nama"], input[placeholder*="search"][placeholder*="name" i]').first();

    if ((await searchInput.count()) > 0) {
      await searchInput.fill(searchName);
    }

    const row = await this.waitForManifestRow(page, firstManifestName);
    if (row) {
      this.selectedManifestName = firstManifestName;
      await row.scrollIntoViewIfNeeded();
      return;
    }

    throw new WorkflowError(
      `Could not find manifest customer for ${firstManifestName}`,
      'NEEDS_REVIEW',
      'SELECT_MANIFEST_CUSTOMER',
    );
  }

  private async waitForManifestRow(page: Page, firstManifestName: string): Promise<Locator | null> {
    const deadline = Date.now() + 60_000;
    let logged = false;
    while (Date.now() < deadline) {
      const row = await this.findManifestRow(page, firstManifestName);
      if (row) return row;
      if (!logged) {
        console.log(`Waiting for manifest search result: ${manifestSearchName(firstManifestName)}`);
        logged = true;
      }
      await page.waitForTimeout(1000);
    }

    return null;
  }

  private async findManifestRow(page: Page, firstManifestName: string): Promise<Locator | null> {
    const normalizedTarget = normalizeNameForComparison(manifestSearchName(firstManifestName));
    const candidates = page.locator('tbody tr').filter({
      hasText: new RegExp(escapeRegExp(manifestSearchName(firstManifestName)), 'i'),
    });

    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const row = candidates.nth(index);
      const text = await row.innerText();
      const isVisible = await row.isVisible().catch(() => false);
      const box = await row.boundingBox().catch(() => null);
      if (isVisible && box && normalizeNameForComparison(text).includes(normalizedTarget)) {
        return row;
      }
    }

    return null;
  }

  private async downloadKtp(page: Page, invoiceNumber: string): Promise<string> {
    await fs.mkdir('tmp/ktp', { recursive: true });
    const filePath = `tmp/ktp/${invoiceNumber.replace(/[^\w.-]+/g, '_')}-ktp`;
    const scope = await this.openScanKtpEditor(page);

    const ktpLink = scope.locator('a[href*="ktp" i], a[href*=".jpg" i], a[href*=".jpeg" i], a[href*=".png" i]').first();
    if ((await ktpLink.count()) > 0) {
      const href = await ktpLink.getAttribute('href', { timeout: 2000 }).catch(() => null);
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

    const ktpImage = scope.locator('img[alt="thumbnail"], img[src*="ktp" i], img[src*=".jpg" i], img[src*=".jpeg" i], img[src*=".png" i]').first();
    const src = await ktpImage.getAttribute('src', { timeout: 5000 }).catch(() => null);
    if (!src || src.includes('default-placeholder')) {
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
    await this.openScanKtpEditor(page);

    const input = page.locator('input[type="file"][accept*=".jpg"], input[type="file"][accept*=".jpeg"], input[type="file"][accept*=".png"]').first();
    await input.setInputFiles(ktpTempPath);

    await this.setFullKtpCrop(page);

    const cropButton = page.getByRole('button', { name: /crop|potong|simpan/i }).first();
    if ((await cropButton.count()) > 0 && (await cropButton.isVisible().catch(() => false))) {
      await cropButton.click();
      await page.waitForTimeout(500);
    }
  }

  private async setFullKtpCrop(page: Page): Promise<void> {
    await page.locator('.cropper-container').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.evaluate(() => {
      const image = document.querySelector('.modal.show .cropper-hidden, .cropper-hidden') as HTMLImageElement | null;
      const cropper = image && (image as HTMLImageElement & { cropper?: {
        getCanvasData: () => { left: number; top: number; width: number; height: number };
        setCropBoxData: (data: { left: number; top: number; width: number; height: number }) => void;
      } }).cropper;

      if (!cropper) return;
      const canvas = cropper.getCanvasData();
      cropper.setCropBoxData({
        left: canvas.left,
        top: canvas.top,
        width: canvas.width,
        height: canvas.height,
      });
    });
  }

  private async openScanKtpEditor(page: Page): Promise<Locator> {
    if (!this.selectedManifestName) {
      throw new WorkflowError('Manifest customer has not been selected', 'NEEDS_REVIEW', 'SELECT_MANIFEST_CUSTOMER');
    }

    const row = await this.findManifestRow(page, this.selectedManifestName);
    if (!row) {
      throw new WorkflowError(
        `Could not find selected manifest row for ${this.selectedManifestName}`,
        'NEEDS_REVIEW',
        'SELECT_MANIFEST_CUSTOMER',
      );
    }

    const scanDocumentCell = row.locator('td').filter({ hasText: /Scan\s*KTP/i }).first();
    const openInput = scanDocumentCell.locator('input[type="file"]').first();
    const openThumbnail = scanDocumentCell.locator('img[alt="thumbnail"], .custom-file-label, .form-file-text').first();
    if ((await openInput.count()) > 0 || (await openThumbnail.count()) > 0) {
      return scanDocumentCell;
    }

    const scanKtpText = scanDocumentCell.getByText(/Scan\s*KTP/i).first();
    await scanKtpText.waitFor({ state: 'visible', timeout: 10000 });
    await scanKtpText.hover();

    const pencilButton = scanDocumentCell.locator('button').filter({ has: scanDocumentCell.locator('i.simple-icon-pencil') }).first();
    if ((await pencilButton.count()) > 0) {
      await pencilButton.click();
    } else {
      await scanKtpText.click();
    }

    await openInput.waitFor({ state: 'attached', timeout: 10000 });
    await page.waitForTimeout(500);

    return scanDocumentCell;
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
  const visibleModal = page.locator('.modal.show, .modal[style*="display: block"]').last();
  const scope = (await visibleModal.count()) > 0 ? visibleModal : page.locator('body');
  const labelsByField: Record<string, RegExp[]> = {
    'Nama Lengkap': [/nama.*vaksin/i, /^nama$/i, /nama lengkap/i],
    'NIK KTP': [/no.*identitas/i, /\bnik\b/i, /id number/i],
    'Tempat Lahir': [/tempat lahir/i, /place of birth/i],
    'Tanggal Lahir': [/tanggal lahir/i, /date of birth/i],
    'Alamat sesuai KTP': [/^alamat$/i, /address/i],
    'Nama Ibu Kandung': [/nama ibu/i, /mother/i],
  };

  const result: Record<string, string> = {};
  for (const [field, patterns] of Object.entries(labelsByField)) {
    const value = await readFieldByPatterns(scope, patterns);
    if (value) result[field] = value;
  }
  return result;
}

async function readFieldByPatterns(scope: Locator, patterns: RegExp[]): Promise<string> {
  for (const pattern of patterns) {
    const formGroup = scope.locator('.form-group').filter({ hasText: pattern }).first();
    if ((await formGroup.count()) > 0) {
      const input = formGroup.locator('input, textarea').first();
      const value = await input.inputValue({ timeout: 1000 }).catch(() => '');
      if (value.trim()) return value.trim();
    }
  }

  return '';
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

function manifestSearchName(firstManifestName: string): string {
  return firstManifestName.split(',')[0]?.trim() || firstManifestName.trim();
}

function extractInvoiceSlug(invoiceUrl: string): string {
  const match = invoiceUrl.match(/\/invoices\/([^/?#]+)/);
  return match?.[1] ?? '';
}

function resolveWebsiteHref(href: string): string {
  if (href.startsWith('http')) return href;
  if (href.startsWith('#')) return `${config.WEBSITE_BASE_URL}/app_v2/${href}`;
  return new URL(href, config.WEBSITE_BASE_URL).toString();
}

function extensionForContentType(contentType: string, url: string): string {
  if (contentType.includes('pdf')) return '.pdf';
  if (contentType.includes('svg')) return '.svg';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('html')) return '.html';

  const pathName = new URL(url).pathname;
  const extension = path.extname(pathName);
  return extension || '.bin';
}
