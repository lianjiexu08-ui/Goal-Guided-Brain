// Preserve source/history references while making the process cwd authoritative.
export function executionContext(context, workspace, restoredFromTaskId) {
  const sourceContext = String(context).replace(
    /^工作目录：([^\n]*)\n/u,
    '项目来源目录：$1\n',
  );
  const recovery = restoredFromTaskId
    ? `已从执行 ${restoredFromTaskId} 的保留目录恢复已有文件到本次独立副本。先核验现有代码和测试，继续未完成部分；不要从头覆盖已有成果。\n`
    : '';
  return `${recovery}本次执行工作目录：${workspace}\n文件读取、编辑和终端命令使用此执行目录；相对路径以此为根。下文的项目来源、历史和交接中的目录只作参考，不是写入目标。分派子任务时使用相对文件名和验收要求，子任务会获得自己的执行目录，不要指定父实例或源项目的绝对路径。\n\n${sourceContext}`;
}
