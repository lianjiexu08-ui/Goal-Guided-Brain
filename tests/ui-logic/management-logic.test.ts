import { describe, expect, it } from 'vitest';
import {
  description,
  initialForm,
  integrationEventLabels,
  integrationTypeLabels,
  labels,
  status,
  statuses,
  time,
  title,
} from '../../app/management-logic';
import type { ManagementState } from '../../app/workbench-api';

const emptyState: ManagementState = {
  providers: [], resources: [], nodes: [], jobs: [], messages: [],
  capabilities: [], schedules: [], monitors: [], notifications: [],
  attention: [], backups: [], roles: [{ id: 'developer', name: '开发助手' }],
  workflows: [], integrations: [], vault: {},
};

describe('title', () => {
  it('按 name → title → filename → content → id 的优先级取标题', () => {
    expect(title({ id: 'a', name: 'N' })).toBe('N');
    expect(title({ id: 'a', title: 'T' })).toBe('T');
    expect(title({ id: 'a', filename: 'F' })).toBe('F');
    expect(title({ id: 'a', content: 'C'.repeat(100) })).toBe('C'.repeat(80));
    expect(title({ id: 'fallback' })).toBe('fallback');
  });
});

describe('status', () => {
  it('优先显式 status 字段', () => {
    expect(status({ id: 'x', status: 'running' })).toBe('running');
  });
  it('enabled 布尔映射为 enabled/disabled', () => {
    expect(status({ id: 'x', enabled: true })).toBe('enabled');
    expect(status({ id: 'x', enabled: false })).toBe('disabled');
  });
  it('lastResult.ok 映射为健康状态', () => {
    expect(status({ id: 'x', lastResult: { ok: true } })).toBe('healthy');
    expect(status({ id: 'x', lastResult: { ok: false } })).toBe('unhealthy');
  });
  it('消息已读状态', () => {
    expect(status({ id: 'x', read: true })).toBe('read');
    expect(status({ id: 'x', read: false })).toBe('unread');
  });
  it('空对象返回空串', () => {
    expect(status({ id: 'x' })).toBe('');
  });
});

describe('time', () => {
  it('ISO 字符串转中文本地时间', () => {
    expect(time('2026-01-01T00:00:00Z')).toContain('2026');
  });
  it('无效输入返回 -', () => {
    expect(time(null)).toBe('-');
    expect(time('')).toBe('-');
    expect(time(123)).toBe('-');
  });
});

describe('initialForm', () => {
  it('integrations 默认表单包含预设字段', () => {
    const form = initialForm('integrations', undefined, emptyState);
    expect(form.type).toBe('webhook');
    expect(form.events).toEqual(['attention', 'task.completed']);
    expect(form.enabled).toBe(true);
  });
  it('编辑时展开 config 嵌套字段（服务端掩码结构）', () => {
    const initial = {
      id: 'i1',
      name: '出口',
      type: 'webhook',
      config: { url: 'https://x', secret: '***ab' },
    };
    const form = initialForm('integrations', initial, emptyState);
    expect(form.url).toBe('https://x');
    expect(form.secret).toBe('***ab');
  });
  it('integrations 编辑且 config 为空时字段回退默认', () => {
    const form = initialForm('integrations', { id: 'i2', name: 'n' }, emptyState);
    expect(form.type).toBe('webhook');
  });
  it('jobs 默认带第一个未归档角色', () => {
    const form = initialForm('jobs', undefined, emptyState);
    expect(form.role).toBe('developer');
  });
  it('未知集合回退为 name 空表单', () => {
    expect(initialForm('nope', undefined, emptyState)).toEqual({ name: '' });
  });
});

describe('description', () => {
  it('providers 拼接协议与模型列表', () => {
    const text = description('providers', {
      id: 'p', protocol: 'openai-completions', baseUrl: 'https://api',
      models: [{ id: 'm1' }, { id: 'm2' }],
    }, emptyState);
    expect(text).toContain('openai-completions');
    expect(text).toContain('m1, m2');
  });
  it('resources 项目类型显示路径、服务器类型显示 host:port', () => {
    expect(description('resources', { id: 'r', kind: 'project', path: '/repo' }, emptyState)).toBe('/repo');
    expect(
      description('resources', { id: 'r', kind: 'server', username: 'u', host: 'h', port: '22' }, emptyState),
    ).toBe('u@h:22');
  });
  it('integrations 显示渠道类型、URL、订阅事件与停用标记', () => {
    const text = description('integrations', {
      id: 'i', type: 'qq-onebot',
      config: { url: 'http://127.0.0.1:3000' },
      events: ['attention', 'verification.failed'],
      enabled: false,
    }, emptyState);
    expect(text).toContain('QQ OneBot');
    expect(text).toContain('待处理事项 / 验证失败');
    expect(text).toContain('已停用');
  });
  it('attention 组合任务与交付上下文', () => {
    const text = description('attention', {
      id: 'a', kind: 'verification', taskTitle: 'T1',
      deliveryStatus: 'awaiting-owner', detail: '请确认', createdAt: '2026-01-01T00:00:00Z',
    }, emptyState);
    expect(text).toContain('任务 · T1');
    expect(text).toContain('待你验收');
    expect(text).toContain('请确认');
  });
  it('default 分支按 description → detail → message 优先级回退', () => {
    expect(description('unknown', { id: 'x', description: 'D' }, emptyState)).toBe('D');
    expect(description('unknown', { id: 'x', detail: 'DE' }, emptyState)).toBe('DE');
    expect(description('unknown', { id: 'x', message: 'M' }, emptyState)).toBe('M');
  });
});

describe('展示映射表完整性', () => {
  it('集成类型与事件映射非空', () => {
    expect(Object.keys(integrationTypeLabels).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(integrationEventLabels).length).toBe(3);
  });
  it('labels 覆盖导航集合', () => {
    for (const key of ['providers', 'jobs', 'integrations', 'capabilities', 'backups'])
      expect(labels[key]).toBeTruthy();
  });
  it('statuses 覆盖核心交付状态', () => {
    for (const key of ['completed', 'failed', 'awaiting-owner', 'accepted', 'rejected'])
      expect(statuses[key]).toBeTruthy();
  });
});
