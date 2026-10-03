const nodeAttentionId = (nodeId) => `node:${nodeId}:offline`;

const nowIso = (control) => new Date(control.now()).toISOString();

const readTimestamp = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

function resolveNodeAttention(control, node, resolution) {
  const id = nodeAttentionId(node.id);
  const attention = control.records.get('attention', id);
  if (attention && !['resolved', 'dismissed'].includes(attention.status)) {
    control.records.save(
      'attention',
      {
        ...attention,
        status: 'resolved',
        resolvedAt: control.now(),
        resolution,
      },
      id,
    );
  }
  const notification = control.records.get('notifications', `attention:${id}`);
  if (notification && notification.read !== true) {
    control.records.save(
      'notifications',
      {
        ...notification,
        read: true,
        readAt: nowIso(control),
      },
      notification.id,
    );
  }
}

function reopenNodeNotification(control, node, attention) {
  const id = `attention:${attention.id}`;
  const notification = control.records.get('notifications', id);
  if (!notification) return;
  control.records.save(
    'notifications',
    {
      ...notification,
      name: attention.title,
      message: attention.detail,
      read: false,
      readAt: null,
      occurredAt: nowIso(control),
      nodeId: node.id,
    },
    id,
  );
}

function markNodeOffline(control, node) {
  const now = control.now();
  const saved = control.records.save(
    'nodes',
    {
      ...node,
      status: 'offline',
      offlineSince: node.offlineSince || now,
      statusChangedAt: now,
    },
    node.id,
  );
  const attention = control.attention(
    {
      nodeId: node.id,
      kind: 'node-offline',
      title: `执行节点失联：${node.name || node.id}`,
      detail:
        '节点已超过租约时间未发送心跳。请重新运行启动命令，并确认已有执行状态。',
    },
    nodeAttentionId(node.id),
  );
  reopenNodeNotification(control, saved, attention);
  return saved;
}

export function reconcileNodeLiveness(control) {
  const transitions = [];
  for (const node of control.records.list('nodes')) {
    if (node.revokedAt || node.status === 'revoked') continue;
    const stale =
      control.now() - readTimestamp(node.lastSeenAt) > control.leaseMs;
    const attention = control.records.get(
      'attention',
      nodeAttentionId(node.id),
    );
    const hasOpenAttention =
      attention && !['resolved', 'dismissed'].includes(attention.status);
    if (stale && node.status !== 'offline') {
      transitions.push({
        node: markNodeOffline(control, node),
        status: 'offline',
      });
      continue;
    }
    if (!stale && (node.status === 'offline' || hasOpenAttention)) {
      const now = control.now();
      const saved = control.records.save(
        'nodes',
        {
          ...node,
          status: 'online',
          offlineSince: null,
          recoveredAt: now,
          statusChangedAt: now,
        },
        node.id,
      );
      resolveNodeAttention(control, saved, '节点已恢复心跳。');
      transitions.push({ node: saved, status: 'online' });
    }
  }
  return transitions;
}

export function markNodeOnline(control, node) {
  const current = control.records.get('nodes', node.id) || node;
  const now = control.now();
  const recovered = current.status === 'offline';
  const saved = control.records.save(
    'nodes',
    {
      ...current,
      status: 'online',
      lastSeenAt: now,
      ...(recovered
        ? {
            offlineSince: null,
            recoveredAt: now,
            statusChangedAt: now,
          }
        : {}),
    },
    current.id,
  );
  if (recovered) resolveNodeAttention(control, saved, '节点已恢复心跳。');
  return saved;
}
