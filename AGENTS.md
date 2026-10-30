# AGENTS.md

给在此仓库工作的智能体/人类的快速交接文档。保持更新：行为以代码和测试为准。

## 项目一句话

Goal-Guided Brain（GGB）：多团队多模型智能体协作工作台。用户描述目标 → 项目经理澄清并组队（Team Charter）→ 成员用授权模型/能力执行 → 证据与验收回填团队空间。

## 常用命令

```bash
npm run dev          # 开发模式（UI + API）
npm test             # 后端确定性套件（~46s，274 项，完全离线）
npm run test:e2e     # Playwright 浏览器基线（54 项，~6 分钟，需先装 chromium）
npm run lint         # oxlint（必须零错误）
npm run typecheck    # tsc --noEmit
npm run build        # vinext 生产构建
npm run stop         # 停止本地服务（UI :3088 / API :3089）
```

CI（GitHub Actions）对每次推送跑三阶段：quality / unit / e2e，必须保持全绿。

## 架构地图

| 位置 | 职责 |
| --- | --- |
| `server/index.mjs` | HTTP 入口、路由、认证边界；入站集成回调在 owner 鉴权**之前**（自带密钥校验） |
| `server/platform.mjs` | 编排核心：任务启动/调度、`contextFor` 上下文组装（压缩→团队记忆→丰富→共享上下文）、verify-loop 钩子、steer/fork、集成出口接线 |
| `server/control.mjs` | 控制平面：任务组/依赖/租约、Team Charter、评审链（pm→reviewer(面板)→owner）、计划/样本/记忆的 MCP 后端 |
| `server/runtime.mjs` | `DshRun`：与 DSH 引擎子进程通信（JSON-RPC）、verify-loop 重试、追加式 session-entries |
| `server/providers.mjs` | 供应商路由（ordered routing + 健康探测 + excludeModels 质量级联） |
| `server/integrations.mjs` | 集成出口层：渠道适配器（webhook/企微/飞书/钉钉/QQ OneBot/bridge）、出站投递留痕、入站校验与限流 |
| `server/compaction.mjs` | 结构化上下文压缩与分支摘要（纯函数） |
| `server/memory.mjs` | 团队记忆（TEAM_MEMORY）读写与备份包 |
| `server/store.mjs` | SQLite + 团队空间/任务的存取与归一化（saveTeamSpace 有字段白名单） |
| `server/records.mjs` | 通用 records 表（collection + JSON data）；`listByTask` 走表达式索引 |
| `app/page.tsx` | 网页工作台主界面（团队招募/对话/时间线） |
| `app/management.tsx` | 管理界面（模型/能力/集成出口/任务详情含插话与会话分叉） |
| `scripts/cli.mjs` | `ggb` CLI |
| `tests/*.test.mjs` | 后端确定性测试（node:test，每文件独立进程） |
| `tests/e2e/` | Playwright 基线（真实后端，desktop+mobile 两个 project） |

## 硬性不变量（改动前必读）

1. **证据优先**：`completed` ≠ 验收通过。验证输出写成 `verification` 产物；需求变更使旧证据失效。
2. **权限最小化**：智能体只能用已绑定能力；高风险操作必须走评审链；入站消息不授予权限。治理层是 GGB 的差异化优势，**不要为了简化而绕过**。
3. **可恢复**：任务通过新实例 + 检查点恢复，不假装复活失联进程。
4. **会话条目追加式**：session-entries 只追加不改写；fork 用分支摘要不重放历史。
5. **回滚语义**：restore.mjs 的 database/vault/team-memory 交换各有独立回滚块，**新增 companion 时三处都要覆盖**（staging 候选、before 备份、catch 回滚），否则会吞掉 database 回滚（有测试拦截）。

## 测试约定

- 后端测试**完全离线、确定性**：不许真实网络调用（Hub 用本地 fixture 服务器 + 环境变量注入）、不许真实 sleep 依赖（用轮询等待）。
- 时间敏感断言用 `waitFor`/轮询模式；并行负载下固定短 sleep 会偶发失败。
- Windows/POSIX 差异：符号链接用 junction（`isSymbolicLink` 语义相同）；`fsync` 目录与只读句柄在 Windows 会 EPERM；文件 mode 位断言（0o600）只在上 POSIX 生效；路径比较注意 JSON 转义与分隔符。
- 新行为必须有对应测试；`npm test` 与 e2e 都要绿再提交。
- 12 个 skipped 是平台守卫（有跨平台替代断言），保持这个状态。
- **E2E fixture 纪律（血泪教训，2026-10 连红 7 次的根因）**：
  - Playwright 的 **webServer 先于 globalSetup 启动**——server 进程先打开 workspace.sqlite；globalSetup 里**删除重建目录**会造成 inode 分裂（Linux 上 server 句柄指向隐形旧文件，worker 新库与 server 完全隔离，51+ 项失败）。global-setup 只 mkdir，不删除。
  - E2E 共享单一 fixture 目录与库：**任何 spec 里直接写库或通过 HTTP 建全局资源都会污染后续测试**（例如建 provider 会破坏 setup-wizard 的“全新环境”断言）。写 fixture 前先确认它不会跨测试泄漏。
  - E2E 必须用 **dev 服务器**（见已知边界的 vinext 缓存条目）。
  - 移动视口（393px）下顶栏空间紧张：新增顶栏元素必须做移动端适配（条件渲染而非 CSS media，见全局搜索框的 `{!isMobile && ...}`）。

## 协作约定（多会话并行开发）

- main 为受 CI 保护的集成分支：推送前必须 `npm test` + lint 本地全绿；e2e 由 CI 兜底。
- 多个 agent 会话同时工作时，大特性（>200 行或新增依赖）应推功能分支并发 PR，小修复可直接推 main。
- 推送被拒（non-fast-forward）时先 `git pull --rebase`，冲突以测试与文档为准协商解决。
- 每个提交说明必须包含行为变化与验证方式（跑了哪些测试）。

## 已知边界

- `server/store.mjs saveTeamSpace` 对 review/recruitment 等做字段白名单归一化——新增团队字段要同步白名单。
- task-meta 在裸 `ControlPlane`（单测）下字段不全（workspaceMode 等），完整链路只在 platform 的 `newTask` 落盘。
- `records.list()` 按集合全量返回（DESC）；按 taskId 的热点查询用 `listByTask`。
- outbound 集成密钥在 GET/PUT 中掩码，回传 `***` 前缀视为"保留旧值"。
- **vinext 生产模式（`vinext start`）对动态 API/RSC payload 有缓存语义**：直接写库的测试 fixture 在已启动的生产服务器上不可见，E2E 必须用 dev 服务器（`playwright.config.mjs` 有注释）。生产部署下的缓存策略是待深挖的产品问题。
