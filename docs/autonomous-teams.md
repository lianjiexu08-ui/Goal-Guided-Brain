# 自治团队：目标驱动的自动招募与高风险多轮评审

> 本文记录"让 GGB 自己根据需求招募智能体干活"这次迭代的决策、行为变化和边界。与 [项目全景说明](project-overview.md) 配合使用。

## 目标

把团队从"项目经理生成方案后必须等用户点确认"推向"**目标驱动的自治团队**"：用户（或上游团队）给出一个目标，项目经理澄清、组队、自动确认并开始执行；同时对高风险操作加上更严格的**多轮评审**。

## 四个行为变化

### 1. 招募审核开关（`requireReview`，默认开）

- 每个团队空间新增 `requireReview` 字段，**默认 `true`（需要人工审核 Team Charter）**，保持现有行为。
- 在创建团队的表单中可关闭（"招募方案需要我确认"取消勾选）。关闭后：
  - 项目经理调用 `propose_team` 且方案 `ready`（无 `openQuestions`）时，系统**自动确认并创建成员**，`phase` 直接进入 `confirmed`。
  - 自动确认复用与人工确认完全相同的校验与落地逻辑（`ControlPlane.applyRecruitmentProposal`），不会绕过角色存在性、能力启用、模型工具兼容性等检查。
  - 自动确认会在团队动态写入一条 `senderType: 'system'` 的可追溯消息（"已按自治招募策略自动创建 N 名成员并开始协作"）。
  - **自动确认失败时**（如绑定了未启用的能力、模型不可用），不中断流程：把失败原因回写进方案的 `openQuestions`，方案停留在 `proposed`，交给项目经理修复后重试。
- `propose_team` 的返回包含 `phase` 与 `autoConfirmed`，项目经理据此判断是"继续等用户确认"还是"直接开始拆解任务"。

### 2. 移除预算限制

- 任务/任务组的 Token **预算默认不限制**（`budgetTokens` 默认 `null`）。只有显式传入有效预算时才生效，调度层只在 `spent >= budgetTokens`（且为有效整数）时才可能标记 `budget-exceeded`。
- 团队自治配置不再包含 `budgetTokens`、`maxJobs` 字段；跨团队委派不再受固定"目标团队任务数上限"约束。
- **保留两道与金额无关的防失控保险丝**：
  - **委派深度 ≤ 4**：防止任务链无限自我复制、跨团队委派成环。
  - **单任务组任务数 ≤ 32**：防止单个任务组无限膨胀。
  - 这两个上限限制的是"递归/规模失控"，不是"花钱"，因此与"不考虑预算"不冲突。

### 3. 高风险操作多轮评审

外部操作（`begin_operation`）命中高风险规则时，进入**多轮评审链**，全部通过前 `canExecute=false`：

| 轮次 | 主体 | 说明 |
| --- | --- | --- |
| `pm` | 发起操作的项目经理/实例 | 登记操作意图与影响面，自动记为自评通过。 |
| `reviewer` | **与发起实例不同的主体** | 独立复核；发起实例不能复核自己。 |
| `owner` | 用户本人 | 仅当团队 `review.requireOwnerApproval !== false`（默认）时需要；必须由 owner 在接口/界面确认。 |

- **高风险判定**：操作 `action` 命中团队自定义 `review.highRiskActions`、`autonomy.requireApprovalKinds`，或默认高风险词（`deploy`/`release`/`publish`/`delete`/`send`/`payment`/`external-write`/`production`，大小写不敏感、子串匹配）。普通操作（如 `read-files`、`push` 分支评审等）不进入评审，直接可执行。
- 任一一轮 `reject`：操作置为 `failed`，记录拒绝原因，写入 `operation-rejected` 待处理事项，不能再继续评审或执行。
- 评审记录保存在 `reviews` 集合，可通过 `/api/operations/:id/review`（POST，提交一轮）与查询接口查看进度。
- 运行中的智能体可用编排 MCP 工具 `list_operation_reviews`（只读进度）与 `submit_operation_review`（提交一轮复核）；`owner` 轮只能由用户执行，智能体调用会被拒绝。

### 4. 跨团队协作纳入自治

- 源团队 PM 通过 `delegate_to_team` 直接发起跨团队委派（仍受 `collaboration.enabled` / `allowedTeamIds` / 目标团队须 `confirmed`+`active` 约束）。
- 由于目标团队招募也可自动确认（见 1），跨团队链路可端到端自动跑通：源 PM 委派 → 目标团队（自动）招募/确认 → 执行 → 结果回传源团队。
- 移除了目标团队固定任务数上限（见 2）；委派本身若是高风险动作，仍走多轮评审（见 3）。

## 配置参考

团队空间新增/调整的字段：

```jsonc
{
  "requireReview": true,                 // 招募审核开关，默认 true
  "review": {
    "reviewerProviderId": null,           // 复核建议使用的供应商（区别于 PM 供应商）
    "reviewerModel": null,                // 复核建议模型
    "highRiskActions": null,              // 自定义高风险动作词；null 用默认集合
    "requireOwnerApproval": true          // 高风险是否必须所有者确认，默认 true
  },
  "autonomy": {
    "mode": "auto",                       // assist | auto
    "maxDepth": 4,                        // 委派深度保险丝（保留）
    "requireApprovalKinds": []            // 追加的高风险动作词
  }
}
```

## 与供应商配置的关系

多轮评审的 `reviewer` 轮设计目标是"由不同于发起方的供应商独立复核"。系统在进入评审时会**自动派发一个复核任务并路由到与发起实例不同的供应商**（`reviewerRoute` / `spawnReviewer`）：

- 优先使用团队 `review.reviewerProviderId` / `review.reviewerModel` 指定的复核供应商与模型。
- 未配置时自动选一个与发起实例不同的启用供应商（发起方供应商从执行快照/任务路由记录中读取），实现跨供应商复核。
- 复核任务的 `providerIds`/`modelOverride` 会写入任务快照，确保路由不被默认模型覆盖。
- 只配了一个可用供应商时无法做到跨供应商复核：复核路由降级为 `distinct: false`，不再自动派发复核任务，需由另一实例或用户人工复核。

配置了多个供应商（如 Kimi K3 / Gemini / GPT）时即可获得真正的跨供应商独立复核。

## 边界

- 自动确认不等于放权高风险操作：发布/部署/删除/发送/外部写入等仍需多轮评审，且默认需所有者确认。
- 深度与任务组规模上限仍然存在，作为自治系统的防失控保险丝。
- `reviewer` 轮的跨供应商复核在配置了多个供应商时自动生效；只有一个供应商时降级为同供应商，需人工或另一实例复核。

## 自维护 Skill 库（skills-hub）

开发场景的能力可以按需从团队自维护的 Skill 库增强，不需要任何收费中介或 API key：

- 仓库：`https://github.com/lianjiexu08-ui/skills-hub`，条目索引在 `catalog.json`。
- GGB 能力中心的搜索源新增 `hub`（可用 `WORKBENCH_SKILL_HUB` 指向内部镜像），直接读 `catalog.json` 并按关键词过滤。
- 安装仍走现有安全闸门：从条目自带的 GitHub tree URL 拉取 → 计算摘要并固定版本 → `assessCapabilityRisk` 评估 → 用户确认后才绑定。安装后默认不启用，也不影响已运行任务。
- 纯指令类 Skill 评估为低风险；含命令、Hook 或 MCP 的包会提升风险等级并要求逐项确认。

当前包含：`engineering-workflow`、`code-review`、`bug-fix`、`project-map`、`verification-gate`、`change-impact`、`task-orchestration`。仓库自带 `npm run check` 校验元数据并检查禁用术语。

## 跨团队共享上下文（共享记忆层）

除了 handoff 消息，双向协作的团队之间现在可以共享一份**结构化的上下文记忆**：

- 智能体用编排 MCP 的 `share_context`（发布/更新）与 `read_shared_context`（读取）共享关键决定、可复用结论、产物索引和状态。条目按 `(团队, key)` 唯一，更新需带 `expectedRevision` 防并发覆盖。
- **可见性边界**：只有两个方向都允许协作（`collaborationAllowed` 双向成立）的团队才互相可见共享条目；单向允许或关闭协作的团队完全看不到对方内容。
- 未确认招募的团队不能发布；没有双向协作团队时发布会拒绝并提示。
- 任务启动时，`contextFor` 会把当前团队可见的共享上下文（最多 10 条）以只读参考形式注入执行上下文，帮助成员感知其它团队的结论；注入失败不影响任务启动。

## 失控防护：死循环熔断与结果收网

参考伯克利《Why Do Multi-Agent LLM Systems Fail?》对多智能体失败模式的归纳，针对两类最高频的失控场景加了规则层防护（不依赖模型自评）：

- **死循环熔断（失败模式 #3 步骤死循环）**：同一执行实例连续 4 次以**相同工具 + 相同参数**调用时，判定为空转，自动暂停任务、撤销执行权限、标记 `blockedReason: 'loop-detected'`，并写入 `loop-detected` 待处理事项提醒你介入——不再任由实例空转烧 token。检测在事件流（本地与远程节点共用）上进行。
- **结果收网（失败模式 #5 不知何时终止）**：成员提交产物后，系统比对其职责中提取的交付物名词；当可识别的交付物均被产物覆盖时，在待处理事项写入一条 `wrap-up`（"交付物已齐备，建议汇总结论"），提醒项目经理核对证据并收尾，而不是做完还在尬聊。同一任务组只提醒一次。

## 自动验证门禁

任务的 `completed` 只代表执行结束。为了让"是否可交付"有硬证据，完成时会**自动探测项目类型并运行检查**（默认开启）。

### 行为

| 情况 | 结果 |
| --- | --- |
| 所有检查通过 | 写入 `verified` 验证证据，交付进入"待验收" |
| 任一检查失败 | 立即停止后续检查，写 `failed` 证据并产生 `verification` 待处理事项 |
| 工具或依赖缺失、超时 | 记为 `unavailable`：不算通过，也不误判为失败 |
| 未识别出项目类型 | 不伪造证据，只记录 `verification/skipped` 事件 |
| 非本地节点 / 目录被隔离 / 显式关闭 | 跳过自动验证 |

**"环境不可用"与"真实失败"必须区分**：没装依赖（例如隔离目录没有 `node_modules`）或命令不存在时判为 `unavailable`，避免把环境问题误报成代码问题。

### 探测规则

按项目标志文件识别，只用项目自带的标准入口：

| 生态 | 检查（按快→慢） |
| --- | --- |
| Node | `typecheck` → `lint` → `test` → `build`（按 `package.json` scripts 存在与否；识别 npm/pnpm/yarn/bun） |
| Python | `pytest` → `ruff` → `mypy`（按配置存在与否） |
| Go | `go vet` → `go build` → `go test` |
| Rust | `cargo check` → `cargo test` |
| JVM | `mvn test` / `gradle test` |
| 其他 | 有 `Makefile` 且定义了 `check`/`test` 时用 `make` |

Node 的 `test` 会带 `CI=1`，避免 watch 模式挂住。monorepo 只跑根级脚本并给出提示。

### 配置

```jsonc
// PUT /api/settings
{ "verification": { "mode": "auto", "timeoutMs": 300000, "maxChecks": 8 } }
```

- `mode`: `auto`（默认）或 `off`
- `timeoutMs`: 单项检查超时，5s–30min
- `maxChecks`: 单次最多执行几项，1–16

任务级关闭：创建任务时传 `autoVerify: false`。

### 接口

- `GET /api/workspaces/:taskId/profile`：返回探测到的检查计划（只读取，不执行）。
- `POST /api/workspaces/:taskId/verify`：`{ auto: true }` 使用探测计划；或传 `command` + `args` 手动验证。

### 边界

- 自动验证只在本机执行目录中运行；远程节点跳过。
- 只运行标准检查入口，不执行安装、部署或发布类命令。
- 验证结论写入产物，仍由验收流程决定是否接受；自动验证通过不等于已验收。

## Skill 推荐（让能力库真正被用上）

有了 200 个 Skill 之后，问题变成"该绑哪个"。平台提供本地推荐，不调用模型：

- 编排 MCP：`recommend_skills { query, limit }`
- HTTP：`GET /api/capabilities/recommend?q=<任务描述>&limit=8`
- 项目经理在招募阶段用它挑选成员能力，再绑定。

### 候选来源与绑定方式

| source | 含义 | 怎么用 |
| --- | --- | --- |
| `builtin` | 角色内置 Skill | 写进成员的 `skillIds` |
| `installed` | 已安装并启用的能力 | 写进 `capabilityIds`（用返回的 `capabilityId`） |
| `hub` | 自维护库中尚未安装 | **需先安装并通过审批**，不能在提案里假定可用 |

推荐只给建议，不安装、不授权。已安装的 Hub 技能会合并到同一条目（用技能名做身份键），展示用中文标题，同时给出可直接绑定的 `capabilityId`。

### 匹配方式

- ASCII 词 + 中文 2/3-gram + 领域别名展开（如"合同→legal/contract"）。
- 字段权重：ID 4 / 标题 3 / 分类 2 / 描述 1。
- 逆文档频率降权：在多数条目都出现的词（"数据""使用"）不会主导排序。
- 无关查询返回空，不硬凑结果。

## 影响面分析（高风险变更的硬约束）

任务完成后按 diff 自动判定变更风险，高风险必须由所有者确认影响面才能验收。

### 判定规则（纯规则，不依赖模型）

| 风险 | 触发条件 |
| --- | --- |
| 高 | 迁移/`.sql`/schema、认证授权会话、凭据密钥加密、CI/部署/容器配置；或改动文件数 ≥ 80 |
| 中 | 依赖与构建配置、对外接口/路由/OpenAPI、配置文件；或改动文件数 ≥ 25；或有文件删除 |
| 低 | 其他改动；无变更 |
| 未知 | 没有 Git 基准或无法读取差异（不假装低风险） |

新文件（未 `git add`）同样计入，否则新模块会被漏判。

### 行为

- 生成 `kind: 'impact'` 证据（含风险、原因、类别、文件统计）。
- 高风险：产生 `impact` 待处理事项；向**双向协作**的团队发送一次通知（按任务幂等）；验收被阻止，直到 `POST /api/tasks/:id/impact/ack`。
- 低/中风险：只记录，不打扰。
- 影响分析证据不计入交付证据数量（`evidenceCount` 只统计产物与验证）。

### UI

- 任务详情显示"变更影响"卡片：等级、原因、文件统计；高风险时提供"确认已评估影响面"按钮。
- 能力中心支持「按任务描述推荐」：输入描述 → 返回内置 / 已安装 / Hub 三类建议；Hub 项一键安装，内置与已安装项直接说明绑定方式。

### 招募自动填充

`propose_team` 默认按成员职责调用推荐：
- 内置 Skill → 自动写入 `skillIds`（最多 2 个）
- 已安装且**低风险**的能力 → 自动写入 `capabilityIds`（最多 2 个）
- 中/高风险能力与未安装的 Hub 项 → 只作为 `recommendations` 返回，不写入权限
- `autoRecommend: false` 可关闭

自动填充不会绕过确认：确认时仍会执行既有的能力风险逐项确认。
