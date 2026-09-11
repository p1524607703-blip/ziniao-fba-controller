#!/bin/bash
# FBA 重测控制器一键启动脚本
# 用法：bash start.sh   （在本技能/控制器目录下执行）
# 启动后访问 http://127.0.0.1:8787/
cd "$(dirname "$0")"
# 优先用 PATH 中的 node，找不到再回退到常见 managed 路径（可用 ZINIAO_NODE 环境变量覆盖）
NODE="${ZINIAO_NODE:-$(command -v node 2>/dev/null)}"
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then NODE=/opt/homebrew/bin/node; fi
if [ ! -x "$NODE" ]; then NODE=/Users/panjinlong/.workbuddy/binaries/node/versions/22.22.2/bin/node; fi
if lsof -tiTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✓ 已在运行，无需重复启动 (http://127.0.0.1:8787/)"
  exit 0
fi
echo "▶ 启动控制器..."
# 脱离启动 shell：Linux 用 setsid 进入独立会话；macOS 无 setsid 则回退 nohup
if command -v setsid >/dev/null 2>&1; then
  setsid nohup "$NODE" server.js >/tmp/fba_controller.log 2>&1 &
else
  nohup "$NODE" server.js >/tmp/fba_controller.log 2>&1 &
fi
sleep 2
if lsof -tiTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✓ 启动成功 → http://127.0.0.1:8787/"
else
  echo "✗ 启动失败，日志："; tail -20 /tmp/fba_controller.log
  exit 1
fi
