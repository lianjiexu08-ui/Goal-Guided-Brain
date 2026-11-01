# GGB 平台可靠性改进方案（v1）

来源：JustClick 5 轮迭代开发暴露的 6 类平台缺陷复盘（2026-11）。
原则：交付的可信性必须建立在**机制**上，不依赖模型自觉。

## 1. 结构化验收清单（Acceptance Checklist）— 堵"凑数测试/漏活"

问题：验证门禁只查"测试是否通过"，不查"测试是否覆盖需求"。迭代 5 中国站点规则 0 条但 smoke 全绿。

机制：
- 任务创建/派活时，验收标准登记为 `acceptance-checklist` 记录：
  `{ taskId, items: [{ id, requirement, verifyHint, status: 'pending'|'met', evidence: { test, command, hash, note } }] }`
- MCP 工具 `submit_acceptance_evidence`：agent 交付时逐条挂证据（可附测试名/命令/hash）
- 验收门禁：`accept` 时若存在 checklist 且有未 met 条目 → 409 拒绝（附未满足清单）；owner 显式 `force: true` 可越过但记录
- CLI：`ggb task checklist <id>` 查看；`ggb task accept` 输出清单状态
- 上下文注入：PM/developer 的任务上下文自动附 checklist（要求"交付说明逐条对应"）

## 2. 交付快照协议（Delivery Snapshot）— 堵"旧代码转录/目录漂移"

问题：两轮汇总实例工作区是旧代码；沙箱转录丢行。

机制：
- 任务完成（completed）时平台自动对其 execution workspace 生成**快照清单**：
  `delivery-snapshot` 记录 `{ taskId, root, files: [{ path, sha256, size }], createdAt }`（排除 node_modules/.git）
- MCP 工具 `sync_delivery`：把指定 taskId 的快照**平台侧复制**到当前实例 workspace（绕过沙箱只读限制，幂等，按 manifest 校验 hash）
- 汇总/后续任务上下文自动注入环境卡（见 #6）：最新交付快照的 taskId + 路径 + 文件数 + "用 sync_delivery 同步，不要手工转录"
- `submit_artifact` 补充 contentHash 字段

## 3. 生命周期集成测试 — 堵"实战才炸"

把实战 bug 固化为回归测试套件：
- 重启 → vault 自动解锁（.vault_pass 0600）→ 派活成功
- 团队换 workspace → PM 会话重绑 → 消息派活不再被拒
- 端口占用 → 友好错误 + 退出码 1（不半死）
- cli.mjs 静态卫兵：脚本内引用的 child_process 方法必须已导入（spawn/ExecFile）

## 4. 影响分析降噪

- `package.json` 变更细查 diff：仅 dependencies/devDependencies 实质变化才算「依赖变更」；纯版本号/description 变化 → 移除该因子
- 首行：风险因子逐项列出，避免"配置变更"一票 high

## 5. 浏览器 E2E 档位

- verification.mjs：探测 `package.json` 的 `scripts.e2e` → 验证结论增加 e2e 档（跑 `npm run e2e`，同 test 档待遇）
- JustClick 侧（团队实施）：Playwright + chromium --load-extension + 本地 mock ATS 页面（tests/fixtures），覆盖 iframe/shadow/中国站点弹窗

## 6. 环境卡自动注入 + 标题

- 任务上下文注入环境卡：执行目录绝对路径、基线版本（package.json version）、测试基线（上次验证 pass 数）、交付快照提示、父目录只读警告——消灭"只读探测"轮次
- 任务标题取 prompt 首个非空行的前 120 字符（原 60 太短不可辨）

## 顺序
4 → 6 → 3 → 2 → 1 → 5（5 与 1-4 并行：JustClick 侧由团队实施）
