'use client';

import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';

type Props = {
  name: string;
  phase: string;
  compact: boolean;
  meta: { label: string; description: string; next: string };
};

export function RecruitmentStatus({ name, phase, compact, meta }: Props) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  return (
    <div className="recruitment-context">
      {compact && (
        <>
          <button
            className="recruitment-context-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>需求草稿 · {meta.label}</span>
            <span>{expanded ? '收起说明' : '查看说明'}</span>
            <ChevronDown size={14} />
          </button>
          {!expanded && (
            <p className="recruitment-next-step">下一步：{meta.next}</p>
          )}
        </>
      )}
      <div id={panelId} hidden={compact && !expanded}>
        <div
          className={`recruitment-status-card recruitment-status-${phase}`}
          data-testid="recruitment-status-card"
        >
          <div>
            <span>当前对象</span>
            <strong>需求草稿</strong>
            <small>{name}</small>
          </div>
          <div>
            <span>当前阶段</span>
            <strong>{meta.label}</strong>
            <small>{meta.description}</small>
          </div>
          <div>
            <span>下一步</span>
            <small>{meta.next}</small>
          </div>
        </div>
      </div>
    </div>
  );
}
