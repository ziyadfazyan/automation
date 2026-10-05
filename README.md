# Document Verification Automation

Small TypeScript/Node.js automation for the internal document verification workflow.

The automation processes visible pending Google Sheets records and asks the operator to approve each record before submitting:

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
12. Submitting after approval, downloading the two required documents, uploading to Drive, verifying uploads, and updating both spreadsheets.

## Local Setup

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

Google auth uses your own Google account through Application Default Credentials. The account must have access to both spreadsheets and the Drive parent folder.

Login with `gcloud`:

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/spreadsheets
```

If Google blocks the default gcloud OAuth app for Drive/Sheets scopes, create an OAuth Client ID in Google Cloud, add your Gmail as a test user on the OAuth consent screen, download the client JSON, then run:

```bash
gcloud auth application-default login \
  --client-id-file=/absolute/path/to/oauth-client.json \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/spreadsheets
```

Use OAuth user credentials for this workflow so Drive uploads use your Google account quota and folder permissions.

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

## Docker Setup

Use Docker when running this project on another laptop without installing Node modules, Playwright browsers, or Linux browser dependencies on that laptop.

Build the image:

```bash
npm run docker:build
```

Prepare local runtime folders:

```bash
mkdir -p artifacts playwright/.auth credentials
```

Use one of these Google auth options.

Option A: login on the host with `gcloud`; `npm run docker:start` mounts `${HOME}/.config/gcloud` into the container:

```bash
gcloud auth application-default login \
  --client-id-file=/absolute/path/to/oauth-client.json \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/spreadsheets
```

Option B: copy the generated user ADC file into `credentials/` and point `.env` to it:

```bash
cp ~/.config/gcloud/application_default_credentials.json credentials/google-adc.json
```

Then set:

```env
GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/google-adc.json
PLAYWRIGHT_STORAGE_STATE=playwright/.auth/website-a.json
PLAYWRIGHT_HEADLESS=true
```

Run:

```bash
npm run docker:start
```

The Docker command mounts:

- `./artifacts` to keep screenshots/download evidence outside the container
- `./playwright` to reuse Website A browser session
- `./credentials` for optional copied user ADC files
- `${HOME}/.config/gcloud` so Docker can use host `gcloud` Application Default Credentials

Do not bake `.env`, Google ADC files, KTP files, or `playwright/.auth` into the Docker image.

### Move to Another Laptop

On the first laptop:

```bash
docker save document-verification-automation -o document-verification-automation.tar
```

Copy these to the other laptop:

- `document-verification-automation.tar`
- `.env`
- `credentials/google-adc.json` if you want to reuse an existing user ADC file
- `playwright/.auth/website-a.json` if you already saved a Website A session

On the other laptop:

```bash
docker load -i document-verification-automation.tar
mkdir -p artifacts playwright/.auth credentials
docker run --rm -it --env-file .env \
  -v ./artifacts:/app/artifacts \
  -v ./playwright:/app/playwright \
  -v ./credentials:/app/credentials \
  -v ${HOME}/.config/gcloud:/root/.config/gcloud:ro \
  document-verification-automation
```

The other laptop still needs Docker installed, but it does not need `npm install`, `npx playwright install`, or Playwright OS dependency setup.

If the other laptop has `gcloud`, you can login there instead of copying `credentials/google-adc.json`. If it does not have `gcloud`, copy the ADC JSON and keep `GOOGLE_APPLICATION_CREDENTIALS=/app/credentials/google-adc.json` in `.env`.

### Website Session in Docker

The easiest path is to create `playwright/.auth/website-a.json` once on a machine where the browser can open, then copy that file with the project.

For Docker runs, prefer:

```env
PLAYWRIGHT_HEADLESS=true
```

Headful Docker browser sessions are possible on Linux with X11/Wayland mounts, but they are more fragile than using an existing storage state.

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

## Run Records

Process the first pending record where `Status Pengajuan Rek` is empty:

```bash
npm run single
```

Process one specific invoice:

```bash
INVOICE_NUMBER=#TAB-3739 npm run single
```

When `INVOICE_NUMBER` is empty, the automation processes visible pending rows from the filtered main sheet and continues to the next visible pending record after each success. When `INVOICE_NUMBER` is set, only that invoice is processed.

The automation does not log full NIK values. Temporary KTP and document files are removed at the end of each record where possible.

## Verification

The operator sees spreadsheet values, Document Reader values, and the AI result:

- `MATCH`
- `REVIEW`
- `MISMATCH`

Press Enter to approve and continue, or type `reject` to stop the record as rejected.

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

After approval, the automation submits the site form, downloads the two required documents, creates or reuses the Drive folder, uploads and verifies the two files, updates the main sheet, and inserts a row into the second sheet.
