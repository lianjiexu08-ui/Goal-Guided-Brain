import { describe, expect, it } from 'vitest';
import {
  capabilityKindLabels,
  draftChangeFromBase,
  draftRangesOverlap,
  formatBytes,
  isActive,
  MAX_ATTACHMENTS,
  mergeDraftAttachments,
  mergeDraftText,
  modelDisplayName,
  parseDraftCache,
  parseRouteCache,
  ROUTE_VIEWS,
  statusLabels,
  taskNeedsAttention,
  taskNeedsOwnerAction,
  taskVerification,
  verificationLabels,
  type Attachment,
} from '../../app/page-logic';

const file = (id: string, name = `${id}.txt`): Attachment => ({
  id,
  name,
  mime: 'text/plain',
  size: 10,
});

describe('taskVerification', () => {
  it('交付状态优先于验证状态', () => {
    expect(taskVerification({ status: 'completed', deliveryStatus: 'accepted', verificationStatus: 'verified' }))
      .toBe('已交付');
  });

  it('交付状态先查 statusLabels，再查 verificationLabels，都没有就回退原值', () => {
    expect(taskVerification({ status: 'completed', deliveryStatus: 'rejected' })).toBe('已退回复核');
    expect(taskVerification({ status: 'completed', deliveryStatus: 'stale' })).toBe('验收已失效');
    expect(taskVerification({ status: 'completed', deliveryStatus: 'brand-new' })).toBe('brand-new');
  });

  it('没有交付状态时用验证状态，未知值原样透出', () => {
    expect(taskVerification({ status: 'running', verificationStatus: 'failed' })).toBe('验证失败');
    expect(taskVerification({ status: 'running', verificationStatus: 'weird' })).toBe('weird');
  });

  it('completed 本身只代表执行结束，显示为待验收而非已验收', () => {
    expect(taskVerification({ status: 'completed' })).toBe('待验收');
  });

  it('未完成且无任何验证信息时不显示', () => {
    expect(taskVerification({ status: 'running' })).toBe('');
    expect(taskVerification({ status: 'queued' })).toBe('');
  });
});

describe('taskNeedsOwnerAction', () => {
  it('三种待所有者处理的状态会命中', () => {
    expect(taskNeedsOwnerAction({ status: 'completed', deliveryStatus: 'pending-review' })).toBe(true);
    expect(taskNeedsOwnerAction({ status: 'completed', deliveryStatus: 'awaiting-owner' })).toBe(true);
    expect(taskNeedsOwnerAction({ status: 'completed', verificationStatus: 'rejected' })).toBe(true);
  });

  it('交付状态存在时不再看验证状态', () => {
    expect(taskNeedsOwnerAction({ status: 'completed', deliveryStatus: 'accepted', verificationStatus: 'rejected' }))
      .toBe(false);
  });

  it('已交付与无状态都不需要处理', () => {
    expect(taskNeedsOwnerAction({ status: 'completed', deliveryStatus: 'accepted' })).toBe(false);
    expect(taskNeedsOwnerAction({ status: 'running' })).toBe(false);
  });
});

describe('taskNeedsAttention', () => {
  it('六种异常状态会命中（预算超限两种写法都要认）', () => {
    for (const status of ['blocked', 'failed', 'interrupted', 'state_unknown', 'budget-exceeded', 'budget_exceeded'])
      expect(taskNeedsAttention({ status })).toBe(true);
  });

  it('未完成任务带 error 也要提醒', () => {
    expect(taskNeedsAttention({ status: 'running', error: 'boom' })).toBe(true);
  });

  it('已完成任务残留的 error 不再提醒', () => {
    expect(taskNeedsAttention({ status: 'completed', error: 'boom' })).toBe(false);
  });

  it('正常进行中的任务不提醒', () => {
    expect(taskNeedsAttention({ status: 'running' })).toBe(false);
    expect(taskNeedsAttention({ status: 'running', error: '' })).toBe(false);
  });
});

describe('isActive', () => {
  it('只有排队与进行中算活跃', () => {
    expect(isActive({ status: 'queued' })).toBe(true);
    expect(isActive({ status: 'running' })).toBe(true);
    expect(isActive({ status: 'completed' })).toBe(false);
    expect(isActive({ status: 'paused' })).toBe(false);
  });
});

describe('modelDisplayName', () => {
  const model = { tools: true, vision: false, contextWindow: 1 };

  it('名称与 ID 不同时同时展示，避免展示名与实际请求模型混淆', () => {
    expect(modelDisplayName({ ...model, id: 'deepseek-chat', name: 'DeepSeek' }))
      .toBe('DeepSeek · deepseek-chat');
  });

  it('名称等于 ID 时不重复', () => {
    expect(modelDisplayName({ ...model, id: 'gpt-5', name: 'gpt-5' })).toBe('gpt-5');
  });
});

describe('formatBytes', () => {
  it('1MB 以下用 KB，且永不显示 0 KB', () => {
    expect(formatBytes(0)).toBe('1 KB');
    expect(formatBytes(1)).toBe('1 KB');
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('1MB 及以上用一位小数的 MB', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB');
    expect(formatBytes(1024 * 1024 * 3.47)).toBe('3.5 MB');
    // toFixed 作用在二进制浮点上：2.55 的实际值略小于 2.55，向下舍入。
    // 这里固化既有行为，提醒别把它当成数学意义的四舍五入。
    expect(formatBytes(1024 * 1024 * 2.55)).toBe('2.5 MB');
  });
});

describe('draftChangeFromBase', () => {
  it('相同文本没有改动', () => {
    expect(draftChangeFromBase('abc', 'abc')).toBeNull();
  });

  it('掐掉公共前后缀，只留实际替换区间', () => {
    expect(draftChangeFromBase('hello world', 'hello brave world'))
      .toEqual({ start: 6, end: 6, replacement: 'brave ' });
    expect(draftChangeFromBase('abcdef', 'abXYef')).toEqual({ start: 2, end: 4, replacement: 'XY' });
  });

  it('纯删除的 replacement 为空串', () => {
    expect(draftChangeFromBase('abcdef', 'abef')).toEqual({ start: 2, end: 4, replacement: '' });
  });

  it('从空串开始与清空到空串', () => {
    expect(draftChangeFromBase('', 'new')).toEqual({ start: 0, end: 0, replacement: 'new' });
    expect(draftChangeFromBase('old', '')).toEqual({ start: 0, end: 3, replacement: '' });
  });
});

describe('draftRangesOverlap', () => {
  it('两个纯插入点只有位置相同才算重叠', () => {
    expect(draftRangesOverlap({ start: 3, end: 3, replacement: 'a' }, { start: 3, end: 3, replacement: 'b' }))
      .toBe(true);
    expect(draftRangesOverlap({ start: 3, end: 3, replacement: 'a' }, { start: 4, end: 4, replacement: 'b' }))
      .toBe(false);
  });

  it('插入点落在替换区间内（含边界）算重叠', () => {
    const span = { start: 2, end: 5, replacement: 'x' };
    expect(draftRangesOverlap({ start: 2, end: 2, replacement: 'i' }, span)).toBe(true);
    expect(draftRangesOverlap({ start: 5, end: 5, replacement: 'i' }, span)).toBe(true);
    expect(draftRangesOverlap({ start: 6, end: 6, replacement: 'i' }, span)).toBe(false);
  });

  it('相邻但不相交的两个区间不算重叠', () => {
    expect(draftRangesOverlap({ start: 0, end: 2, replacement: 'a' }, { start: 2, end: 4, replacement: 'b' }))
      .toBe(false);
    expect(draftRangesOverlap({ start: 0, end: 3, replacement: 'a' }, { start: 2, end: 4, replacement: 'b' }))
      .toBe(true);
  });
});

describe('mergeDraftText', () => {
  it('两端一致或只有一端改动时无冲突', () => {
    expect(mergeDraftText('base', 'same', 'same')).toEqual({ content: 'same', conflict: false });
    expect(mergeDraftText('base', 'base', 'remote')).toEqual({ content: 'remote', conflict: false });
    expect(mergeDraftText('base', 'local', 'base')).toEqual({ content: 'local', conflict: false });
  });

  it('不重叠的两端改动自动合并', () => {
    // 本机改开头，远端改结尾。
    expect(mergeDraftText('one two three', 'ONE two three', 'one two THREE'))
      .toEqual({ content: 'ONE two THREE', conflict: false });
  });

  it('合并按 start 倒序套用，前面的改动不会移位后面的区间', () => {
    expect(mergeDraftText('aaa bbb ccc', 'XXXXXX bbb ccc', 'aaa bbb Z'))
      .toEqual({ content: 'XXXXXX bbb Z', conflict: false });
  });

  it('改动重叠时保留本机内容并标记冲突，交给界面让用户选', () => {
    expect(mergeDraftText('hello world', 'hello LOCAL', 'hello REMOTE'))
      .toEqual({ content: 'hello LOCAL', conflict: true });
  });

  it('两端做了完全相同的改动不算冲突', () => {
    expect(mergeDraftText('hello world', 'hello there', 'hello there'))
      .toEqual({ content: 'hello there', conflict: false });
  });

  it('一端清空、另一端改动属于重叠，不能静默丢掉本机内容', () => {
    const merged = mergeDraftText('draft text', '', 'draft text!');
    expect(merged.conflict).toBe(true);
    expect(merged.content).toBe('');
  });
});

describe('mergeDraftAttachments', () => {
  it('按 id 去重，远端同 id 覆盖本机', () => {
    const merged = mergeDraftAttachments([file('a', 'local.txt')], [file('a', 'remote.txt'), file('b')]);
    expect(merged.map((item) => item.id)).toEqual(['a', 'b']);
    expect(merged[0].name).toBe('remote.txt');
  });

  it('合并结果截断到上限', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 5 }, (_, i) => file(`f${i}`));
    expect(mergeDraftAttachments(many, [])).toHaveLength(MAX_ATTACHMENTS);
  });

  it('两侧都为空时返回空数组', () => {
    expect(mergeDraftAttachments([], [])).toEqual([]);
  });
});

describe('parseDraftCache', () => {
  it('损坏的 JSON 与非对象输入回退为空缓存', () => {
    expect(parseDraftCache('not json')).toEqual({});
    expect(parseDraftCache('')).toEqual({
      drafts: {}, attachments: {}, updatedAt: {}, revisions: {}, bases: {},
    });
  });

  it('逐字段剔除类型不对的条目', () => {
    const parsed = parseDraftCache(JSON.stringify({
      drafts: { good: 'text', bad: 42 },
      updatedAt: { good: '2026-01-01', bad: 7 },
      revisions: { good: 3, bad: 1.5 },
    }));
    expect(parsed.drafts).toEqual({ good: 'text' });
    expect(parsed.updatedAt).toEqual({ good: '2026-01-01' });
    expect(parsed.revisions).toEqual({ good: 3 });
  });

  it('附件必须四个字段齐全才保留，并截断到上限', () => {
    const parsed = parseDraftCache(JSON.stringify({
      attachments: {
        k: [
          file('ok'),
          { id: 'no-size', name: 'n', mime: 'm' },
          { id: 'nan-size', name: 'n', mime: 'm', size: Number.NaN },
          null,
        ],
      },
    }));
    expect(parsed.attachments?.k.map((item) => item.id)).toEqual(['ok']);
  });

  it('bases 需要 content 字符串与全字符串的 attachmentIds', () => {
    const parsed = parseDraftCache(JSON.stringify({
      bases: {
        ok: { content: 'c', attachmentIds: ['a'] },
        badContent: { content: 1, attachmentIds: [] },
        badIds: { content: 'c', attachmentIds: [1] },
        notArray: { content: 'c', attachmentIds: 'a' },
      },
    }));
    expect(Object.keys(parsed.bases ?? {})).toEqual(['ok']);
  });

  it('数组形式的字段不被当成对象接受', () => {
    expect(parseDraftCache(JSON.stringify({ drafts: ['a'], bases: ['b'] })))
      .toEqual({ drafts: {}, attachments: {}, updatedAt: {}, revisions: {}, bases: {} });
  });
});

describe('parseRouteCache', () => {
  it('只接受白名单内的视图名', () => {
    expect(parseRouteCache(JSON.stringify({ view: 'tasks' }))).toEqual({ view: 'tasks' });
    expect(parseRouteCache(JSON.stringify({ view: 'not-a-view' }))).toEqual({});
  });

  it('spaceId 与 role 必须是字符串', () => {
    expect(parseRouteCache(JSON.stringify({ spaceId: 's1', role: 'developer' })))
      .toEqual({ spaceId: 's1', role: 'developer' });
    expect(parseRouteCache(JSON.stringify({ spaceId: 5, role: null }))).toEqual({});
  });

  it('损坏的 JSON 回退为空路由', () => {
    expect(parseRouteCache('{oops')).toEqual({});
  });
});

describe('展示映射表', () => {
  it('statusLabels 覆盖预算超限的两种写法', () => {
    expect(statusLabels.budget_exceeded).toBe('预算超限');
    expect(statusLabels['budget-exceeded']).toBe('预算超限');
  });

  it('verificationLabels 覆盖验收失效', () => {
    expect(verificationLabels.stale).toBe('验收已失效');
  });

  it('能力类型三类齐全', () => {
    expect(Object.keys(capabilityKindLabels).sort()).toEqual(['mcp', 'plugin', 'skill']);
  });

  it('ROUTE_VIEWS 含 workspace 与 recruitment 两个主入口', () => {
    expect(ROUTE_VIEWS.has('workspace')).toBe(true);
    expect(ROUTE_VIEWS.has('recruitment')).toBe(true);
  });
});
