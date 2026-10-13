import { google, drive_v3 } from 'googleapis';
import { config } from '../config.js';
import { createGoogleAuth } from '../google/auth.js';

const OLD_OWNER_EMAIL = getArg('--old-owner') ?? 'ziyadfazyan2@gmail.com';
const isConfirm = process.argv.includes('--confirm');
const shouldReplace = process.argv.includes('--replace');
const shouldTrashOld = process.argv.includes('--trash-old');
const allFolders = process.argv.includes('--all-folders');
const listOld = process.argv.includes('--list-old');
const limit = parsePositiveIntegerArg('--limit');
const nameFilter = getArg('--name');
const invoiceFilter = getArg('--invoice');
const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

const drive = google.drive({ version: 'v3', auth: createGoogleAuth() });

try {
  await main();
} catch (error) {
  printGoogleError(error);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log(`${isConfirm ? 'LIVE' : 'DRY RUN'} reown by copy`);
  console.log(`Old owner filter: ${OLD_OWNER_EMAIL}`);
  console.log(`Parent folder: ${config.DRIVE_PARENT_FOLDER_ID}`);

  const folders = await listChildren(config.DRIVE_PARENT_FOLDER_ID);
  if (listOld) {
    const oldFolders = folders
      .filter((file) => file.mimeType === 'application/vnd.google-apps.folder')
      .filter((file) => file.name?.startsWith('__old_owner__'));
    for (const folder of oldFolders) {
      console.log(`${folder.name} (${folder.id}) owner=${ownerEmails(folder).join(', ') || '-'}`);
    }
    console.log(`Found ${oldFolders.length} old owner folder(s).`);
    return;
  }

  const targetFolders = folders
    .filter((file) => file.mimeType === 'application/vnd.google-apps.folder')
    .filter((file) => !file.name?.startsWith('__reown_tmp__'))
    .filter((file) => !nameFilter || file.name?.toLowerCase().includes(nameFilter.toLowerCase()))
    .filter((file) => !invoiceFilter || normalizeInvoice(file.name ?? '').includes(normalizeInvoice(invoiceFilter)))
    .filter((file) => allFolders || isOwnedBy(file, OLD_OWNER_EMAIL));

  const selected = limit ? targetFolders.slice(0, limit) : targetFolders;
  console.log(`Found ${targetFolders.length} target folder(s). Processing ${selected.length}.`);

  let copiedFiles = 0;
  let copiedFolders = 0;
  let incomplete = 0;

  for (const folder of selected) {
    if (!folder.id || !folder.name) continue;
    const originalName = originalFolderName(folder.name);
    console.log(`\nFolder: ${folder.name} (${folder.id}) owner=${ownerEmails(folder).join(', ') || '-'}`);

    const newFolderName = shouldReplace ? `__reown_tmp__ ${originalName} ${timestamp}` : `${originalName} (reowned ${timestamp})`;
    if (!isConfirm) {
      const stats = await countTree(folder.id);
      console.log(`Would create folder: ${newFolderName}`);
      console.log(`Would copy ${stats.folders} folder(s), ${stats.files} file(s).`);
      if (shouldReplace) console.log('Would copy, verify, rename replacement back to original name.');
      if (shouldTrashOld) console.log('Would trash old folder after copy.');
      continue;
    }

    const alreadyMigrated = folders.find((candidate) => {
      return (
        candidate.id !== folder.id &&
        candidate.mimeType === 'application/vnd.google-apps.folder' &&
        candidate.name === originalName &&
        !isOwnedBy(candidate, OLD_OWNER_EMAIL)
      );
    });

    if (alreadyMigrated?.id && folder.name.startsWith('__old_owner__')) {
      console.log(`Already copied to new owner folder: ${alreadyMigrated.name} (${alreadyMigrated.id})`);
      if (shouldTrashOld) {
        await trashOldFolderOrFail(folder.id, folder.name);
      }
      continue;
    }

    const beforeStats = await countTree(folder.id);
    const replacement = await createFolder(config.DRIVE_PARENT_FOLDER_ID, newFolderName);
    const stats = await copyTree(folder.id, replacement.id, folder.name);
    const afterStats = await countTree(replacement.id);
    if (beforeStats.files !== afterStats.files || beforeStats.folders !== afterStats.folders) {
      throw new Error(
        `Copy verification failed for ${folder.name}: source=${beforeStats.folders} folder(s), ${beforeStats.files} file(s); copy=${afterStats.folders} folder(s), ${afterStats.files} file(s)`,
      );
    }

    copiedFiles += stats.files;
    copiedFolders += stats.folders + 1;

    if (shouldReplace) {
      if (!folder.name.startsWith('__old_owner__')) {
        await renameFile(folder.id, `__old_owner__ ${originalName} ${timestamp}`);
      }
      await renameFile(replacement.id, originalName);
      console.log(`Copied and replaced folder name: ${originalName}`);
    }

    if (shouldTrashOld) {
      try {
        await trashOldFolderOrFail(folder.id, folder.name);
      } catch (error) {
        incomplete += 1;
        console.log(`INCOMPLETE: copied new folder, but old owner folder could not be trashed: ${folder.name}`);
        if (!isPermissionError(error)) throw error;
      }
    }

    console.log(`Copied ${stats.folders} nested folder(s), ${stats.files} file(s).`);
  }

  console.log(`\nDone. Copied ${copiedFolders} folder(s), ${copiedFiles} file(s).`);
  if (incomplete > 0) {
    console.log(`Incomplete migration(s): ${incomplete}. Old owner folders still need deletion by ${OLD_OWNER_EMAIL}.`);
    process.exitCode = 2;
  }
  if (!isConfirm) {
    console.log('Dry run only. Add --confirm to copy.');
    console.log('Use --replace to swap names, and --trash-old to trash old folders after successful copy.');
  }
}

async function trashOldFolderOrFail(folderId: string, folderName: string): Promise<void> {
  try {
    await trashFile(folderId);
    console.log(`Trashed old folder: ${folderName}`);
  } catch (error) {
    console.log(`Could not trash old folder with current account: ${folderName}`);
    console.log(`Old folder id: ${folderId}`);
    throw error;
  }
}

async function copyTree(sourceFolderId: string, targetFolderId: string, label: string): Promise<{ folders: number; files: number }> {
  const children = await listChildren(sourceFolderId);
  let folders = 0;
  let files = 0;

  for (const child of children) {
    if (!child.id || !child.name || !child.mimeType) continue;

    if (child.mimeType === 'application/vnd.google-apps.folder') {
      const newChildFolder = await createFolder(targetFolderId, child.name);
      const nested = await copyTree(child.id, newChildFolder.id, `${label}/${child.name}`);
      folders += nested.folders + 1;
      files += nested.files;
      continue;
    }

    await copyFile(child.id, targetFolderId, child.name);
    files += 1;
  }

  return { folders, files };
}

async function countTree(folderId: string): Promise<{ folders: number; files: number }> {
  const children = await listChildren(folderId);
  let folders = 0;
  let files = 0;

  for (const child of children) {
    if (!child.id || !child.mimeType) continue;
    if (child.mimeType === 'application/vnd.google-apps.folder') {
      const nested = await countTree(child.id);
      folders += nested.folders + 1;
      files += nested.files;
    } else {
      files += 1;
    }
  }

  return { folders, files };
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

async function createFolder(parentId: string, name: string): Promise<{ id: string; name: string }> {
  const response = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id,name',
    supportsAllDrives: true,
  });

  if (!response.data.id || !response.data.name) throw new Error(`Could not create folder: ${name}`);
  return { id: response.data.id, name: response.data.name };
}

async function copyFile(fileId: string, parentId: string, name: string): Promise<void> {
  await drive.files.copy({
    fileId,
    requestBody: {
      name,
      parents: [parentId],
    },
    fields: 'id,name',
    supportsAllDrives: true,
  });
}

async function renameFile(fileId: string, name: string): Promise<void> {
  await drive.files.update({
    fileId,
    requestBody: { name },
    fields: 'id,name',
    supportsAllDrives: true,
  });
}

async function trashFile(fileId: string): Promise<void> {
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    fields: 'id,trashed',
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

function originalFolderName(name: string): string {
  return name.replace(/^__old_owner__\s+(.+?)(?:\s+\d{14})?$/i, '$1').trim();
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
