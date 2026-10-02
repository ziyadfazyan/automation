export const Statuses = [
  'PENDING',
  'ALREADY_EXISTS',
  'PROCESSING',
  'NEEDS_REVIEW',
  'REJECTED',
  'SUCCESS',
  'DOWNLOAD_FAILED',
  'OCR_FAILED',
  'SUBMIT_FAILED',
  'GOOGLE_DRIVE_UPLOAD_FAILED',
  'VERIFICATION_FAILED',
] as const;

export type WorkflowStatus = (typeof Statuses)[number];

export type WorkflowStep =
  | 'READ_SHEET'
  | 'CHECK_DRIVE_DUPLICATE'
  | 'START_BROWSER'
  | 'OPEN_INVOICE'
  | 'OPEN_TOUR_PACK'
  | 'OPEN_MANIFEST'
  | 'SELECT_MANIFEST_CUSTOMER'
  | 'DOWNLOAD_KTP'
  | 'UPLOAD_KTP'
  | 'RUN_DOCUMENT_READER'
  | 'READ_DOCUMENT_READER_RESULT'
  | 'MOTHER_NAME_FALLBACK'
  | 'AI_VERIFICATION'
  | 'HUMAN_CONFIRMATION'
  | 'SUBMIT_FORM'
  | 'DOWNLOAD_DOCUMENTS'
  | 'CREATE_DRIVE_FOLDER'
  | 'UPLOAD_DRIVE_FILES'
  | 'VERIFY_DRIVE_UPLOAD'
  | 'UPDATE_MAIN_SHEET'
  | 'UPDATE_SECOND_SHEET'
  | 'STOP_AFTER_VERIFICATION';

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly status: WorkflowStatus,
    public readonly step: WorkflowStep,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}
