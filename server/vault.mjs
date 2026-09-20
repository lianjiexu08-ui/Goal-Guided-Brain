import fs from 'node:fs';
import path from 'node:path';
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { argon2id } from 'hash-wasm';

const KDF = {
  algorithm: 'argon2id',
  memorySize: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
};

export class Vault {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'vault.json');
    this.key = null;
    this.entries = null;
    this.busy = false;
    this.generation = 0;
  }
  status() {
    return {
      initialized: fs.existsSync(this.file),
      unlocked: !!this.key,
      count: this.entries ? Object.keys(this.entries).length : null,
    };
  }
  async derive(passphrase, salt) {
    if (
      typeof passphrase !== 'string' ||
      passphrase.length < 6 ||
      passphrase.length > 1024
    )
      throw new Error('凭据库口令需要 6 至 1024 个字符。');
    return Buffer.from(
      await argon2id({
        ...KDF,
        password: passphrase,
        salt: Buffer.from(salt, 'base64'),
        outputType: 'binary',
      }),
    );
  }
  async initialize(passphrase) {
    if (this.busy || fs.existsSync(this.file))
      throw new Error('凭据库已初始化或正在解锁。');
    this.busy = true;
    const generation = this.generation;
    try {
      this.salt = randomBytes(16).toString('base64');
      const key = await this.derive(passphrase, this.salt);
      if (generation !== this.generation) {
        key.fill(0);
        throw new Error('凭据库操作已取消。');
      }
      this.key = key;
      this.entries = Object.create(null);
      try {
        this.persist();
      } catch (error) {
        this.lock();
        throw error;
      }
      return this.status();
    } finally {
      this.busy = false;
    }
  }
  async unlock(passphrase) {
    if (this.busy) throw new Error('凭据库正在解锁。');
    this.busy = true;
    const generation = this.generation;
    let key;
    try {
      const envelope = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        envelope.version !== 1 ||
        JSON.stringify(envelope.kdf) !== JSON.stringify(KDF)
      )
        throw new Error('不支持的凭据库版本。');
      key = await this.derive(passphrase, envelope.salt);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAAD(Buffer.from('dsh-workbench-vault-v1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const decoded = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
      const entries = JSON.parse(decoded.toString('utf8'));
      decoded.fill(0);
      if (generation !== this.generation) throw new Error('凭据库操作已取消。');
      this.key?.fill(0);
      this.key = key;
      key = null;
      this.entries = Object.assign(Object.create(null), entries);
      this.salt = envelope.salt;
      return this.status();
    } catch {
      throw new Error('凭据库无法解锁，请检查口令和备份文件。');
    } finally {
      key?.fill(0);
      this.busy = false;
    }
  }
  lock() {
    this.generation += 1;
    this.key?.fill(0);
    this.key = null;
    this.entries = null;
    return this.status();
  }
  requireUnlocked() {
    if (!this.key || !this.entries) throw new Error('请先解锁凭据库。');
  }
  list() {
    if (!this.entries) return [];
    return Object.values(this.entries).map(
      ({ value: _value, ...entry }) => entry,
    );
  }
  async put({ name, value, kind = 'api-key' }, id = randomUUID()) {
    this.requireUnlocked();
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 120 ||
      typeof value !== 'string' ||
      !value ||
      value.length > 65536 ||
      typeof kind !== 'string' ||
      !kind ||
      kind.length > 80 ||
      typeof id !== 'string' ||
      !id ||
      id.length > 160
    )
      throw new Error('凭据名称、类型或内容无效。');
    const previous = this.entries[id];
    this.entries[id] = {
      id,
      name: name.trim(),
      kind,
      value,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      this.persist();
    } catch (error) {
      if (previous) this.entries[id] = previous;
      else delete this.entries[id];
      throw error;
    }
    return this.list().find((entry) => entry.id === id);
  }
  get(id) {
    this.requireUnlocked();
    return this.entries[id]?.value ?? null;
  }
  remove(id) {
    this.requireUnlocked();
    const previous = this.entries[id];
    if (!previous) return false;
    delete this.entries[id];
    try {
      this.persist();
    } catch (error) {
      this.entries[id] = previous;
      throw error;
    }
    return true;
  }
  persist() {
    this.requireUnlocked();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('dsh-workbench-vault-v1'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(this.entries), 'utf8'),
      cipher.final(),
    ]);
    const envelope = {
      version: 1,
      kdf: KDF,
      salt: this.salt,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(envelope));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
