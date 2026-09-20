import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshRun, findDsh } from '../server/runtime.mjs';
import { ROLES } from '../server/store.mjs';

test(
  'configured execution duration terminates a stalled native runtime',
  { timeout: 10000, skip: !findDsh() },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-deadline-'));
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* Keep the local provider request pending. */
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let run;
    try {
      const started = Date.now();
      const outcome = await new Promise((resolve) => {
        run = new DshRun({
          task: { id: 'deadline-fixture', role: 'product', workspace: dir },
          assistant: {
            ...ROLES.product,
            tools: { files: false, terminal: false, web: false },
            skillIds: [],
          },
          config: {},
          dataDir: path.join(dir, 'data'),
          maxDurationMinutes: 0.02,
          route: {
            protocol: 'openai-completions',
            providerName: 'fixture',
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            model: 'fixture-model',
            secret: 'local-fixture-key',
          },
          onLog: () => {},
          onResult: () => {},
          onDone: (status, error) => resolve({ status, error }),
        });
        void run.start('Wait for the local provider.');
      });
      assert.equal(outcome.status, 'failed');
      assert.match(outcome.error, /0.02 分钟执行上限/);
      assert.equal(run.closed, true);
      assert.ok(Date.now() - started < 8000);
    } finally {
      if (run?.child && !run.closed) {
        run.kill();
        await new Promise((resolve) => run.child.once('close', resolve));
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'cancellation reports completion exactly once after process exit',
  { timeout: 60000, skip: !findDsh() },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cancel-'));
    let run;
    let completions = 0;
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* Drain the fixture request before cancelling. */
      }
      run.cancel();
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await new Promise((resolve) => {
        run = new DshRun({
          task: { id: 'cancel-fixture', role: 'product', workspace: dir },
          assistant: {
            ...ROLES.product,
            skillIds: [],
            tools: { files: false, web: false, terminal: false },
          },
          config: {},
          dataDir: path.join(dir, 'data'),
          route: {
            protocol: 'openai-completions',
            providerName: 'local',
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            model: 'fixture-model',
            secret: 'local-fixture-key',
          },
          onLog: () => {},
          onResult: () => {},
          onDone: (status, error) => {
            completions += 1;
            resolve({ status, error, closed: run.closed });
          },
        });
        void run.start('Wait for cancellation.');
      });
      assert.equal(result.status, 'cancelled', result.error);
      assert.equal(result.closed, true);
      run.cancel();
      assert.equal(completions, 1);
      assert.throws(() => run.enqueue('late message'), /结束/);
    } finally {
      if (run?.child && !run.closed) {
        run.kill();
        await new Promise((resolve) => run.child.once('close', resolve));
      }
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

for (const protocol of [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])
  test(
    `native DSH ${protocol} route authenticates and executes a tool`,
    { timeout: 60000, skip: !findDsh() },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-route-test-'));
      const workspace = path.join(dir, 'workspace');
      fs.mkdirSync(workspace);
      const hookFile = path.join(dir, 'fixture-hooks.json');
      fs.writeFileSync(
        hookFile,
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: "printf 'hook-ran' > hook-verified.txt",
                  },
                ],
              },
            ],
          },
        }),
      );
      const requests = [];
      const mcpRequests = [];
      const args = JSON.stringify({
        file_path: 'verified.txt',
        content: 'multi-provider verified',
      });
      const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (req.url === '/mcp') {
          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
          }
          const message = JSON.parse(body);
          mcpRequests.push({ message, headers: req.headers });
          if (message.id === undefined) {
            res.writeHead(202);
            res.end();
            return;
          }
          const result =
            message.method === 'initialize'
              ? {
                  protocolVersion: '2024-11-05',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'fixture', version: '1' },
                }
              : message.method === 'tools/list'
                ? {
                    tools: [
                      {
                        name: 'ping',
                        description: 'Check the local fixture',
                        inputSchema: { type: 'object', properties: {} },
                      },
                    ],
                  }
                : { content: [{ type: 'text', text: 'pong' }] };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
          return;
        }
        requests.push({
          headers: req.headers,
          body: JSON.parse(body),
          path: req.url,
        });
        const tool = requests.length === 1;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        const emit = (event, value) =>
          res.write(
            `event: ${event}\ndata: ${JSON.stringify({ type: event, ...value })}\n\n`,
          );
        if (protocol === 'openai-completions') {
          const chunk = (delta, finish_reason = null) =>
            res.write(
              `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`,
            );
          chunk(
            tool
              ? {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_fixture',
                      type: 'function',
                      function: { name: 'write', arguments: args },
                    },
                  ],
                }
              : { role: 'assistant', content: 'Protocol verified.' },
          );
          chunk({}, tool ? 'tool_calls' : 'stop');
          res.write('data: [DONE]\n\n');
        } else if (protocol === 'openai-responses') {
          const item = tool
            ? {
                id: 'fc_fixture',
                type: 'function_call',
                name: 'write',
                call_id: 'call_fixture',
                arguments: args,
                status: 'completed',
              }
            : {
                id: 'msg_fixture',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: 'Protocol verified.',
                    annotations: [],
                  },
                ],
              };
          emit('response.created', {
            response: { id: 'resp_fixture', status: 'in_progress' },
          });
          emit('response.output_item.added', {
            output_index: 0,
            item: { ...item, ...(tool ? { arguments: '' } : { content: [] }) },
          });
          emit(
            tool
              ? 'response.function_call_arguments.delta'
              : 'response.output_text.delta',
            { output_index: 0, delta: tool ? args : 'Protocol verified.' },
          );
          emit('response.output_item.done', { output_index: 0, item });
          emit('response.completed', {
            response: {
              id: 'resp_fixture',
              status: 'completed',
              output: [item],
              usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
            },
          });
        } else {
          emit('message_start', {
            message: {
              id: 'msg_fixture',
              type: 'message',
              role: 'assistant',
              model: 'fixture-model',
              content: [],
              usage: { input_tokens: 20, output_tokens: 0 },
            },
          });
          emit('content_block_start', {
            index: 0,
            content_block: tool
              ? {
                  type: 'tool_use',
                  id: 'call_fixture',
                  name: 'write',
                  input: {},
                }
              : { type: 'text', text: '' },
          });
          emit('content_block_delta', {
            index: 0,
            delta: tool
              ? { type: 'input_json_delta', partial_json: args }
              : { type: 'text_delta', text: 'Protocol verified.' },
          });
          emit('content_block_stop', { index: 0 });
          emit('message_delta', {
            delta: {
              stop_reason: tool ? 'tool_use' : 'end_turn',
              stop_sequence: null,
            },
            usage: { output_tokens: 8 },
          });
          emit('message_stop', {});
        }
        res.end();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      let run;
      const logs = [];
      const events = [];
      let queued = false;
      try {
        const outcome = await new Promise((resolve) => {
          run = new DshRun({
            task: { id: 'route-fixture', role: 'product', workspace },
            assistant: {
              ...ROLES.product,
              skillIds: [],
              tools: { files: true, terminal: false, web: false },
            },
            config: {},
            dataDir: path.join(dir, 'data'),
            route: {
              protocol,
              providerName: 'local',
              baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
              model: 'fixture-model',
              modelSpec: { contextWindow: 128000 },
              secret: 'local-route-fixture-key',
            },
            capabilityPatch:
              protocol === 'openai-completions'
                ? [
                    {
                      id: 'fixture-mcp',
                      name: '@deepseek-ai/dsh-mcp-client',
                      config: {
                        serverName: 'fixture',
                        transport: 'streamable-http',
                        url: `http://127.0.0.1:${server.address().port}/mcp`,
                        headers: { Authorization: 'Bearer mcp-runtime-secret' },
                        failOnStartupError: true,
                      },
                    },
                    {
                      id: 'fixture-hooks',
                      name: '@deepseek-ai/dsh-hooks-claude-code',
                      config: {
                        configPath: hookFile,
                        pluginRoot: dir,
                        defaultTimeoutMs: 5000,
                      },
                    },
                  ]
                : [],
            onLog: (value) => logs.push(value),
            onResult: (value) => logs.push(value),
            onEvent: (value) => {
              events.push(value);
              if (
                protocol === 'openai-responses' &&
                value.type === 'turn/start' &&
                !queued
              ) {
                queued = true;
                assert.equal(
                  run.enqueue('ADDITIONAL_CONTEXT: confirm the result.').queued,
                  true,
                );
              }
            },
            onDone: (status, error) => resolve({ status, error }),
          });
          void run.start('Write verified.txt with multi-provider verified.');
        });
        assert.equal(
          outcome.status,
          'completed',
          `${outcome.error}\n${logs.join('\n')}`,
        );
        assert.equal(run.closed, true);
        assert.equal(
          requests[0].headers[
            protocol === 'anthropic-messages' ? 'x-api-key' : 'authorization'
          ],
          protocol === 'anthropic-messages'
            ? 'local-route-fixture-key'
            : 'Bearer local-route-fixture-key',
        );
        assert.equal(
          requests[0].path,
          `/v1/${protocol === 'anthropic-messages' ? 'messages' : protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`,
        );
        assert.equal(
          fs.readFileSync(path.join(workspace, 'verified.txt'), 'utf8'),
          'multi-provider verified',
        );
        assert.ok(events.some((event) => event.type === 'tool/call'));
        assert.ok(
          !JSON.stringify({ logs, events }).includes('local-route-fixture-key'),
        );
        if (protocol === 'openai-completions') {
          assert.equal(
            fs.readFileSync(path.join(workspace, 'hook-verified.txt'), 'utf8'),
            'hook-ran',
          );
          assert.ok(mcpRequests.length >= 2);
          assert.ok(
            mcpRequests.every(
              (request) =>
                request.headers.authorization === 'Bearer mcp-runtime-secret',
            ),
          );
          assert.ok(
            requests[0].body.tools.some(
              (tool) => tool.function.name === 'mcp__fixture__ping',
            ),
          );
          const patch = fs.readFileSync(
            path.join(dir, 'data/runs/route-fixture/runtime.yml'),
            'utf8',
          );
          assert.ok(!patch.includes('mcp-runtime-secret'));
          assert.ok(
            !JSON.stringify({ logs, events }).includes('mcp-runtime-secret'),
          );
        }
        if (protocol === 'openai-responses') {
          assert.ok(requests.length >= 3);
          assert.match(
            JSON.stringify(requests.at(-1).body.input),
            /ADDITIONAL_CONTEXT/,
          );
          assert.ok(events.some((event) => event.type === 'message/accepted'));
        }
      } finally {
        if (run && !run.closed) {
          run.kill();
          await new Promise((resolve) => run.child.once('close', resolve));
        }
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

for (const role of ['product', 'developer', 'custom', 'no-tools'])
  test(
    `real DSH ${role} runtime executes its tool with a local model fixture`,
    { timeout: 60000, skip: !findDsh() },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wire-test-'));
      const dataDir = path.join(dir, 'data');
      const workspace = path.join(dir, 'project');
      fs.mkdirSync(dataDir);
      fs.mkdirSync(workspace);
      fs.writeFileSync(
        path.join(dataDir, 'secrets.json'),
        JSON.stringify({ apiKey: 'local-fixture-key' }),
        { mode: 0o600 },
      );
      const calls = [];
      const assistant =
        role === 'custom' || role === 'no-tools'
          ? {
              ...ROLES.product,
              name: '研究助手',
              instructions:
                'CUSTOM_ASSISTANT_PERSONA: 按指定工作流程处理任务。',
              tools: {
                files: role === 'custom',
                terminal: role === 'custom',
                web: false,
              },
              skillIds: [],
              workflow: 'CUSTOM_WORKFLOW: 先收集证据，然后检查并交付。',
            }
          : undefined;
      let toolRound = 0;
      const provider = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const request = JSON.parse(body);
        calls.push(request);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        const emit = (delta, finish_reason = null) =>
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'fixture',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'deepseek-v4-flash',
                choices: [{ index: 0, delta, finish_reason }],
              }) +
              '\n\n',
          );
        if (toolRound++ === 0 && role !== 'no-tools') {
          const toolName = ['developer', 'custom'].includes(role)
            ? 'bash'
            : 'write';
          const write = request.tools.find(
            (t) => t.function?.name === toolName,
          );
          if (!write) {
            emit(
              { role: 'assistant', content: 'fixture: write tool unavailable' },
              'stop',
            );
          } else {
            emit({
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'fixture-write',
                  type: 'function',
                  function: {
                    name: toolName,
                    arguments: JSON.stringify(
                      ['developer', 'custom'].includes(role)
                        ? {
                            command:
                              "printf 'DSH wrote this file.\\n' > verified.txt",
                            description:
                              'Write a test file inside the workspace',
                          }
                        : {
                            file_path: 'verified.txt',
                            content: 'DSH wrote this file.\n',
                          },
                    ),
                  },
                },
              ],
            });
            emit({}, 'tool_calls');
          }
        } else {
          emit({ role: 'assistant', content: '本地集成验证完成。' }, 'stop');
        }
        res.end('data: [DONE]\n\n');
      });
      await new Promise((r) => provider.listen(0, '127.0.0.1', r));
      const logs = [];
      let run;
      try {
        const result = await new Promise((resolve) => {
          run = new DshRun({
            task: { id: 'fixture-task-01', role, workspace },
            assistant,
            config: {
              model: 'deepseek-v4-flash',
              roleInstructions: Object.fromEntries(
                Object.entries(ROLES).map(([k, v]) => [k, v.instructions]),
              ),
            },
            dataDir,
            env: {
              DEEPSEEK_API_KEY: 'local-fixture-key',
              DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
            },
            onLog: (text) => logs.push(text),
            onResult: (text) => logs.push(text),
            onDone: (status, error) =>
              resolve({ status, error, closed: run.closed }),
          });
          void run.start(
            '这是隔离的测试工作目录。请创建 verified.txt，内容为 DSH wrote this file.',
          );
        });
        assert.equal(
          result.status,
          'completed',
          result.error + '\n' + logs.join('\n'),
        );
        assert.equal(
          result.closed,
          true,
          'completion must follow actual process close',
        );
        if (role !== 'no-tools')
          assert.equal(
            fs.readFileSync(path.join(workspace, 'verified.txt'), 'utf8'),
            'DSH wrote this file.\n',
          );
        const tools = calls[0].tools.map((t) => t.function.name);
        assert.equal(tools.includes('write'), role !== 'no-tools');
        assert.equal(
          tools.includes('bash'),
          ['developer', 'custom'].includes(role),
        );
        if (assistant) {
          assert.ok(!tools.includes('web_search'));
          assert.ok(!tools.includes('web_fetch'));
          assert.match(
            JSON.stringify(calls[0].messages),
            /CUSTOM_ASSISTANT_PERSONA/,
          );
          assert.match(JSON.stringify(calls[0].messages), /assistant-workflow/);
          assert.match(
            fs.readFileSync(
              path.join(
                dataDir,
                'runs/fixture-task-01/skills/assistant-workflow/SKILL.md',
              ),
              'utf8',
            ),
            /CUSTOM_WORKFLOW/,
          );
        }
        assert.ok(calls.length >= (role === 'no-tools' ? 1 : 2));
        assert.ok(logs.some((t) => t.includes('本地集成验证完成')));
        assert.ok(!logs.join('\n').includes('local-fixture-key'));
      } finally {
        if (run?.child && !run.child.killed) {
          run.kill();
          await new Promise((r) => {
            if (run.child.exitCode !== null) return r();
            run.child.once('close', r);
          });
        }
        await new Promise((r) => provider.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
