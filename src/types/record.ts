export interface SheetRecord {
  rowNumber: number;
  invoiceNumber: string;
  manifest: string;
  firstManifestName: string;
  fullName: string;
  motherName: string;
  nik: string;
  birthPlace: string;
  birthDate: string;
  ktpAddress: string;
  ktpPhotoLink: string;
  signatureLink: string;
  accountSubmissionStatus: string;
}

export interface DocumentReaderResult {
  name?: string;
  nik?: string;
  birthPlace?: string;
  birthDate?: string;
  address?: string;
  motherName?: string;
  systemMotherName?: string;
  scannedMotherName?: string;
  ktpVision?: KtpVisionResult;
  rawFields?: Record<string, string>;
  systemFields?: Record<string, string>;
  scannedFields?: Record<string, string>;
}

export interface KtpVisionResult {
  name?: string;
  nik?: string;
  birthPlace?: string;
  birthDate?: string;
  address?: string;
  rtRw?: string;
  kelurahan?: string;
  kecamatan?: string;
  kabupatenKota?: string;
  gender?: string;
  job?: string;
  marriageStatus?: string;
  education?: string;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  notes?: string;
}

export interface VerificationComparison {
  field: 'name' | 'nik' | 'birthPlace' | 'birthDate' | 'address' | 'motherName';
  spreadsheet: string;
  documentReader: string;
  notes?: string;
}

export type VerificationDecision = 'MATCH' | 'REVIEW' | 'MISMATCH';

export interface VerificationResult {
  decision: VerificationDecision;
  summary: string;
  comparisons: VerificationComparison[];
}
