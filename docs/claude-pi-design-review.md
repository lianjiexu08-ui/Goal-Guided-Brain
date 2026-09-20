# Claude Code 与 pi 设计调研

调研对象：Claude Code 官方文档（2026-09）与 [pi coding agent](https://github.com/earendil-works/pi)（原 badlogic/pi-mono）。目标是为本项目的统一 CLI 和工作台提取可复用的设计，不复制两个产品的品牌、私有提示词或模型专属行为。

## 结论

Claude Code 的核心优势是治理：设置有明确作用域和优先级，权限可以按工具和参数匹配，Hook 在工具调用前后提供确定性拦截，Skills 和 Subagents 有清晰的加载边界。官方文档将 Hook 定义为命令、HTTP、MCP 工具、提示词或子代理，并覆盖会话、每轮和每次工具调用等生命周期节点。[Claude Code Hooks](https://code.claude.com/docs/en/hooks)

pi 的核心优势是可组合：核心保持小，交互、打印、JSON、RPC 和 SDK 共用同一 AgentSession；扩展可以注册工具、命令、事件、Provider、UI 和自定义压缩策略。它用追加式 JSONL 会话树支持恢复、分支和完整历史保留。[pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)

本项目已经具备多供应商路由、加密凭据、任务组、MCP 网关、Skills/插件、隔离 worktree/snapshot 和检查点。下一阶段应吸收两者的“核心抽象”，而不是继续堆网页表单：先把 CLI、网页和远程节点统一到一个可恢复的 Agent Core，再补治理和扩展接口。

## 值得吸收的设计

### 1. 设置作用域与可解释优先级（Claude Code）

Claude Code 区分用户、共享项目、项目本地和组织托管设置，命令行只覆盖当前会话；列表字段合并而不是静默覆盖，并通过 `/status` 显示实际加载来源。[Settings](https://code.claude.com/docs/en/settings)

建议采用：

```text
managed > cli-session > project-local > project-shared > user > defaults
```

在本项目中对应：`~/.dsh/settings.json`、项目 `.dsh/settings.json`、不入 Git 的 `.dsh/settings.local.json`、CLI 的 `--settings`。配置解析结果要保留 `source`，在 CLI 的 `/status` 和网页管理界面展示“哪个文件生效”。

### 2. 把 Hook 做成确定性策略层（Claude Code）

Claude Code 的 `PreToolUse` 可以在参数生成后、工具执行前阻止调用；`PostToolUse`、失败事件、SessionStart、Stop、PreCompact 等事件用于审计和自动化。Hook 输入是结构化 JSON，有超时和明确的阻止语义；普通错误与策略拒绝分开处理。[Hooks reference](https://code.claude.com/docs/en/hooks)

当前项目已经解析一部分插件 Hook，但仍有“读取并诊断”多于“可靠执行”的情况。建议建立统一事件总线：

```text
session.start
prompt.submit
tool.before
permission.request
tool.after / tool.error
subagent.start / subagent.stop
context.before_compact / context.after_compact
session.stop / session.error
```

每个 Hook 只返回 `allow`、`deny`、`ask`、`modify` 或 `continue`，并记录超时、来源、版本和决定。Shell/HTTP/MCP 三种执行器先做，提示词型 Hook 后做。任何“安全约束”必须走 Hook 或权限策略，不能只写进系统提示词。

### 3. Skills 的渐进式披露（Claude Code + pi）

两者都采用 `SKILL.md` 作为可移植格式。Claude Code 只把 Skill 描述放入常驻上下文，真正的正文在调用时载入；Skill 可以带参考文档和脚本，并用 `disable-model-invocation`、`user-invocable` 控制谁能触发。[Skills](https://code.claude.com/docs/en/skills)

建议将本项目现有 Skill 从“启动时全部挂载目录”推进为三层：

1. 常驻索引：名称、描述、版本、摘要、所需能力。
2. 调用时正文：只注入当前 Skill 的 `SKILL.md`。
3. 按需资源：参考文档和脚本只作为可读路径，不自动塞进上下文。

增加 `userInvocable`、`modelInvocable`、`allowedTools`、`arguments` 和 `context` 字段。部署、推送、发送消息等有副作用的 Skill 默认只能由用户显式触发。

### 4. 文件化 Subagent 与隔离执行（Claude Code）

Claude Code 用 Markdown + YAML frontmatter 定义 Subagent，配置包含模型、工具、禁用工具、权限模式、Skill、最大轮数和 `isolation: worktree`；工作目录检查会阻止子任务绕回主 checkout。[Subagents](https://code.claude.com/docs/en/sub-agents)

当前项目已有角色、任务组、依赖、远程节点和 worktree，缺的是一个简单可移植的定义格式。建议支持：

```text
.dsh/agents/reviewer.md
~/.dsh/agents/reviewer.md
```

frontmatter 至少包括 `name`、`description`、`model`、`tools`、`disallowedTools`、`workspaceMode`、`maxTurns` 和 `skills`。文件变更后刷新索引，不必重启 CLI；真正执行仍创建现有 task/attempt，沿用预算、租约、检查点和权限继承。

### 5. Agent Core 与外壳解耦（pi）

pi 的 AgentSession 同时服务交互模式、打印模式、JSON、RPC 和 SDK，统一管理消息、模型、工具、事件、压缩和会话文件。[SDK](https://github.com/pi0/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)

当前项目的 `server/runtime.mjs`、HTTP API 和 React 状态之间仍存在工作台语义耦合。建议抽出 `server/agent-core.mjs`：

- 输入：Session、ModelRoute、ToolRegistry、PermissionPolicy、Workspace。
- 输出：统一事件流 `turn_start`、`text_delta`、`tool_call`、`tool_result`、`usage`、`turn_end`、`error`。
- 消费者：网页、统一 CLI、RPC、远程节点适配器。

这样可以让 `dsh -p`、交互 TUI、网页和后台任务共享行为，而不是各自实现一套轮询和错误处理。

### 6. 追加式会话树、恢复与分支（pi）

pi 的会话以 JSONL 保存，每条记录有 `id` 和 `parentId`；`/tree` 可以在历史节点切换，`/fork` 创建分支，完整历史仍保留。数据库只需要维护索引和当前投影，重放会话才是权威状态。[Sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session.md)

当前项目的 `sessions` 表是线性会话，任务结果作为摘要回填。建议新增 append-only `session_entries`：

```text
session, message, model_change, tool_call, tool_result,
checkpoint, compaction, branch_summary, custom
```

SQLite 继续作为查询索引，但恢复、审计和分支以事件记录为准。这样可以实现 `/continue`、`/fork`、失败后从工具调用前重试，以及网页和 CLI 之间无损切换。

### 7. 结构化自动压缩，而不是简单截断（pi）

pi 在达到 `contextWindow - reserveTokens` 前自动压缩，保留最近消息、生成结构化摘要，并记录读过和修改过的文件；分支切换使用 Branch Summary。完整 JSONL 历史仍保留。[Compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)

当前项目主要依赖有限的历史任务摘要。建议把压缩作为 Agent Core 的能力：

- 保留最近完整工具调用对，不能切断 tool call/tool result。
- 摘要固定包含目标、约束、决策、修改文件、验证证据、未完成事项。
- 记录 `tokensBefore`、`firstKeptEntryId` 和摘要模型用量。
- 压缩失败时保留原上下文并停止继续调用，不静默丢历史。

### 8. 扩展 SDK 与 Provider 注册（pi）

pi 扩展可以注册自定义工具、命令、快捷键、事件、UI、Provider 和压缩逻辑，并以 npm/git 包分发；项目和用户目录都能加载扩展。它明确警告扩展拥有完整系统权限。[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

本项目现有能力包已做摘要固定、哈希和 MCP 网关隔离，但还没有统一的 TypeScript Extension API。建议先定义受限版本：

```ts
export default function (dsh: DshExtensionAPI) {
  dsh.registerTool(...)
  dsh.registerCommand(...)
  dsh.on('tool.before', ...)
  dsh.registerProvider(...)
}
```

扩展必须经过能力包安装、摘要固定、启用和权限审查；不要直接执行任意 npm 包的 install script。Provider 应能声明协议、模型目录、OAuth/API-key 获取器、上下文窗口、工具/视觉能力和价格。

### 9. Trust 与最小默认工具（pi）

pi 对项目级设置、Skill、扩展和包安装引入 project trust；默认只给模型 `read`、`write`、`edit`、`bash` 四个基础工具，再由工具选项扩展 `grep/find/ls`。[pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)

建议把当前的助手级工具布尔开关细化为：项目信任状态、工具 allowlist、路径范围、命令模式和外部操作授权。读取 `.env`、网络、部署、推送和消息发送应有独立规则；默认拒绝未知 MCP 写操作。现有 capability gateway 的实例权限模型可以作为底层执行器。

### 10. JSONL/RPC/SDK 作为 CLI 的一等接口（pi）

pi 提供交互、一次性打印、JSON 事件和 RPC 模式。RPC 支持 steering/follow-up，用户可以在模型工作时追加指令，而不是强制取消当前轮。

当前 CLI 已支持一次性调用和 SSE，但还应增加：

- `dsh --mode json`：每行一个稳定事件，便于 CI 和 IDE。
- `dsh --mode rpc`：stdin/stdout JSONL，支持 `prompt`、`steer`、`follow_up`、`abort`。
- `dsh --continue`、`--session`、`--fork`。
- 事件中包含 `sessionId`、`taskId`、`provider`、`model`、`usage` 和 `workspace`，禁止输出密钥。

## 不建议照搬

- Claude Code 的私有系统提示词、模型专属分类器和云端账号策略不可作为本项目基础。
- 直接允许第三方 Hook、扩展或 npm 包拥有全机权限；必须经过本项目现有的摘要固定、凭据隔离、节点边界和审批。
- pi 的“默认不内置子代理和计划模式”适合极简工具，但本项目已定位为协作工作台，应保留任务组、预算、检查点和租约，只把调用界面做得更轻。
- 不要把所有历史都拼回每次请求；采用事件日志 + 可验证压缩摘要，必要时从原始分支重建。

## 建议实施顺序

### P0：统一 Agent Core（最高收益）

1. 事件类型和 JSONL session entry schema。
2. CLI、网页、后台任务共用 Agent Core 事件流。
3. `--mode json` 和基础 RPC。
4. `--continue`、`--session`、`--fork`。

### P1：治理和上下文

1. `.dsh/settings.json` 作用域、优先级和 `/status`。
2. `tool.before/after` Hook 与 allow/ask/deny 决策。
3. 项目 trust、路径规则和命令规则。
4. 自动压缩、分支摘要、文件变更证据。

### P2：可移植扩展

1. 文件化 Subagent frontmatter 和热加载。
2. Skill 渐进式披露、显式/模型调用控制。
3. Extension API、Provider 注册和签名/固定版本包。
4. OAuth 登录适配与模型目录刷新。

验收标准应是同一任务在 CLI、网页和 RPC 中产生相同的事件、权限决定、用量统计和可恢复会话；模型切换、断线、压缩和分支不能丢失工具结果或扩大权限。
