# Document Verification Automation

Small TypeScript/Node.js automation for the internal document verification workflow.

The first implementation phase processes exactly one pending Google Sheets record and stops after:

1. Reading the main Google Sheet.
2. Checking Google Drive for duplicate `{manifest_name} #{invoice_number}` folders.
3. Opening Website A with an authenticated Playwright session.
4. Searching the invoice and opening its actual link.
5. Opening the Tour Pack and Manifest tab.
6. Selecting the first manifest customer only.
7. Downloading the current KTP image, uploading it back to `Scan KTP`, and running `Document Reader (MRZ)`.
8. Reading populated identity fields.
9. Applying the mother-name fallback rule.
10. Running conservative AI verification.
11. Requiring operator approval.
12. Stopping before submit/download/Drive upload/spreadsheet updates.

Batch processing and final submission steps are intentionally not enabled yet.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Fill `.env`.

Required Google variables:

- `MAIN_SPREADSHEET_ID`
- `MAIN_SHEET_NAME`
- `SECOND_SPREADSHEET_ID`
- `SECOND_SHEET_NAME`
- `DRIVE_PARENT_FOLDER_ID`
- `GOOGLE_APPLICATION_CREDENTIALS`

The Google identity must have access to both spreadsheets and the shared Drive folder. A service account works if the sheets/folder are shared with the service account email. Application Default Credentials also work.

Required Website A variables:

- `WEBSITE_BASE_URL`
- `WEBSITE_INVOICES_URL`
- `PLAYWRIGHT_STORAGE_STATE`
- `PLAYWRIGHT_HEADLESS=false` for the first live run

Required AI variables:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL` for OpenAI-compatible providers such as 9Router, OpenRouter, or xAI
- `OPENAI_MODEL`

If `OPENAI_API_KEY` is missing, the app returns `REVIEW` and requires manual handling.

## Website Session

Create an authenticated Website A browser state:

```bash
npm run auth:website
```

A browser opens. Log in normally. Do not bypass MFA, CAPTCHA, or other controls. After you can see the invoice area, press Enter in the terminal. The session is saved to `PLAYWRIGHT_STORAGE_STATE`.

### CachyOS / Arch Browser Dependencies

Playwright's `install-deps` command uses `apt-get`, so it does not work on CachyOS/Arch. Install the equivalent packages with `pacman`:

```bash
sudo pacman -S --needed icu libxml2 flite nss atk at-spi2-core cups libdrm libxkbcommon libxcomposite libxdamage libxfixes libxrandr mesa pango cairo alsa-lib
```

Then test Chromium:

```bash
node --import tsx -e "import('@playwright/test').then(async ({ chromium }) => { const b = await chromium.launch({ headless: true }); const p = await b.newPage(); await p.goto('data:text/html,<title>ok</title>'); console.log(await p.title()); await b.close(); })"
```

## Run One Record

Process the first pending record where `Status Pengajuan Rek` is empty:

```bash
npm run single
```

Process one specific invoice:

```bash
INVOICE_NUMBER=#TAB-3739 npm run single
```

The automation does not log full NIK values. Temporary KTP files are removed at the end of the run where possible.

## Verification

The operator sees spreadsheet values, Document Reader values, and the AI result:

- `MATCH`
- `REVIEW`
- `MISMATCH`

The operator must type `approve` to continue. Any other answer is treated as rejection and the form is not submitted.

For this prototype, even approval stops before form submission.

## Error Handling

Failures print:

- invoice number
- workflow step
- workflow status
- error message
- screenshot path when a browser page exists

Screenshots are written under `artifacts/screenshots/`.

Statuses used by the project:

- `PENDING`
- `ALREADY_EXISTS`
- `PROCESSING`
- `NEEDS_REVIEW`
- `REJECTED`
- `SUCCESS`
- `DOWNLOAD_FAILED`
- `OCR_FAILED`
- `SUBMIT_FAILED`
- `GOOGLE_DRIVE_UPLOAD_FAILED`
- `VERIFICATION_FAILED`

## Next Phase

After the single-record flow is confirmed against the real site DOM, add:

- form submission after approval
- Document Pengajuan Rekening download
- signature SVG download
- Drive folder creation with the next numeric prefix
- upload and verification of exactly two files
- main sheet status update to `manifest oke`
- append to the second sheet
- batch processing with resume safety

Keep those steps behind explicit commands until the prototype has been validated.
