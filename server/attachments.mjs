import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_NAME = 180;
const SAFE_NAME = (value) => {
  const base = path.basename(String(value || '').replace(/\\/g, '/')).trim();
  return (base.replace(/^\.+/, '') || 'attachment').slice(0, MAX_NAME);
};
const PUBLIC_FIELDS = ['id', 'name', 'mime', 'size', 'createdAt', 'updatedAt'];

export class AttachmentService {
  constructor({ dataDir, records }) {
    this.records = records;
    this.directory = path.join(dataDir, 'attachments');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  metadata(id) {
    const row = this.records.get('attachments', id);
    if (!row) return null;
    return Object.fromEntries(PUBLIC_FIELDS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
  }
  list(ids) {
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => this.metadata(id)).filter(Boolean);
  }
  validateIds(ids, teamId = null) {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !id.trim()))
      throw new Error('附件引用无效，最多关联 20 个文件。');
    const unique = [...new Set(ids.map((id) => id.trim()))];
    const requestedTeamId = typeof teamId === 'string' && teamId.trim() ? teamId.trim() : null;
    for (const id of unique) {
      const row = this.records.get('attachments', id);
      if (!row) throw new Error(`附件不存在：${id}`);
      if (row.teamId && row.teamId !== requestedTeamId)
        throw Object.assign(new Error('附件属于另一个团队，不能跨团队引用。'), { status: 409 });
    }
    return unique;
  }
  create({ name, mime = 'application/octet-stream', data, teamId = null }) {
    if (typeof data !== 'string' || !data || data.length > Math.ceil(MAX_BYTES * 4 / 3) + 8)
      throw new Error('附件内容无效或超过 10 MB。');
    const normalized = data.replace(/^data:[^;]+;base64,/, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized))
      throw new Error('附件必须使用有效的 Base64 内容。');
    const bytes = Buffer.from(normalized, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('附件不能为空，且不能超过 10 MB。');
    const id = randomUUID();
    const safeName = SAFE_NAME(name);
    const row = this.records.save('attachments', {
      name: safeName,
      mime: typeof mime === 'string' && mime.trim() ? mime.trim().slice(0, 180) : 'application/octet-stream',
      size: bytes.length,
      storageName: `${id}.bin`,
      ...(typeof teamId === 'string' && teamId.trim() ? { teamId: teamId.trim() } : {}),
    }, id);
    try {
      fs.writeFileSync(path.join(this.directory, row.storageName), bytes, { mode: 0o600 });
    } catch (error) {
      this.records.remove('attachments', id);
      throw error;
    }
    return this.metadata(id);
  }
  read(id) {
    const row = this.records.get('attachments', id);
    if (!row || typeof row.storageName !== 'string') throw new Error('附件不存在。');
    const filename = path.join(this.directory, row.storageName);
    if (!fs.existsSync(filename)) throw new Error('附件内容已丢失，请重新上传。');
    return { metadata: this.metadata(id), bytes: fs.readFileSync(filename) };
  }
  materialize(ids, destination, teamId = null) {
    const result = [];
    for (const id of this.validateIds(ids, teamId)) {
      const { metadata, bytes } = this.read(id);
      const filename = `${String(result.length + 1).padStart(2, '0')}-${SAFE_NAME(metadata.name)}`;
      const target = path.join(destination, filename);
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, bytes, { mode: 0o600 });
      result.push({ ...metadata, path: target });
    }
    return result;
  }
  remove(id) {
    const row = this.records.get('attachments', id);
    if (!row) return false;
    if (row.storageName) fs.rmSync(path.join(this.directory, row.storageName), { force: true });
    return this.records.remove('attachments', id);
  }
}

export { MAX_BYTES };
