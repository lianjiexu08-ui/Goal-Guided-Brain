'use client';

import { useState } from 'react';
import { ChevronDown, KeyRound, Settings2 } from 'lucide-react';
import type { Config, CredentialState, Provider } from './model';

const credentialMessages: Partial<Record<CredentialState, string>> = {
  locked: '凭据库已锁定，解锁后才能使用这个模型。',
  'missing-vault': '这个模型引用了凭据，但凭据库尚未初始化。',
  missing: '这个模型引用的凭据已不存在，需要重新绑定。',
};
const setupMessages = {
  missing: '先接入一个聊天模型，再开始招募。',
  'decision-only': '当前只有结构化决策后端，还需要一个聊天模型。',
  unsupported: '模型接口协议不受支持，请检查供应商配置。',
  disabled: '聊天模型已全部停用，请启用一个后继续。',
  'empty-models': '供应商还没有模型，请同步列表或填写模型 ID。',
  credentials: '聊天模型的凭据暂不可用，请检查凭据库。',
  legacy: '已识别旧版默认模型配置，可以继续描述需求。',
  configured: '模型配置已具备，可以开始描述需求。',
};
const shortMessages = {
  missing: '未配置聊天模型',
  'decision-only': '需配置聊天模型',
  unsupported: '模型协议待调整',
  disabled: '聊天模型已停用',
  'empty-models': '模型列表为空',
  credentials: '模型凭据待处理',
  legacy: '默认模型已配置',
  configured: '模型配置已具备',
};
export function modelSetupLabel(
  config?: Pick<Config, 'modelSetup' | 'hasApiKey'>,
) {
  const state = config?.modelSetup?.state;
  if (state === 'credentials') return '模型凭据待处理';
  if (state === 'disabled') return '聊天模型已停用';
  if (state === 'configured' || state === 'legacy') return '模型配置已具备';
  if (state) return '待配置聊天模型';
  return config?.hasApiKey ? '模型已配置' : '待配置模型';
}
export function ModelSetupNotice({
  config,
  providers,
  providerId,
  modelId,
  firstRecruitment,
  disconnected,
  onModels,
  onCredentials,
}: {
  config: Config;
  providers: Provider[];
  providerId?: string;
  modelId?: string;
  firstRecruitment: boolean;
  disconnected: boolean;
  onModels: () => void;
  onCredentials: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const provider = providers.find((item) => item.id === providerId);
  const problem =
    provider?.credentialState && credentialMessages[provider.credentialState];
  const state =
    config.modelSetup?.state || (config.hasApiKey ? 'configured' : 'missing');
  const needsSetup = !!problem || !['configured', 'legacy'].includes(state);
  if (!needsSetup && !firstRecruitment) return null;
  const credentialAction = !!problem || state === 'credentials';
  const model = provider?.models.find((item) => item.id === modelId);
  const message = disconnected
    ? '配置状态暂未更新，请恢复连接后核对。'
    : problem
      ? `${provider!.name}：${problem}`
      : setupMessages[state];
  const summary = firstRecruitment
    ? message
    : disconnected
      ? '配置状态待更新'
      : problem
        ? provider?.credentialState === 'locked'
          ? '模型凭据库已锁定'
          : '当前模型凭据待处理'
        : shortMessages[state];
  return (
    <section
      className={`model-setup-notice${needsSetup ? ' needs-setup' : ''}${firstRecruitment ? '' : ' is-compact'}`}
      aria-label="模型启动检查"
    >
      <div className="model-setup-summary">
        <button
          type="button"
          className="model-setup-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {credentialAction ? <KeyRound size={16} /> : <Settings2 size={16} />}
          <span>{summary}</span>
          <ChevronDown size={15} />
        </button>
        {needsSetup && (
          <button
            type="button"
            className="secondary-button"
            onClick={credentialAction ? onCredentials : onModels}
          >
            {credentialAction
              ? provider?.credentialState === 'locked'
                ? '解锁模型凭据'
                : '管理模型凭据'
              : '配置聊天模型'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="model-setup-details">
          {!firstRecruitment && <p>{message}</p>}
          <p>
            先连接模型，再和项目经理澄清目标，确认团队方案后开始执行。Skill、MCP、Plugin
            可以按任务需要添加，TypeSafe 也是可选能力。
          </p>
          <p>
            这里只检查本机配置，不会自动调用付费模型。接口是否可用、额度及工具能力需要在模型管理中检查连接。
          </p>
          {model && !model.tools && (
            <p>
              当前是纯文本模型，可先讨论需求；需要自动创建团队或执行工具时，请切换到支持工具调用的模型。
            </p>
          )}
          <div className="model-setup-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onModels}
            >
              打开模型管理
            </button>
            {credentialAction && (
              <button
                type="button"
                className="secondary-button"
                onClick={onCredentials}
              >
                打开资源与凭据
              </button>
            )}
          </div>
          <small>配置期间可以先写需求；切换页面和刷新会保留当前草稿。</small>
        </div>
      )}
    </section>
  );
}
