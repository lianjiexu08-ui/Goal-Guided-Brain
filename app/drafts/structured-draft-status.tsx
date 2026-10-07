'use client';

import { pendingDraftId, type SyncStatus } from './use-structured-draft';

const labels: Record<SyncStatus, string> = {
  loading: '正在恢复草稿…',
  saving: '正在同步草稿…',
  saved: '草稿已同步，可在其他设备继续。',
  offline: '暂未同步，当前内容保留在本机；恢复连接后会重试。',
  conflict: '另一设备也修改了这份草稿，请核对后选择。',
};
export function StructuredDraftStatus({
  store,
  describe,
  label = '协作草稿',
}: {
  store: {
    status: SyncStatus;
    storageError: string;
    draft: object;
    conflict: { value: object } | null;
    resolve: (choice: 'local' | 'remote') => void;
    retry: () => Promise<void>;
  };
  describe: (value: object) => string;
  label?: string;
}) {
  return (
    <section className="structured-draft-status" aria-label={`${label}同步`}>
      <output>{store.storageError || labels[store.status]}</output>
      {store.status === 'offline' && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => void store.retry()}
        >
          重试同步草稿
        </button>
      )}
      {store.conflict && (
        <fieldset
          className="structured-draft-conflict"
          aria-label={`${label}版本冲突`}
        >
          <p>两个版本均保留在这里，选择前不会发送协作或记录处理决定。</p>
          <div className="structured-draft-versions">
            <label>
              本机版本
              <textarea
                readOnly
                aria-label={`${label}本机版本`}
                value={describe(store.draft)}
                rows={5}
              />
            </label>
            <label>
              服务端版本
              <textarea
                readOnly
                aria-label={`${label}服务端版本`}
                value={describe(store.conflict.value)}
                rows={5}
              />
            </label>
          </div>
          {pendingDraftId(store.conflict.value) && (
            <p>
              服务端有待确认请求，请先使用该版本确认结果；可复制本机内容留作后续需求。
            </p>
          )}
          <div className="collaboration-chain-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={!!pendingDraftId(store.conflict.value)}
              onClick={() => store.resolve('local')}
            >
              保留本机版本
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => store.resolve('remote')}
            >
              使用服务端版本
            </button>
          </div>
        </fieldset>
      )}
    </section>
  );
}
