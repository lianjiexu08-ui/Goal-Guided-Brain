import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchVinext } from './patches/vinext-lifecycle.mjs';

const adapter = fileURLToPath(import.meta.resolve('vinext/server/prod-server'));
const manifest = JSON.parse(
  fs.readFileSync(
    new URL('../../package.json', pathToFileURL(adapter)),
    'utf8',
  ),
);
const before = fs.readFileSync(adapter, 'utf8');
const after = patchVinext(before, manifest.version);
if (after !== before) fs.writeFileSync(adapter, after);
console.log('GGB production connection patch verified.');
