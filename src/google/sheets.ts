import { google, sheets_v4 } from 'googleapis';
import { config } from '../config.js';
import { SheetRecord } from '../types/record.js';
import { extractFirstManifestName, normalizeInvoiceForSearch } from '../utils/normalize.js';
import { createGoogleAuth } from './auth.js';

const REQUIRED_COLUMNS = [
  'Nomor Invoice',
  'Manifest',
  'Nama Lengkap',
  'Nama Ibu Kandung',
  'NIK KTP',
  'Tempat Lahir',
  'Tanggal Lahir',
  'Alamat sesuai KTP',
  'Link Foto KTP',
  'Link TTD',
  'Status Pengajuan Rek',
] as const;

type RequiredColumn = (typeof REQUIRED_COLUMNS)[number];

export class SheetsClient {
  private readonly sheets: sheets_v4.Sheets;

  constructor() {
    this.sheets = google.sheets({ version: 'v4', auth: createGoogleAuth() });
  }

  async findPendingRecord(invoiceNumber?: string): Promise<SheetRecord | null> {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: config.MAIN_SPREADSHEET_ID,
      range: `${config.MAIN_SHEET_NAME}!A:ZZ`,
    });

    const rows = response.data.values ?? [];
    if (rows.length < 2) return null;

    const headers = rows[0].map((header) => String(header).trim());
    const indexes = this.getColumnIndexes(headers);

    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      const record = this.toRecord(row, indexes, index + 1);
      if (!record.invoiceNumber) continue;
      if (invoiceNumber && !sameInvoice(record.invoiceNumber, invoiceNumber)) continue;
      if (record.accountSubmissionStatus.trim()) continue;
      return record;
    }

    return null;
  }

  async markStatus(rowNumber: number, status: string): Promise<void> {
    const headersResponse = await this.sheets.spreadsheets.values.get({
      spreadsheetId: config.MAIN_SPREADSHEET_ID,
      range: `${config.MAIN_SHEET_NAME}!1:1`,
    });
    const headers = headersResponse.data.values?.[0]?.map((header) => String(header).trim()) ?? [];
    const statusIndex = headers.indexOf('Status Pengajuan Rek');
    if (statusIndex === -1) {
      throw new Error('Missing Status Pengajuan Rek column');
    }

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: config.MAIN_SPREADSHEET_ID,
      range: `${config.MAIN_SHEET_NAME}!${columnLetter(statusIndex + 1)}${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[status]] },
    });
  }

  async appendSecondSheet(firstManifestName: string, invoiceNumber: string): Promise<void> {
    const normalizedInvoice = normalizeInvoiceForSearch(invoiceNumber).toUpperCase();
    const existing = await this.sheets.spreadsheets.values.get({
      spreadsheetId: config.SECOND_SPREADSHEET_ID,
      range: `${config.SECOND_SHEET_NAME}!A:G`,
    });

    const rows = existing.data.values ?? [];
    const existingRowIndex = rows.findIndex((row) => normalizeInvoiceForSearch(String(row[2] ?? '')).toUpperCase() === normalizedInvoice);
    if (existingRowIndex !== -1) return;

    const lastSuccessRowIndex = findLastSecondSheetMainRowIndex(rows);
    if (lastSuccessRowIndex === -1) {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: config.SECOND_SPREADSHEET_ID,
        range: `${config.SECOND_SHEET_NAME}!A:D`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[1, firstManifestName, invoiceNumber, 'Uploaded']] },
      });
      return;
    }

    const sheetId = await this.getSheetId(config.SECOND_SPREADSHEET_ID, config.SECOND_SHEET_NAME);
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.SECOND_SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: lastSuccessRowIndex + 1,
                endIndex: lastSuccessRowIndex + 2,
              },
              inheritFromBefore: true,
            },
          },
        ],
      },
    });

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: config.SECOND_SPREADSHEET_ID,
      range: `${config.SECOND_SHEET_NAME}!A${lastSuccessRowIndex + 2}:D${lastSuccessRowIndex + 2}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[nextSecondSheetNumber(rows, lastSuccessRowIndex), firstManifestName, invoiceNumber, 'Uploaded']] },
    });
  }

  private async getSheetId(spreadsheetId: string, sheetName: string): Promise<number> {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(sheetId,title))',
    });
    const sheet = response.data.sheets?.find((candidate) => candidate.properties?.title === sheetName);
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId === undefined || sheetId === null) {
      throw new Error(`Missing sheet tab: ${sheetName}`);
    }
    return sheetId;
  }

  private getColumnIndexes(headers: string[]): Record<RequiredColumn, number> {
    const result = {} as Record<RequiredColumn, number>;
    for (const column of REQUIRED_COLUMNS) {
      const index = headers.indexOf(column);
      if (index === -1) {
        throw new Error(`Missing required column: ${column}`);
      }
      result[column] = index;
    }
    return result;
  }

  private toRecord(
    row: string[],
    indexes: Record<RequiredColumn, number>,
    rowNumber: number,
  ): SheetRecord {
    const value = (column: RequiredColumn) => String(row[indexes[column]] ?? '').trim();
    const manifest = value('Manifest');
    return {
      rowNumber,
      invoiceNumber: value('Nomor Invoice'),
      manifest,
      firstManifestName: extractFirstManifestName(manifest),
      fullName: value('Nama Lengkap'),
      motherName: value('Nama Ibu Kandung'),
      nik: value('NIK KTP'),
      birthPlace: value('Tempat Lahir'),
      birthDate: value('Tanggal Lahir'),
      ktpAddress: value('Alamat sesuai KTP'),
      ktpPhotoLink: value('Link Foto KTP'),
      signatureLink: value('Link TTD'),
      accountSubmissionStatus: value('Status Pengajuan Rek'),
    };
  }
}

function sameInvoice(left: string, right: string): boolean {
  return normalizeInvoiceForSearch(left).toUpperCase() === normalizeInvoiceForSearch(right).toUpperCase();
}

function findLastSecondSheetMainRowIndex(rows: unknown[][]): number {
  let result = -1;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const name = String(row[1] ?? '').trim();
    if (name) result = index;
  }
  return result;
}

function nextSecondSheetNumber(rows: unknown[][], lastRowIndex: number): number {
  const lastNumber = Number(String(rows[lastRowIndex]?.[0] ?? '').trim());
  return Number.isFinite(lastNumber) && lastNumber > 0 ? lastNumber + 1 : lastRowIndex + 1;
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
