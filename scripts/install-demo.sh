#!/usr/bin/env bash
# 把 demo 留言板应用注册到 agent-sites 系统。
# 幂等：可重复执行，已存在则复用 + 重做 cp 和 collection 初始化。
#
# 用法：
#   deno task start &      # 先启动服务
#   scripts/install-demo.sh

set -euo pipefail

SERVER="${AGENT_SITES_URL:-http://localhost:3000}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEMO_SOURCE="$REPO_ROOT/demo/guestbook"
PUBLIC_DIR="$REPO_ROOT/public"

# 颜色输出
say()  { printf '\033[32m[install-demo]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[install-demo] 错误:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

# 1. 检查服务在跑
say "检查服务健康 ($SERVER/health)..."
curl -sf "$SERVER/health" > /dev/null || die "服务未启动（$SERVER）。先 deno task start。"

# 2. 找已存在的 demo App
say "查找已存在的 demo App..."
EXISTING_ID=$(curl -sf "$SERVER/api/apps" | python3 -c "
import sys, json
data = json.load(sys.stdin).get('data', [])
demos = [a for a in data if a.get('name') == 'demo']
print(demos[0]['id'] if demos else '')
")

if [ -n "$EXISTING_ID" ]; then
  APP_ID="$EXISTING_ID"
  say "复用已存在的 demo App: $APP_ID"
  RESP=$(curl -sf "$SERVER/api/apps/$APP_ID")
else
  # 3. 创建 App
  say "创建 demo App..."
  RESP=$(curl -sf -X POST "$SERVER/api/apps" \
    -H 'Content-Type: application/json' \
    -d '{"name":"demo"}') || die "创建 App 失败"
fi

APP_ID=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['id'])")
EMAIL=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['superuser_email'])")
PASSWORD=$(echo "$RESP" | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['superuser_password'])")

say "App: $APP_ID"
say "Email: $EMAIL"

# 4. 复制前端文件
TARGET_DIR="$PUBLIC_DIR/$APP_ID"
say "复制前端文件到 $TARGET_DIR..."
mkdir -p "$TARGET_DIR"
cp "$DEMO_SOURCE/index.html" "$TARGET_DIR/index.html"

# 5. 换 token
say "用凭证换 token..."
TOKEN=$(curl -sf -X POST "$SERVER/$APP_ID/api/collections/_superusers/auth-with-password" \
  -H 'Content-Type: application/json' \
  -d "{\"identity\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['token'])") \
  || die "换 token 失败"

# 6. 初始化 collection（幂等：先 DELETE 已存在的，再 POST）
say "初始化 posts collection..."

# 6.1 找已存在的 posts collection id
EXISTING_CID=$(curl -sf "$SERVER/$APP_ID/api/collections" \
  -H "Authorization: $TOKEN" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
items = data.get('items', data) if isinstance(data, dict) else data
for c in items:
    if c.get('name') == 'posts':
        print(c.get('id'))
        break
else:
    print('')
")

if [ -n "$EXISTING_CID" ]; then
  say "已存在 posts collection (id=$EXISTING_CID)，删除后重建..."
  curl -sf -X DELETE "$SERVER/$APP_ID/api/collections/$EXISTING_CID" \
    -H "Authorization: $TOKEN" > /dev/null
fi

# 6.2 创建 posts collection
# PocketBase 0.23 rule 语义："" = 允许所有，null = 拒绝所有（与 0.22 相反！）
# 留言板语义：公开匿名读/写，但禁止改/删单条
say "创建 posts collection..."
curl -sf -X POST "$SERVER/$APP_ID/api/collections" \
  -H "Authorization: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "posts",
    "type": "base",
    "listRule": "",
    "viewRule": "",
    "createRule": "",
    "updateRule": null,
    "deleteRule": null,
    "fields": [
      {"name": "name", "type": "text", "required": true, "min": 1, "max": 50},
      {"name": "content", "type": "text", "required": true, "min": 1, "max": 500}
    ]
  }' > /dev/null || die "创建 collection 失败"

# 7. 完成
say "完成！"
echo ""
echo "  控制面板：$SERVER/"
echo "  留言板：  $SERVER/$APP_ID/"
echo ""
