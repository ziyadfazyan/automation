export function compactWhitespace(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeNameForComparison(value: string | undefined): string {
  return compactWhitespace(value)
    .toUpperCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractFirstManifestName(manifest: string): string {
  const firstNonEmptyLine = manifest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstNonEmptyLine) return '';

  return firstNonEmptyLine
    .replace(/^\s*\d+\s*[.)-]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeInvoiceForSearch(invoiceNumber: string): string {
  return invoiceNumber.replace(/^#/, '').trim();
}

export function maskSensitive(value: string | undefined): string {
  const clean = compactWhitespace(value);
  if (!clean) return '';
  if (clean.length <= 6) return '***';
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

export function safeFolderNamePart(value: string): string {
  return compactWhitespace(value).replace(/[\\/:*?"<>|]/g, '-');
}
