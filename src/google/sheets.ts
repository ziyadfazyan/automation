import { google, sheets_v4 } from 'googleapis';
import { config } from '../config.js';
import { SheetRecord } from '../types/record.js';
import { extractFirstManifestName } from '../utils/normalize.js';
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
      if (invoiceNumber && record.invoiceNumber !== invoiceNumber) continue;
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
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: config.SECOND_SPREADSHEET_ID,
      range: `${config.SECOND_SHEET_NAME}!A:A`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[`${firstManifestName} | ${invoiceNumber}`]] },
    });
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
