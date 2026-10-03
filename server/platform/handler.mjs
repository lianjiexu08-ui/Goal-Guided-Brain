import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { assessCapabilityRisk, inspectBundle } from '../capabilities.mjs';
import { scheduleNextTimes } from '../automation.mjs';
import { command } from '../workspaces.mjs';
import { backupDatabase } from '../migrations.mjs';
import { approveToolRequest } from '../capability-gateway.mjs';
import { modelMetrics } from '../metrics.mjs';
import { resolveApiKey, redact } from '../runtime.mjs';

const statuses = new Set(['queued', 'running', 'waiting', 'state_unknown']);
const text = (v, max = 32000) =>
  String(v || '')
    .trim()
    .slice(0, max);
const shellQuote = (value) => `'${String(value).replace(/'/g, `"'"'`)}'`;
const nowIso = () => new Date().toISOString();

export function createPlatformHandler({
  records,
  store,
  dataDir,
  attachments,
  vault,
  providers,
  automation,
  capabilities,
  manage,
  checkMcp,
  newTask,
  schedule,
  control,
  runs,
  workspaces,
  backups,
  saveLegacyCredential,
  validateTaskAcceptance,
  recordTaskAcceptance,
}) {
  async function handle({ method, parts, body, req, query, principal }) {
    const [collection, id, action] = parts;
    const ok = (body, status = 200) => ({ status, body });
    if (collection === 'manage' && method === 'GET') return ok(manage());
    if (collection === 'metrics' && id === 'models' && method === 'GET')
      return ok(modelMetrics(store, query));
    if (collection === 'drafts') {
      const spaceId =
        (method === 'GET' ? query.get('spaceId') : body.spaceId) || null;
      const roleId = (method === 'GET' ? query.get('role') : body.roleId) || '';
      if (typeof spaceId !== 'string' && spaceId !== null)
        throw new Error('草稿团队无效。');
      if (typeof roleId !== 'string' || !roleId.trim())
        throw new Error('草稿所属助手不能为空。');
      const normalizedRoleId = roleId.trim();
      const role = store.role(normalizedRoleId);
      if (!role || role.archived)
        throw new Error('草稿所属助手不存在或已归档。');
      if (spaceId) {
        const space = store.teamSpace(spaceId);
        if (!space) throw new Error('草稿所属团队不存在。');
        if (space.status !== 'active')
          throw new Error('草稿所属团队当前不可编辑。');
        if (!space.memberRoleIds.includes(normalizedRoleId))
          throw new Error('该助手不属于当前团队。');
      }
      const publicDraft = (draft) =>
        draft
          ? {
              ...draft,
              attachments: attachments.list(draft.attachmentIds),
            }
          : {
              spaceId,
              roleId: normalizedRoleId,
              content: '',
              attachmentIds: [],
              attachments: [],
            };
      if (method === 'GET') {
        return ok(publicDraft(store.teamDraft(spaceId, normalizedRoleId)));
      }
      if (method === 'DELETE') {
        const expectedRevision = Number.isSafeInteger(body.revision)
          ? body.revision
          : undefined;
        try {
          return ok({
            ok: store.removeTeamDraft(
              spaceId,
              normalizedRoleId,
              expectedRevision,
            ),
          });
        } catch (error) {
          if (error.status !== 409) throw error;
          return ok(
            {
              error: error.message,
              draft: publicDraft(store.teamDraft(spaceId, normalizedRoleId)),
            },
            409,
          );
        }
      }
      if (method === 'PUT' || method === 'POST') {
        const attachmentIds = attachments.validateIds(
          body.attachmentIds,
          spaceId,
        );
        try {
          const draft = store.saveTeamDraft(
            {
              spaceId,
              roleId: normalizedRoleId,
              content: body.content,
              attachmentIds,
            },
            Number.isSafeInteger(body.revision) ? body.revision : undefined,
          );
          return ok(publicDraft(draft));
        } catch (error) {
          if (error.status !== 409) throw error;
          return ok(
            {
              error: error.message,
              draft: publicDraft(store.teamDraft(spaceId, normalizedRoleId)),
            },
            409,
          );
        }
      }
    }
    if (collection === 'vault' && method === 'POST') {
      if (id === 'lock') return ok(vault.lock());
      if (id === 'initialize' || id === 'unlock') {
        const result = await vault[id](body.passphrase);
        void schedule();
        return ok(result);
      }
      if (id === 'import-legacy') {
        const legacyFile = path.join(dataDir, 'secrets.json');
        const legacy = fs.existsSync(legacyFile)
          ? JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
          : null;
        const value = legacy?.apiKey || resolveApiKey(dataDir);
        if (!value) throw new Error('没有可导入的旧版密钥。');
        const result = await saveLegacyCredential(value);
        if (legacy?.apiKey === value) fs.rmSync(legacyFile);
        return ok({ ...result, removedLegacyFile: !!legacy?.apiKey });
      }
    }
    if (collection === 'credentials') {
      if (method === 'GET') return ok(vault.list());
      if (method === 'POST' && (action === 'probe' || id === 'probe')) {
        const secret = id && id !== 'probe' ? vault.get(id) : body.value;
        if (!secret) throw new Error('凭据内容为空或凭据不存在。');
        const kind =
          body.kind ||
          (id && id !== 'probe'
            ? vault.list().find((e) => e.id === id)?.kind
            : 'api_key') ||
          'api_key';
        const targetUrl =
          typeof body.targetUrl === 'string' && body.targetUrl.trim()
            ? body.targetUrl.trim()
            : '';
        const started = Date.now();

        // 探测逻辑
        try {
          if (targetUrl) {
            const parsed = new URL(targetUrl);
            const resp = await fetch(parsed.href, {
              method: 'GET',
              headers: { Authorization: `Bearer ${secret}` },
              signal: AbortSignal.timeout(10000),
            });
            return ok({
              ok: resp.ok,
              status: resp.status,
              latencyMs: Date.now() - started,
              message: resp.ok
                ? '自定义地址测试成功'
                : `服务返回状态码 HTTP ${resp.status}`,
              checkedAt: nowIso(),
            });
          }

          if (kind === 'ssh_key') {
            const hasHeader = /BEGIN [A-Z0-9_-]+ PRIVATE KEY/i.test(secret);
            return ok({
              ok: hasHeader,
              latencyMs: Date.now() - started,
              message: hasHeader
                ? 'SSH 私钥格式有效'
                : '私钥内容缺少标准标头 (BEGIN ... PRIVATE KEY)',
              checkedAt: nowIso(),
            });
          }

          // 默认尝试针对常见 API 进行探测或检测 Key 格式
          // 1. 如果匹配 sk-ant- (Anthropic)
          if (secret.startsWith('sk-ant-')) {
            const resp = await fetch('https://api.anthropic.com/v1/models', {
              headers: {
                'x-api-key': secret,
                'anthropic-version': '2023-06-01',
              },
              signal: AbortSignal.timeout(10000),
            });
            return ok({
              ok: resp.ok,
              status: resp.status,
              latencyMs: Date.now() - started,
              message: resp.ok
                ? 'Anthropic 凭据校验通过'
                : `Anthropic 返回 HTTP ${resp.status}`,
              checkedAt: nowIso(),
            });
          }

          // 2. 如果包含 AIza (Gemini)
          if (secret.startsWith('AIza')) {
            const resp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models?key=${secret}`,
              {
                signal: AbortSignal.timeout(10000),
              },
            );
            return ok({
              ok: resp.ok,
              status: resp.status,
              latencyMs: Date.now() - started,
              message: resp.ok
                ? 'Gemini 凭据校验通过'
                : `Google API 返回 HTTP ${resp.status}`,
              checkedAt: nowIso(),
            });
          }

          // 3. 通用 OpenAI / DeepSeek 兼容探测
          const testEndpoint =
            secret.startsWith('sk-') &&
            secret.length > 40 &&
            !secret.startsWith('sk-proj-')
              ? 'https://api.deepseek.com/models'
              : 'https://api.openai.com/v1/models';

          const resp = await fetch(testEndpoint, {
            headers: { Authorization: `Bearer ${secret}` },
            signal: AbortSignal.timeout(10000),
          });

          if (resp.ok) {
            return ok({
              ok: true,
              status: resp.status,
              latencyMs: Date.now() - started,
              message: 'API Key 连通并验证通过',
              checkedAt: nowIso(),
            });
          }

          // 如果因为 401 失败
          if (resp.status === 401 || resp.status === 403) {
            return ok({
              ok: false,
              status: resp.status,
              latencyMs: Date.now() - started,
              message: `认证失败 (HTTP ${resp.status})，请检查 Key 是否有效`,
              checkedAt: nowIso(),
            });
          }

          return ok({
            ok: resp.status < 500,
            status: resp.status,
            latencyMs: Date.now() - started,
            message: `接口响应 HTTP ${resp.status}`,
            checkedAt: nowIso(),
          });
        } catch (err) {
          return ok({
            ok: false,
            latencyMs: Date.now() - started,
            message:
              err.name === 'TimeoutError'
                ? '请求连接超时'
                : redact(err.message, [secret]),
            checkedAt: nowIso(),
          });
        }
      }
      if (method === 'POST' || method === 'PUT')
        return ok(await vault.put(body, id));
      if (method === 'DELETE') return ok({ ok: vault.remove(id) });
    }
    if (collection === 'providers') {
      if (method === 'GET') return ok(providers.list());
      if (method === 'POST' && action === 'sync-models')
        return ok(await providers.syncModels(id));
      if (method === 'POST' && action === 'probe')
        return ok(await providers.probe(id, body));
      if (method === 'POST' || method === 'PUT')
        return ok(providers.save(body, id));
      if (method === 'DELETE') return ok({ ok: providers.remove(id) });
    }
    if (collection === 'resources') {
      if (method === 'GET') return ok(records.list(collection));
      if (method === 'POST' && (action === 'probe' || id === 'probe')) {
        const row = id && id !== 'probe' ? records.get(collection, id) : null;
        const resData = { ...row, ...body };
        const started = Date.now();
        if (resData.kind === 'project') {
          const p = resData.path ? path.resolve(resData.path) : '';
          if (!p) throw new Error('项目路径不能为空。');
          const exists = fs.existsSync(p);
          if (!exists) {
            return ok({
              ok: false,
              latencyMs: Date.now() - started,
              message: `路径不存在：${p}`,
              checkedAt: nowIso(),
            });
          }
          const isDir = fs.statSync(p).isDirectory();
          const hasGit = fs.existsSync(path.join(p, '.git'));
          return ok({
            ok: isDir,
            latencyMs: Date.now() - started,
            message: isDir
              ? `项目目录有效${hasGit ? '（已检测到 Git 仓库）' : ''}`
              : `路径不是目录：${p}`,
            checkedAt: nowIso(),
          });
        }
        const host = resData.host ? String(resData.host).trim() : '';
        const port = Number(resData.port || 22);
        if (!host) throw new Error('服务器地址不能为空。');
        const probeResult = await new Promise((resolve) => {
          const socket = new net.Socket();
          socket.setTimeout(4000);
          socket.on('connect', () => {
            socket.destroy();
            resolve({ ok: true });
          });
          socket.on('timeout', () => {
            socket.destroy();
            resolve({ ok: false, error: `连接 ${host}:${port} 超时` });
          });
          socket.on('error', (err) => {
            socket.destroy();
            resolve({ ok: false, error: err.message });
          });
          socket.connect(port, host);
        });
        return ok({
          ok: probeResult.ok,
          latencyMs: Date.now() - started,
          message: probeResult.ok
            ? `TCP 连通成功 (${host}:${port})`
            : `连接失败: ${probeResult.error}`,
          checkedAt: nowIso(),
        });
      }
      if (method === 'DELETE')
        return ok({ ok: records.remove(collection, id) });
      if (['POST', 'PUT'].includes(method)) {
        const previous = id ? records.get(collection, id) : {};
        const row = {
          ...previous,
          name: text(body.name, 120),
          kind: body.kind || 'server',
          host: text(body.host, 300),
          port: Number(body.port || 22),
          username: text(body.username, 100),
          credentialId: text(body.credentialId, 150),
          path: text(body.path, 2000),
          notes: text(body.notes, 10000),
        };
        if (
          !row.name ||
          !['server', 'project'].includes(row.kind) ||
          !Number.isInteger(row.port) ||
          row.port < 1 ||
          row.port > 65535
        )
          throw new Error('资源名称、类型或端口无效。');
        return ok(records.save(collection, row, id));
      }
    }
    if (collection === 'workflows') {
      if (method === 'GET') return ok(records.list(collection));
      if (method === 'DELETE')
        return ok({ ok: records.remove(collection, id) });
      if (['POST', 'PUT'].includes(method)) {
        if (
          !text(body.name) ||
          !Array.isArray(body.steps) ||
          !body.steps.length ||
          body.steps.length > 20 ||
          body.steps.some((s) => !store.role(s.role) || !text(s.prompt))
        )
          throw new Error('工作流需要名称和 1 至 20 个有效步骤。');
        return ok(
          records.save(
            collection,
            {
              name: text(body.name, 120),
              steps: body.steps.map((s) => ({
                role: s.role,
                prompt: text(s.prompt),
              })),
            },
            id,
          ),
        );
      }
    }
    if (collection === 'capabilities') {
      if (method === 'GET' && id === 'search')
        return ok(
          await capabilities.search(query.get('source'), query.get('q')),
        );
      if (method === 'POST' && id === 'install')
        return ok(await capabilities.install(body));
      if (method === 'GET' && action === 'components')
        return ok(capabilities.components(id));
      if (method === 'POST' && action === 'run-command')
        return ok(
          newTask(capabilities.commandTask(id, body.commandId, body)),
          201,
        );
      if (method === 'POST' && action === 'import-agent')
        return ok(capabilities.importAgent(id, body.agentId, body), 201);
      if (method === 'POST' && action === 'import-mcp')
        return ok(capabilities.importMcp(id, body.entryId, body), 201);
      if (method === 'POST' && action === 'probe')
        return ok(await checkMcp(id));
      if (
        method === 'POST' &&
        ['enable', 'disable', 'rollback'].includes(action)
      )
        return ok(
          capabilities.action(id, action, {
            confirmed: body.confirmed === true && principal.type === 'owner',
            enforceReview: true,
            actor:
              principal.type === 'owner'
                ? 'owner'
                : principal.agentId || principal.type,
          }),
        );
      if (method === 'GET') {
        const row = id ? records.get(collection, id) : capabilities.list();
        if (id && row) {
          const audits = records
            .list('capability-audits')
            .filter((item) => item.capabilityId === id)
            .sort((a, b) =>
              String(b.createdAt || '').localeCompare(
                String(a.createdAt || ''),
              ),
            )
            .slice(0, 20);
          return ok({
            ...row,
            risk: assessCapabilityRisk(row),
            audits,
            latestAudit: audits[0] || null,
          });
        }
        return row ? ok(row) : ok({ error: '能力不存在。' }, 404);
      }
      if (method === 'DELETE')
        return ok({ ok: records.remove(collection, id) });
      if (['POST', 'PUT'].includes(method)) {
        if (body.kind === 'skill' && body.content) {
          const capabilityId = id || randomUUID();
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(capabilityId))
            throw new Error('能力 ID 无效。');
          const directory = path.join(
            dataDir,
            'capabilities',
            capabilityId,
            randomUUID(),
            'package',
          );
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          const content = text(body.content, 100000);
          const skillText = /^---\r?\n/.test(content)
            ? content
            : `---\nname: custom-${createHash('sha256').update(capabilityId).digest('hex').slice(0, 8)}\ndescription: Custom assistant workflow\n---\n\n${content}\n`;
          fs.writeFileSync(path.join(directory, 'SKILL.md'), skillText, {
            mode: 0o600,
          });
          const inspection = inspectBundle(directory);
          if (
            body.enabled !== false &&
            assessCapabilityRisk(inspection).requiresReview &&
            !(body.confirmed === true && principal.type === 'owner')
          ) {
            fs.rmSync(directory, { recursive: true, force: true });
            const error = new Error('保存并启用中/高风险能力前需要逐项确认。');
            error.status = 409;
            throw error;
          }
          const old = records.get(collection, capabilityId);
          const savedCustom = records.save(
            collection,
            {
              ...inspection,
              name: text(body.name, 120),
              content,
              path: directory,
              source: 'custom',
              enabled: body.enabled !== false,
              allowHooks: false,
              history: old
                ? [
                    ...(old.history || []),
                    {
                      digest: old.digest,
                      path: old.path,
                      version: old.version,
                      content: old.content,
                    },
                  ].slice(-10)
                : [],
            },
            capabilityId,
          );
          const customRisk = assessCapabilityRisk(savedCustom);
          if (
            savedCustom.enabled &&
            customRisk.requiresReview &&
            body.confirmed === true &&
            principal.type === 'owner'
          )
            capabilities.audit(savedCustom.id, 'enable', {
              actor: 'owner',
              risk: customRisk,
              digest: savedCustom.digest || String(savedCustom.revision || ''),
              confirmed: true,
            });
          return ok(savedCustom);
        }
        const savedCapability = capabilities.save(body, id, {
          confirmed: body.confirmed === true && principal.type === 'owner',
          enforceReview: true,
        });
        const savedRisk = assessCapabilityRisk(savedCapability);
        if (
          savedCapability.enabled &&
          savedRisk.requiresReview &&
          body.confirmed === true &&
          principal.type === 'owner'
        )
          capabilities.audit(savedCapability.id, 'enable', {
            actor: 'owner',
            risk: savedRisk,
            digest:
              savedCapability.digest || String(savedCapability.revision || ''),
            confirmed: true,
          });
        return ok(savedCapability);
      }
    }
    if (collection === 'schedules') {
      if (method === 'POST' && id === 'preview')
        return ok({ times: scheduleNextTimes(body) });
      if (method === 'POST' && action === 'run') {
        const rule = records.get(collection, id);
        if (!rule) throw new Error('定时任务不存在。');
        return ok(automation.trigger(rule, nowIso(), true));
      }
      if (method === 'GET')
        return ok(
          id
            ? {
                ...records.get(collection, id),
                runs: records
                  .list('schedule-runs')
                  .filter((r) => r.scheduleId === id)
                  .slice(0, 100),
              }
            : records.list(collection),
        );
      if (method === 'DELETE')
        return ok({ ok: records.remove(collection, id) });
      if (['POST', 'PUT'].includes(method))
        return ok(automation.saveSchedule(body, id));
    }
    if (collection === 'monitors') {
      if (method === 'GET')
        return ok(
          id
            ? {
                ...records.get(collection, id),
                runs: records
                  .list('monitor-checks')
                  .filter((r) => r.monitorId === id)
                  .slice(0, 100),
              }
            : records.list(collection),
        );
      if (method === 'DELETE')
        return ok({ ok: records.remove(collection, id) });
      if (method === 'POST' && action === 'check') {
        const rule = records.get(collection, id);
        if (!rule) throw new Error('监控不存在。');
        records.save(
          collection,
          { ...rule, manualCheck: true, nextCheckAt: nowIso() },
          id,
        );
        await automation.tick();
        return ok(records.get(collection, id));
      }
      if (['POST', 'PUT'].includes(method))
        return ok(automation.saveMonitor(body, id));
    }
    if (
      collection === 'notifications' &&
      method === 'POST' &&
      action === 'read'
    ) {
      const row = records.get(collection, id);
      if (!row) throw new Error('通知不存在。');
      return ok(
        records.save(collection, { ...row, read: true, readAt: nowIso() }, id),
      );
    }
    if (collection === 'backups') {
      if (method === 'GET') return ok(backups());
      if (method === 'POST' && action === 'restore') {
        if (!backups().some((b) => b.filename === id))
          throw new Error('备份不存在。');
        return ok({
          requiresRestart: true,
          filename: id,
          command: `WORKBENCH_DATA_DIR=${shellQuote(dataDir)} npm run stop\nnode scripts/restore.mjs --backup ${shellQuote(path.join(dataDir, 'backups', id))} --data-dir ${shellQuote(dataDir)}`,
          message: '停止控制端后运行恢复命令；恢复前会再保存当前数据库。',
        });
      }
      if (method === 'POST') {
        const backup = backupDatabase(store.db, dataDir);
        if (fs.existsSync(vault.file))
          fs.copyFileSync(vault.file, `${backup.path}.vault.json`);
        return ok({
          filename: backup.filename,
          bytes: backup.bytes,
          hasVault: fs.existsSync(`${backup.path}.vault.json`),
        });
      }
    }
    if (collection === 'workspaces') {
      if (method === 'GET' && id) return ok(await workspaces.diff(id));
      if (method === 'POST' && action === 'commit')
        return ok(await workspaces.commit(id, body.message));
      if (method === 'POST' && action === 'verify') {
        const workspace = records.get('workspaces', id);
        if (!workspace || workspace.state === 'quarantined' || runs.has(id))
          throw new Error('请等待有效执行目录空闲后再验证。');
        const executable = text(body.command, 1000),
          args = body.args || [];
        if (
          !executable ||
          !Array.isArray(args) ||
          args.some((a) => typeof a !== 'string')
        )
          throw new Error('请提供验证程序和参数列表。');
        const startedAt = nowIso();
        let output = '',
          status = 'verified';
        try {
          output = await command(executable, args, {
            cwd: workspace.path,
            timeout: 120000,
          });
        } catch (error) {
          output = error.message;
          status = 'failed';
        }
        const meta = records.get('task-meta', id) || {};
        const job = meta.jobId ? records.get('jobs', meta.jobId) : null;
        const evidence = records.save('artifacts', {
          taskId: id,
          groupId: meta.groupId || job?.groupId || null,
          requirementVersion: Number(
            job?.requirementVersion || meta.requirementVersion || 1,
          ),
          kind: 'verification',
          name: `${executable} ${args.join(' ')}`,
          status,
          output: redact(output),
          startedAt,
          finishedAt: nowIso(),
          path: workspace.path,
        });
        return ok({
          ...evidence,
          ok: status === 'verified',
          verified: status === 'verified',
        });
      }
      if (method === 'POST' && id === 'integrate')
        return ok(await workspaces.integrate(body.taskIds));
    }
    if (collection === 'tasks' && method === 'POST' && id === 'batch-review') {
      if (principal?.type && principal.type !== 'owner')
        throw Object.assign(new Error('只有所有者可以做出交付验收决定。'), {
          status: 403,
        });
      const rawDecision =
        typeof body.decision === 'string'
          ? body.decision.trim().toLowerCase()
          : '';
      const decision =
        rawDecision === 'accept' || rawDecision === 'accepted'
          ? 'accepted'
          : rawDecision === 'reject' || rawDecision === 'rejected'
            ? 'rejected'
            : '';
      if (!decision) throw new Error('批量复核决定必须是 accept 或 reject。');
      if (!Array.isArray(body.taskIds))
        throw new Error('请提供待复核的任务列表。');
      const taskIds = [
        ...new Set(
          body.taskIds
            .filter((taskId) => typeof taskId === 'string')
            .map((taskId) => taskId.trim())
            .filter(Boolean),
        ),
      ];
      if (!taskIds.length) throw new Error('至少选择一项待复核任务。');
      if (taskIds.length > 50) throw new Error('一次最多复核 50 项任务。');
      const note = text(body.note, 10000);
      const results = [];
      const validated = [];
      for (const taskId of taskIds) {
        const task = store.task(taskId);
        try {
          const delivery = validateTaskAcceptance(task, decision, note);
          validated.push({ task, delivery });
          results.push({ taskId, ok: true });
        } catch (error) {
          results.push({ taskId, ok: false, error: error.message });
        }
      }
      // Batch review is intentionally all-or-nothing. A stale evidence record
      // or a task that changed status must never leave a mixed decision that
      // the owner did not explicitly inspect.
      if (results.some((result) => !result.ok)) {
        return ok(
          {
            ok: false,
            decision,
            results,
            succeeded: 0,
            failed: results.filter((result) => !result.ok).length,
            message: '批量复核未执行，请修正失败项后重新选择。',
          },
          409,
        );
      }
      const items = validated.map(({ task, delivery }) =>
        recordTaskAcceptance(task, decision, note, delivery),
      );
      return ok({
        ok: true,
        decision,
        items,
        results: items.map((item) => ({
          taskId: item.taskId,
          ok: true,
          delivery: item.delivery,
        })),
        succeeded: items.length,
        failed: 0,
      });
    }
    if (
      collection === 'tasks' &&
      method === 'POST' &&
      id &&
      ['accept', 'reject'].includes(action)
    ) {
      if (principal?.type && principal.type !== 'owner')
        throw Object.assign(new Error('只有所有者可以做出交付验收决定。'), {
          status: 403,
        });
      const task = store.task(id);
      const decision = action === 'accept' ? 'accepted' : 'rejected';
      const note = text(body.note, 10000);
      const delivery = validateTaskAcceptance(task, decision, note);
      return ok(recordTaskAcceptance(task, decision, note, delivery));
    }
    if (collection === 'tasks' && method === 'GET') {
      if (id) {
        const task = store.task(id);
        if (!task) return ok({ error: '任务不存在。' }, 404);
        const { context: _context, ...publicTask } = task;
        const artifacts = records
          .list('artifacts')
          .filter((item) => item.taskId === id);
        const delivery = store.taskDelivery(task);
        return ok({
          ...publicTask,
          attachmentIds: records.get('task-meta', id)?.attachmentIds || [],
          attachments: attachments.list(
            records.get('task-meta', id)?.attachmentIds,
          ),
          meta: records.get('task-meta', id),
          workspace: task.workspace,
          executionWorkspace: records.get('workspaces', id),
          snapshot: records.get('runtime-snapshots', id),
          events: records
            .list('task-events')
            .filter((e) => e.taskId === id)
            .slice(0, 100),
          usage: records.list('usage').filter((e) => e.taskId === id),
          artifacts,
          delivery,
          latestVerification: delivery.latestVerification,
          acceptance: delivery.acceptance,
        });
      }
      const offset = Math.max(0, Number(query.get('offset')) || 0),
        limit = Math.min(100, Math.max(1, Number(query.get('limit')) || 50));
      return ok({
        items: store
          .tasks()
          .slice(offset, offset + limit)
          .map(({ context: _c, log: _l, ...t }) => {
            const attachmentIds =
              records.get('task-meta', t.id)?.attachmentIds || [];
            return {
              ...t,
              attachmentIds,
              attachments: attachments.list(attachmentIds),
            };
          }),
        total: store.tasks().length,
      });
    }
    if (collection === 'messages' && method === 'POST' && !id) {
      if (!body.toTaskId && body.toAgentId)
        body.toTaskId = store
          .tasks()
          .find((t) => t.role === body.toAgentId && statuses.has(t.status))?.id;
      body.idempotencyKey ||= randomUUID();
    }
    if (
      collection === 'attention' &&
      method === 'POST' &&
      action === 'resolve'
    ) {
      const item = records.get('attention', id);
      if (item?.kind === 'tool-approval') {
        if (!body.approved)
          return ok(
            records.save(
              'attention',
              { ...item, status: 'dismissed', resolution: 'denied' },
              id,
            ),
          );
        let targetTaskId = item.taskId;
        const task = store.task(targetTaskId);
        if (!task) throw new Error('原执行实例不存在。');
        if (task.status !== 'running') {
          const meta = records.get('task-meta', task.id);
          const next = newTask({
            ...meta,
            role: task.role,
            prompt: task.prompt,
            workspace: task.workspace,
            sessionId: task.sessionId,
            sourceTaskId: task.id,
            contextExtra: `用户已批准特定工具操作：${item.action}。请核验检查点，再继续该操作。`,
            workspaceMode: 'isolated',
          });
          targetTaskId = next.id;
          const job = records.get('jobs', meta.jobId);
          if (job)
            records.save(
              'jobs',
              { ...job, status: 'queued', taskId: next.id },
              job.id,
            );
        }
        const result = approveToolRequest(control, id, targetTaskId);
        const run = runs.get(targetTaskId);
        if (run?.enqueue)
          await run.enqueue(
            '用户已批准待处理的工具操作，请检查工作台记录并继续。',
          );
        return ok(result);
      }
    }
    if (
      collection === 'jobs' &&
      method === 'POST' &&
      !id &&
      Array.isArray(body.steps) &&
      body.steps.length
    ) {
      const job = control.createJob(body, principal);
      const children = body.steps.map((step) =>
        control.createJob(
          {
            ...step,
            parentJobId: job.id,
            workspaceMode: body.workspaceMode || 'isolated',
          },
          principal,
        ),
      );
      return ok({ ...job, children }, 201);
    }
    if (collection === 'jobs' && method === 'GET' && id) {
      const job = records.get('jobs', id);
      if (!job) return ok({ error: '任务不存在。' }, 404);
      const taskIds = records
        .list('task-meta')
        .filter((m) => m.jobId === id || m.groupId === job.groupId)
        .map((m) => m.id);
      const scoped = (collection) =>
        records
          .list(collection)
          .filter(
            (item) =>
              item.groupId === job.groupId ||
              item.jobId === id ||
              taskIds.includes(item.taskId) ||
              taskIds.includes(item.toTaskId),
          );
      return ok({
        ...job,
        job,
        tasks: taskIds.map((taskId) => {
          const {
            context: _context,
            log: _log,
            ...task
          } = store.task(taskId) || {};
          return {
            ...task,
            executionWorkspace: records.get('workspaces', taskId),
            ...(() => {
              const delivery = task.id ? store.taskDelivery(task) : null;
              return delivery
                ? {
                    artifactCount: delivery.evidenceCount,
                    verificationStatus: delivery.hasVerificationEvidence
                      ? delivery.acceptanceStatus
                      : null,
                    deliveryStatus: delivery.deliveryStatus,
                    acceptanceDecision: delivery.acceptanceDecision,
                    acceptanceNote: delivery.acceptanceNote,
                  }
                : {};
            })(),
          };
        }),
        board: scoped('board'),
        artifacts: scoped('artifacts'),
        checkpoints: scoped('checkpoints'),
        messages: scoped('messages'),
        children: records.list('jobs').filter((j) => j.parentJobId === id),
      });
    }
    return control.handle({ method, parts, body, req, query, principal });
  }
  return handle;
}
