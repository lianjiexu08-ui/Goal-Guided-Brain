import fs from 'node:fs';
import path from 'node:path';
import { c as createTar } from 'tar';

// Authentication and membership in the backup catalog are checked by the
// request handler before this streaming response is opened.
export function streamBackupDownload(res, dataDir, filename) {
  const directory = path.join(dataDir, 'backups');
  const files = [
    filename,
    ...(fs.existsSync(path.join(directory, `${filename}.vault.json`))
      ? [`${filename}.vault.json`]
      : []),
  ];
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${filename}.tar.gz"`,
  });
  createTar({ cwd: directory, gzip: true, portable: true }, files)
    .on('error', (error) => res.destroy(error))
    .pipe(res);
}
