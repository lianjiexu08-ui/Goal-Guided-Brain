// Filter before taking the page: old matching records must remain reachable
// even when the newest activity belongs to another category.
export function teamTimelinePage(spaceId, query, publicTeamTimeline) {
  const kind = query.get('kind') || 'all';
  if (
    ![
      'all',
      'messages',
      'execution',
      'evidence',
      'risk',
      'collaboration',
    ].includes(kind)
  )
    throw new Error('不支持的团队时间线筛选。');
  const limit = Math.max(1, Math.min(120, Number(query.get('limit')) || 60));
  const items = publicTeamTimeline(spaceId, {
    limit: limit + 1,
    before: query.get('before') || null,
    kind,
  });
  const hasMore = items.length > limit;
  return { items: hasMore ? items.slice(1) : items, hasMore };
}
