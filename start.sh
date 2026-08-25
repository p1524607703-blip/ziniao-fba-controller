#!/bin/bash
# FBA 重测控制器一键启动脚本
# 用法：bash start.sh   （在本技能/控制器目录下执行）
# 启动后访问 http://127.0.0.1:${ZINIAO_FBA_PORT:-8787}/
cd "$(dirname "$0")"
# 优先使用 ZINIAO_NODE，否则从 PATH 查找，不内置任何用户目录。
NODE="${ZINIAO_NODE:-$(command -v node 2>/dev/null)}"
PORT="${ZINIAO_FBA_PORT:-8787}"
LOG_FILE="${ZINIAO_FBA_LOG:-${TMPDIR:-/tmp}/ziniao-fba-controller.log}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "✗ 找不到 Node.js；请安装 Node 16+ 或设置 ZINIAO_NODE。"
  exit 1
fi
if command -v lsof >/dev/null 2>&1 && lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✓ 已在运行，无需重复启动 (http://127.0.0.1:$PORT/)"
  exit 0
fi
echo "▶ 启动控制器..."
nohup "$NODE" server.js >"$LOG_FILE" 2>&1 &
PID=$!
sleep 2
if kill -0 "$PID" >/dev/null 2>&1; then
  echo "✓ 启动成功 → http://127.0.0.1:$PORT/"
else
  echo "✗ 启动失败，日志："; tail -20 "$LOG_FILE"
  exit 1
fi
