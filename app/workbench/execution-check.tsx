'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../workbench-api';

type Check = {
  id: 'workspace' | 'engine';
  status: 'pass' | 'warn' | 'fail';
  detail: string;
};
type Report = { checkedAt: string; checks: Check[] };
function validReport(value: unknown): value is Report {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<Report>;
  return (
    typeof report.checkedAt === 'string' &&
    Number.isFinite(Date.parse(report.checkedAt)) &&
    Array.isArray(report.checks) &&
    report.checks.length === 2 &&
    ['workspace', 'engine'].every((id) =>
      report.checks!.some(
        (check) =>
          check?.id === id &&
          ['pass', 'warn', 'fail'].includes(check.status) &&
          typeof check.detail === 'string',
      ),
    )
  );
}

export function ExecutionCheck({ workspace }: { workspace: string }) {
  return <ExecutionCheckContent key={workspace} workspace={workspace} />;
}

function ExecutionCheckContent({ workspace }: { workspace: string }) {
  const [result, setResult] = useState<{
    workspace: string;
    report: Report;
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef<{ id: number; controller?: AbortController }>({
    id: 0,
  });
  useEffect(() => {
    const active = request.current;
    return () => {
      active.id++;
      active.controller?.abort();
    };
  }, []);

  async function inspect() {
    request.current.controller?.abort();
    const id = ++request.current.id;
    const controller = new AbortController();
    request.current.controller = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setBusy(true);
    setError('');
    try {
      const report = await api(
        'execution-check',
        'POST',
        { workspace },
        controller.signal,
      );
      if (request.current.id !== id) return;
      if (!validReport(report)) throw new Error('检查结果无效，请重试。');
      setResult({ workspace, report });
    } catch (failure) {
      if (request.current.id === id)
        setError(
          controller.signal.aborted
            ? '检查超时，请确认服务连接后重试。'
            : failure instanceof Error
              ? failure.message
              : '检查失败，请重试。',
        );
    } finally {
      window.clearTimeout(timeout);
      if (request.current.id === id) setBusy(false);
    }
  }
  const report = result?.workspace === workspace ? result.report : null;
  return (
    <section
      className="execution-check"
      aria-label="本机执行检查"
      aria-busy={busy}
    >
      <div className="execution-check-heading">
        <strong>本机执行检查</strong>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void inspect()}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {busy ? '正在检查…' : error ? '重试检查' : '检查目录与引擎'}
        </button>
      </div>
      <p>检查运行 GGB 服务的这台电脑。不会创建文件、启动任务或调用模型。</p>
      {error && (
        <p role="alert" className="execution-check-error">
          {error}
        </p>
      )}
      {report && (
        <div aria-live="polite">
          <small>
            {busy || error ? '上次检查' : '检查时间'}：
            {new Date(report.checkedAt).toLocaleTimeString()}
          </small>
          <ul>
            {report.checks.map((check) => (
              <li key={check.id} data-status={check.status}>
                <strong>
                  {check.id === 'workspace' ? '工作目录' : '执行引擎'} ·{' '}
                  {check.status === 'pass'
                    ? '已检查'
                    : check.status === 'warn'
                      ? '需留意'
                      : '待处理'}
                </strong>
                <span>{check.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <small>
        文件与权限检查不代表引擎启动、模型连接或执行成功；远程节点的目录映射需在节点上单独核对。
      </small>
    </section>
  );
}
