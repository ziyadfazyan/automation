import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { google, drive_v3 } from 'googleapis';
import { config } from '../config.js';
import { createGoogleAuth } from '../google/auth.js';

const OLD_OWNER_EMAIL = getArg('--old-owner') ?? 'ziyadfazyan2@gmail.com';
const isConfirm = process.argv.includes('--confirm');
const shouldDeleteOld = process.argv.includes('--delete-old') || process.argv.includes('--trash-old');
const limit = parsePositiveIntegerArg('--limit');
const folderLimit = parsePositiveIntegerArg('--folder-limit');
const invoiceFilter = getArg('--invoice');
const nameFilter = getArg('--name');

const drive = google.drive({ version: 'v3', auth: createGoogleAuth() });

try {
  await main();
} catch (error) {
  printGoogleError(error);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log(`${isConfirm ? 'LIVE' : 'DRY RUN'} file reupload`);
  console.log(`Old owner filter: ${OLD_OWNER_EMAIL}`);
  console.log(`Parent folder: ${config.DRIVE_PARENT_FOLDER_ID}`);

  const topLevel = await listChildren(config.DRIVE_PARENT_FOLDER_ID);
  const roots = invoiceFilter
    ? topLevel.filter((file) => file.id && file.mimeType === 'application/vnd.google-apps.folder' && normalizeInvoice(file.name ?? '').includes(normalizeInvoice(invoiceFilter)))
    : topLevel.filter((file) => file.id && file.mimeType === 'application/vnd.google-apps.folder' && isOwnedBy(file, OLD_OWNER_EMAIL));

  if (invoiceFilter && roots.length === 0) {
    console.log(`No folder found for invoice ${invoiceFilter}.`);
    return;
  }

  const selectedRoots = folderLimit ? roots.slice(0, folderLimit) : roots;
  const files: DriveFileWithPath[] = [];
  for (let index = 0; index < selectedRoots.length; index += 1) {
    const root = selectedRoots[index];
    console.log(`Scanning folder ${index + 1}/${selectedRoots.length}: ${root.name}`);
    files.push(...(await listFilesRecursive(root.id!, root.name ? [root.name] : [])));
  }
  const targets = files
    .filter((file) => file.mimeType !== 'application/vnd.google-apps.folder')
    .filter((file) => isOwnedBy(file, OLD_OWNER_EMAIL))
    .filter((file) => !invoiceFilter || file.pathNames.some((name) => normalizeInvoice(name).includes(normalizeInvoice(invoiceFilter))))
    .filter((file) => !nameFilter || file.name?.toLowerCase().includes(nameFilter.toLowerCase()) || file.pathNames.some((name) => name.toLowerCase().includes(nameFilter.toLowerCase())));

  const selected = limit ? targets.slice(0, limit) : targets;
  console.log(`Found ${targets.length} old-owner file(s). Processing ${selected.length}.`);

  let uploaded = 0;
  let trashed = 0;
  let incomplete = 0;

  for (const file of selected) {
    if (!file.id || !file.name || !file.mimeType || !file.parents?.[0]) continue;
    const parentId = file.parents[0];
    const displayPath = [...file.pathNames, file.name].join('/');
    console.log(`\nFile: ${displayPath} (${file.id}) owner=${ownerEmails(file).join(', ') || '-'}`);

    if (!isConfirm) {
      console.log(`Would download and upload again to same folder: ${parentId}`);
      if (shouldDeleteOld) console.log('Would trash old file after verified upload.');
      continue;
    }

    const tempPath = await downloadFile(file);
    try {
      const newFile = await uploadFile(parentId, tempPath, file.name, file.mimeType);
      const verified = await verifyFile(newFile.id, parentId, file.name);
      if (!verified) throw new Error(`Upload verification failed for ${file.name}`);
      uploaded += 1;

      if (shouldDeleteOld) {
        try {
          await deleteOldFile(file.id, parentId);
          trashed += 1;
          console.log(`Uploaded new file and removed old file: ${file.name}`);
        } catch (error) {
          incomplete += 1;
          console.log(`Uploaded new file, but could not remove old file: ${file.name}`);
          console.log(`Old file id: ${file.id}`);
          if (!isPermissionError(error)) throw error;
        }
      } else {
        console.log(`Uploaded new file: ${file.name}`);
      }
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  console.log(`\nDone. Uploaded ${uploaded} file(s). Trashed ${trashed} old file(s).`);
  if (incomplete > 0) {
    console.log(`Incomplete file(s): ${incomplete}. Old files still need deletion by ${OLD_OWNER_EMAIL}.`);
    process.exitCode = 2;
  }
  if (!isConfirm) console.log('Dry run only. Add --confirm --delete-old to really reupload and trash old files.');
}

interface DriveFileWithPath extends drive_v3.Schema$File {
  pathNames: string[];
}

async function listFilesRecursive(parentId: string, pathNames: string[] = []): Promise<DriveFileWithPath[]> {
  const children = await listChildren(parentId);
  const results: DriveFileWithPath[] = [];

  for (const child of children) {
    const file = { ...child, pathNames };
    results.push(file);
    if (child.id && child.name && child.mimeType === 'application/vnd.google-apps.folder') {
      results.push(...(await listFilesRecursive(child.id, [...pathNames, child.name])));
    }
  }

  return results;
}

async function listChildren(parentId: string): Promise<drive_v3.Schema$File[]> {
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const response = await drive.files.list({
      q: `'${parentId}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,owners(emailAddress),parents)',
      pageToken,
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(response.data.files ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

async function downloadFile(file: drive_v3.Schema$File): Promise<string> {
  if (!file.id || !file.name || !file.mimeType) throw new Error('Missing file metadata for download');
  if (file.mimeType.startsWith('application/vnd.google-apps.')) {
    throw new Error(`Cannot raw-download Google Workspace file: ${file.name}`);
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'drive-reupload-'));
  const tempPath = path.join(tempDir, safeFileName(file.name));
  const response = await drive.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
  await pipeline(response.data as NodeJS.ReadableStream, fs.createWriteStream(tempPath));
  return tempPath;
}

async function uploadFile(parentId: string, filePath: string, name: string, mimeType: string): Promise<{ id: string; name: string }> {
  const response = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: fs.createReadStream(filePath) },
    fields: 'id,name',
    supportsAllDrives: true,
  });

  if (!response.data.id || !response.data.name) throw new Error(`Upload failed for ${name}`);
  return { id: response.data.id, name: response.data.name };
}

async function verifyFile(fileId: string, parentId: string, name: string): Promise<boolean> {
  const response = await drive.files.get({
    fileId,
    fields: 'id,name,parents,trashed',
    supportsAllDrives: true,
  });

  return response.data.name === name && response.data.trashed !== true && (response.data.parents ?? []).includes(parentId);
}

async function deleteOldFile(fileId: string, parentId: string): Promise<void> {
  try {
    await drive.files.delete({
      fileId,
      supportsAllDrives: true,
    });
    return;
  } catch (error) {
    if (!isPermissionError(error)) throw error;
  }

  await drive.files.update({
    fileId,
    removeParents: parentId,
    fields: 'id,parents',
    supportsAllDrives: true,
  });
}

function isOwnedBy(file: drive_v3.Schema$File, email: string): boolean {
  return ownerEmails(file).some((ownerEmail) => ownerEmail.toLowerCase() === email.toLowerCase());
}

function ownerEmails(file: drive_v3.Schema$File): string[] {
  return (file.owners ?? []).map((owner) => owner.emailAddress ?? '').filter(Boolean);
}

function getArg(name: string): string | null {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || null;
}

function parsePositiveIntegerArg(name: string): number | null {
  const value = Number(getArg(name));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeInvoice(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function safeFileName(value: string): string {
  return value.replace(/[^\w .()[\]-]+/g, '_');
}

function printGoogleError(error: unknown): void {
  const detail = error && typeof error === 'object' && 'code' in error ? `Detail: ${(error as { code?: string }).code}` : '';
  console.error(error instanceof Error ? error.message : String(error));
  if (detail) console.error(detail);
}

function isPermissionError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      Number((error as { code?: number | string }).code) === 403,
  );
}
