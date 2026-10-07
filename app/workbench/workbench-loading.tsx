import { ArrowRight, LoaderCircle, RefreshCw } from 'lucide-react';

export function WorkbenchLoading({
  error,
  refreshing,
  onRetry,
}: {
  error: string;
  refreshing: boolean;
  onRetry: () => Promise<void>;
}) {
  return (
    <main className="workbench-loading" aria-busy={refreshing}>
      <section className="workbench-loading-card" aria-label="连接工作台">
        <div className="workbench-loading-brand">GGB / GOAL-GUIDED BRAIN</div>
        <div className="workbench-loading-symbol" aria-hidden="true">
          {error ? (
            <RefreshCw size={26} />
          ) : (
            <LoaderCircle className="spin" size={26} />
          )}
        </div>
        <h1>{error ? '暂时无法打开工作台' : '正在准备你的工作台'}</h1>
        <p>
          {error
            ? '请确认本地服务正在运行。连接恢复后，会回到你上次的团队和工作位置。'
            : '正在读取团队、模型和最近的工作位置，连接后即可继续。'}
        </p>
        {error ? (
          <>
            <p className="workbench-loading-error" role="alert">
              {error}
            </p>
            <button
              className="primary-button"
              disabled={refreshing}
              onClick={() => void onRetry()}
            >
              {refreshing ? '正在重试…' : '重新连接'}
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </>
        ) : (
          <output className="workbench-loading-status">
            正在连接本地服务…
          </output>
        )}
        <div className="workbench-loading-preview" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>
    </main>
  );
}
