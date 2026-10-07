'use client';

import { useEffect, useRef, useState } from 'react';

export type CollaborationDraft = {
  targetTeamId: string;
  content: string;
  acceptance: string;
  clientMessageId?: string;
  followup?: { messageId: string; title: string };
};
const empty = (): CollaborationDraft => ({
  targetTeamId: '',
  content: '',
  acceptance: '',
});
const eventName = 'ggb-collaboration-draft-updated';

function read(key: string): CollaborationDraft {
  const raw = window.localStorage.getItem(key);
  if (!raw) return empty();
  const value = JSON.parse(raw);
  if (
    !value ||
    typeof value.targetTeamId !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.acceptance !== 'string' ||
    value.content.length > 32000 ||
    value.acceptance.length > 20000 ||
    (value.clientMessageId !== undefined &&
      typeof value.clientMessageId !== 'string') ||
    (value.followup !== undefined &&
      (!value.followup ||
        typeof value.followup.messageId !== 'string' ||
        typeof value.followup.title !== 'string'))
  )
    throw new Error('Invalid collaboration draft');
  return value;
}

export function useCollaborationDraft(teamId: string) {
  const key = `ggb.collaboration-draft.v1:${teamId}`;
  const [draft, setDraft] = useState<CollaborationDraft>(empty);
  const current = useRef(draft);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  useEffect(() => {
    const load = () => {
      try {
        const next = read(key);
        current.current = next;
        setDraft(next);
        setStorageError('');
      } catch {
        setStorageError('本机草稿无法读取，请保持当前页面并复制重要内容。');
      }
      setReady(true);
    };
    const timer = window.setTimeout(load, 0);
    const storage = (event: StorageEvent) => {
      if (event.key === key) load();
    };
    const local = (event: Event) => {
      if ((event as CustomEvent).detail === key) load();
    };
    window.addEventListener('storage', storage);
    window.addEventListener(eventName, local);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('storage', storage);
      window.removeEventListener(eventName, local);
    };
  }, [key]);
  const save = (next: CollaborationDraft) => {
    current.current = next;
    setDraft(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
      setStorageError('');
      window.dispatchEvent(new CustomEvent(eventName, { detail: key }));
    } catch {
      setStorageError('草稿未能保存到本机，离开页面前请复制重要内容。');
    }
    return next;
  };
  return {
    draft,
    ready,
    storageError,
    update: (patch: Partial<CollaborationDraft>) =>
      save({ ...current.current, ...patch }),
    confirm: () => {
      if (current.current.clientMessageId) return current.current;
      return save({ ...current.current, clientMessageId: crypto.randomUUID() });
    },
    release: (id: string) => {
      let latest = current.current;
      try {
        latest = read(key);
      } catch {
        /* Preserve the in-memory fallback. */
      }
      if (latest.clientMessageId === id)
        save({ ...latest, clientMessageId: undefined });
    },
    complete: (id: string) => {
      // A response from an old mount must not erase a newer draft.
      let latest = current.current;
      try {
        latest = read(key);
      } catch {
        /* Keep the in-memory draft if storage is unavailable. */
      }
      if (latest.clientMessageId === id)
        save({ ...empty(), targetTeamId: latest.targetTeamId });
    },
  };
}
