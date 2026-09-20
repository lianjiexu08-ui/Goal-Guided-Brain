import { createHash, randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

export const hashToken = value => createHash('sha256').update(String(value)).digest('hex');
export const bearer = req => /^Bearer\s+([^\s]+)$/i.exec(req?.headers?.authorization || '')?.[1] || '';
const localAddress = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

export class AuthService {
  constructor({ store, now = () => Date.now(), ownerPassword = process.env.WORKBENCH_OWNER_PASSWORD,
    requireAuth = process.env.WORKBENCH_REQUIRE_AUTH === '1', secureCookies = process.env.WORKBENCH_PUBLIC_URL?.startsWith('https:') } = {}) {
    this.store = store;
    this.now = now;
    this.ownerPassword = ownerPassword;
    const binding = process.env.WORKBENCH_BIND_HOST || '127.0.0.1';
    this.requireAuth = !!requireAuth || !!process.env.WORKBENCH_PUBLIC_URL || !['localhost', '127.0.0.1', '::1'].includes(binding);
    this.secureCookies = !!secureCookies;
    this.attempts = new Map();
  }
  async init() {
    if (!this.store.records.get('auth', 'owner') && this.ownerPassword) {
      await this.setPassword(this.ownerPassword);
    }
    this.ownerPassword = undefined;
    if (this.requireAuth && !this.store.records.get('auth', 'owner')) {
      throw new Error('云端登录未初始化，请通过 WORKBENCH_OWNER_PASSWORD 设置至少 12 位的初始密码。');
    }
    return this;
  }
  async setPassword(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
      throw new Error('登录密码需要 12 至 1024 个字符。');
    }
    const passwordHash = await argon2id({ password, salt: randomBytes(16), parallelism: 1,
      iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'encoded' });
    this.store.records.save('auth', { passwordHash }, 'owner');
    for (const session of this.store.records.list('auth-sessions')) this.store.records.remove('auth-sessions', session.id);
  }
  authorize(req) {
    // Direct loopback mode is available only when authentication was not enabled.
    if (!this.requireAuth && localAddress(req?.socket?.remoteAddress)) return { authorized: true, principal: { type: 'owner' } };
    const token = /(?:^|;\s*)dsh_session=([a-f0-9]{64})(?:;|$)/.exec(req?.headers?.cookie || '')?.[1];
    const session = token && this.store.records.get('auth-sessions', hashToken(token));
    if (!session || session.expiresAt <= this.now()) return { authorized: false, status: 401 };
    return { authorized: true, principal: { type: 'owner' } };
  }
  cookie(token, age) {
    return `dsh_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.secureCookies ? '; Secure' : ''}`;
  }
  async handle({ method, parts, body = {}, req }) {
    if (parts[0] === 'api') parts = parts.slice(1);
    if (parts[0] !== 'auth') return null;
    if (method === 'GET' && parts[1] === 'status') return { status: 200, body: {
      required: this.requireAuth || !localAddress(req?.socket?.remoteAddress),
      configured: !!this.store.records.get('auth', 'owner'), authenticated: this.authorize(req).authorized,
    } };
    if (method === 'POST' && parts[1] === 'login') {
      const address = req?.socket?.remoteAddress || 'unknown';
      const now = this.now();
      for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key);
      const attempts = this.attempts.get(address) || { count: 0, until: now + 15 * 60_000 };
      if (attempts.count >= 8 || (!this.attempts.has(address) && this.attempts.size >= 1000)) {
        return { status: 429, body: { error: '登录尝试过多，请稍后重试。' } };
      }
      attempts.count++;
      this.attempts.set(address, attempts);
      const owner = this.store.records.get('auth', 'owner');
      if (!owner || typeof body.password !== 'string' || body.password.length > 1024 ||
        !(await argon2Verify({ password: body.password, hash: owner.passwordHash }))) {
        return { status: 401, body: { error: '用户名或密码不正确。' } };
      }
      this.attempts.delete(address);
      const token = randomBytes(32).toString('hex');
      for (const session of this.store.records.list('auth-sessions')) {
        if (session.expiresAt <= now) this.store.records.remove('auth-sessions', session.id);
      }
      this.store.records.save('auth-sessions', { expiresAt: now + 12 * 60 * 60_000 }, hashToken(token));
      return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': this.cookie(token, 43200) } };
    }
    if (method === 'POST' && parts[1] === 'logout') {
      const token = /(?:^|;\s*)dsh_session=([a-f0-9]{64})(?:;|$)/.exec(req?.headers?.cookie || '')?.[1];
      if (token) this.store.records.remove('auth-sessions', hashToken(token));
      return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': this.cookie('', 0) } };
    }
    if (method === 'PUT' && parts[1] === 'password') {
      if (!this.authorize(req).authorized) return { status: 401, body: { error: '请先登录。' } };
      await this.setPassword(body.password);
      return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': this.cookie('', 0) } };
    }
    return { status: 404, body: { error: '登录接口不存在。' } };
  }
}
