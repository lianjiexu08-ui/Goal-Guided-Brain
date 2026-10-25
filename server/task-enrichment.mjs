import fs from 'node:fs';
import path from 'node:path';

/**
 * 任务上下文增强：根据任务描述、项目特征和历史数据，
 * 自动生成丰富的执行指引注入 Agent 上下文。
 *
 * 四个维度：
 * 1. 任务类型检测 → 匹配对应的操作规范
 * 2. 项目技术栈检测 → 匹配框架/语言特定指引
 * 3. 验证预期 → 告诉 Agent 交付后会被怎样检查
 * 4. 历史教训 → 注入类似任务的失败模式，避免重复踩坑
 */

// ---- 任务类型检测 ----
const TASK_TYPE_PATTERNS = [
  { type: 'bug-fix', patterns: [/修复|修复.*bug|fix.*bug|bug.*fix|报错|崩溃|异常|错误|不工作|失败|error|crash|broken/i] },
  { type: 'refactor', patterns: [/重构|整理|优化.*结构|clean.?up|refactor|restructure|reorganize/i] },
  { type: 'testing', patterns: [/测试|测试用例|单元测试|集成测试|coverage|test.*case|testing/i] },
  { type: 'security', patterns: [/安全|认证|授权|加密|漏洞|security|auth|encrypt|vulnerability/i] },
  { type: 'performance', patterns: [/性能|优化.*速度|慢|卡|内存|performance|latency|memory|slow|optimi[sz]e/i] },
  { type: 'new-feature', patterns: [/实现|新增|添加|开发|创建.*功能|implement|add.*feature|create|build.*new/i] },
  { type: 'docs', patterns: [/文档|说明|注释|documentation|readme|docs|comment/i] },
  { type: 'migration', patterns: [/迁移|数据库.*变更|schema|migration|alter.*table/i] },
  { type: 'devops', patterns: [/部署|CI.?CD|流水线|docker|kubernetes|deploy|pipeline|infra/i] },
];

export function detectTaskType(text) {
  for (const { type, patterns } of TASK_TYPE_PATTERNS) {
    if (patterns.some(p => p.test(text))) return type;
  }
  return 'general';
}

// ---- 项目技术栈检测 ----
const STACK_INDICATORS = [
  { files: ['package.json'], name: 'Node.js', guidance: '使用 npm/pnpm/yarn 管理依赖；测试通常在 package.json scripts 中。' },
  { files: ['tsconfig.json'], name: 'TypeScript', guidance: '注意类型安全；运行 tsc --noEmit 检查类型。' },
  { files: ['go.mod'], name: 'Go', guidance: '使用 go vet/test/build；注意 goroutine 安全。' },
  { files: ['Cargo.toml'], name: 'Rust', guidance: '使用 cargo check/test/clippy；注意所有权和生命周期。' },
  { files: ['pyproject.toml', 'setup.py', 'requirements.txt'], name: 'Python', guidance: '使用 pytest/mypy/ruff；注意虚拟环境。' },
  { files: ['pom.xml'], name: 'Java Maven', guidance: '使用 mvn test/compile；注意依赖 scope。' },
  { files: ['Makefile'], name: 'Make', guidance: '查看 make help 或 Makefile 了解可用目标。' },
  { files: ['Dockerfile'], name: 'Docker', guidance: '注意容器化约束；可能需要 docker build 验证。' },
  { files: ['.github/workflows'], name: 'GitHub Actions', guidance: 'CI 流水线会自动运行检查，确保本地通过。' },
];

export function detectProjectStack(root) {
  if (!root) return [];
  const stacks = [];
  for (const indicator of STACK_INDICATORS) {
    for (const file of indicator.files) {
      try {
        if (fs.existsSync(path.join(root, file))) {
          stacks.push({ name: indicator.name, guidance: indicator.guidance });
          break;
        }
      } catch {}
    }
  }
  return stacks;
}

// ---- 验证预期生成 ----
export function buildVerificationExpectations(plan) {
  if (!plan?.checks?.length) return '';
  const items = plan.checks.map(check =>
    `  - ${check.command} ${check.args ? check.args.join(' ') : ''} (${check.label || check.id})`
  );
  return `\n<验证预期>\n交付后将自动运行以下检查。请在完成时确保这些检查能通过：\n${items.join('\n')}\n</验证预期>\n`;
}

// ---- 历史教训 ----
export function buildLessonsFromHistory(failureHistory, taskPrompt) {
  if (!failureHistory?.length || !taskPrompt) return '';
  const text = taskPrompt.toLowerCase();
  const relevant = failureHistory.filter(entry => {
    if (!entry.pattern) return false;
    // 检查任务描述是否与历史失败的任务类似
    const patternWords = entry.pattern.toLowerCase().match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) || [];
    return patternWords.some(word => word.length > 1 && text.includes(word));
  }).slice(0, 3);
  if (!relevant.length) return '';
  const lines = relevant.map(entry =>
    `  - ${entry.pattern}: ${entry.lesson}`
  );
  return `\n<历史教训>\n以下类似任务曾遇到问题，请避免重复：\n${lines.join('\n')}\n</历史教训>\n`;
}

// ---- 代码风格检测 ----
export function detectCodeStyle(root) {
  if (!root) return '';
  const hints = [];
  // ESLint / Prettier
  for (const config of ['.eslintrc.json', '.eslintrc.js', '.eslintrc.yml', 'eslint.config.js', '.prettierrc', '.editorconfig']) {
    try {
      if (fs.existsSync(path.join(root, config))) {
        hints.push(`项目有 ${config} 配置，请遵循其代码风格规则。`);
        break;
      }
    } catch {}
  }
  // CONTRIBUTING / AGENTS.md
  for (const doc of ['CONTRIBUTING.md', 'AGENTS.md', '.github/CONTRIBUTING.md']) {
    try {
      if (fs.existsSync(path.join(root, doc))) {
        hints.push(`请阅读 ${doc} 了解项目贡献规范。`);
        break;
      }
    } catch {}
  }
  return hints.length ? `\n<代码风格>\n${hints.map(h => `  - ${h}`).join('\n')}\n</代码风格>\n` : '';
}

// ---- 综合增强 ----
export function enrichTaskContext({ prompt, workspace, verificationPlan, failureHistory }) {
  const sections = [];

  // 1. 任务类型
  const taskType = detectTaskType(prompt);
  if (taskType !== 'general') {
    const typeLabels = {
      'bug-fix': '缺陷修复', 'refactor': '重构', 'new-feature': '新功能',
      'security': '安全相关', 'performance': '性能优化', 'testing': '测试相关',
      'docs': '文档', 'migration': '数据迁移', 'devops': 'DevOps',
    };
    sections.push(`<任务类型>${typeLabels[taskType] || taskType}</任务类型>`);
  }

  // 2. 项目技术栈
  if (workspace) {
    const stacks = detectProjectStack(workspace);
    if (stacks.length) {
      sections.push(`<项目技术栈>\n${stacks.map(s => `  - ${s.name}: ${s.guidance}`).join('\n')}\n</项目技术栈>`);
    }
    const style = detectCodeStyle(workspace);
    if (style) sections.push(style);
  }

  // 3. 验证预期
  if (verificationPlan) {
    const ve = buildVerificationExpectations(verificationPlan);
    if (ve) sections.push(ve);
  }

  // 4. 历史教训
  if (failureHistory) {
    const lessons = buildLessonsFromHistory(failureHistory, prompt);
    if (lessons) sections.push(lessons);
  }

  return sections.length ? sections.join('\n') + '\n' : '';
}

export { TASK_TYPE_PATTERNS, STACK_INDICATORS };
