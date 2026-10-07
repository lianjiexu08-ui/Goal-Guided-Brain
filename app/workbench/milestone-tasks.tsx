'use client';

import { useState } from 'react';
import { ArrowUpRight, Link2 } from 'lucide-react';
import { statusLabels, taskVerification, type Task } from './model';

export function MilestoneTasks({
  title,
  taskIds = [],
  tasks,
  disabled,
  onSave,
  onOpenTask,
}: {
  title: string;
  taskIds?: string[];
  tasks: Task[];
  disabled: boolean;
  onSave: (ids: string[]) => Promise<boolean>;
  onOpenTask: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const accepted = taskIds.filter(
    (id) => byId.get(id)?.deliveryStatus === 'accepted',
  ).length;
  const matches = tasks.filter((task) =>
    `${task.title} ${task.prompt}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const missing = selected.filter((id) => !byId.has(id));
  return (
    <section className="milestone-tasks" aria-label={`${title}关联任务`}>
      <div className="milestone-tasks-head">
        <span>
          {taskIds.length
            ? `${accepted}/${taskIds.length} 项任务已验收`
            : '尚未关联执行任务'}
        </span>
        {!editing && (
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => {
              setSelected(taskIds);
              setSearch('');
              setEditing(true);
            }}
          >
            <Link2 size={14} />
            {taskIds.length ? '管理关联任务' : '关联任务'}
          </button>
        )}
      </div>
      {taskIds.length > 0 && (
        <ul className="milestone-task-links">
          {taskIds.map((id) => {
            const task = byId.get(id);
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={!task}
                  onClick={() => onOpenTask(id)}
                >
                  <span>
                    <strong>
                      {task?.title || task?.prompt || '关联任务不可用'}
                    </strong>
                    <small>
                      {task
                        ? `执行：${statusLabels[task.status] || task.status} · 交付：${taskVerification(task) || '尚未交付'}`
                        : '任务不存在或已不属于当前团队，请移除此关联。'}
                    </small>
                  </span>
                  {task && <ArrowUpRight size={16} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <div className="milestone-task-picker">
          <label>
            搜索本团队任务
            <input
              aria-label={`${title}搜索任务`}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="按任务名称或需求搜索"
            />
          </label>
          <fieldset disabled={disabled}>
            <legend>选择关联任务（{selected.length}/40）</legend>
            <div className="milestone-task-options">
              {matches.map((task) => (
                <label key={task.id} aria-label={task.title || task.prompt}>
                  <input
                    type="checkbox"
                    checked={selected.includes(task.id)}
                    disabled={
                      !selected.includes(task.id) && selected.length >= 40
                    }
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, task.id]
                          : current.filter((id) => id !== task.id),
                      )
                    }
                  />
                  <span>
                    <strong>{task.title || task.prompt}</strong>
                    <small>
                      {statusLabels[task.status] || task.status} ·{' '}
                      {taskVerification(task) || '尚未交付'}
                    </small>
                  </span>
                </label>
              ))}
              {missing.map((id) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked
                    onChange={() =>
                      setSelected((current) =>
                        current.filter((item) => item !== id),
                      )
                    }
                  />
                  <span>任务不可用（{id}）</span>
                </label>
              ))}
              {!matches.length && (
                <p>
                  {tasks.length
                    ? '没有匹配的任务，请调整搜索。'
                    : '请先在当前团队对话中安排任务，再关联到里程碑。'}
                </p>
              )}
            </div>
          </fieldset>
          <p>关联用于追踪交付；里程碑标记不会代替任务验收。</p>
          <div className="milestone-task-actions">
            <button
              type="button"
              className="primary-button"
              disabled={disabled}
              onClick={async () => {
                if (await onSave(selected)) setEditing(false);
              }}
            >
              保存关联
            </button>
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              onClick={() => setEditing(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
