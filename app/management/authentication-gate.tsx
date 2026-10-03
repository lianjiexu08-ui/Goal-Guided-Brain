'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Inbox,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';
import { api } from '../workbench-api';

type AuthState = {
  required: boolean;
  authenticated: boolean;
  configured: boolean;
};

function AuthMessage({ error }: { error: string }) {
  return error ? (
    <div className="manage-error" role="alert">
      <span>{error}</span>
    </div>
  ) : null;
}

function AuthEmpty({ busy, text }: { busy: boolean; text: string }) {
  return (
    <div className="manage-empty">
      {busy ? <LoaderCircle size={26} className="spin" /> : <Inbox size={27} />}
      <strong>{busy ? '正在载入' : text}</strong>
    </div>
  );
}

export function AuthenticationGate({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = useCallback(async () => {
    try {
      setAuth(await api<AuthState>('auth/status'));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void check(), 0);
    const onExpired = () => void check();
    window.addEventListener('workbench-auth-required', onExpired);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('workbench-auth-required', onExpired);
    };
  }, [check]);

  if (auth && (!auth.required || auth.authenticated)) return children;
  return (
    <main className="manage-login">
      <section>
        <Layers3 size={32} color="#1b7565" />
        <h1>Goal-Guided Brain</h1>
        <AuthMessage error={error} />
        {!auth ? (
          <>
            <AuthEmpty busy={!error} text="连接失败" />
            {error && (
              <button className="secondary-button" onClick={() => void check()}>
                <RefreshCw size={16} />
                重新连接
              </button>
            )}
          </>
        ) : (
          <form
            className="manage-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError('');
              try {
                await api('auth/login', 'POST', { password });
                setPassword('');
                await check();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              工作台密码
              <input
                required
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="primary-button" disabled={busy || !password}>
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <LockKeyhole size={16} />
              )}
              登录
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
