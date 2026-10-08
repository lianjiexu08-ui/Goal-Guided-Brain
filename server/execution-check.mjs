import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findDsh } from './runtime.mjs';

// Read-only local evidence. Do not create directories, execute binaries or
// interpret control-plane paths as remote worker workspace mappings.
export async function inspectLocalExecution(
  workspace,
  { io = fs.promises, discover = findDsh, home = os.homedir() } = {},
) {
  if (typeof workspace !== 'string' || workspace.length > 2000)
    throw new Error('工作目录需要是不超过 2000 字符的路径。');
  let directory = workspace.trim();
  if (directory.startsWith('~/'))
    directory = path.join(home, directory.slice(2));
  const workspaceCheck = { id: 'workspace', status: 'fail', detail: '' };
  if (!directory || !path.isAbsolute(directory) || directory.includes('\0')) {
    workspaceCheck.detail = '请填写本机已存在的文件夹绝对路径。';
  } else {
    try {
      const stat = await io.stat(directory);
      if (!stat.isDirectory()) {
        workspaceCheck.detail = '这个路径是文件，请选择项目所在的文件夹。';
      } else {
        await io.access(directory, fs.constants.R_OK | fs.constants.X_OK);
        workspaceCheck.status = 'pass';
        workspaceCheck.detail = '目录存在，当前服务可以读取和进入。';
        try {
          await io.access(directory, fs.constants.W_OK);
          workspaceCheck.detail += '写入权限检查通过。';
        } catch {
          workspaceCheck.status = 'warn';
          workspaceCheck.detail += '当前没有写入权限；直接修改项目会受限。';
        }
      }
    } catch (error) {
      workspaceCheck.detail = ['ENOENT', 'ENOTDIR'].includes(error.code)
        ? '目录不存在，请恢复目录或选择新的项目位置。'
        : ['EACCES', 'EPERM'].includes(error.code)
          ? '当前服务无法读取或进入目录，请检查目录权限。'
          : '暂时无法检查目录，请确认磁盘可访问后重试。';
    }
  }
  const executable = discover();
  return {
    checkedAt: new Date().toISOString(),
    checks: [
      workspaceCheck,
      {
        id: 'engine',
        status: executable ? 'pass' : 'fail',
        detail: executable
          ? `已发现 DSH 可执行文件：${executable}`
          : '未找到 DSH 可执行文件。安装项目支持的 DSH 引擎，或设置 DSH_EXECUTABLE 后重启服务。',
      },
    ],
  };
}
