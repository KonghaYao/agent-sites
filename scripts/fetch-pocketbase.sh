#!/usr/bin/env bash
# scripts/fetch-pocketbase.sh
# 下载 PocketBase 二进制到 bin/pocketbase，自动识别 OS + 架构。
# 支持平台：macOS arm64/amd64、Linux arm64/amd64（对应 PocketBase 官方 release）。
# Docker 镜像构建不依赖此脚本——Dockerfile 内置 pb-fetcher 阶段直接拉 Linux 版。
set -euo pipefail

VERSION="0.23.10"  # 锁定版本

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) os="darwin" ;;
  Linux)  os="linux"  ;;
  *) echo "不支持的 OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="amd64" ;;
  *) echo "不支持的架构: $ARCH" >&2; exit 1 ;;
esac

PB_ARCH="${os}_${arch}"
BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/bin"
mkdir -p "$BIN_DIR"

URL="https://github.com/pocketbase/pocketbase/releases/download/v${VERSION}/pocketbase_${VERSION}_${PB_ARCH}.zip"
TMP_ZIP="$(mktemp -t pocketbase.XXXXXX).zip"
trap 'rm -f "$TMP_ZIP"' EXIT

echo "Downloading PocketBase v${VERSION} (${PB_ARCH}) from $URL"
curl -L --fail -o "$TMP_ZIP" "$URL"

echo "Extracting to $BIN_DIR"
unzip -o "$TMP_ZIP" pocketbase -d "$BIN_DIR"
chmod +x "$BIN_DIR/pocketbase"

echo "Verifying..."
"$BIN_DIR/pocketbase" --version
echo "Done: $BIN_DIR/pocketbase"
