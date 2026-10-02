import { runSingleRecord, saveWebsiteAuth } from './workflow/singleRecord.js';

const command = process.argv[2] ?? 'single';

if (command === 'single') {
  await runSingleRecord();
} else if (command === 'auth:website') {
  await saveWebsiteAuth();
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
