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

## 跨团队共享上下文（共享记忆层）

除了 handoff 消息，双向协作的团队之间现在可以共享一份**结构化的上下文记忆**：

- 智能体用编排 MCP 的 `share_context`（发布/更新）与 `read_shared_context`（读取）共享关键决定、可复用结论、产物索引和状态。条目按 `(团队, key)` 唯一，更新需带 `expectedRevision` 防并发覆盖。
- **可见性边界**：只有两个方向都允许协作（`collaborationAllowed` 双向成立）的团队才互相可见共享条目；单向允许或关闭协作的团队完全看不到对方内容。
- 未确认招募的团队不能发布；没有双向协作团队时发布会拒绝并提示。
- 任务启动时，`contextFor` 会把当前团队可见的共享上下文（最多 10 条）以只读参考形式注入执行上下文，帮助成员感知其它团队的结论；注入失败不影响任务启动。
