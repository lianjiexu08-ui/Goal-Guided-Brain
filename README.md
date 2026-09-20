# Goal-Guided Brain

Goal-Guided Brain 是一个服务个人目标的智能协作工作空间，使用 DSH 运行模型与工具。支持多个模型供应商、助手协作、隔离开发目录、Skill/MCP/插件、服务器资料、定时任务和监控。可以纯本地部署，也可以由云端控制端调度出站连接的执行节点。

## 启动

需要 Node.js 22.19+（建议 24+）、Git，以及安装好的 `dsh`。当前开发验证使用 macOS、Node.js 26.8.1 和 DSH 0.1.2-rc.1。Windows 执行节点使用 WSL2。

```sh
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:3088>。API 默认监听本机 3089。`npm run dev` 启动开发模式；`npm run stop` 停止生产启动脚本。macOS 可双击 `启动工作台.command`。

也可以直接使用统一 CLI，不打开网页。兼容命令为 `dsh`，项目品牌命令为 `goal-guided-brain`：

```sh
npm link
export GEMINI_API_KEY=...
dsh run --provider gemini --model gemini-2.5-flash "总结当前项目"
echo "设计一个缓存方案" | dsh run --provider claude
dsh run --session refactor "先分析这个模块"
dsh run --session refactor --continue "继续重构并运行测试"
dsh chat --provider claude --session personal
dsh providers
```

CLI 预设支持 `gemini`、`claude`、`codex`、`kimi` 和 `deepseek`。`dsh chat` 提供持续对话，支持 `/new`、`/session`、`/help` 和 `/exit`。密钥只从对应环境变量读取（也可临时使用 `--api-key`），不会自动写入文件；`--no-stream` 返回完整结果，`--json` 输出稳定的 `turn_end` JSON 事件。`--session` 将对话追加保存为 JSONL，`--continue` 恢复最近会话（默认目录 `~/.dsh/sessions`，可用 `DSH_SESSION_DIR` 覆盖），历史最多带入最近 20 轮或 80,000 字符。也可通过 `--base-url` 接入自托管或兼容接口。

在模型管理中创建加密凭据库、保存 API Key，再添加供应商和模型。协议支持 DeepSeek、OpenAI Chat Completions、OpenAI Responses、Anthropic Messages；可填写自定义 HTTPS 地址，本机确定性接口可用 HTTP。模型测试会实际发送请求，费用由对应供应商收取。

助手可配置工作规范、工具、能力绑定、供应商候选顺序和执行节点。默认并发 3，每次执行默认最多 30 分钟，任务组默认共享 200,000 Token 预算。用量按模型上报事件累计；达到预算后停止当前任务组，无法预先阻止一个尚未返回用量的模型请求。费用按输入/输出每百万 Token 单价估算，未填单价显示未知。

## 功能

产品方向和个人智能体行为约定见 [个人智能体方向](docs/personal-agent.md)；它把个人习惯、模型路由、记忆边界和风险确认作为稳定内核，把模型供应商作为可替换执行引擎。

- **助手与会话**：新建、复制、编辑、归档及恢复；每个助手有稳定通信 ID。原有助手、任务、会话和知识继续保留。
- **多团队 Chat**：每个 Chat 都可以绑定一个长期团队，例如运维团队、产品团队或多个独立开发团队；团队拥有自己的职责、成员、项目经理、工作目录、模型路由和自治模式。用户从 Chat 切换团队并提出需求，项目经理在团队内自驱推进；获准的团队之间可以通过受控协作请求交接任务。团队动态页用于查看拆解、成员状态和结果。设计说明见 [团队智能体空间](docs/team-agent-workspace.md)。
- **模型**：按能力与候选顺序路由；Chat 可以按团队直接切换已配置的供应商和模型，选择会持久化并写入任务执行快照。认证失败禁用路由，网络故障可切换供应商。工具已开始执行时不自动重跑整个任务。
- **协作任务**：主子任务、依赖、共享任务板、持久收件箱、回复、检查点、成果和待处理事项。需求变更提升版本，旧成果进入待复核状态。
- **开发验收**：有基准提交的 Git 项目使用 worktree，无提交项目使用独立快照。支持差异检查、内部提交、验证证据和集成目录，源目录及未提交内容不被自动覆盖。
- **能力中心**：集中管理 Skill、MCP 和 Plugin，支持检索 SkillsMP、ClawHub、官方 MCP Registry，安装自定义仓库或本机能力包。固定版本与摘要，绑定到助手后会注入对应 Skill 或 MCP 工具；智能体可通过 `list_capabilities` 查看本次执行实际可用的能力，并通过 `run_capability_command` 排队执行已绑定且允许调用的 Plugin 命令。固定版本支持禁用、升级和回退，市场可能要求认证或受可用性限制。
- **MCP**：stdio、Streamable HTTP 工具调用；工具允许列表与具体参数审批。首版外部 MCP 均在控制端连接或运行，远程节点通过实例凭证访问网关。
- **资源**：保存项目目录、服务器别名、地址、端口、用户名、备注和凭据引用。
- **定时监控**：固定间隔、Cron、时区、执行预览、补跑一次、默认不重叠；HTTP/TCP/模型/MCP 检查。站内通知和 Webhook 仅在异常或恢复时投递，投递记录持久化并有限重试。
- **项目记忆**：知识作用域、来源、历史版本、删除及可阅读 Markdown 导出。

## 数据、恢复与凭据

默认数据目录为 `~/.dsh-workbench/`，可用 `WORKBENCH_DATA_DIR` 指定独立目录。`WORKBENCH_UI_PORT`、`WORKBENCH_API_PORT` 修改端口；`DSH_EXECUTABLE` 指定 DSH。

| 内容     | 位置与用途                                                       |
| -------- | ---------------------------------------------------------------- |
| SQLite   | `workspace.sqlite`，任务、会话、配置、消息、租约、调度及版本记录 |
| 加密凭据 | `vault.json`，Argon2id 派生密钥、AES-256-GCM；不保存解锁口令     |
| 执行目录 | `runs/<taskId>/`，独立运行配置、Home、日志、临时资料             |
| 能力版本 | `capabilities/<id>/<digest>/package/`，任务固定内容摘要          |
| 知识导出 | `knowledge/*.md`，数据库为编辑权威，直接改文件不会反向导入       |
| 备份     | `backups/`，SQLite 一致性备份及配套的加密凭据副本                |

升级前自动创建 SQLite 一致性备份；版本迁移在事务中进行。不要通过运行中的数据库文件复制代替备份功能。离线恢复、失败回滚和云端单次迁移见 [备份恢复说明](deploy/backup-restore.md)。一个数据目录只允许一个控制端持有写入权。

旧版 DeepSeek 环境变量或 DSH 凭据仍可读取。界面提供显式导入旧凭据：加密保存并验证后移除工作台自己的旧 `secrets.json`，不会修改外部 DSH 配置或用户环境变量。旧 settings API 写入密钥也必须先解锁凭据库。

恢复采用检查点交接，由新实例、新目录继续。租约失效的实例不能覆盖当前结果，状态不明的操作需核验，不自动重复执行。关闭浏览器不停止任务；纯本地部署在电脑离线后无法运行，云端常驻需要另行部署。

## 权限与兼容边界

云端登录、HTTPS、Linux 常驻服务、节点配对和 WSL2 安装见 [部署说明](deploy/README.md)。`WORKBENCH_VAULT_PASSWORD` 可从部署环境提供无人值守解锁材料，不能与密文备份一起存储。

MCP 非只读工具按实例和参数精确授权，发送身份由实例凭证推导。服务器的 `readOnlyHint` 是信任声明，无法把恶意服务器变成安全代码。启用终端、Skill 脚本或 Hook 等同于运行第三方代码；任务授权和环境变量隔离不等同于虚拟机隔离。推送、部署、消息发送按用户授予任务的权限执行。

插件导入展示逐项兼容结果，导入成功不表示原平台全部行为可用。首版覆盖 Skills、MCP、可转换的命令与助手模板，以及已验证的同步命令 Hooks。MCP Resources/Prompts、LSP、平台专属界面和依赖原平台运行的组件仍不支持；Skills.sh、Smithery 的认证接入尚未交付。

## 验证与进度

```sh
DEEPSEEK_API_KEY=local-fixture-key npm test
npm run lint
npm run typecheck
npm run build
```

测试使用临时数据库、本地确定性模型、MCP 服务和真实安装的 DSH，不调用付费模型。覆盖数据迁移、加密凭据、协议认证与工具调用、降级、持久消息、节点断线、迟到结果、目录隔离、定时幂等、通知重试及恢复。

计划及逐项验收记录见 [阶段计划](docs/phase-2-plan.md)。macOS 本机验证不代替 Linux、Windows/WSL2 或真实云端 HTTPS 的平台验收；没有目标环境的项目继续标记待验证。
