# 主流编码智能体工具调研与 GGB 优化方案

> 调研对象：Claude Code、OpenAI Codex CLI、pi coding agent、OpenClaw。
> 前提假设：**Token 用量不受限**。这会改变优化方向——不再节省调用次数，而是把 Token 换成质量：更长的迭代循环、更多并行探索、更多轮交叉评审、更完整的证据链。
> 与 [claude-pi-design-review.md](claude-pi-design-review.md) 互补：那份聚焦架构抽象（Agent Core、Hook、会话树），本篇聚焦**执行策略层**。

## 1. 四个工具的核心模式对比

| 模式 | Claude Code | Codex CLI | pi | OpenClaw | GGB 现状 |
| --- | --- | --- | --- | --- | --- |
| 长迭代 agentic loop | ✅ 核心循环：写→跑测试→读报错→修，直到通过 | ✅ 同样以"测试通过"为循环出口 | ✅ AgentSession 多轮循环 | ✅ 常驻循环 | ⚠️ 单轮任务为主，靠检查点续接 |
| 上下文自动压缩 | ✅ auto-compact + PreCompact Hook | ✅ 历史摘要 | ✅ 结构化压缩，保留最近工具对 + Branch Summary | ✅ 会话压缩 | ❌ 无压缩，靠任务摘要回填 |
| Plan / 探索先行 | ✅ Plan Mode（只读探索→出方案→批准后执行） | ✅ 先读代码库再给 diff | ⚠️ 不内置，可扩展 | ✅ 任务规划 | ⚠️ PM 澄清阶段有，执行阶段无 |
| 并行子代理 | ✅ Subagents + `isolation: worktree` | ✅ 云端并行任务 | ❌ 有意不做（靠扩展） | ✅ 多 agent | ⚠️ 有任务组/依赖，但成员基本串行 |
| 多轮评审/交叉验证 | ⚠️ 靠子代理 reviewer 模式 | ⚠️ 靠 code review 流程 | ❌ | ✅ 多 agent 互审 | ✅ 高风险操作三轮评审（独有优势） |
| Mid-turn steering | ⚠️ 需打断 | ⚠️ 需打断 | ✅ RPC `steer`/`follow_up` | ✅ 消息注入 | ❌ 只能阻塞后重新发送（409 机制） |
| 会话树/分支/恢复 | ✅ `--resume`/`--fork` | ✅ session resume | ✅ JSONL 追加式会话树，`/tree` `/fork` | ✅ | ❌ 线性 sessions 表 |
| 记忆文件 | ✅ CLAUDE.md 分层 | ✅ AGENTS.md | ✅ AGENTS.md + skills | ✅ | ⚠️ 有知识库，但非 agent 自动维护 |
| 确定性治理（Hook/权限） | ✅ 最强 | ⚠️ 沙箱审批 | ✅ project trust + 最小工具集 | ⚠️ | ✅ capability gateway + 评审链（独有优势） |

**结论**：GGB 的治理层（评审链、capability gateway、证据链）领先于这四个工具；短板集中在**执行策略层**——循环深度、上下文管理、并行度和 steering。在"Token 不限"的前提下，这些短板恰恰是最值得投入的，因为它们全都靠"多花 Token"换质量。

## 2. 优化方案（按收益排序）

### P0-1 执行循环升级：从"单轮交付"到"验证驱动循环"

现状：`platform.mjs` 中任务执行一轮产出即 `completed`，验证是事后环节（`verification/skipped` 常见）。

改进：给开发类任务引入 **verify-loop**（Claude Code / Codex 的核心出口条件）：

```text
执行 → 自验（运行测试/构建）→ 失败则读错误、修复、再验
     → 连续 N 次失败或达到 maxTurns 才转 failed，保留全部尝试轨迹
```

- `maxTurns`（如 15）和"连续同签名工具调用"熔断（已有 `loop-detected`，保留）作为唯一护栏；预算不设限。
- 每轮失败→修复作为独立 `attempt-turn` 事件入库，验收证据自动包含"经过几轮才通过"，这本身就是质量信号。
- 验收标准：`completed` 任务的验证通过率显著上升；`verification/skipped` 事件需要 PM 说明理由。

### P0-2 结构化上下文压缩（pi 模式）

现状：无压缩机制，长会话只能靠截断或检查点。Token 不限意味着**上下文窗口成为唯一稀缺资源**，压缩是必需品而非省钱手段。

- 在 Agent Core（设计评审文档的 P0）内实现：接近 `contextWindow - reserveTokens` 时自动触发。
- 摘要固定结构：目标、约束、已做决定、修改过的文件、验证证据、未完成事项。
- 保留最近完整 tool call/result 对，不允许切断；原始 JSONL 全量保留，摘要可追溯（`tokensBefore`、`firstKeptEntryId`）。
- 压缩失败 → 停止继续调用并告警，不静默丢历史。

### P0-3 Plan-then-Execute（Claude Code Plan Mode）

执行阶段前插入**只读探索轮**：

1. 成员先以只读权限（read/grep/ls，无 write/bash 写操作）探索代码库和现状。
2. 产出简短执行计划（改哪些文件、验证命令、风险点），作为 `plan` 事件入库。
3. PM 或用户批准后切到写权限执行。

收益：大幅减少"改错方向后浪费整轮"的情况；计划本身成为可审计证据；Token 成本在无限前提下可忽略。

### P1-1 并行子任务 + worktree 扇出（Claude Code Subagents / Codex 云并行）

现状：任务组有依赖图但成员执行基本串行。

- 无依赖的子任务默认并行执行，各自在独立 worktree（已有隔离机制，直接复用）。
- PM 汇总阶段做**三方合并评审**：并行产物的整合由 PM 在主 worktree 统一验证。
- 保险丝沿用现有约束：委派深度 ≤4、单任务组 ≤32 任务。

### P1-2 多样本 + 交叉评审（无限 Token 的独特红利）

这是预算受限工具做不到、GGB 评审链基础最好的方向：

- **关键子任务多采样**：同一子任务用 2~3 个不同模型（或同模型不同温度）并行执行，PM 比较结果择优或合成，落选方案保留为证据。
- **评审面板**：现有高风险三轮评审（pm/reviewer/owner）扩展出可选的 `panel` 轮——2 个与发起实例不同模型/供应商的 reviewer 独立复核，意见分歧时升级到 owner。`review.reviewerProviderId` 已有雏形，扩展成 `reviewerPanel: [{providerId, model}]`。
- **对抗验证**：交付前由一个"红队"实例专门尝试找出产物缺陷（跑边界用例、检查未处理错误），发现问题回炉。验收证据中记录红队轮次与结论。

### P1-3 Mid-turn steering（pi RPC 模式）

现状：PM 轮次进行中新消息返回 `409 blocked`，用户只能等。

- 在执行实例上开放 `steer` 通道：运行中注入用户/PM 消息，作为下一轮上下文追加，不打断当前工具调用。
- 网页团队对话的"阻塞/重新发送"升级为"插话（steer）"和"追加（follow_up）"，409 仅保留给真正不可并发的招募阶段。

### P2-1 会话树与分支（pi JSONL 模式）

按设计评审文档 P0 落地 append-only `session_entries` 后，叠加：

- 失败任务从"最后一次成功工具调用前"分叉重试，而不是整任务重来。
- `/fork` 支持对同一任务尝试两种方案并行比较。

### P2-2 自动维护的团队记忆（AGENTS.md 模式）

现状：知识库靠用户手动维护。

- 每个团队空间自动维护 `TEAM_MEMORY.md`：项目结构、构建/测试命令、已踩过的坑、用户偏好修正。由 PM 在任务收尾时增量更新，作为执行上下文常驻注入（替代部分重复的检查点回放）。
- 分层：`~/.dsh/MEMORY.md`（用户全局）> 团队空间 > 项目 `.dsh/MEMORY.md`，与设计评审中的 settings 作用域方案一致。

### P2-3 模型质量级联（扩展现有路由回退）

现状：回退只针对**连接失败**（405/503）。

- 增加**质量回退**：verify-loop 连续失败 N 轮后，重试时自动升级到更强的候选模型（路由表已有 ordered routing，直接扩展），并把升级原因记入 `routing/fallback` 事件。
- 结合多样本：便宜模型先跑，失败后强者接力——无限 Token 下这纯粹是省时间和提高成功率。

## 3. 不建议做的

- **不取消治理护栏**：Token 不限 ≠ 权限放宽。委派深度、评审链、capability gateway 必须保留，这是 GGB 相对四个工具的核心差异。
- **不做无限重试**：verify-loop 必须有 maxTurns 和 loop-detected 熔断，否则"无限 Token"会变成"无限空转"。
- **不把全部历史拼回每次请求**：压缩 + 事件日志才是正确姿势，上下文窗口终究有限。

## 4. 实施顺序

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| P0 | verify-loop、结构化压缩、plan-then-execute | 无（可在现有 runtime 内先行） |
| P1 | 并行子任务扇出、多样本+评审面板、steering | P0 的 verify-loop 与事件模型 |
| P2 | 会话树分叉重试、团队记忆、质量级联路由 | 设计评审文档的 Agent Core / session_entries |

**统一验收标准**：同一开发任务在开启新策略后——验证通过率上升、返工轮次可追溯、并行不产生合并事故、评审分歧可升级、所有新增 Token 消耗都对应可检查的证据事件。
