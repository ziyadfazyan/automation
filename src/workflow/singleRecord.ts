import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { VerificationAi } from '../ai/verification.js';
import { DownloadedDocument } from '../browser/siteAutomation.js';
import { SiteAutomation } from '../browser/siteAutomation.js';
import { config } from '../config.js';
import { DriveClient } from '../google/drive.js';
import { SheetsClient } from '../google/sheets.js';
import { DocumentReaderResult, SheetRecord, VerificationResult } from '../types/record.js';
import { WorkflowError } from '../types/status.js';
import { maskSensitive } from '../utils/normalize.js';

export async function runSingleRecord(): Promise<void> {
  const sheets = new SheetsClient();
  const drive = new DriveClient();
  const site = new SiteAutomation();

  let record: SheetRecord | null = null;
  let ktpTempPath: string | null = null;
  let downloadedDocuments: DownloadedDocument[] = [];

  try {
    record = await sheets.findPendingRecord(config.INVOICE_NUMBER);
    if (!record) {
      console.log('No pending record found.');
      return;
    }

    console.log(`Selected invoice ${record.invoiceNumber} for ${record.firstManifestName}.`);
    const existing = await drive.findExistingFolder(record.invoiceNumber, record.firstManifestName);
    if (existing) {
      console.log(`ALREADY_EXISTS: ${existing.name} (${existing.id})`);
      return;
    }

    await site.initialize();
    const result = await site.processToVerification(record);
    ktpTempPath = result.ktpTempPath;

    const documentReaderResult = applyMotherNameFallback(record, result.documentReaderResult);
    const verification = await new VerificationAi().verify(record, documentReaderResult);
    printVerification(record, documentReaderResult, verification);

    const approved = await requestApproval();
    if (!approved) {
      throw new WorkflowError('Operator rejected verification result', 'REJECTED', 'HUMAN_CONFIRMATION');
    }

    downloadedDocuments = await site.submitVerifiedKtpAndDownloadDocuments(result.invoiceUrl, record.invoiceNumber);
    await uploadDocumentsAndUpdateSheets({
      drive,
      sheets,
      record,
      documents: downloadedDocuments,
    });
    console.log(`SUCCESS: ${record.invoiceNumber} completed and spreadsheets updated.`);
  } catch (error) {
    await handleFailure(error, site, record);
  } finally {
    if (ktpTempPath) {
      await fs.rm(ktpTempPath, { force: true }).catch(() => undefined);
    }
    for (const document of downloadedDocuments) {
      await fs.rm(document.path, { force: true }).catch(() => undefined);
    }
    await site.close().catch(() => undefined);
  }
}

async function uploadDocumentsAndUpdateSheets({
  drive,
  sheets,
  record,
  documents,
}: {
  drive: DriveClient;
  sheets: SheetsClient;
  record: SheetRecord;
  documents: DownloadedDocument[];
}): Promise<void> {
  if (documents.length !== 2) {
    throw new WorkflowError('Expected exactly two documents for Drive upload', 'VERIFICATION_FAILED', 'VERIFY_DRIVE_UPLOAD');
  }

  let folder = await drive.findExistingFolder(record.invoiceNumber, record.firstManifestName);
  if (!folder) {
    try {
      const sequence = await drive.nextFolderSequence();
      folder = await drive.createRecordFolder(sequence, record.firstManifestName, record.invoiceNumber);
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
    await sheets.appendSecondSheet(record.firstManifestName, record.invoiceNumber);
  } catch (error) {
    throw new WorkflowError(
      error instanceof Error ? error.message : 'Second spreadsheet update failed',
      'VERIFICATION_FAILED',
      'UPDATE_SECOND_SHEET',
      error,
    );
  }
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
  if (record.motherName.trim()) {
    return { ...document, motherName: record.motherName };
  }
  throw new WorkflowError('Mother name missing from Document Reader and spreadsheet', 'NEEDS_REVIEW', 'MOTHER_NAME_FALLBACK');
}

function printVerification(
  record: SheetRecord,
  document: DocumentReaderResult,
  verification: VerificationResult,
): void {
  const display = [
    ['Name', record.fullName || record.firstManifestName, document.name ?? ''],
    ['NIK', maskSensitive(record.nik), maskSensitive(document.nik)],
    ['Place of birth', record.birthPlace, document.birthPlace ?? ''],
    ['Date of birth', record.birthDate, document.birthDate ?? ''],
    ['Address', record.ktpAddress, document.address ?? ''],
    ['Mother', record.motherName, document.motherName ?? ''],
  ];

  console.log('\nVerification result');
  for (const [label, sheet, doc] of display) {
    console.log(`${label}:`);
    console.log(`  Spreadsheet: ${sheet}`);
    console.log(`  Document Reader: ${doc}`);
  }
  console.log(`AI result: ${verification.decision}`);
  console.log(`AI summary: ${verification.summary}`);
  for (const comparison of verification.comparisons) {
    if (comparison.notes) console.log(`- ${comparison.field}: ${comparison.notes}`);
  }
}

async function requestApproval(): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('\nApprove this verification, submit, upload documents, and update sheets? Press Enter to approve, or type "reject": ');
    return answer.trim().toLowerCase() !== 'reject';
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
