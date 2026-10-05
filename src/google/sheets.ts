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
    const records = await this.findPendingRecords(invoiceNumber);
    return records[0] ?? null;
  }

  async findPendingRecords(invoiceNumber?: string): Promise<SheetRecord[]> {
    const rows = await this.getVisibleMainSheetRows();
    if (rows.length < 2) return [];

    const headers = rows[0].values.map((header) => String(header).trim());
    const indexes = this.getColumnIndexes(headers);
    const records: SheetRecord[] = [];

    for (const visibleRow of rows.slice(1)) {
      const record = this.toRecord(visibleRow.values, indexes, visibleRow.rowNumber);
      if (!record.invoiceNumber) continue;
      if (invoiceNumber && !sameInvoice(record.invoiceNumber, invoiceNumber)) continue;
      if (record.accountSubmissionStatus.trim()) continue;
      records.push(record);
    }

    return records;
  }

  private async getVisibleMainSheetRows(): Promise<Array<{ rowNumber: number; values: string[] }>> {
    const response = await this.sheets.spreadsheets.get({
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
