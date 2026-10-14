import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, Page, BrowserContext, Locator } from '@playwright/test';
import { config } from '../config.js';
import { DocumentReaderResult, SheetRecord } from '../types/record.js';
import { WorkflowError } from '../types/status.js';
import { normalizeInvoiceForSearch, normalizeNameForComparison } from '../utils/normalize.js';
import { resolveWebsiteSite, WebsiteSiteConfig } from '../utils/siteConfig.js';

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

interface InvoiceApiItem {
  number?: unknown;
  profiles?: ProfileApiItem[];
  bookings?: Array<{ profile?: ProfileApiItem | null }>;
}

interface ProfileApiItem {
  name?: unknown;
  no_ktp?: unknown;
  place_of_birth?: unknown;
  date_of_birth?: unknown;
  address?: unknown;
  kelurahan?: unknown;
  mothers_name?: unknown;
  gender?: unknown;
  marriage?: unknown;
  job?: unknown;
  education?: unknown;
  district?: { name?: unknown } | string | null;
}

export class SiteAutomation {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private siteConfig: WebsiteSiteConfig = resolveWebsiteSite();
  private selectedManifestName: string | null = null;
  private selectedInvoiceNumber: string | null = null;

  async initialize(site?: string): Promise<void> {
    this.siteConfig = resolveWebsiteSite(site);
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
    await page.goto(this.siteConfig.invoicesUrl, { waitUntil: 'domcontentloaded' });
    console.log('Log in manually if prompted. Press Enter here after Website A is authenticated.');
    await waitForEnter();
    await this.context?.storageState({ path: config.PLAYWRIGHT_STORAGE_STATE });
  }

  async processToVerification(record: SheetRecord): Promise<SiteAutomationResult> {
    const page = this.requirePage();
    const invoiceUrl = await this.openInvoice(page, record.invoiceNumber);
    await this.openTourPack(page);
    await this.openManifestTab(page);
    await this.selectManifestCustomer(page, record.firstManifestName, record.invoiceNumber);
    const systemFields = await this.runStep(
      () => fetchSystemFieldsFromApi(page, record),
      'NEEDS_REVIEW',
      'READ_SYSTEM_FORM_FIELDS',
      'System/Rails DB field extraction failed',
    );
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
    const scannedFields = { ...documentReaderResult.rawFields };
    const systemMotherName = systemFields['Nama Ibu Kandung']?.trim() || '';
    const scannedMotherName = documentReaderResult.motherName?.trim() ?? '';
    if (systemMotherName) {
      await this.runStep(
        () => setIdentityField(page, [/nama ibu/i, /mother/i], systemMotherName),
        'OCR_FAILED',
        'RESTORE_SYSTEM_MOTHER_NAME',
        'System mother name restore failed',
      );
      documentReaderResult.motherName = systemMotherName;
    }
    documentReaderResult.systemMotherName = systemMotherName;
    documentReaderResult.scannedMotherName = scannedMotherName;
    documentReaderResult.systemFields = {
      ...systemFields,
      'Nama Ibu Kandung': systemMotherName || systemFields['Nama Ibu Kandung'] || '',
    };
    documentReaderResult.scannedFields = {
      ...scannedFields,
      'Nama Ibu Kandung': scannedMotherName,
    };
    documentReaderResult.rawFields = {
      ...documentReaderResult.rawFields,
      'Nama Ibu Kandung Sistem': systemMotherName,
      'Nama Ibu Kandung Scan': scannedMotherName,
      'Nama Ibu Kandung': documentReaderResult.motherName ?? '',
    };

    return { documentReaderResult, ktpTempPath, invoiceUrl };
  }

  async applyIdentityCorrections(document: DocumentReaderResult, record: SheetRecord): Promise<DocumentReaderResult> {
    const page = this.requirePage();
    const corrected: DocumentReaderResult = {
      ...document,
      name: document.ktpVision?.name || record.fullName || record.firstManifestName,
      nik: document.ktpVision?.nik || record.nik,
      birthPlace: document.ktpVision?.birthPlace || record.birthPlace,
      birthDate: document.ktpVision?.birthDate || record.birthDate,
      address: document.ktpVision?.address || record.ktpAddress,
      motherName: document.systemMotherName || document.motherName || record.motherName,
    };
    const current = {
      name: document.rawFields?.['Nama Lengkap'] ?? document.name ?? '',
      nik: document.rawFields?.['NIK KTP'] ?? document.nik ?? '',
      birthPlace: document.rawFields?.['Tempat Lahir'] ?? document.birthPlace ?? '',
      birthDate: document.rawFields?.['Tanggal Lahir'] ?? document.birthDate ?? '',
      address: document.rawFields?.['Alamat sesuai KTP'] ?? document.address ?? '',
      rtRw: document.rawFields?.['RT/RW'] ?? '',
      kelurahan: document.rawFields?.Kelurahan ?? '',
      kecamatan: document.rawFields?.Kecamatan ?? '',
      motherName: document.rawFields?.['Nama Ibu Kandung'] ?? document.motherName ?? '',
      gender: document.rawFields?.['Jenis Kelamin'] ?? '',
      marriageStatus: document.rawFields?.['Status Pernikahan'] ?? '',
      job: document.rawFields?.Pekerjaan ?? '',
      education: document.rawFields?.Pendidikan ?? '',
    };
    const gender = normalizeGender(document.ktpVision?.gender);
    const marriageStatus = normalizeMarriage(document.ktpVision?.marriageStatus);
    const job = dropdownJobFromKtp(document.ktpVision?.job);
    const education = normalizeEducation(document.ktpVision?.education);
    const district = document.ktpVision?.kecamatan || '';

    if (shouldSetText(current.name, corrected.name)) await setIdentityField(page, [/nama.*vaksin/i, /nama ktp/i, /^nama$/i], corrected.name ?? '');
    if (shouldSetText(current.nik, corrected.nik)) await setIdentityField(page, [/\bnik\b/i, /id number/i], corrected.nik ?? '');
    if (shouldSetText(current.birthPlace, corrected.birthPlace)) await setIdentityField(page, [/tempat lahir/i, /place of birth/i], corrected.birthPlace ?? '');
    if (shouldSetDate(current.birthDate, corrected.birthDate)) await setVueDateField(page, [/tanggal lahir/i, /date of birth/i], corrected.birthDate ?? '');
    if (shouldSetAddress(current.address, corrected.address)) await setIdentityField(page, [/^alamat$/i, /address/i], corrected.address ?? '');
    if (document.ktpVision?.rtRw && shouldSetRtRw(current.rtRw, document.ktpVision.rtRw)) {
      await setIdentityField(page, [/rt\s*\/?\s*rw/i], document.ktpVision.rtRw);
    }
    if (document.ktpVision?.kelurahan && shouldSetText(current.kelurahan, document.ktpVision.kelurahan)) {
      await setIdentityField(page, [/kelurahan/i, /village/i], document.ktpVision.kelurahan);
    }
    if (district && shouldSetDistrict(current.kecamatan, district, document.ktpVision?.kabupatenKota ?? '')) {
      await setSelectField(page, [/kecamatan/i, /district/i], district);
    }
    if (corrected.motherName && shouldSetText(current.motherName, corrected.motherName)) {
      await setIdentityField(page, [/nama ibu/i, /mother/i], corrected.motherName);
    }
    if (shouldSetDropdown(current.gender, gender, normalizeGender)) await setSelectField(page, [/jenis kelamin/i, /gender/i], gender);
    if (shouldSetDropdown(current.marriageStatus, marriageStatus, normalizeMarriage)) {
      await setSelectField(page, [/status pernikahan/i, /status perkawinan/i, /marriage/i], marriageStatus);
    }
    if (shouldSetJob(current.job, job)) await setSelectField(page, [/pekerjaan/i, /job/i], job);
    if (shouldSetDropdown(current.education, education, normalizeEducation)) await setSelectField(page, [/pendidikan/i, /graduate/i, /education/i], education);

    await page.waitForTimeout(500);
    return mergeCurrentIdentity(corrected, await readIdentityFields(page));
  }

  async readCurrentFormIdentity(): Promise<DocumentReaderResult> {
    const page = this.requirePage();
    return mergeCurrentIdentity({}, await readIdentityFields(page));
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

  async submitVerifiedKtpAndDownloadDocuments(invoiceUrl: string, invoiceNumber: string, displayName: string): Promise<DownloadedDocument[]> {
    const page = this.requirePage();
    await this.runStep(
      () => this.submitKtpForm(page),
      'SUBMIT_FAILED',
      'SUBMIT_FORM',
      'KTP form submission failed',
    );
    await page.goto(invoiceUrl, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(5000);
    return this.runStep(
      () => this.downloadRequiredDocuments(page, invoiceUrl, invoiceNumber, displayName),
      'DOWNLOAD_FAILED',
      'DOWNLOAD_DOCUMENTS',
      'Required document download failed',
    );
  }

  private async openInvoice(page: Page, invoiceNumber: string): Promise<string> {
    await page.goto(this.siteConfig.invoicesUrl, { waitUntil: 'domcontentloaded' });
    const searchValue = normalizeInvoiceForSearch(invoiceNumber);
    await searchInvoice(page, searchValue);

    const invoiceLink = await findExactInvoiceLink(page, searchValue);

    await invoiceLink.waitFor({ state: 'visible', timeout: 15000 });
    const href = await invoiceLink.getAttribute('href');
    await invoiceLink.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(750);

    if (!page.url().includes('/invoices/') && href) {
      await page.goto(resolveWebsiteHref(href, this.siteConfig.baseUrl), { waitUntil: 'domcontentloaded' });
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
    await Promise.race([
      page.getByText(/data berhasil disimpan|berhasil|data has been saved|success/i).first().waitFor({ state: 'visible', timeout: 30000 }),
      page.locator('.modal.show').waitFor({ state: 'hidden', timeout: 30000 }),
    ]);
    await page.waitForTimeout(1500);
  }

  private async downloadRequiredDocuments(page: Page, invoiceUrl: string, invoiceNumber: string, displayName: string): Promise<DownloadedDocument[]> {
    await fs.mkdir('artifacts/documents', { recursive: true });
    const detailUrl = extractInvoiceSlug(invoiceUrl) ? invoiceUrl : await this.openInvoice(page, invoiceNumber);
    const invoiceSlug = extractInvoiceSlug(detailUrl);
    const safeInvoice = invoiceNumber.replace(/[^\w.-]+/g, '_');
    const safeName = displayName.replace(/[^\w.-]+/g, '_');

    const pengajuanUrl = new URL(`/print/pengajuan-rekening-jamaah/${invoiceSlug}`, this.siteConfig.baseUrl).toString();
    const pengajuan = await this.downloadUrl(
      page,
      pengajuanUrl,
      `Document Pengajuan Rekening ${safeName} ${safeInvoice}`,
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
      new URL(signerHref, this.siteConfig.baseUrl).toString(),
      `Signature ${safeName} ${safeInvoice}`,
      'artifacts/documents',
    );

    const documents = [pengajuan, signer];
    const parafLink = page.getByRole('link', { name: /download paraf/i }).first();
    if (await parafLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      const parafHref = await parafLink.getAttribute('href');
      if (parafHref && !parafHref.includes('image-not-found')) {
        documents.push(await this.downloadUrl(
          page,
          new URL(parafHref, this.siteConfig.baseUrl).toString(),
          `Paraf ${safeName} ${safeInvoice}`,
          'artifacts/documents',
        ));
      }
    }

    return documents;
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

  private async selectManifestCustomer(page: Page, firstManifestName: string, invoiceNumber: string): Promise<void> {
    const searchName = manifestSearchName(firstManifestName);
    const searchInput = page.locator('input[placeholder*="Pencarian"][placeholder*="Nama"], input[placeholder*="search"][placeholder*="name" i]').first();

    if ((await searchInput.count()) > 0) {
      await searchInput.fill(searchName);
    }

    const row = await this.waitForManifestRow(page, firstManifestName, invoiceNumber);
    if (row) {
      this.selectedManifestName = firstManifestName;
      this.selectedInvoiceNumber = invoiceNumber;
      await row.scrollIntoViewIfNeeded();
      return;
    }

    throw new WorkflowError(
      `Could not find manifest customer for ${firstManifestName}`,
      'NEEDS_REVIEW',
      'SELECT_MANIFEST_CUSTOMER',
    );
  }

  private async waitForManifestRow(page: Page, firstManifestName: string, invoiceNumber: string): Promise<Locator | null> {
    const deadline = Date.now() + 60_000;
    let logged = false;
    while (Date.now() < deadline) {
      await scrollManifestInvoiceIntoView(page, invoiceNumber);
      const row = await this.findManifestRow(page, firstManifestName, invoiceNumber);
      if (row) return row;
      if (!logged) {
        console.log(`Waiting for manifest search result: ${invoiceNumber} ${manifestSearchName(firstManifestName)}`);
        logged = true;
      }
      await page.mouse.wheel(0, 900).catch(() => undefined);
      await page.waitForTimeout(1000);
    }

    return null;
  }

  private async findManifestRow(page: Page, firstManifestName: string, invoiceNumber: string): Promise<Locator | null> {
    const normalizedTarget = normalizeNameForComparison(manifestSearchName(firstManifestName));
    const invoiceGroup = await findManifestInvoiceGroup(page, invoiceNumber);
    if (invoiceGroup) {
      const rows = invoiceGroup.locator('tbody tr').filter({
        hasText: new RegExp(escapeRegExp(manifestSearchName(firstManifestName)), 'i'),
      });
      const rowCount = await rows.count();
      for (let index = 0; index < rowCount; index += 1) {
        const row = rows.nth(index);
        const text = await row.innerText();
        const isVisible = await row.isVisible().catch(() => false);
        const box = await row.boundingBox().catch(() => null);
        if (isVisible && box && normalizeNameForComparison(text).includes(normalizedTarget)) {
          return row;
        }
      }
    }

    const candidates = page.locator('tbody tr').filter({
      hasText: new RegExp(escapeRegExp(manifestSearchName(firstManifestName)), 'i'),
    });
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const row = candidates.nth(index);
      const text = await row.innerText();
      const isVisible = await row.isVisible().catch(() => false);
      const box = await row.boundingBox().catch(() => null);
      const isCurrentInvoice = await rowBelongsToInvoice(row, invoiceNumber);
      if (isVisible && box && isCurrentInvoice && normalizeNameForComparison(text).includes(normalizedTarget)) {
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
        const response = await page.request.get(new URL(href, this.siteConfig.baseUrl).toString());
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

    const response = await page.request.get(new URL(src, this.siteConfig.baseUrl).toString());
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
    await page.evaluate(`(() => {
      const image = document.querySelector('.modal.show .cropper-hidden, .cropper-hidden');
      const cropper = image && image.cropper;

      if (!cropper) return;
      const canvas = cropper.getCanvasData();
      cropper.setCropBoxData({
        left: canvas.left,
        top: canvas.top,
        width: canvas.width,
        height: canvas.height,
      });
    })()`);
  }

  private async openScanKtpEditor(page: Page): Promise<Locator> {
    if (!this.selectedManifestName || !this.selectedInvoiceNumber) {
      throw new WorkflowError('Manifest customer has not been selected', 'NEEDS_REVIEW', 'SELECT_MANIFEST_CUSTOMER');
    }

    const row = await this.findManifestRow(page, this.selectedManifestName, this.selectedInvoiceNumber);
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
    await waitForDocumentReaderFields(page, 30000);
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
  const scope = await getVisibleFormScope(page);
  const labelsByField: Record<string, RegExp[]> = {
    'Nama Lengkap': [/nama.*vaksin/i, /nama ktp/i, /^nama$/i, /nama lengkap/i],
    'NIK KTP': [/no.*identitas/i, /\bnik\b/i, /id number/i],
    'Tempat Lahir': [/tempat lahir/i, /place of birth/i],
    'Tanggal Lahir': [/tanggal lahir/i, /date of birth/i],
    'Alamat sesuai KTP': [/^alamat$/i, /address/i],
    'RT/RW': [/rt\s*\/?\s*rw/i],
    Kecamatan: [/kecamatan/i, /district/i],
    Kelurahan: [/kelurahan/i, /village/i],
    'Nama Ibu Kandung': [/nama ibu/i, /mother/i],
    'Jenis Kelamin': [/jenis kelamin/i, /gender/i],
    'Status Pernikahan': [/status pernikahan/i, /status perkawinan/i, /marriage/i],
    Pekerjaan: [/pekerjaan/i, /job/i],
    Pendidikan: [/pendidikan/i, /graduate/i, /education/i],
  };

  const result: Record<string, string> = {};
  for (const [field, patterns] of Object.entries(labelsByField)) {
    const value = await readFieldByPatterns(scope, patterns);
    if (value) result[field] = value;
  }
  result['Nama Lengkap'] ||= await readInputByPlaceholder(scope, [/nama ktp/i, /nama.*vaksin/i]);
  result['NIK KTP'] ||= await readInputByPlaceholder(scope, [/^nik$/i]);
  result['Tempat Lahir'] ||= await readInputByPlaceholder(scope, [/tempat lahir/i]);
  result['Tanggal Lahir'] ||= await readInputByPlaceholder(scope, [/tanggal lahir/i]);
  result['Alamat sesuai KTP'] ||= await readInputByPlaceholder(scope, [/^alamat$/i]);
  result['RT/RW'] = await readInputByPlaceholder(scope, [/rt\s*\/?\s*rw/i]) || result['RT/RW'] || '';
  result.Kecamatan ||= await readSelectByLabel(scope, [/kecamatan/i, /district/i]);
  result.Kelurahan ||= await readInputByPlaceholder(scope, [/kelurahan/i, /village/i]);
  result['Nama Ibu Kandung'] ||= await readInputByPlaceholder(scope, [/nama ibu/i]);
  result['Jenis Kelamin'] ||= await readSelectByLabel(scope, [/jenis kelamin/i, /gender/i]);
  result['Status Pernikahan'] ||= await readSelectByLabel(scope, [/status pernikahan/i, /status perkawinan/i, /marriage/i]);
  result.Pekerjaan ||= await readSelectByLabel(scope, [/pekerjaan/i, /job/i]);
  result.Pendidikan ||= await readSelectByLabel(scope, [/pendidikan/i, /graduate/i, /education/i]);
  return result;
}

function mergeCurrentIdentity(document: DocumentReaderResult, fields: Record<string, string>): DocumentReaderResult {
  return {
    ...document,
    name: fields['Nama Lengkap'] ?? fields.Name ?? fields.Nama ?? document.name,
    nik: fields['NIK KTP'] ?? fields.NIK ?? document.nik,
    birthPlace: fields['Tempat Lahir'] ?? document.birthPlace,
    birthDate: fields['Tanggal Lahir'] ?? document.birthDate,
    address: fields['Alamat sesuai KTP'] ?? fields.Alamat ?? document.address,
    motherName: fields['Nama Ibu Kandung'] ?? document.motherName,
    rawFields: {
      ...document.rawFields,
      ...fields,
    },
  };
}

async function fetchSystemFieldsFromApi(page: Page, record: SheetRecord): Promise<Record<string, string>> {
  const token = await readWebsiteAuthTokenFromPage(page);
  const site = resolveWebsiteSite(record.site);
  const url = new URL('/admin_api/invoices', site.baseUrl);
  url.searchParams.set('per_page', '10');
  url.searchParams.set('search[invoice_number]', normalizeInvoiceForSearch(record.invoiceNumber));
  url.searchParams.set('include_profiles', '1');

  const response = await page.request.get(url.toString(), {
    headers: {
      Accept: 'application/json',
      Authorization: `Token token=${token}`,
    },
  });
  const text = await response.text();
  if (!response.ok()) throw new Error(`API ${url.pathname} returned HTTP ${response.status()}: ${text.slice(0, 300)}`);

  const body = JSON.parse(text) as { data?: InvoiceApiItem[] };
  const targetInvoice = normalizeInvoiceForSearch(record.invoiceNumber).toUpperCase();
  const targetName = normalizeNameForComparison(record.firstManifestName);
  const exactInvoices = (body.data ?? []).filter((item) => normalizeInvoiceForSearch(apiText(item.number)).toUpperCase() === targetInvoice);
  const invoice = exactInvoices.find((item) => {
    const profiles = [
      ...(Array.isArray(item.profiles) ? item.profiles : []),
      ...(Array.isArray(item.bookings) ? item.bookings.map((booking) => booking.profile).filter(Boolean) as ProfileApiItem[] : []),
    ];
    return profiles.some((profile) => {
      const profileName = normalizeNameForComparison(apiText(profile.name));
      return profileName === targetName || profileName.includes(targetName) || targetName.includes(profileName);
    });
  }) ?? exactInvoices[0];
  if (!invoice) throw new Error(`Could not find invoice ${record.invoiceNumber} from API`);

  const profiles = [
    ...(Array.isArray(invoice.profiles) ? invoice.profiles : []),
    ...(Array.isArray(invoice.bookings) ? invoice.bookings.map((booking) => booking.profile).filter(Boolean) as ProfileApiItem[] : []),
  ];
  const profile = profiles.find((item) => {
    const profileName = normalizeNameForComparison(apiText(item.name));
    return profileName === targetName || profileName.includes(targetName) || targetName.includes(profileName);
  }) ?? (profiles.length === 1 ? profiles[0] : undefined);
  if (!profile) throw new Error(`Could not find profile ${record.firstManifestName} from API invoice ${record.invoiceNumber}`);

  const district = typeof profile.district === 'string' ? profile.district.trim() : apiText(profile.district?.name);
  return {
    'Nama Lengkap': apiText(profile.name),
    'NIK KTP': apiText(profile.no_ktp),
    'Tempat Lahir': apiText(profile.place_of_birth),
    'Tanggal Lahir': apiDate(profile.date_of_birth),
    'Alamat sesuai KTP': apiText(profile.address),
    'RT/RW': '',
    Kelurahan: apiText(profile.kelurahan),
    Kecamatan: district,
    'Nama Ibu Kandung': apiText(profile.mothers_name),
    'Jenis Kelamin': normalizeGender(apiText(profile.gender)),
    Pekerjaan: dropdownJobFromKtp(apiText(profile.job)),
    'Status Pernikahan': normalizeMarriage(apiText(profile.marriage)),
    Pendidikan: normalizeEducation(apiText(profile.education)),
  };
}

async function readWebsiteAuthTokenFromPage(page: Page): Promise<string> {
  const state = await page.context().storageState();
  for (const origin of state.origins ?? []) {
    const storage = origin.localStorage ?? [];
    const directToken = storage.find((item) => item.name === 'auth_token' || item.name === 'jwt')?.value;
    if (directToken) return directToken;

    const credential = storage.find((item) => item.name === 'currentCredential')?.value;
    if (!credential) continue;
    const parsed = JSON.parse(credential) as { auth_token?: unknown; jwt?: unknown };
    const token = typeof parsed.auth_token === 'string' ? parsed.auth_token : typeof parsed.jwt === 'string' ? parsed.jwt : '';
    if (token) return token;
  }

  throw new Error('Could not read Website A auth token from authenticated browser session');
}

function apiDate(value: unknown): string {
  const raw = apiText(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  return raw;
}

function apiText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

async function searchInvoice(page: Page, searchValue: string): Promise<void> {
  const searchInput = page.locator('input[placeholder="Pencarian"]').first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await searchInput.fill('');
    await page.waitForTimeout(300);
    await searchInput.fill(searchValue);
    await page.keyboard.press('Enter').catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(1500);

    const invoiceRows = await page.locator('tbody tr').filter({ hasText: /#?\s*TAB\s*-?\s*\d+/i }).count().catch(() => 0);
    if (invoiceRows > 0) return;

    const clearButton = page.getByRole('button', { name: /^clear$/i }).first();
    if ((await clearButton.count()) > 0 && (await clearButton.isVisible().catch(() => false))) {
      await clearButton.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
}

async function findExactInvoiceLink(page: Page, searchValue: string): Promise<Locator> {
  const links = page.locator('a:visible');
  const count = await links.count();
  const target = looseText(searchValue);

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    const text = await link.innerText().catch(() => '');
    const candidate = looseText(text);
    if (!candidate.includes('TAB')) continue;
    if (candidate === target) return link;
  }

  throw new Error(`Could not find invoice link for ${searchValue}`);
}

function looseText(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

async function rowBelongsToInvoice(row: Locator, invoiceNumber: string): Promise<boolean> {
  const normalizedInvoice = normalizeInvoiceForSearch(invoiceNumber).toUpperCase();
  return row.evaluate((element, targetInvoice) => {
    const normalizeInvoice = (value: string): string => value.replace(/^#/, '').trim().toUpperCase();
    let current: Element | null = element;
    while (current) {
      const headings = Array.from(current.querySelectorAll('h5'));
      if (headings.length > 0 && current.querySelector('tbody')) {
        return headings.some((heading) => normalizeInvoice(heading.textContent ?? '') === targetInvoice);
      }
      current = current.parentElement;
    }
    return false;
  }, normalizedInvoice).catch(() => false);
}

async function findManifestInvoiceGroup(page: Page, invoiceNumber: string): Promise<Locator | null> {
  const normalizedInvoice = normalizeInvoiceForSearch(invoiceNumber).toUpperCase();
  const headings = page.locator('h5');
  const count = await headings.count();
  for (let index = 0; index < count; index += 1) {
    const heading = headings.nth(index);
    const text = normalizeInvoiceForSearch((await heading.innerText().catch(() => '')).trim()).toUpperCase();
    if (text !== normalizedInvoice) continue;

    await heading.scrollIntoViewIfNeeded().catch(() => undefined);
    const group = heading.locator('xpath=ancestor::*[.//tbody][1]');
    if ((await group.count()) === 0) continue;

    const visibleRows = await group.locator('tbody tr:visible').count().catch(() => 0);
    if (visibleRows === 0) {
      const toggleButton = heading.locator('xpath=ancestor::*[contains(@class, "row")][1]').locator('button').first();
      if ((await toggleButton.count()) > 0 && (await toggleButton.isVisible().catch(() => false))) {
        await toggleButton.click().catch(() => undefined);
        await page.waitForTimeout(500);
      }
    }

    return group;
  }

  return null;
}

async function scrollManifestInvoiceIntoView(page: Page, invoiceNumber: string): Promise<void> {
  const group = await findManifestInvoiceGroup(page, invoiceNumber);
  if (group) return;

  await page.mouse.wheel(0, 1200).catch(() => undefined);
  await page.waitForTimeout(300);
}

async function getVisibleFormScope(page: Page): Promise<Locator> {
  const visibleModal = page.locator('.modal.show, .modal[style*="display: block"]').last();
  if ((await visibleModal.count()) > 0 && (await visibleModal.isVisible().catch(() => false))) {
    return visibleModal;
  }

  return page.locator('body');
}

async function readFieldByPatterns(scope: Locator, patterns: RegExp[]): Promise<string> {
  for (const pattern of patterns) {
    const formGroups = scope.locator('.form-group').filter({ hasText: pattern });
    const count = await formGroups.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const formGroup = formGroups.nth(index);
      if (!(await formGroup.isVisible().catch(() => false))) continue;

      const input = formGroup.locator('input, textarea').first();
      if (!(await input.isVisible().catch(() => false))) continue;

      const value = await input.inputValue({ timeout: 1000 }).catch(() => '');
      if (value.trim()) return value.trim();
    }
  }

  return '';
}

async function readInputByPlaceholder(scope: Locator, patterns: RegExp[]): Promise<string> {
  const inputs = scope.locator('input, textarea');
  const count = await inputs.count();
  for (const pattern of patterns) {
    for (let index = count - 1; index >= 0; index -= 1) {
      const input = inputs.nth(index);
      if (!(await input.isVisible().catch(() => false))) continue;

      const placeholder = await input.getAttribute('placeholder').catch(() => '');
      if (!placeholder || !pattern.test(placeholder)) continue;

      const value = await input.inputValue({ timeout: 1000 }).catch(() => '');
      if (value.trim()) return value.trim();
    }
  }

  return '';
}

async function readSelectByLabel(scope: Locator, patterns: RegExp[]): Promise<string> {
  for (const pattern of patterns) {
    const formGroups = scope.locator('.form-group').filter({ hasText: pattern });
    const count = await formGroups.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const formGroup = formGroups.nth(index);
      if (!(await formGroup.isVisible().catch(() => false))) continue;

      const value = await formGroup.locator('.vs__selected').first().innerText({ timeout: 1000 }).catch(() => '');
      if (value.trim()) return value.trim();
    }
  }

  return '';
}

async function waitForDocumentReaderFields(page: Page, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const fields = await readIdentityFields(page);
    if (fields['Nama Lengkap'] || fields['NIK KTP'] || fields['Tempat Lahir'] || fields['Alamat sesuai KTP']) {
      return;
    }
    await page.waitForTimeout(750);
  }
}

async function setIdentityField(page: Page, patterns: RegExp[], value: string): Promise<void> {
  if (!value) return;
  const scope = await getVisibleFormScope(page);
  for (const pattern of patterns) {
    const formGroups = scope.locator('.form-group').filter({ hasText: pattern });
    const count = await formGroups.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const formGroup = formGroups.nth(index);
      await formGroup.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(150);
      if (!(await formGroup.isVisible().catch(() => false))) continue;

      const input = formGroup.locator('input, textarea').first();
      if ((await input.count()) === 0 || !(await input.isVisible().catch(() => false))) continue;

      await input.fill(value);
      return;
    }
  }

  throw new Error('Could not find identity field');
}

async function setVueDateField(page: Page, patterns: RegExp[], value: string): Promise<void> {
  if (!value) return;
  const scope = await getVisibleFormScope(page);
  for (const pattern of patterns) {
    const formGroups = scope.locator('.form-group').filter({ hasText: pattern });
    const count = await formGroups.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const formGroup = formGroups.nth(index);
      await formGroup.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(250);
      if (!(await formGroup.isVisible().catch(() => false))) continue;

      const input = formGroup.locator('input').first();
      if ((await input.count()) > 0 && (await input.isVisible().catch(() => false))) {
        await selectDateWithDatepicker(page, input, value);
        return;
      }
    }
  }

  throw new Error('Could not find datepicker field');
}

async function selectDateWithDatepicker(page: Page, input: Locator, value: string): Promise<void> {
  const target = parseDateParts(value);
  if (!target) throw new Error(`Invalid date value for datepicker: ${value}`);

  await input.click();
  const popover = page.locator('.vc-popover-content:visible').last();
  await popover.waitFor({ state: 'visible', timeout: 5000 });

  await popover.locator('.vc-title').first().click();
  const nav = page.locator('.vc-nav-container:visible').last();
  await nav.waitFor({ state: 'visible', timeout: 5000 });

  await openYearPicker(nav, target.year);
  await clickYear(nav, target.year);
  await clickMonth(nav, target.year, target.month);
  await clickDay(popover, target.day);

  await page.waitForTimeout(400);
  await input.press('Tab').catch(() => undefined);
}

async function openYearPicker(nav: Locator, year: number): Promise<void> {
  if ((await nav.locator(`.vc-nav-item[data-id="${year}"]:visible`).count().catch(() => 0)) > 0) return;
  await nav.locator('.vc-nav-title').first().click();
  await nav.locator('.vc-nav-item:visible').first().waitFor({ state: 'visible', timeout: 3000 });
}

async function clickYear(nav: Locator, year: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const yearItem = nav.locator(`.vc-nav-item[data-id="${year}"]:visible:not(.is-disabled)`).first();
    if ((await yearItem.count().catch(() => 0)) > 0) {
      await yearItem.click();
      return;
    }

    const visibleYears = await nav.locator('.vc-nav-item:visible').evaluateAll((items) =>
      items
        .map((item) => Number(item.getAttribute('data-id') || item.textContent || ''))
        .filter((item) => Number.isFinite(item)),
    );
    if (!visibleYears.length) break;

    const minYear = Math.min(...visibleYears);
    const maxYear = Math.max(...visibleYears);
    const arrow = year < minYear ? '.vc-nav-arrow.is-left' : year > maxYear ? '.vc-nav-arrow.is-right' : '';
    if (!arrow) break;
    await nav.locator(arrow).first().click();
    await nav.page().waitForTimeout(100);
    await nav.locator('.vc-nav-item:visible').first().waitFor({ state: 'visible', timeout: 3000 });
  }

  throw new Error(`Could not select datepicker year ${year}`);
}

async function clickMonth(nav: Locator, year: number, month: number): Promise<void> {
  const monthId = `${year}.${String(month).padStart(2, '0')}`;
  const monthItem = nav.locator(`.vc-nav-item[data-id="${monthId}"]:visible:not(.is-disabled)`).first();
  await monthItem.waitFor({ state: 'visible', timeout: 5000 });
  await monthItem.click();
}

async function clickDay(popover: Locator, day: number): Promise<void> {
  const dayItem = popover
    .locator('.vc-day:not(.is-not-in-month) .vc-day-content:not(.is-disabled)')
    .filter({ hasText: new RegExp(`^\\s*${day}\\s*$`) })
    .first();
  await dayItem.waitFor({ state: 'visible', timeout: 5000 });
  await dayItem.click();
}

function parseDateParts(value: string): { day: number; month: number; year: number } | null {
  const parts = value.match(/\d+/g)?.map(Number);
  if (!parts || parts.length < 3) return null;

  const [first, second, third] = parts;
  const date =
    String(first).length === 4
      ? { year: first, month: second, day: third }
      : { day: first, month: second, year: third };
  if (date.year < 1900 || date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return null;
  return date;
}

async function setSelectField(page: Page, patterns: RegExp[], value: string, contextValues: string[] = []): Promise<void> {
  if (!value) return;
  const scope = await getVisibleFormScope(page);
  for (const pattern of patterns) {
    const formGroups = scope.locator('.form-group').filter({ hasText: pattern });
    const count = await formGroups.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const formGroup = formGroups.nth(index);
      await formGroup.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(150);
      if (!(await formGroup.isVisible().catch(() => false))) continue;

      const search = formGroup.locator('.vs__search, input[type="search"]').first();
      if ((await search.count()) === 0 || !(await search.isVisible().catch(() => false))) continue;

      const selected = await chooseVisibleSelectOption(page, formGroup, value, contextValues);
      if (!selected && contextValues.some((context) => context.trim())) {
        console.log(`Skipping select field: could not find option for ${value} with context ${contextValues.filter(Boolean).join(', ')}`);
      } else if (!selected) {
        console.log(`Skipping select field: could not find option for ${value}`);
      }
      return;
    }
  }
}

async function chooseVisibleSelectOption(
  page: Page,
  formGroup: Locator,
  value: string,
  contextValues: string[] = [],
): Promise<boolean> {
  const search = formGroup.locator('.vs__search, input[type="search"]').first();
  const context = contextValues.filter((item) => item.trim()).join(' ');
  const queries = Array.from(new Set([
    value,
    [context, value].filter(Boolean).join(' '),
  ].filter(Boolean)));

  for (const query of queries) {
    await search.click();
    await search.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => undefined);
    await search.press('Backspace').catch(() => undefined);
    await search.type(query, { delay: 20 });
    await page.waitForTimeout(1000);

    const option = await findBestDropdownOption(page, value, contextValues);
    if (!option) continue;

    const optionText = (await option.innerText().catch(() => '')).trim();
    await option.scrollIntoViewIfNeeded().catch(() => undefined);
    await option.click();
    await page.waitForTimeout(500);
    await search.press('Tab').catch(() => undefined);

    if (await selectedOptionMatches(formGroup, value, contextValues, optionText)) return true;
  }

  return false;
}

async function findBestDropdownOption(page: Page, value: string, contextValues: string[] = []): Promise<Locator | null> {
  const deadline = Date.now() + 5000;
  let best: Locator | null = null;
  while (Date.now() < deadline) {
    best = await findBestVisibleDropdownOption(page, value, contextValues);
    if (best) return best;
    await page.waitForTimeout(250);
  }

  return best;
}

async function findBestVisibleDropdownOption(page: Page, value: string, contextValues: string[] = []): Promise<Locator | null> {
  const options = page.locator('.vs__dropdown-option:visible');
  const count = await options.count();
  const target = normalizePlaceForDropdown(value);
  const contexts = contextValues.map(normalizePlaceForDropdown).filter(Boolean);
  const targetTokens = target.split(' ').filter(Boolean);
  let bestMatch: Locator | null = null;
  let bestScore = 0;

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const text = (await option.innerText().catch(() => '')).trim();
    const normalizedText = normalizePlaceForDropdown(text);
    if (!normalizedText) continue;
    if (!contexts.length && targetTokens.length === 1 && normalizePlaceForDropdown(lastPlacePart(text)) !== target) continue;

    const targetScore = scoreTokenMatch(normalizedText, target);
    if (!targetScore) continue;

    let score = targetScore;
    for (const context of contexts) {
      if (scoreTokenMatch(normalizedText, context)) score += 50;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = option;
    }
  }

  return bestMatch;
}

async function selectedOptionMatches(
  formGroup: Locator,
  value: string,
  contextValues: string[] = [],
  optionText = '',
): Promise<boolean> {
  const selectedText = (await formGroup.locator('.vs__selected').first().innerText({ timeout: 2000 }).catch(() => '')).trim();
  if (!selectedText) return false;

  const text = normalizePlaceForDropdown(selectedText);
  const clickedOption = normalizePlaceForDropdown(optionText);
  if (clickedOption && text === clickedOption) return true;

  const target = normalizePlaceForDropdown(value);
  const targetTokens = target.split(' ').filter(Boolean);
  if (!contextValues.some((context) => context.trim()) && targetTokens.length === 1) {
    return normalizePlaceForDropdown(lastPlacePart(selectedText)) === target;
  }

  if (!scoreTokenMatch(text, target)) return false;

  const contexts = contextValues.map(normalizePlaceForDropdown).filter(Boolean);
  return contexts.every((context) => scoreTokenMatch(text, context));
}

function scoreTokenMatch(text: string, target: string): number {
  if (!text || !target) return 0;
  if (text === target) return 120;
  const textTokens = text.split(' ').filter(Boolean);
  const targetTokens = target.split(' ').filter(Boolean);
  if (!targetTokens.length) return 0;

  for (let index = 0; index <= textTokens.length - targetTokens.length; index += 1) {
    if (targetTokens.every((token, tokenIndex) => textTokens[index + tokenIndex] === token)) return 100;
  }

  return 0;
}

function shouldSetText(current: string | undefined, target: string | undefined): boolean {
  return Boolean(target?.trim()) && normalizeNameForComparison(current ?? '') !== normalizeNameForComparison(target ?? '');
}

function shouldSetDate(current: string | undefined, target: string | undefined): boolean {
  const targetDigits = (target ?? '').replace(/\D/g, '');
  if (!targetDigits) return false;
  return (current ?? '').replace(/\D/g, '') !== targetDigits;
}

function shouldSetAddress(current: string | undefined, target: string | undefined): boolean {
  if (!target?.trim()) return false;
  return (current ?? '').trim().toUpperCase() !== target.trim().toUpperCase();
}

function shouldSetRtRw(current: string | undefined, target: string | undefined): boolean {
  const targetDigits = (target ?? '').replace(/\D/g, '');
  if (!targetDigits) return false;
  return (current ?? '').replace(/\D/g, '') !== targetDigits;
}

function shouldSetDistrict(current: string | undefined, district: string | undefined, city: string | undefined): boolean {
  const currentFull = normalizePlaceForDropdown(current ?? '');
  const currentDistrict = normalizePlaceForDropdown(lastPlacePart(current ?? ''));
  const districtNormalized = normalizePlaceForDropdown(district ?? '');
  const cityNormalized = normalizePlaceForDropdown(city ?? '');
  if (!districtNormalized) return false;
  if (!scoreTokenMatch(currentDistrict, districtNormalized)) return true;
  return Boolean(cityNormalized) && !scoreTokenMatch(currentFull, cityNormalized);
}

function lastPlacePart(value: string): string {
  return value.split('-').map((part) => part.trim()).filter(Boolean).at(-1) ?? value;
}

function shouldSetDropdown(
  current: string | undefined,
  target: string | undefined,
  normalize: (value: string | undefined) => string,
): boolean {
  if (!target?.trim()) return false;
  const currentNormalized = normalizeNameForComparison(normalize(current));
  const targetNormalized = normalizeNameForComparison(normalize(target));
  return Boolean(targetNormalized) && currentNormalized !== targetNormalized;
}

function shouldSetJob(current: string | undefined, targetJob: string | undefined): boolean {
  if (!targetJob?.trim()) return false;
  return normalizeNameForComparison(dropdownJobFromKtp(current)) !== normalizeNameForComparison(targetJob);
}

function normalizePlaceForDropdown(value: string): string {
  return normalizeNameForComparison(value)
    .replace(/\b(KABUPATEN|KAB|KOTA|ADM|ADMINISTRASI)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeGender(value: string | undefined): string {
  const normalized = normalizeNameForComparison(value ?? '');
  if (!normalized) return '';
  if (normalized.includes('LAKI') || normalized === 'MALE') return 'Laki-laki';
  if (normalized.includes('PEREMPUAN') || normalized === 'FEMALE') return 'Perempuan';
  return value ?? '';
}

function normalizeMarriage(value: string | undefined): string {
  const normalized = normalizeNameForComparison(value ?? '');
  if (!normalized) return '';
  if (normalized.includes('BELUM')) return 'Belum Menikah';
  if (normalized.includes('KAWIN') || normalized.includes('MENIKAH')) return 'Menikah';
  return 'Janda/Duda';
}

function normalizeJob(value: string | undefined): string {
  return dropdownJobFromKtp(value);
}

function dropdownJobFromKtp(value: string | undefined): string {
  const canonical = canonicalJob(value);
  if (!canonical) return '';
  if (canonical === 'IBU RUMAH TANGGA') return 'Ibu Rumah Tangga';
  if (canonical === 'WIRAUSAHA') return 'WIRAUSAHA';
  if (canonical === 'TIDAK BEKERJA') return 'BELUM/TIDAK BEKERJA';
  if (['PNS', 'PEG. SWASTA', 'TNI/POLRI', 'PETANI', 'NELAYAN'].includes(canonical)) return canonical;
  return 'LAINNYA';
}

function canonicalJob(value: string | undefined): string {
  const normalized = (value ?? '').toUpperCase();
  if (!normalized) return '';
  if (normalized.includes('RUMAH TANGGA') || (normalized.includes('MENGURUS') && normalized.includes('TANGGA'))) return 'IBU RUMAH TANGGA';
  if (normalized.includes('TIDAK') || normalized.includes('BELUM') || normalized.includes('PELAJAR') || normalized.includes('MAHASISWA')) return 'TIDAK BEKERJA';
  if (normalized.includes('WIRASWASTA') || normalized.includes('WIRAUSAHA')) return 'WIRAUSAHA';
  if (normalized.includes('SWASTA')) return 'PEG. SWASTA';
  if (normalized.includes('TNI') || normalized.includes('POLRI')) return 'TNI/POLRI';
  if (normalized.includes('PNS')) return 'PNS';
  if (normalized.includes('PETANI')) return 'PETANI';
  if (normalized.includes('NELAYAN')) return 'NELAYAN';
  return normalized;
}

function normalizeEducation(value: string | undefined): string {
  const normalized = normalizeNameForComparison(value ?? '');
  if (!normalized) return '';
  if (normalized.includes('SLTA') || normalized.includes('SMA')) return 'SMA/MA';
  if (normalized.includes('SLTP') || normalized.includes('SMP')) return 'SMP/MTS';
  if (normalized.includes('SD')) return 'SD/MI';
  if (normalized.includes('S1') || normalized.includes('STRATAI')) return 'S1';
  if (normalized.includes('S2')) return 'S2';
  if (normalized.includes('S3')) return 'S3';
  return value?.toUpperCase() ?? '';
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

function resolveWebsiteHref(href: string, baseUrl: string): string {
  if (href.startsWith('http')) return href;
  if (href.startsWith('#')) return `${baseUrl}/app_v2/${href}`;
  return new URL(href, baseUrl).toString();
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
