'use client';

import { useStructuredDraft } from '../drafts/use-structured-draft';

export type CollaborationDraft = {
  targetTeamId: string;
  content: string;
  acceptance: string;
  clientMessageId?: string;
  followup?: { messageId: string; title: string };
};
const empty: CollaborationDraft = {
  targetTeamId: '',
  content: '',
  acceptance: '',
};
function valid(raw: unknown) {
  const value = raw as CollaborationDraft | null;
  return (
    !!value &&
    typeof value.targetTeamId === 'string' &&
    typeof value.content === 'string' &&
    typeof value.acceptance === 'string' &&
    value.content.length <= 32000 &&
    value.acceptance.length <= 20000 &&
    (value.clientMessageId === undefined ||
      typeof value.clientMessageId === 'string') &&
    (value.followup === undefined ||
      (!!value.followup &&
        typeof value.followup.messageId === 'string' &&
        typeof value.followup.title === 'string'))
  );
}
export function useCollaborationDraft(teamId: string) {
  const store = useStructuredDraft({
    endpoint: `teams/${encodeURIComponent(teamId)}/collaboration-draft`,
    legacyKey: `ggb.collaboration-draft.v1:${teamId}`,
    empty,
    valid,
  });
  return {
    ...store,
    update: (patch: Partial<CollaborationDraft>) =>
      store.update({ ...store.draft, ...patch }),
    confirm: async () => {
      const value = {
        ...store.draft,
        clientMessageId: store.draft.clientMessageId || crypto.randomUUID(),
      };
      const saved = await store.commit(value);
      return { ...saved.value, draftRevision: saved.revision };
    },
    release: (id: string) => {
      const latest = store.getCurrent();
      if (latest.clientMessageId === id)
        store.update({ ...latest, clientMessageId: undefined });
    },
    complete: store.completed,
  };
}
