import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createWorkbench } from '../server/index.mjs';
import { seedStateLoad } from './fixtures/state-load.mjs';

const teams = Number(process.argv[2] || 10);
const tasksPerTeam = Number(process.argv[3] || 20);
if (
  ![teams, tasksPerTeam].every(
    (n) => Number.isSafeInteger(n) && n >= 1 && n <= 50,
  )
)
  throw new Error(
    'Usage: node tests/benchmark-state.mjs [teams 1..50] [tasks per team 1..50]',
  );
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggb-state-benchmark-'));
const app = createWorkbench({
  dataDir: path.join(dir, 'data'),
  workspace: path.join(dir, 'project'),
  requireCredential: false,
});
try {
  await app.platform.ready;
  seedStateLoad(app.store, { teams, tasksPerTeam });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const scans = {};
  const list = app.store.records.list.bind(app.store.records);
  app.store.records.list = (name) => {
    scans[name] = (scans[name] || 0) + 1;
    return list(name);
  };
  const started = performance.now();
  const state = app.getState();
  const firstMs = performance.now() - started;
  app.store.records.list = list;
  const times = [];
  const httpTimes = [];
  const conditionalTimes = [];
  let conditionalBodyBytes = 0;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    app.getState();
    times.push(performance.now() - start);
    const httpStart = performance.now();
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/state`,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.json();
    httpTimes.push(performance.now() - httpStart);
    const conditionalStart = performance.now();
    const unchanged = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/state`,
      { headers: { 'If-None-Match': response.headers.get('etag') } },
    );
    if (unchanged.status !== 304)
      throw new Error(`Expected unchanged state, got ${unchanged.status}`);
    conditionalBodyBytes += (await unchanged.arrayBuffer()).byteLength;
    conditionalTimes.push(performance.now() - conditionalStart);
  }
  const median = (values) =>
    Math.round(
      values.sort((a, b) => a - b)[Math.floor(values.length / 2)] * 100,
    ) / 100;
  console.log(
    JSON.stringify(
      {
        teams,
        tasks: state.tasks.length,
        bytes: Buffer.byteLength(JSON.stringify(state)),
        firstMs: Math.round(firstMs),
        medianMs: median(times),
        httpMedianMs: median(httpTimes),
        conditionalHttpMedianMs: median(conditionalTimes),
        conditionalBodyBytes,
        collectionReads: scans,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
