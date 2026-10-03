export function runAtomic(store, fn) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    store.db.exec('COMMIT');
    return result;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
