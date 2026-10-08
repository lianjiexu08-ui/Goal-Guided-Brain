// Read a password without terminal echo; never persist it in reports or arguments.
export function readPassword() {
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    const cleanup = () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(!!wasRaw);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
    };
    const onEnd = () => {
      cleanup();
      reject(Error('Vault password was not supplied.'));
    };
    const onData = (chunk) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') {
          onEnd();
          return;
        }
        if (char === '\n' || char === '\r') {
          cleanup();
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.resume();
  });
}
