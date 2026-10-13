import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { KtpVisionAi } from '../ai/ktpVision.js';
import { VerificationAi } from '../ai/verification.js';
import { DownloadedDocument } from '../browser/siteAutomation.js';
import { SiteAutomation } from '../browser/siteAutomation.js';
import { config } from '../config.js';
import { DriveClient } from '../google/drive.js';
import { SheetsClient } from '../google/sheets.js';
import { DocumentReaderResult, SheetRecord, VerificationResult } from '../types/record.js';
import { WorkflowError } from '../types/status.js';

export async function runSingleRecord(): Promise<void> {
  const sheets = new SheetsClient();
  const drive = new DriveClient();
  const site = new SiteAutomation();

  let record: SheetRecord | null = null;
  let processedCount = 0;
  let siteInitialized = false;

  try {
    do {
      let ktpTempPath: string | null = null;
      let downloadedDocuments: DownloadedDocument[] = [];

      try {
        record = await selectRecordToProcess(sheets, drive);
        if (!record) {
          console.log(processedCount > 0 ? 'No more pending visible records found.' : 'No pending record found.');
          return;
        }

        console.log(`Selected invoice ${record.invoiceNumber} for ${record.firstManifestName}.`);

        if (!siteInitialized) {
          await site.initialize();
          siteInitialized = true;
        }

        const result = await site.processToVerification(record);
        ktpTempPath = result.ktpTempPath;

        let documentReaderResult = applyMotherNameFallback(record, result.documentReaderResult);
        const ktpVision = await new KtpVisionAi().readKtp(ktpTempPath).catch((error) => {
          console.error(`KTP vision read failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (ktpVision) {
          documentReaderResult = applyKtpVision(documentReaderResult, ktpVision);
        }
        while (true) {
          const verification = await new VerificationAi().verify(record, documentReaderResult);
          printVerification(record, documentReaderResult, verification);
          printEditPlan(record, documentReaderResult);

          const action = await requestApproval();
          if (action === 'reject') {
            throw new WorkflowError('Operator rejected verification result', 'REJECTED', 'HUMAN_CONFIRMATION');
          }
          if (action === 'edit') {
            documentReaderResult = await site.applyIdentityCorrections(documentReaderResult, record);
            console.log('Edited form from KTP Vision / trusted data. Rechecking before submit...');
            continue;
          }
          break;
        }

        const currentFormIdentity = await site.readCurrentFormIdentity().catch(() => null);
        if (currentFormIdentity?.name?.trim()) {
          documentReaderResult = mergeDocumentResult(documentReaderResult, currentFormIdentity);
        }
        const finalName = finalOutputName(record, documentReaderResult);
        downloadedDocuments = await site.submitVerifiedKtpAndDownloadDocuments(result.invoiceUrl, record.invoiceNumber, finalName);
        await uploadDocumentsAndUpdateSheets({
          drive,
          sheets,
          record,
          finalName,
          documents: downloadedDocuments,
        });
        processedCount += 1;
        console.log(`SUCCESS: ${record.invoiceNumber} completed and spreadsheets updated.`);
        if (!config.INVOICE_NUMBER) console.log('Looking for the next visible pending record...');
      } finally {
        if (ktpTempPath) {
          await fs.rm(ktpTempPath, { force: true }).catch(() => undefined);
        }
        for (const document of downloadedDocuments) {
          await fs.rm(document.path, { force: true }).catch(() => undefined);
        }
      }
    } while (!config.INVOICE_NUMBER);
  } catch (error) {
    await handleFailure(error, site, record);
  } finally {
    await site.close().catch(() => undefined);
  }
}

async function selectRecordToProcess(sheets: SheetsClient, drive: DriveClient): Promise<SheetRecord | null> {
  if (config.INVOICE_NUMBER) {
    const record = await sheets.findPendingRecord(config.INVOICE_NUMBER);
    if (!record) return null;

    const existing = await drive.findExistingFolder(record.invoiceNumber, record.firstManifestName);
    if (existing) {
      console.log(`ALREADY_EXISTS: ${existing.name} (${existing.id}) - continuing and will reuse existing Drive folder.`);
    }

    return record;
  }

  const records = await sheets.findPendingRecords();
  for (const record of records) {
    const existing = await drive.findExistingFolder(record.invoiceNumber, record.firstManifestName);
    if (existing) {
      console.log(`ALREADY_EXISTS: ${existing.name} (${existing.id}) - continuing and will reuse existing Drive folder.`);
    }

    return record;
  }

  return null;
}

async function uploadDocumentsAndUpdateSheets({
  drive,
  sheets,
  record,
  finalName,
  documents,
}: {
  drive: DriveClient;
  sheets: SheetsClient;
  record: SheetRecord;
  finalName: string;
  documents: DownloadedDocument[];
}): Promise<void> {
  if (documents.length < 2 || documents.length > 3) {
    throw new WorkflowError('Expected two required documents plus optional paraf for Drive upload', 'VERIFICATION_FAILED', 'VERIFY_DRIVE_UPLOAD');
  }

  let folder = await drive.findExistingFolder(record.invoiceNumber, finalName);
  if (!folder) {
    try {
      const sequence = await drive.nextFolderSequence();
      folder = await drive.createRecordFolder(sequence, finalName, record.invoiceNumber);
    } catch (error) {
      throw new WorkflowError(
        error instanceof Error ? error.message : 'Google Drive folder creation failed',
        'GOOGLE_DRIVE_UPLOAD_FAILED',
        'CREATE_DRIVE_FOLDER',
        error,
      );
    }
  } else {
    console.log(`Drive folder already exists before upload, using it: ${folder.name}`);
  }

  const uploadedFiles = [];
  try {
    for (const document of documents) {
      uploadedFiles.push(await drive.uploadFile(folder.id, document.path, document.name, document.mimeType));
    }
  } catch (error) {
    throw new WorkflowError(
      error instanceof Error ? error.message : 'Google Drive upload failed',
      'GOOGLE_DRIVE_UPLOAD_FAILED',
      'UPLOAD_DRIVE_FILES',
      error,
    );
  }

  for (const uploadedFile of uploadedFiles) {
    const verified = await drive.verifyFileInFolder(uploadedFile.id, folder.id, uploadedFile.name);
    if (!verified) {
      throw new WorkflowError(
        `Drive upload verification failed for ${uploadedFile.name}`,
        'VERIFICATION_FAILED',
        'VERIFY_DRIVE_UPLOAD',
      );
    }
  }

  try {
    await sheets.markStatus(record.rowNumber, 'auto manifest oke');
  } catch (error) {
    throw new WorkflowError(
      error instanceof Error ? error.message : 'Main spreadsheet update failed',
      'VERIFICATION_FAILED',
      'UPDATE_MAIN_SHEET',
      error,
    );
  }

  try {
    await sheets.appendSecondSheet(finalName, record.invoiceNumber);
  } catch (error) {
    throw new WorkflowError(
      error instanceof Error ? error.message : 'Second spreadsheet update failed',
      'VERIFICATION_FAILED',
      'UPDATE_SECOND_SHEET',
      error,
    );
  }
}

function finalOutputName(record: SheetRecord, document: DocumentReaderResult): string {
  return (
    document.name?.trim() ||
    document.rawFields?.['Nama Lengkap']?.trim() ||
    record.fullName.trim() ||
    record.firstManifestName.trim()
  );
}

function mergeDocumentResult(base: DocumentReaderResult, current: DocumentReaderResult): DocumentReaderResult {
  return {
    ...base,
    name: current.name?.trim() || base.name,
    nik: current.nik?.trim() || base.nik,
    birthPlace: current.birthPlace?.trim() || base.birthPlace,
    birthDate: current.birthDate?.trim() || base.birthDate,
    address: current.address?.trim() || base.address,
    motherName: current.motherName?.trim() || base.motherName,
    rawFields: {
      ...base.rawFields,
      ...current.rawFields,
    },
  };
}

export async function saveWebsiteAuth(): Promise<void> {
  const site = new SiteAutomation();
  try {
    await site.initialize();
    await site.saveAuthenticatedState();
    console.log(`Saved Website A session to ${config.PLAYWRIGHT_STORAGE_STATE}.`);
  } finally {
    await site.close().catch(() => undefined);
  }
}

function applyMotherNameFallback(record: SheetRecord, document: DocumentReaderResult): DocumentReaderResult {
  if (document.motherName?.trim()) return document;
  if (document.systemMotherName?.trim()) {
    return { ...document, motherName: document.systemMotherName };
  }
  if (document.scannedMotherName?.trim()) {
    return { ...document, motherName: document.scannedMotherName };
  }
  if (record.motherName.trim()) {
    return { ...document, motherName: record.motherName };
  }
  throw new WorkflowError('Mother name missing from system, scan, and spreadsheet', 'NEEDS_REVIEW', 'MOTHER_NAME_FALLBACK');
}

function applyKtpVision(document: DocumentReaderResult, ktpVision: NonNullable<DocumentReaderResult['ktpVision']>): DocumentReaderResult {
  return {
    ...document,
    name: ktpVision.name || document.name,
    nik: ktpVision.nik || document.nik,
    birthPlace: ktpVision.birthPlace || document.birthPlace,
    birthDate: ktpVision.birthDate || document.birthDate,
    address: ktpVision.address || document.address,
    ktpVision,
  };
}

function printVerification(
  record: SheetRecord,
  document: DocumentReaderResult,
  verification: VerificationResult,
): void {
  console.log('\nVerification result');
  console.log('Spreadsheet source:');
  console.log(`  Name: ${record.fullName || record.firstManifestName}`);
  console.log(`  NIK: ${record.nik}`);
  console.log(`  Place of birth: ${record.birthPlace}`);
  console.log(`  Date of birth: ${record.birthDate}`);
  console.log(`  Address: ${record.ktpAddress}`);
  console.log(`  Mother: ${record.motherName}`);
  printFieldSource('System/Rails DB source before scan', document.systemFields);
  printFieldSource('Scan/Document Reader source', document.scannedFields ?? document.rawFields);
  console.log('Mother:');
  console.log(`  Spreadsheet: ${record.motherName}`);
  console.log(`  System/Rails DB: ${document.systemMotherName ?? ''}`);
  console.log(`  Scan/Document Reader: ${document.scannedMotherName ?? ''}`);
  console.log(`  Final used: ${document.motherName ?? ''}`);
  if (document.ktpVision) {
    console.log('KTP Vision:');
    console.log(`  Name: ${document.ktpVision.name ?? ''}`);
    console.log(`  NIK: ${document.ktpVision.nik ?? ''}`);
    console.log(`  Place of birth: ${document.ktpVision.birthPlace ?? ''}`);
    console.log(`  Date of birth: ${document.ktpVision.birthDate ?? ''}`);
    console.log(`  Address: ${document.ktpVision.address ?? ''}`);
    console.log(`  RT/RW: ${document.ktpVision.rtRw ?? ''}`);
    console.log(`  Kelurahan: ${document.ktpVision.kelurahan ?? ''}`);
    console.log(`  Kecamatan: ${document.ktpVision.kecamatan ?? ''}`);
    console.log(`  Kabupaten/Kota: ${document.ktpVision.kabupatenKota ?? ''}`);
    console.log(`  Jenis Kelamin: ${document.ktpVision.gender ?? ''}`);
    console.log(`  Pekerjaan: ${document.ktpVision.job ?? ''}`);
    console.log(`  Status Pernikahan: ${document.ktpVision.marriageStatus ?? ''}`);
    console.log(`  Pendidikan: ${document.ktpVision.education ?? ''}`);
    console.log(`  Confidence: ${document.ktpVision.confidence ?? ''}`);
    if (document.ktpVision.notes) console.log(`  Notes: ${document.ktpVision.notes}`);
  }
  console.log(`AI result: ${verification.decision}`);
  console.log(`AI summary: ${verification.summary}`);
  for (const comparison of verification.comparisons) {
    if (comparison.notes) console.log(`- ${comparison.field}: ${comparison.notes}`);
  }
}

function printFieldSource(title: string, fields?: Record<string, string>): void {
  if (!fields || !Object.keys(fields).length) return;
  console.log(`${title}:`);
  console.log(`  Name: ${fields['Nama Lengkap'] ?? ''}`);
  console.log(`  NIK: ${fields['NIK KTP'] ?? ''}`);
  console.log(`  Place of birth: ${fields['Tempat Lahir'] ?? ''}`);
  console.log(`  Date of birth: ${fields['Tanggal Lahir'] ?? ''}`);
  console.log(`  Address: ${formatAddressWithRtRw(fields['Alamat sesuai KTP'] ?? '', fields['RT/RW'] ?? '')}`);
  console.log(`  Kelurahan: ${fields.Kelurahan ?? ''}`);
  console.log(`  Kecamatan: ${fields.Kecamatan ?? ''}`);
  console.log(`  Mother: ${fields['Nama Ibu Kandung'] ?? ''}`);
  console.log(`  Jenis Kelamin: ${fields['Jenis Kelamin'] ?? ''}`);
  console.log(`  Pekerjaan: ${fields.Pekerjaan ?? ''}`);
  console.log(`  Status Pernikahan: ${fields['Status Pernikahan'] ?? ''}`);
  console.log(`  Pendidikan: ${fields.Pendidikan ?? ''}`);
}

function printEditPlan(record: SheetRecord, document: DocumentReaderResult): void {
  const target = {
    name: document.ktpVision?.name || record.fullName || record.firstManifestName,
    nik: document.ktpVision?.nik || record.nik,
    birthPlace: document.ktpVision?.birthPlace || record.birthPlace,
    birthDate: document.ktpVision?.birthDate || record.birthDate,
    address: document.ktpVision?.address || record.ktpAddress,
    motherName: document.systemMotherName || document.motherName || record.motherName,
    rtRw: document.ktpVision?.rtRw ?? '',
    kelurahan: document.ktpVision?.kelurahan ?? '',
    kecamatan: document.ktpVision?.kecamatan ?? '',
    kabupatenKota: document.ktpVision?.kabupatenKota ?? '',
    gender: normalizeGenderForPlan(document.ktpVision?.gender),
    job: normalizeJobForPlan(document.ktpVision?.job),
    marriageStatus: normalizeMarriageForPlan(document.ktpVision?.marriageStatus),
    education: normalizeEducationForPlan(document.ktpVision?.education),
  };
  const current = {
    name: document.rawFields?.['Nama Lengkap'] ?? document.name ?? '',
    nik: document.rawFields?.['NIK KTP'] ?? document.nik ?? '',
    birthPlace: document.rawFields?.['Tempat Lahir'] ?? document.birthPlace ?? '',
    birthDate: document.rawFields?.['Tanggal Lahir'] ?? document.birthDate ?? '',
    address: document.rawFields?.['Alamat sesuai KTP'] ?? document.address ?? '',
    motherName: document.rawFields?.['Nama Ibu Kandung'] ?? document.motherName ?? '',
    rtRw: document.rawFields?.['RT/RW'] ?? '',
    kelurahan: document.rawFields?.Kelurahan ?? '',
    kecamatan: document.rawFields?.Kecamatan ?? '',
    kabupatenKota: document.rawFields?.Kecamatan ?? '',
    gender: document.rawFields?.['Jenis Kelamin'] ?? '',
    job: document.rawFields?.Pekerjaan ?? '',
    marriageStatus: document.rawFields?.['Status Pernikahan'] ?? '',
    education: document.rawFields?.Pendidikan ?? '',
  };
  const labels: Record<keyof typeof target, string> = {
    name: 'Name',
    nik: 'NIK',
    birthPlace: 'Place of birth',
    birthDate: 'Date of birth',
    address: 'Address',
    motherName: 'Mother',
    rtRw: 'RT/RW',
    kelurahan: 'Kelurahan',
    kecamatan: 'Kecamatan',
    kabupatenKota: 'Kabupaten/Kota',
    gender: 'Jenis Kelamin',
    job: 'Pekerjaan',
    marriageStatus: 'Status Pernikahan',
    education: 'Pendidikan',
  };
  const sheet = {
    name: record.fullName || record.firstManifestName,
    nik: record.nik,
    birthPlace: record.birthPlace,
    birthDate: record.birthDate,
    address: record.ktpAddress,
    motherName: record.motherName,
  };
  const reviewDifferences = [
    ['Name', sheet.name, target.name],
    ['NIK', sheet.nik, target.nik],
    ['Place of birth', sheet.birthPlace, target.birthPlace],
    ['Date of birth', sheet.birthDate, target.birthDate],
    ['Address', sheet.address, formatAddressWithRtRw(target.address, target.rtRw)],
    ['Mother', sheet.motherName, target.motherName],
  ].filter(([label, sheetValue, targetValue]) => {
    if (!targetValue) return false;
    if (label === 'Address') return !addressesEquivalentForPlan(sheetValue, targetValue);
    return normalizeForPlan(sheetValue) !== normalizeForPlan(targetValue);
  });
  const changes = (Object.keys(target) as Array<keyof typeof target>)
    .filter((field) => field !== 'kabupatenKota')
    .filter((field) => target[field])
    .filter((field) => field !== 'kecamatan' || !isDistrictMatchForPlan(current.kecamatan, target.kecamatan, target.kabupatenKota))
    .filter((field) => field !== 'address' || !isAddressMatchForPlan(current.address, target.address, target.rtRw))
    .filter((field) => {
      if (field === 'job') return normalizeForPlan(dropdownJobForPlan(current.job)) !== normalizeForPlan(target.job);
      return normalizeForPlan(current[field]) !== normalizeForPlan(target[field]);
    });

  if (reviewDifferences.length) {
    console.log('Review differences, not auto-edited unless form differs from KTP/system:');
    for (const [label, sheetValue, targetValue] of reviewDifferences) {
      console.log(`- ${label}: Sheet "${sheetValue}" vs KTP/System "${targetValue}"`);
    }
  }

  if (!changes.length) {
    console.log('Edit plan: no field changes needed.');
    return;
  }

  console.log('Edit plan if you type "e":');
  for (const field of changes) {
    console.log(`- ${labels[field]}: "${current[field]}" -> "${target[field]}"`);
  }
}

function normalizeForPlan(value: string): string {
  return value.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizePlaceForPlan(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\b(KABUPATEN|KAB|KOTA|ADM|ADMINISTRASI)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTokenMatchForPlan(text: string, target: string): number {
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

function isDistrictMatchForPlan(current: string, district: string, city: string): boolean {
  const currentFull = normalizePlaceForPlan(current);
  const currentDistrict = normalizePlaceForPlan(lastPlacePartForPlan(current));
  const districtNormalized = normalizePlaceForPlan(district);
  const cityNormalized = normalizePlaceForPlan(city);
  if (!scoreTokenMatchForPlan(currentDistrict, districtNormalized)) return false;
  return !cityNormalized || Boolean(scoreTokenMatchForPlan(currentFull, cityNormalized));
}

function lastPlacePartForPlan(value: string): string {
  return value.split('-').map((part) => part.trim()).filter(Boolean).at(-1) ?? value;
}

function isAddressMatchForPlan(current: string, address: string, _rtRw: string): boolean {
  return current.trim().toUpperCase() === address.trim().toUpperCase();
}

function addressesEquivalentForPlan(left: string, right: string): boolean {
  const leftParts = splitAddressForPlan(left);
  const rightParts = splitAddressForPlan(right);
  return leftParts.base === rightParts.base && leftParts.rtRw === rightParts.rtRw;
}

function splitAddressForPlan(value: string): { base: string; rtRw: string } {
  const upper = value.toUpperCase();
  const rtRwMatch =
    upper.match(/\bRT\s*\/?\s*RW\s*0*(\d+)\s*\/\s*0*(\d+)/i) ??
    upper.match(/\bRT\s*0*(\d+)\s*RW\s*0*(\d+)/i) ??
    upper.match(/\bRT\s*0*(\d+)\s*\/\s*0*(\d+)/i);
  const base = upper
    .replace(/\bRT\s*\/?\s*RW\s*\d+\s*\/\s*\d+.*/i, '')
    .replace(/\bRT\s*\d+\s*RW\s*\d+.*/i, '')
    .replace(/\bRT\s*\d+\s*\/\s*\d+.*/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  const rtRw = rtRwMatch ? `${Number(rtRwMatch[1])}/${Number(rtRwMatch[2])}` : '';
  return { base, rtRw };
}

function formatDocumentAddress(document: DocumentReaderResult): string {
  return formatAddressWithRtRw(document.address ?? '', document.ktpVision?.rtRw ?? '');
}

function formatAddressWithRtRw(address: string, rtRw: string): string {
  if (!address.trim()) return '';
  if (!rtRw.trim()) return address;
  return `${address} RT/RW ${rtRw}`;
}

function normalizeGenderForPlan(value: string | undefined): string {
  const normalized = normalizeForPlan(value ?? '');
  if (!normalized) return '';
  if (normalized.includes('LAKI') || normalized === 'MALE') return 'Laki-laki';
  if (normalized.includes('PEREMPUAN') || normalized === 'FEMALE') return 'Perempuan';
  return value ?? '';
}

function normalizeMarriageForPlan(value: string | undefined): string {
  const normalized = normalizeForPlan(value ?? '');
  if (!normalized) return '';
  if (normalized.includes('BELUM')) return 'Belum Menikah';
  if (normalized.includes('KAWIN') || normalized.includes('MENIKAH')) return 'Menikah';
  return 'Janda/Duda';
}

function normalizeJobForPlan(value: string | undefined): string {
  return dropdownJobForPlan(value);
}

function dropdownJobForPlan(value: string | undefined): string {
  const canonical = canonicalJobForPlan(value);
  if (!canonical) return '';
  if (canonical === 'IBU RUMAH TANGGA') return 'Ibu Rumah Tangga';
  if (canonical === 'WIRAUSAHA') return 'WIRAUSAHA';
  if (canonical === 'TIDAK BEKERJA') return 'BELUM/TIDAK BEKERJA';
  if (['PNS', 'PEG. SWASTA', 'TNI/POLRI', 'PETANI', 'NELAYAN'].includes(canonical)) return canonical;
  return 'LAINNYA';
}

function canonicalJobForPlan(value: string | undefined): string {
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

function normalizeEducationForPlan(value: string | undefined): string {
  const normalized = normalizeForPlan(value ?? '');
  if (!normalized) return '';
  if (normalized.includes('SLTA') || normalized.includes('SMA')) return 'SMA/MA';
  if (normalized.includes('SLTP') || normalized.includes('SMP')) return 'SMP/MTS';
  if (normalized.includes('SD')) return 'SD/MI';
  if (normalized.includes('S1') || normalized.includes('STRATAI')) return 'S1';
  if (normalized.includes('S2')) return 'S2';
  if (normalized.includes('S3')) return 'S3';
  return value?.toUpperCase() ?? '';
}

async function requestApproval(): Promise<'approve' | 'reject' | 'edit'> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('\nApprove this verification, submit, upload documents, and update sheets? Press Enter to approve, type "e" to edit, or type "reject": ');
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'reject') return 'reject';
    if (normalized === 'e' || normalized === 'edit') return 'edit';
    return 'approve';
  } finally {
    rl.close();
  }
}

async function handleFailure(error: unknown, site: SiteAutomation, record: SheetRecord | null): Promise<void> {
  const invoice = record?.invoiceNumber ?? 'unknown-invoice';
  const workflowError =
    error instanceof WorkflowError
      ? error
      : new WorkflowError(error instanceof Error ? error.message : String(error), 'NEEDS_REVIEW', 'READ_SHEET', error);

  const screenshot = await site.captureScreenshot(invoice, workflowError.step).catch(() => null);
  console.error(`${workflowError.status}: invoice=${invoice} step=${workflowError.step} error=${workflowError.message}`);
  const detail = errorDetails(workflowError.cause);
  if (detail) console.error(`Cause: ${detail}`);
  if (screenshot) console.error(`Screenshot: ${screenshot}`);
}

function errorDetails(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const details: string[] = [];
  const record = error as Record<string, unknown>;
  for (const key of ['code', 'errno', 'syscall', 'hostname', 'host', 'reason']) {
    if (record[key]) details.push(`${key}=${String(record[key])}`);
  }
  if (record.cause instanceof Error) {
    details.push(record.cause.message);
  }
  return details.join(' ');
}
