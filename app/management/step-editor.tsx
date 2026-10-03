'use client';

import { Plus, X } from 'lucide-react';
import { entityText as txt, type Entity } from '../workbench-api';
import { IconButton, title } from './shared';

type Props = {
  steps: Entity[];
  role: string;
  roles: Entity[];
  onChange: (key: string, value: unknown) => void;
};

export function StepEditor({ steps, role, roles, onChange }: Props) {
  return (
    <fieldset>
      <div className="manage-field-heading">
        子任务
        <button
          type="button"
          className="text-button"
          onClick={() =>
            onChange('steps', [...steps, { role: role, prompt: '' }])
          }
        >
          <Plus size={15} />
          添加
        </button>
      </div>
      {steps.map((step, index) => (
        <div className="manage-model-row" key={index}>
          <div className="manage-inline-fields">
            <select
              aria-label={`子任务 ${index + 1} 助手`}
              required
              value={txt(step, 'role')}
              onChange={(event) =>
                onChange(
                  'steps',
                  steps.map((item, at) =>
                    at === index ? { ...item, role: event.target.value } : item,
                  ),
                )
              }
            >
              <option value="">选择助手</option>
              {roles
                .filter((item) => !item.archived)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {title(item)}
                  </option>
                ))}
            </select>
            <IconButton
              icon={X}
              label={`移除子任务 ${index + 1}`}
              onClick={() =>
                onChange(
                  'steps',
                  steps.filter((_, at) => at !== index),
                )
              }
            />
          </div>
          <textarea
            aria-label={`子任务 ${index + 1} 目标`}
            required
            rows={2}
            value={txt(step, 'prompt')}
            onChange={(event) =>
              onChange(
                'steps',
                steps.map((item, at) =>
                  at === index ? { ...item, prompt: event.target.value } : item,
                ),
              )
            }
          />
        </div>
      ))}
    </fieldset>
  );
}
