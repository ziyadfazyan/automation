import fs from 'node:fs';
import { google, drive_v3 } from 'googleapis';
import { config } from '../config.js';
import { safeFolderNamePart } from '../utils/normalize.js';
import { createGoogleAuth } from './auth.js';

export interface DriveFolderMatch {
  id: string;
  name: string;
}

export interface UploadedFile {
  id: string;
  name: string;
  mimeType: string;
}

export class DriveClient {
  private readonly drive: drive_v3.Drive;

  constructor() {
    this.drive = google.drive({ version: 'v3', auth: createGoogleAuth() });
  }

  async findExistingFolder(invoiceNumber: string, manifestName: string): Promise<DriveFolderMatch | null> {
    const folders = await this.listChildFolders();
    const invoice = invoiceNumber.trim();
    const normalizedManifest = safeFolderNamePart(manifestName).toUpperCase();

    return (
      folders.find((folder) => {
        const upperName = folder.name.toUpperCase();
        return upperName.includes(invoice.toUpperCase()) && upperName.includes(normalizedManifest);
      }) ?? null
    );
  }

  async nextFolderSequence(): Promise<number> {
    const folders = await this.listChildFolders();
    const highest = folders.reduce((max, folder) => {
      const match = folder.name.match(/^(\d+)\./);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return highest + 1;
  }

  async createRecordFolder(sequence: number, manifestName: string, invoiceNumber: string): Promise<DriveFolderMatch> {
    const name = `${sequence}. ${safeFolderNamePart(manifestName)} ${invoiceNumber}`;
    const response = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [config.DRIVE_PARENT_FOLDER_ID],
      },
      fields: 'id,name',
      supportsAllDrives: true,
    });

    if (!response.data.id || !response.data.name) {
      throw new Error('Drive did not return created folder id/name');
    }

    return { id: response.data.id, name: response.data.name };
  }

  async uploadFile(folderId: string, filePath: string, fileName: string, mimeType: string): Promise<UploadedFile> {
    const response = await this.drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: fs.createReadStream(filePath) },
      fields: 'id,name,mimeType',
      supportsAllDrives: true,
    });

    if (!response.data.id || !response.data.name || !response.data.mimeType) {
      throw new Error(`Drive did not return uploaded file metadata for ${fileName}`);
    }

    return {
      id: response.data.id,
      name: response.data.name,
      mimeType: response.data.mimeType,
    };
  }

  async verifyFileInFolder(fileId: string, folderId: string, expectedName: string): Promise<boolean> {
    const response = await this.drive.files.get({
      fileId,
      fields: 'id,name,parents,trashed',
      supportsAllDrives: true,
    });

    return (
      response.data.name === expectedName &&
      response.data.trashed !== true &&
      (response.data.parents ?? []).includes(folderId)
    );
  }

  private async listChildFolders(): Promise<DriveFolderMatch[]> {
    const folders: DriveFolderMatch[] = [];
    let pageToken: string | undefined;

    do {
      const response = await this.drive.files.list({
        q: `'${config.DRIVE_PARENT_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'nextPageToken,files(id,name)',
        pageToken,
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      for (const file of response.data.files ?? []) {
        if (file.id && file.name) folders.push({ id: file.id, name: file.name });
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return folders;
  }
}
