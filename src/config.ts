import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  MAIN_SPREADSHEET_ID: z.string().min(1),
  MAIN_SHEET_NAME: z.string().default('Sheet1'),
  SECOND_SPREADSHEET_ID: z.string().min(1),
  SECOND_SHEET_NAME: z.string().default('Sheet1'),
  DRIVE_PARENT_FOLDER_ID: z.string().min(1),
  WEBSITE_BASE_URL: z.string().url(),
  WEBSITE_INVOICES_URL: z.string().url(),
  PLAYWRIGHT_STORAGE_STATE: z.string().default('playwright/.auth/website-a.json'),
  PLAYWRIGHT_HEADLESS: z
    .string()
    .default('false')
    .transform((value) => value.toLowerCase() === 'true'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  INVOICE_NUMBER: z.string().optional(),
});

export const config = envSchema.parse(process.env);
