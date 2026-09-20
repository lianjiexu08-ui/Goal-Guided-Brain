import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NodeClient } from '../server/node-client.mjs';
import { DshRun } from '../server/runtime.mjs';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, pair: { type: 'string' }, name: { type: 'string' },
} });
const configFile = values.config || process.env.WORKBENCH_NODE_CONFIG;
if (!configFile) throw new Error('请通过 --config 指定节点 JSON 配置文件。');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const client = new NodeClient({
  controlUrl: config.controlUrl,
  dataDir: config.dataDir || path.join(os.homedir(), '.dsh-workbench-node'),
  workspaces: config.workspaces,
  maxConcurrent: config.maxConcurrent || 3,
  runtimeFactory: options => new DshRun(options),
  onEvent: event => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`),
});
if (values.pair) {
  const node = await client.pair({ code: values.pair, name: values.name || config.name || os.hostname() });
  process.stdout.write(`节点已配对：${node.name} (${node.id})\n`);
}
client.start();
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await client.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
