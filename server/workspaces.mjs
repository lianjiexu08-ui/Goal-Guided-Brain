import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { childEnvironment } from './runtime.mjs';

export function command(
  executable,
  args,
  { cwd, timeout = 60000, maxOutputBytes = 32_000_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...childEnvironment(), GIT_TERMINAL_PROMPT: '0' },
    });
    const stdout = [],
      stderr = [];
    let bytes = 0,
      failure;
    const timer = setTimeout(() => {
      failure = new Error(`${executable} 执行超时。`);
      child.kill('SIGKILL');
    }, timeout);
    const collect = (target) => (data) => {
      bytes += data.length;
      if (bytes > maxOutputBytes) {
        failure ??= new Error(
          `${executable} 输出超过 ${maxOutputBytes} 字节限制，已停止以防止数据截断。`,
        );
        child.kill('SIGKILL');
      } else target.push(data);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'));
      else
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8') ||
              `${executable} exited ${code}`,
          ),
        );
    });
  });
}

const excluded = (relative) =>
  relative
    .split(path.sep)
    .some(
      (part) =>
        ['.git', 'node_modules', '.next', 'dist', '.env'].includes(part) ||
        part.startsWith('.env.'),
    );

export class WorkspaceManager {
  constructor({ store, dataDir }) {
    this.store = store;
    this.dir = path.join(dataDir, 'executions');
    this.ports = new Map();
  }
  async prepare(task, mode = 'shared') {
    if (
      !/^[A-Za-z0-9_-]{1,160}$/.test(task.id) ||
      !['shared', 'isolated', 'worktree', 'snapshot'].includes(mode)
    )
      throw new Error('执行实例或目录模式无效。');
    const existing = this.store.records.get('workspaces', task.id);
    if (existing) {
      if (existing.state === 'active' && !this.ports.has(task.id))
        await this.reservePort(task.id, existing.port);
      return existing;
    }
    const root = path.join(this.dir, task.id);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const tempDir = path.join(root, 'tmp');
    fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    let directory = task.workspace,
      kind = 'shared',
      baseCommit = null,
      branch = null;
    let createdWorktree = false;
    try {
      if (mode !== 'shared') {
        directory = path.join(root, 'workspace');
        const sourceRoot = fs.realpathSync(task.workspace);
        if (fs.realpathSync(root).startsWith(`${sourceRoot}${path.sep}`))
          throw new Error('执行目录不能位于源项目内，请更换数据目录。');
        if (mode !== 'snapshot') {
          try {
            baseCommit = (
              await command('git', ['rev-parse', '--verify', 'HEAD'], {
                cwd: task.workspace,
              })
            ).trim();
          } catch {
            /* A new project has no committed base. */
          }
        }
        if (mode === 'worktree' && !baseCommit)
          throw new Error('项目没有 Git 基准提交，无法创建 worktree。');
        if (baseCommit) {
          branch = `codex/task-${task.id}`;
          await command(
            'git',
            ['worktree', 'add', '-b', branch, directory, baseCommit],
            { cwd: task.workspace },
          );
          createdWorktree = true;
          kind = 'worktree';
          const dirty = await command('git', ['status', '--porcelain'], {
            cwd: task.workspace,
          });
          if (dirty) {
            const patch = await command('git', ['diff', '--binary', 'HEAD'], {
              cwd: task.workspace,
            });
            if (patch) {
              const filename = path.join(root, 'working.patch');
              fs.writeFileSync(filename, patch, { mode: 0o600 });
              await command('git', ['apply', '--binary', filename], {
                cwd: directory,
              });
            }
            const untracked = await command(
              'git',
              ['ls-files', '--others', '--exclude-standard', '-z'],
              { cwd: task.workspace },
            );
            for (const relative of untracked.split('\0').filter(Boolean)) {
              if (excluded(relative)) continue;
              const source = path.join(task.workspace, relative);
              if (!fs.lstatSync(source).isSymbolicLink()) {
                fs.mkdirSync(path.dirname(path.join(directory, relative)), {
                  recursive: true,
                });
                fs.copyFileSync(source, path.join(directory, relative));
              }
            }
          }
        } else {
          fs.cpSync(sourceRoot, directory, {
            recursive: true,
            dereference: false,
            filter: (source) =>
              !fs.lstatSync(source).isSymbolicLink() &&
              !excluded(path.relative(sourceRoot, source)),
          });
          kind = 'snapshot';
        }
      }
      const port = await this.reservePort(task.id);
      return this.store.records.save(
        'workspaces',
        {
          source: task.workspace,
          path: directory,
          kind,
          baseCommit,
          branch,
          tempDir,
          port,
          portPolicy: 'reserved-until-launch; fail on EADDRINUSE',
          state: 'active',
        },
        task.id,
      );
    } catch (error) {
      this.releasePort(task.id);
      if (createdWorktree) {
        await command('git', ['worktree', 'remove', '--force', directory], {
          cwd: task.workspace,
        }).catch(() => {});
        await command('git', ['branch', '-D', branch], {
          cwd: task.workspace,
        }).catch(() => {});
      }
      throw error;
    }
  }
  async reservePort(id, port = 0) {
    return new Promise((resolve, reject) => {
      const socket = net.createServer();
      socket.once('error', (error) =>
        reject(
          new Error(
            `执行端口 ${port} 无法独占：${error.code || error.message}`,
          ),
        ),
      );
      socket.listen(port, '127.0.0.1', () => {
        const value = socket.address().port;
        this.ports.set(id, socket);
        resolve(value);
      });
    });
  }
  // The launched program must bind this exact port and report EADDRINUSE. A
  // generic CLI cannot inherit the reservation socket, so release is not atomic.
  releasePort(id) {
    const socket = this.ports.get(id);
    if (socket) {
      socket.close();
      this.ports.delete(id);
    }
  }
  finish(id, state = 'retained') {
    this.releasePort(id);
    const row = this.store.records.get('workspaces', id);
    if (row) this.store.records.save('workspaces', { ...row, state }, id);
  }
  async diff(id) {
    const row = this.store.records.get('workspaces', id);
    if (!row) throw new Error('执行目录不存在。');
    if (row.kind !== 'worktree')
      return {
        kind: row.kind,
        diff: '',
        message: '此目录没有 Git 基准，成果通过文件交接。',
      };
    return {
      kind: row.kind,
      diff: await command('git', ['diff', '--stat', row.baseCommit], {
        cwd: row.path,
      }),
      status: await command('git', ['status', '--short'], { cwd: row.path }),
    };
  }
  async commit(id, message = 'Save verified task output') {
    const row = this.store.records.get('workspaces', id);
    if (row?.kind !== 'worktree' || row.state === 'quarantined')
      throw new Error('只有有效 worktree 可以保存提交。');
    await command('git', ['add', '--all'], { cwd: row.path });
    await command(
      'git',
      [
        '-c',
        'user.name=DSH Workbench',
        '-c',
        'user.email=dsh@localhost',
        'commit',
        '-m',
        message,
      ],
      { cwd: row.path },
    );
    const commit = (
      await command('git', ['rev-parse', 'HEAD'], { cwd: row.path })
    ).trim();
    this.store.records.save('artifacts', {
      taskId: id,
      kind: 'commit',
      name: message,
      commit,
      branch: row.branch,
      path: row.path,
      state: 'pending-review',
    });
    return { commit, branch: row.branch };
  }
  async integrate(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20)
      throw new Error('请选择 1 至 20 个 worktree。');
    const rows = ids.map((id) => this.store.records.get('workspaces', id));
    if (
      rows.some(
        (r) => !r || r.kind !== 'worktree' || r.state === 'quarantined',
      ) ||
      rows.some((r) => r.source !== rows[0].source)
    )
      throw new Error('只能集成同一项目的有效 worktree。');
    const id = randomUUID(),
      destination = path.join(this.dir, `integration-${id}`),
      branch = `codex/integration-${id}`;
    await command(
      'git',
      ['worktree', 'add', '-b', branch, destination, rows[0].baseCommit],
      { cwd: rows[0].source },
    );
    let state = 'ready',
      error = '';
    try {
      for (const row of rows)
        await command(
          'git',
          [
            '-c',
            'user.name=DSH Workbench',
            '-c',
            'user.email=dsh@localhost',
            'merge',
            '--no-edit',
            row.branch,
          ],
          { cwd: destination },
        );
    } catch (failure) {
      state = 'conflict';
      error = failure.message;
    }
    return this.store.records.save(
      'integrations',
      {
        source: rows[0].source,
        taskIds: ids,
        path: destination,
        branch,
        state,
        error,
        verified: false,
      },
      id,
    );
  }
  close() {
    for (const id of this.ports.keys()) this.releasePort(id);
  }
}
