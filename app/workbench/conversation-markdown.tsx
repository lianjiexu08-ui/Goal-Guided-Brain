'use client';

import { memo } from 'react';
import Markdown from 'react-markdown';

// Draft edits and sibling task updates should not reparse unchanged answers.
export const ConversationMarkdown = memo(function ConversationMarkdown({
  source,
}: {
  source: string;
}) {
  return <Markdown>{source}</Markdown>;
});
