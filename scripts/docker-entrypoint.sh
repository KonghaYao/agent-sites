#!/bin/sh
# scripts/docker-entrypoint.sh
# 容器入口：在 deno 启动前确保控制面板 HTML 存在。
#
# 问题：docker-compose 用 `./public:/app/public` bind mount 持久化用户上传的前端文件，
# 但这会覆盖镜像 build 时 COPY 进去的 public/_panel/。导致控制面板 fallback 到提示文字。
# 解法：build 时把 _panel 也 COPY 到 /app/_panel-seed/，启动时检测 public/_panel 缺失则恢复。
# 这是 postgres/mysql 等镜像初始化数据库的标准模式。
set -e

PANEL_DIR="${PUBLIC_DIR:-public}/_panel"
SEED_DIR="/app/_panel-seed"

if [ ! -f "$PANEL_DIR/index.html" ] && [ -f "$SEED_DIR/index.html" ]; then
  mkdir -p "$PANEL_DIR"
  cp -a "$SEED_DIR/." "$PANEL_DIR/"
  echo "entrypoint: 已从镜像 seed 恢复控制面板到 $PANEL_DIR"
fi

# 透传所有参数给 deno（CMD 由 Dockerfile 提供）
exec deno "$@"
