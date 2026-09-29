import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NodeClient } from '../server/node-client.mjs';
import { DshRun } from '../server/runtime.mjs';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, pair: { type: 'string' }, name: { type: 'string' },
  'control-url': { type: 'string' }, workspace: { type: 'string', multiple: true },
  'data-dir': { type: 'string' }, 'max-concurrent': { type: 'string' },
  'print-config': { type: 'boolean' },
}, allowPositionals: false });
const configFile = values.config || process.env.WORKBENCH_NODE_CONFIG;
const fileConfig = configFile ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
const workspaceArgs = values.workspace || [];
const workspaceOverrides = Object.fromEntries(workspaceArgs.map(value => {
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) throw new Error('--workspace 格式必须为 名称=本机绝对路径。');
  return [value.slice(0, separator), value.slice(separator + 1)];
}));
const config = {
  ...fileConfig,
  ...(values['control-url'] ? { controlUrl: values['control-url'] } : {}),
  ...(values['data-dir'] ? { dataDir: values['data-dir'] } : {}),
  ...(values['max-concurrent'] ? { maxConcurrent: Number(values['max-concurrent']) } : {}),
  ...(workspaceArgs.length ? { workspaces: { ...fileConfig.workspaces, ...workspaceOverrides } } : {}),
};
if (values['max-concurrent'] !== undefined && (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1 || config.maxConcurrent > 16)) {
  throw new Error('--max-concurrent 必须是 1 到 16 的整数。');
}
if (!config.controlUrl || !config.workspaces) {
  throw new Error('请通过 --config 指定节点 JSON，或同时提供 --control-url 和至少一个 --workspace 名称=本机绝对路径。');
}
if (values['print-config']) {
  // This output is safe to paste into a config file: pairing tokens and node
  // identities are deliberately never read or emitted by this command.
  process.stdout.write(`${JSON.stringify({ controlUrl: config.controlUrl, dataDir: config.dataDir || path.join(os.homedir(), '.dsh-workbench-node'),
    workspaces: config.workspaces, maxConcurrent: config.maxConcurrent || 3, name: config.name || os.hostname() }, null, 2)}\n`);
  process.exit(0);
}
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
