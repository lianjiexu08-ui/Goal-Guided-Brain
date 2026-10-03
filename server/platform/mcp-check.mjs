import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { redact } from '../runtime.mjs';

const nowIso = () => new Date().toISOString();

/**
 * Create the MCP capability probe used by the platform and automation layer.
 *
 * Keeping transport setup, pagination limits, and health persistence together
 * makes the platform orchestration module independent from MCP SDK details.
 * The returned function deliberately keeps the platform's existing contract:
 * it resolves to a redacted health object or throws a redacted error.
 */
export function createMcpChecker({ records, vault }) {
  return async function checkMcp(id) {
    const capability = records.get('capabilities', id);
    if (capability?.kind !== 'mcp') throw new Error('MCP 连接不存在。');
    const credential = (ref) => {
      const value = vault.get(ref);
      if (!value) throw new Error('MCP 引用的凭据不存在。');
      return value;
    };
    const secrets = [
      ...Object.values(capability.envRefs || {}).map(credential),
      ...(capability.credentialId ? [credential(capability.credentialId)] : []),
    ];
    const client = new Client({
      name: 'dsh-workbench-check',
      version: '1.0.0',
    });
    const transport =
      capability.transport === 'stdio'
        ? new StdioClientTransport({
            command: capability.command,
            args: capability.args,
            stderr: 'ignore',
            env: Object.fromEntries(
              Object.entries(capability.envRefs || {}).map(([key, ref]) => [
                key,
                credential(ref),
              ]),
            ),
          })
        : new StreamableHTTPClientTransport(new URL(capability.url), {
            requestInit: {
              headers: capability.credentialId
                ? {
                    Authorization: `Bearer ${credential(capability.credentialId)}`,
                  }
                : {},
            },
          });
    const start = Date.now();
    try {
      await client.connect(transport, { timeout: 15000 });
      const tools = [],
        cursors = new Set();
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          timeout: 15000,
        });
        tools.push(
          ...page.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            ...(typeof tool.annotations?.readOnlyHint === 'boolean'
              ? { readOnlyHint: tool.annotations.readOnlyHint }
              : {}),
          })),
        );
        cursor = page.nextCursor;
        if (tools.length > 2000 || (cursor && cursors.has(cursor)))
          throw new Error('MCP 工具目录超过限制或分页游标重复。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const cleanTools = JSON.parse(redact(JSON.stringify(tools), secrets));
      const result = {
        ok: true,
        tools: cleanTools,
        checkedAt: nowIso(),
        latencyMs: Date.now() - start,
      };
      records.save('capabilities', { ...capability, health: result }, id);
      return result;
    } catch (error) {
      const message = redact(error.message, secrets);
      records.save(
        'capabilities',
        {
          ...capability,
          health: { ok: false, error: message, checkedAt: nowIso() },
        },
        id,
      );
      throw new Error(message);
    } finally {
      await client.close();
    }
  };
}
