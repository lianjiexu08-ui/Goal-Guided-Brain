/**
 * 结构化上下文压缩（pi 模式的确定性版本）。
 *
 * GGB 的执行上下文由 checkpoints / board / messages 三类结构化条目拼成。
 * 条目本身已经是结构化数据，因此压缩采用"结构摘要"而不是模型调用：
 * - 最近条目全文保留，且不允许切断（每条是原子单位）；
 * - 较早条目压缩为固定字段的摘要（丢弃长正文，保留 id、状态、标题、关键标记）；
 * - 压缩结果附带 tokensBefore / tokensAfter / firstKeptEntryId 等元数据，
 *   供任务事件和审计使用；原始数据仍在 SQLite 中，可随时重建。
 *
 * Token 估算使用 chars/4 的保守近似，只用于决策，不作为计费依据。
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(value) {
  return Math.ceil((typeof value === 'string' ? value : JSON.stringify(value ?? '')).length / CHARS_PER_TOKEN);
}

/** 把单条较早条目压缩为摘要：保留标识与状态字段，截断正文。 */
function summarizeEntry(entry, maxContentChars = 120) {
  if (!entry || typeof entry !== 'object') return entry;
  const summary = {};
  for (const key of ['id', 'status', 'kind', 'type', 'title', 'goal', 'role', 'senderType', 'senderId', 'createdAt', 'version', 'requirementVersion'])
    if (entry[key] !== undefined) summary[key] = entry[key];
  for (const key of ['content', 'result', 'output', 'text', 'constraint', 'decision']) {
    const value = entry[key];
    if (typeof value === 'string' && value.length)
      summary[key] = value.length > maxContentChars ? `${value.slice(0, maxContentChars)}…[已压缩]` : value;
  }
  summary.compacted = true;
  return summary;
}

/**
 * 压缩上下文条目集合。
 * @param {object} entries { checkpoints: [], board: [], messages: [] }
 * @param {object} options
 *   - maxTokens: 压缩后目标 token 上限（超过才压缩；0 表示不限制，仅做超长保护）
 *   - keepRecentMessages / keepRecentCheckpoints: 全文保留的最近条目数
 * @returns {{ context: object, compaction: object|null }}
 */
export function compactContext(entries, options = {}) {
  const {
    maxTokens = 0,
    keepRecentMessages = 12,
    keepRecentCheckpoints = 4,
    maxBoardEntries = 40,
  } = options;
  const source = {
    checkpoints: Array.isArray(entries?.checkpoints) ? entries.checkpoints : [],
    board: Array.isArray(entries?.board) ? entries.board : [],
    messages: Array.isArray(entries?.messages) ? entries.messages : [],
  };
  const tokensBefore = estimateTokens(source);
  const totalEntries = source.checkpoints.length + source.board.length + source.messages.length;
  const withinBudget = maxTokens <= 0 || tokensBefore <= maxTokens;
  // 超长保护：即使预算允许，条目过多时也强制收敛。
  const forced = totalEntries > 400;
  if (withinBudget && !forced)
    return { context: source, compaction: null };

  const messages = source.messages;
  const checkpoints = source.checkpoints;
  const board = source.board;
  const keptMessages = messages.slice(-keepRecentMessages);
  const keptCheckpoints = checkpoints.slice(-keepRecentCheckpoints);
  const keptBoard = board.slice(-maxBoardEntries);
  const context = {
    checkpoints: [
      ...checkpoints.slice(0, -keepRecentCheckpoints).map(entry => summarizeEntry(entry)),
      ...keptCheckpoints,
    ],
    board: keptBoard.map(entry => summarizeEntry(entry, 160)),
    messages: [
      ...messages.slice(0, -keepRecentMessages).map(entry => summarizeEntry(entry)),
      ...keptMessages,
    ],
  };
  const tokensAfter = estimateTokens(context);
  return {
    context,
    compaction: {
      strategy: 'structured-v1',
      tokensBefore,
      tokensAfter,
      firstKeptMessageId: keptMessages[0]?.id ?? null,
      firstKeptCheckpointId: keptCheckpoints[0]?.id ?? null,
      summarizedMessages: messages.length - keptMessages.length,
      summarizedCheckpoints: checkpoints.length - keptCheckpoints.length,
      summarizedBoard: board.length - keptBoard.length + (board.length > maxBoardEntries ? board.length - maxBoardEntries : 0),
      originalEntryCount: totalEntries,
    },
  };
}

/**
 * 把追加式会话条目压缩为分支摘要（fork / 分支重试用）。
 * 与 compactContext 相同的原则：保留最近完整工具对，摘要结构固定。
 * @param {Array<{id:string,type:string,data:object,at:string}>} entries 按序排列
 * @param {object} options keepRecentToolPairs、keepRecentMessages
 * @returns {{ summary: object, firstKeptEntryId: string|null }}
 */
export function branchSummary(entries, options = {}) {
  const { keepRecentToolPairs = 3, keepRecentMessages = 6 } = options;
  const list = Array.isArray(entries) ? entries : [];
  const summary = {
    strategy: 'branch-summary-v1',
    goal: null,
    decisions: [],
    filesTouched: [],
    verification: [],
    unfinished: [],
    entryCount: list.length,
  };
  const kept = { toolCalls: [], messages: [] };
  let openToolCall = null;
  let pairBudget = keepRecentToolPairs;
  for (const entry of list) {
    const data = entry?.data || {};
    switch (entry?.type) {
      case 'message': {
        const text = typeof data.text === 'string' ? data.text : '';
        if (!summary.goal && text) summary.goal = text.slice(0, 400);
        kept.messages.push({ id: entry.id, text: text.slice(0, 400) });
        if (kept.messages.length > keepRecentMessages) kept.messages.shift();
        break;
      }
      case 'plan': {
        summary.decisions.push({ plan: data.goal || null, steps: data.steps || [], at: entry.at });
        break;
      }
      case 'tool_call': {
        openToolCall = { id: entry.id, name: data.name, arguments: data.arguments };
        break;
      }
      case 'tool_result': {
        if (openToolCall) {
          if (pairBudget > 0) {
            kept.toolCalls.push({ ...openToolCall, status: data.error ? 'error' : 'ok' });
            pairBudget--;
          }
          if (typeof data.name === 'string' && /write|edit/i.test(openToolCall.name || '')) {
            const file = openToolCall.arguments?.path || openToolCall.arguments?.file_path || null;
            if (file && !summary.filesTouched.includes(file)) summary.filesTouched.push(file);
          }
          openToolCall = null;
        }
        break;
      }
      case 'verification': {
        summary.verification.push({ status: data.status, command: data.command || null, at: entry.at });
        break;
      }
      case 'checkpoint': {
        summary.decisions.push({ checkpoint: data.title || data.id || null, nextSteps: data.nextSteps || null, at: entry.at });
        if (Array.isArray(data.nextSteps)) summary.unfinished.push(...data.nextSteps.slice(0, 5));
        break;
      }
      default:
        break;
    }
  }
  return {
    summary: {
      ...summary,
      filesTouched: summary.filesTouched.slice(0, 50),
      unfinished: summary.unfinished.slice(0, 10),
      decisions: summary.decisions.slice(-10),
      recentToolCalls: kept.toolCalls,
      recentMessages: kept.messages,
    },
    firstKeptEntryId: kept.messages[0]?.id ?? list[0]?.id ?? null,
  };
}
