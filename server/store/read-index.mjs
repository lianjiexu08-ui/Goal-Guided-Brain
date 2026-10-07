import { deriveTaskDelivery } from './helpers.mjs';

// A synchronous read projection owns this index. Never retain it on Store or
// across requests: writes (including another SQLite connection) must be visible
// on the next read without cache invalidation machinery.
export class StoreReadIndex {
  constructor(store) {
    this.store = store;
    this.collections = new Map();
    this.byId = new Map();
    this.groups = new Map();
    this.deliveries = new Map();
  }

  list(name) {
    if (!this.collections.has(name))
      this.collections.set(name, this.store.records.list(name));
    return this.collections.get(name);
  }

  get(name, id) {
    if (!this.byId.has(name))
      this.byId.set(
        name,
        new Map(this.list(name).map((item) => [item.id, item])),
      );
    return this.byId.get(name).get(id) || null;
  }

  group(name, field, value) {
    const key = `${name}:${field}`;
    if (!this.groups.has(key)) {
      const groups = new Map();
      for (const item of this.list(name)) {
        if (!groups.has(item[field])) groups.set(item[field], []);
        groups.get(item[field]).push(item);
      }
      this.groups.set(key, groups);
    }
    return this.groups.get(key).get(value) || [];
  }

  tasks() {
    return (this.taskRows ??= this.store.tasks());
  }

  task(id) {
    this.taskById ??= new Map(this.tasks().map((task) => [task.id, task]));
    return this.taskById.get(id) || null;
  }

  tasksForSpace(spaceId) {
    if (!this.tasksBySpace) {
      this.tasksBySpace = new Map();
      for (const task of this.tasks()) {
        const meta = this.get('task-meta', task.id) || {};
        const job = meta.jobId ? this.get('jobs', meta.jobId) : null;
        const id = meta.spaceId || job?.spaceId || null;
        if (!this.tasksBySpace.has(id)) this.tasksBySpace.set(id, []);
        this.tasksBySpace.get(id).push(task);
      }
    }
    return this.tasksBySpace.get(spaceId) || [];
  }

  teamSpaces() {
    return (this.spaces ??= this.list('spaces').map((space) =>
      this.store.normalizeTeamSpace(space),
    ));
  }

  knowledge() {
    return (this.knowledgeRows ??= this.store.knowledge());
  }

  taskDelivery(task) {
    if (!this.deliveries.has(task.id)) {
      const meta = this.get('task-meta', task.id) || {};
      this.deliveries.set(
        task.id,
        deriveTaskDelivery({
          task,
          meta,
          job: meta.jobId ? this.get('jobs', meta.jobId) : null,
          artifacts: this.group('artifacts', 'taskId', task.id),
          savedAcceptance: this.get('task-acceptance', task.id),
        }),
      );
    }
    return this.deliveries.get(task.id);
  }

  usedTokens(spaceId) {
    if (!this.tokensBySpace) {
      this.tokensBySpace = new Map();
      for (const usage of this.list('usage')) {
        const job = this.get('jobs', usage.jobId);
        if (!job) continue;
        const id = job.teamId || job.spaceId;
        this.tokensBySpace.set(
          id,
          (this.tokensBySpace.get(id) || 0) + (Number(usage.totalTokens) || 0),
        );
      }
    }
    return this.tokensBySpace.get(spaceId) || 0;
  }
}
