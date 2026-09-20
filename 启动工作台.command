#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
export PATH="$HOME/.pixi/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if curl -fsS http://127.0.0.1:3088/api/health >/dev/null 2>&1; then
  open http://127.0.0.1:3088
  exit 0
fi
if [[ ! -f dist/server/index.js ]]; then
  npm run build || exit 1
fi
( for i in {1..30}; do
    if curl -fsS http://127.0.0.1:3088/api/health >/dev/null 2>&1; then
      open http://127.0.0.1:3088
      break
    fi
    sleep 1
  done ) &
print 'Goal-Guided Brain 正在运行。可关闭浏览器或切换助手；此终端保留后台服务。按 Ctrl+C 停止。'
exec node scripts/start.mjs
