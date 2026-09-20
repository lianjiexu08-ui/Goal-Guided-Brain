import { randomUUID } from 'node:crypto';

export const RECORDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  PRIMARY KEY(collection,id)
);
CREATE INDEX IF NOT EXISTS idx_records_collection_updated ON records(collection,updatedAt);
`;

export class Records {
  constructor(db) {
    this.db = db;
  }
  get(collection, id) {
    const row = this.db
      .prepare('SELECT * FROM records WHERE collection=? AND id=?')
      .get(collection, id);
    return row
      ? {
          ...JSON.parse(row.data),
          id: row.id,
          revision: row.revision,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }
      : null;
  }
  list(collection) {
    return this.db
      .prepare(
        'SELECT * FROM records WHERE collection=? ORDER BY createdAt DESC,rowid DESC',
      )
      .all(collection)
      .map((row) => ({
        ...JSON.parse(row.data),
        id: row.id,
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  }
  save(collection, input, id = input.id || randomUUID(), expectedRevision) {
    const previous = this.get(collection, id);
    if (
      expectedRevision !== undefined &&
      previous?.revision !== expectedRevision
    )
      throw new Error('记录已更新，请刷新后重试。');
    const {
      id: _id,
      revision: _revision,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...data
    } = input;
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO records(collection,id,data,createdAt,updatedAt) VALUES(?,?,?,?,?)
      ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,revision=records.revision+1,updatedAt=excluded.updatedAt`)
      .run(collection, id, JSON.stringify(data), now, now);
    return this.get(collection, id);
  }
  remove(collection, id) {
    return (
      this.db
        .prepare('DELETE FROM records WHERE collection=? AND id=?')
        .run(collection, id).changes > 0
    );
  }
}
