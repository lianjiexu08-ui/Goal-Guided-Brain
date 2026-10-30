#!/usr/bin/env node
/**
 * GGB 内置技能库生成器。
 *
 * 从「领域 × 任务类型 × 技术变体」分类法确定性生成 2000 个技能，
 * 每个技能包含可直接执行的 SKILL.md 指南（适用场景/前置检查/执行
 * 步骤/验证方式/注意事项），输出到 skills-library/library.json。
 *
 * 确定性：同一份分类法永远生成同一批技能（无随机数），保证可复现、
 * 可 diff、跨环境一致。
 *
 * 用法：node scripts/generate-skill-library.mjs [--count 2000] [--out skills-library]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? Number(args[at + 1]) || fallback : fallback;
};
const TARGET = argValue('--count', 2000);
const outDir = path.join(repo, argValue('--out', 'skills-library'));

// ---- 分类法：20 个领域，每个领域 10 种任务、10 个技术变体 → 2000 组合 ----

const DOMAINS = [
  {
    id: 'frontend', label: '前端开发', icon: 'layout',
    guidance: '关注组件边界、状态管理、渲染性能与无障碍访问。改动前确认影响面，样式改动需在主流浏览器与移动断点下目检。',
    variants: ['React', 'Vue', 'Svelte', 'Next.js', 'Nuxt', 'Tailwind CSS', 'Web Components', '状态管理（Redux/Zustand/Pinia）', '表单（React Hook Form/VeeValidate）', '动画（Framer Motion/GSAP）'],
  },
  {
    id: 'backend', label: '后端服务', icon: 'server',
    guidance: '关注接口契约、错误处理、幂等性与向后兼容。修改 API 前先确认调用方，破坏性变更必须有版本策略与迁移说明。',
    variants: ['Node.js', 'Python', 'Go', 'Java', 'Rust', 'REST API', 'GraphQL', 'gRPC', '消息队列（Kafka/RabbitMQ）', '定时任务与工作流'],
  },
  {
    id: 'mobile', label: '移动端', icon: 'smartphone',
    guidance: '关注碎片化设备适配、离线行为、包体与启动性能。UI 改动需在主流尺寸与深色模式下目检，权限申请需说明用途。',
    variants: ['React Native', 'Flutter', 'iOS（Swift）', 'Android（Kotlin）', '小程序', '离线同步', '推送通知', '应用内购买', '深度链接', '应用升级与热更新'],
  },
  {
    id: 'devops', label: 'DevOps 与发布', icon: 'rocket',
    guidance: '关注可重复性、回滚路径与最小权限。任何变更先在预发验证，生产操作必须有审计记录与回滚脚本。',
    variants: ['Docker', 'Kubernetes', 'GitHub Actions', 'Terraform', 'Ansible', 'Nginx', 'CDN 与边缘', '蓝绿/金丝雀发布', '制品管理', '密钥管理'],
  },
  {
    id: 'database', label: '数据库', icon: 'database',
    guidance: '关注数据安全、迁移可逆性与查询计划。结构变更前必须备份，大表变更需评估锁表时间与批处理策略。',
    variants: ['PostgreSQL', 'MySQL', 'SQLite', 'MongoDB', 'Redis', 'Elasticsearch', 'ClickHouse', 'Schema 迁移', '查询优化', '备份与恢复'],
  },
  {
    id: 'security', label: '安全', icon: 'shield',
    guidance: '关注最小暴露面、输入验证与凭据卫生。发现漏洞先评估可利用性与影响范围，修复需附回归测试，不引入新攻击面。',
    variants: ['认证与授权（OAuth/JWT）', '注入防护', 'XSS/CSRF', '密钥轮换', '依赖漏洞', '安全审计日志', '传输加密', '渗透测试清单', '数据脱敏', '合规（SOC2/GDPR）'],
  },
  {
    id: 'testing', label: '测试与质量', icon: 'flask',
    guidance: '关注可重复性、隔离性与失败可诊断性。测试必须确定性（不依赖网络/时钟/顺序），失败信息要能直接定位原因。',
    variants: ['单元测试', '集成测试', '端到端测试', '契约测试', '性能压测', '模糊测试', '快照测试', '测试数据工厂', '覆盖率策略', '视觉回归'],
  },
  {
    id: 'data', label: '数据工程', icon: 'chart',
    guidance: '关注数据血缘、幂等管道与质量门禁。管道改动需说明上下游影响，指标口径变更必须同步文档与消费方。',
    variants: ['ETL 管道', '流处理', '数据建模', '指标体系', '数据质量', '数据目录', '特征工程', '报表开发', '数据迁移', '湖仓架构'],
  },
  {
    id: 'ai', label: 'AI 与智能体', icon: 'sparkles',
    guidance: '关注提示词可复现性、评估基线与成本边界。模型行为变更需有评估集对比，外部调用需有超时与降级路径。',
    variants: ['提示词工程', 'RAG 检索增强', '智能体编排', '模型评估', '微调与蒸馏', '向量数据库', '多模态', '推理成本优化', '安全护栏', 'MCP 集成'],
  },
  {
    id: 'docs', label: '文档与写作', icon: 'book',
    guidance: '关注读者视角、结构与可检索性。文档改动需说明动机与影响范围，示例代码必须可运行，术语保持与代码一致。',
    variants: ['架构决策记录（ADR）', 'API 文档', '用户手册', '变更日志', '教学教程', '故障复盘报告', '技术方案评审', '术语表', 'FAQ 维护', '多语言文档'],
  },
  {
    id: 'product', label: '产品设计', icon: 'pen',
    guidance: '关注用户目标、边界条件与可验证的验收标准。需求描述必须可测试，交互改动需附状态说明与异常路径。',
    variants: ['需求梳理', '用户故事', '原型走查', '可用性清单', '数据埋点设计', 'A/B 实验设计', '竞品分析', '用户旅程图', '信息架构', '无障碍设计'],
  },
  {
    id: 'pm', label: '项目管理', icon: 'kanban',
    guidance: '关注范围边界、风险前置与可交付节奏。计划必须可跟踪，风险要有负责人与触发条件，变更需评估对既定承诺的影响。',
    variants: ['任务拆解', '迭代计划', '风险评估', '干系人同步', '燃尽跟踪', '跨团队协作', '事故响应', '资源排期', '里程碑评审', '复盘机制'],
  },
  {
    id: 'legal', label: '法务合规', icon: 'scale',
    guidance: '关注条款风险点、管辖差异与可执行性。所有输出仅供参考并建议专业复核，不得替代正式法律意见。',
    variants: ['合同审查', '隐私政策', '开源许可证', '服务条款', '数据处理协议', '商标与版权', '劳动合规', '出海合规', '供应商协议', '免责声明'],
  },
  {
    id: 'finance', label: '财务分析', icon: 'calculator',
    guidance: '关注口径一致、来源可溯与敏感性分析。数字必须注明口径与时间窗，预测需给出假设与区间而非单点。',
    variants: ['成本核算', '预算编制', '账单审计', '云成本优化', '定价分析', '现金流预测', '报表自动化', '税务基础', '投资回报分析', '采购比价'],
  },
  {
    id: 'marketing', label: '营销与增长', icon: 'megaphone',
    guidance: '关注受众画像、渠道适配与可衡量结果。文案需说明目标受众与转化目标，实验需预设判读标准防事后归因。',
    variants: ['落地页文案', 'SEO 清单', '邮件序列', '社交媒体日历', '内容日历', '增长实验', '用户调研', '品牌语气指南', '发布公告', '客户见证整理'],
  },
  {
    id: 'network', label: '网络与基础设施', icon: 'globe',
    guidance: '关注拓扑可观测、变更窗口与回滚路径。网络变更需先在低峰期验证，规则改动需评估对存量连接的影响。',
    variants: ['DNS 管理', '负载均衡', '防火墙规则', 'VPN 组网', 'TLS 证书', '内网穿透', '带宽与QoS', 'IPv6 迁移', '多区域容灾', '抓包分析'],
  },
  {
    id: 'performance', label: '性能优化', icon: 'gauge',
    guidance: '先测量后优化：建立基线、定位瓶颈、单点改动、复测对比。禁止凭直觉做无数据支撑的"优化"，需记录前后数据。',
    variants: ['前端加载性能', '包体优化', '服务端延迟', '内存泄漏排查', 'CPU 火焰图', '缓存策略', '并发调优', '启动时间', '渲染性能', '基准测试设计'],
  },
  {
    id: 'observability', label: '可观测性', icon: 'activity',
    guidance: '关注黄金指标、告警可操作性 与排障路径。每条告警必须有对应 runbook，日志需结构化并含关联 ID。',
    variants: ['日志规范', '指标设计', '分布式追踪', '告警规则', 'Dashboard 设计', 'SLO/SLI', '事件响应', '巡检自动化', '容量规划', '成本可观测'],
  },
  {
    id: 'browser', label: '浏览器自动化', icon: 'globe2',
    guidance: '关注选择器稳定性、等待策略与幂等执行。脚本必须显式等待而非固定 sleep，对目标站点保持礼貌（限速）。',
    variants: ['Playwright 脚本', '数据抓取', '表单自动化', '截图与 PDF', 'E2E 巡检', '竞品监控', '定时任务', '验证码应对策略', '多标签页编排', '页面变更监测'],
  },
  {
    id: 'collab', label: '协作与沟通', icon: 'users',
    guidance: '关注信息密度、结论前置与行动项明确。同步信息必须有 owner 与截止时间，会议需有议程与结论记录。',
    variants: ['会议纪要', '周报生成', '技术分享大纲', '跨时区协作', '代码提交规范', 'PR 描述模板', '晋升材料', '新人引导清单', '冲突协调', '决策记录'],
  },
];

const TASKS = [
  { id: 'review', label: '审查', verb: '审查', outcome: '问题清单（按严重程度分级）与修复建议' },
  { id: 'implement', label: '实现', verb: '实现', outcome: '可运行的实现代码与变更说明' },
  { id: 'refactor', label: '重构', verb: '重构', outcome: '行为不变的改写、前后对比与回归验证结果' },
  { id: 'troubleshoot', label: '排查', verb: '排查', outcome: '根因分析、修复方案与预防措施' },
  { id: 'deploy', label: '部署', verb: '部署上线', outcome: '部署检查单、执行记录与回滚脚本' },
  { id: 'monitor', label: '监控', verb: '监控', outcome: '监控项设计、告警规则与巡检清单' },
  { id: 'spec', label: '规范制定', verb: '制定规范', outcome: '团队规范文档与示例正反例' },
  { id: 'checklist', label: '清单生成', verb: '生成清单', outcome: '分阶段检查清单（含每项的判定标准）' },
  { id: 'template', label: '模板生成', verb: '生成模板', outcome: '可复用模板与使用说明' },
  { id: 'practices', label: '最佳实践', verb: '沉淀最佳实践', outcome: '最佳实践指南（含理由与反例）' },
];

// 任务方法论模板：每种任务类型一份通用的步骤骨架，再叠加领域细则。
const TASK_METHODOLOGY = {
  review: ['明确审查范围与评判标准', '逐项核对关键风险点并记录证据', '按严重程度（阻塞/重要/建议）分级', '输出问题清单与可执行的修复建议'],
  implement: ['确认需求边界与验收标准', '设计最小改动方案并列出影响面', '分步实现，每步保持可编译可测试', '补充测试并运行完整验证'],
  refactor: ['锁定当前行为（先补 characterization 测试）', '小步改写，每步保证行为等价', '消除重复与改善命名', '全量回归并输出前后对比'],
  troubleshoot: ['收集现象、复现步骤与环境信息', '提出候选根因并按可能性排序', '逐一验证（最小化变量）直到定位', '修复、验证并沉淀预防措施'],
  deploy: ['核对变更清单与回滚脚本', '预发环境完整验证', '按发布检查单灰度执行', '观察核心指标并确认稳定'],
  monitor: ['梳理需要观测的关键指标', '定义告警阈值与判定依据', '配置看板与告警通道', '编写每条告警的 runbook'],
  spec: ['调研现状与团队痛点', '起草规范条款与正反例', '评审并吸收团队反馈', '发布并约定遵循与例外流程'],
  checklist: ['划分检查阶段（事前/事中/事后）', '为每阶段列出可判定的检查项', '标注每项的负责人与判定标准', '试运行一轮并修订'],
  template: ['明确模板的使用场景与受众', '设计结构化字段与填写示例', '预填默认值减少使用成本', '附使用说明与常见问题'],
  practices: ['收集团队实践与踩坑记录', '提炼为带理由的实践条款', '补充反面案例说明边界', '定期复审与更新'],
};

function slug(value) {
  const ascii = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii.replace(/-/g, '').length >= 3) return ascii.slice(0, 40);
  // 纯中文/非 ASCII 变体：取内容的确定性短哈希，保证 id 唯一且稳定
  let hash = 0;
  const str = String(value);
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return `v${hash.toString(36)}`.slice(0, 12);
}

function buildSkill(domain, task, variant, index) {
  const variantSlug = slug(variant);
  const id = `lib-${domain.id}-${task.id}-${variantSlug}`.slice(0, 99);
  const title = `${domain.label} · ${variant} ${task.verb}指南`;
  const shortVariant = variant.split(/[（(]/)[0].trim();
  const description = `面向${domain.label}场景的${variant} ${task.verb}技能：按方法论分步推进，产出${task.outcome}。内置${shortVariant}相关的检查点与验证方式，适合个人开发者与小团队直接使用。`;
  const category = domain.id;
  const categoryLabel = domain.label;
  const keywords = [domain.id, domain.label, task.id, task.label, shortVariant.toLowerCase(), variant.toLowerCase()];

  const body = `---
name: ${id}
description: ${description}
version: 1.0.0
ggb:
  category: ${category}
  categoryLabel: ${categoryLabel}
  keywords: [${keywords.map((k) => `'${k}'`).join(', ')}]
  generator: skill-library-v1
  index: ${index}
---

# ${title}

## 适用场景

- 需要针对「${variant}」做${task.verb}，且希望按团队沉淀的方法论推进，而不是凭感觉操作。
- 期望产出：${task.outcome}。
- 适用对象：个人开发者与小团队；${domain.label}领域的日常与应急场景均适用。

## 前置检查

1. 确认工作目录正确，且目标「${shortVariant}」相关代码或配置位于当前工作区内。
2. 阅读仓库根部的 AGENTS.md / README，了解构建、测试与协作约定。
3. 确认已安装必要的工具链与依赖；缺少时先向用户说明，不要擅自安装全局依赖。
4. 若涉及生产环境或不可逆操作，必须先获得用户的明确授权。

## 执行步骤

${TASK_METHODOLOGY[task.id].map((step, i) => `${i + 1}. ${step}`).join('\n')}

### 领域要点（${domain.label}）

${domain.guidance}

### 技术要点（${variant}）

- 以「${shortVariant}」的官方最佳实践为基线，团队已有约定优先于通用实践。
- 改动保持最小必要：只改与目标直接相关的部分，不顺手重构无关代码。
- 每个关键决策记录一句"为什么这样做"，写进交付说明。

## 验证方式

1. 运行项目已有的测试与静态检查（如 \`npm test\`、\`npm run lint\`），全绿后才算完成。
2. 对照任务目标逐条自查：产出物是否满足「${task.outcome}」。
3. 用一段话向用户说明：做了什么、如何验证的、还有什么风险或未完成项。

## 注意事项

- 不确定的信息先问用户或检索仓库，不要编造。
- 输出中的结论必须有依据（代码位置、命令输出或文档引用）。
- 高风险操作（删除、发布、对外发送）走工作台的评审链，不要绕过治理层。
- 本技能由 GGB 技能库生成器维护（index=${index}）；修改建议请反馈到技能库而不是直接改动生成产物。
`;

  return {
    id,
    title,
    name: id,
    description,
    category,
    categoryLabel: categoryLabel,
    version: '1.0.0',
    installUrl: null,
    keywords,
    index,
    body,
  };
}

// ---- 确定性组合生成，直到达到目标数量 ----

const generated = [];
const seen = new Set();
let index = 0;
outer: for (const domain of DOMAINS) {
  for (const task of TASKS) {
    for (const variant of domain.variants) {
      const skill = buildSkill(domain, task, variant, index);
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      generated.push(skill);
      index++;
      if (generated.length >= TARGET) break outer;
    }
  }
}

const catalog = {
  version: 1,
  generator: 'skill-library-v1',
  generatedAt: new Date().toISOString().slice(0, 10),
  count: generated.length,
  categories: DOMAINS.map((d) => ({ id: d.id, label: d.label, icon: d.icon })),
  skills: generated.map(({ body, ...meta }) => ({ ...meta, body })),
};

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'library.json');
fs.writeFileSync(outFile, JSON.stringify(catalog));
console.log(`已生成 ${catalog.count} 个技能 → ${path.relative(repo, outFile)}（${Math.round(fs.statSync(outFile).size / 1024)} KB）`);
const categories = {};
for (const skill of generated) categories[skill.categoryLabel] = (categories[skill.categoryLabel] || 0) + 1;
for (const [label, count] of Object.entries(categories)) console.log(`  ${label}: ${count}`);
