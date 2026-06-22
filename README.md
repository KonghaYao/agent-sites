# Agent Sites

Agent 站点托管平台 — 用于托管、路由和管理多个 Agent Web 站点的 Deno 服务。

## 架构

Deno 网关（`:3000`）+ 多个独立 PocketBase 进程。

- Deno 网关按 `/app-{id}/*` 路径前缀分发请求：
  - `/app-{id}/api/*` → 反向代理到本机对应 PocketBase 进程（端口 `9000-11000`）
  - 其余 `/app-{id}/*` → 直接 serve `public/app-{id}/` 下的静态文件
- 每个 App 一个独立 PocketBase 进程，数据隔离在 `data/app-{id}/`
- App 元数据由 Deno 用单文件 JSON 持久化（`data/apps.json`），无外部数据库

完整设计见 [`docs/architecture.md`](docs/architecture.md)。三层鉴权细节见 [`docs/superpowers/specs/2026-06-19-token-only-access-design.md`](docs/superpowers/specs/2026-06-19-token-only-access-design.md)。

## 技术栈

Deno 2.x + TypeScript（原生 `Deno.serve`，不依赖框架） | PocketBase 0.23.x（Go 二进制，作为子进程）

## 启动

### 本地开发

```bash
# 1. 下载 PocketBase 二进制（首次；脚本自动识别 macOS/Linux + arm64/amd64）
bash scripts/fetch-pocketbase.sh

# 2. 设置平台主密钥（必填）
echo "AGENT_SITES_MASTER_KEY=$(openssl rand -hex 32)" > .env

# 3. 运行网关（默认监听 0.0.0.0:3000，自动从 .env 读 master key）
deno task start
deno task start -- --port 8080            # 指定端口

# 4. 一键注册 demo 留言板（另开终端）
scripts/install-demo.sh

# 5. 浏览器访问
#    http://localhost:3000/          控制面板（粘贴 master key 后看 App 列表 + 实时健康）
#    http://localhost:3000/{app_id}/ 留言板 demo（提交 + 列表）
```

### Docker 部署

```bash
# 1. 准备 .env（参考 .env.example）
cp .env.example .env
# 编辑 .env，替换 AGENT_SITES_MASTER_KEY 为 openssl rand -hex 32 生成的值

# 2. 构建并启动（多阶段 build，自动拉 Linux 版 PocketBase + 内置 _panel 控制台）
docker compose up -d --build

# 3. 查看日志
docker compose logs -f agent-sites
```

镜像内置：
- 多阶段 build 拉 Linux 版 PocketBase 0.23.10（按 `TARGETARCH` 自动选 amd64/arm64）
- `_panel` 控制台 seed，`docker-entrypoint.sh` 在 bind mount 覆盖时自动恢复

数据持久化挂载在宿主机 `./data`（App 元数据 + tokens + 每个 App 的 SQLite）和 `./public`（用户上传的前端文件）。

## 手动创建一个 App

```bash
# /api/apps 强制 X-Master-Key 鉴权
curl -X POST http://localhost:3000/api/apps \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"my-app"}'

# 申请 platform token（仅此一次返回 token 字符串，永久有效）
curl -X POST http://localhost:3000/api/tokens \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  -H "content-type: application/json" \
  -d '{"app_id":"app-xxxxxxxx"}'

# 用 token 创建 PB collection（平台凭证代换为 superuser 后转发）
curl -X POST http://localhost:3000/app-xxxxxxxx/api/collections \
  -H "Authorization: Bearer <platform_token>" \
  -H "content-type: application/json" \
  -d '{"name":"todos","type":"base","schema":[{"name":"title","type":"text"}]}'

# 上传前端（≤ 1 MiB；或用 bundle API 上传整目录）
echo '<!doctype html><title>my-app</title><h1>It works</h1>' > /tmp/index.html
curl -X PUT http://localhost:3000/api/apps/app-xxxxxxxx/files/index.html \
  -H "X-Master-Key: $AGENT_SITES_MASTER_KEY" \
  --data-binary @/tmp/index.html
```

返回的 `app-{id}` 即可作为前缀访问：`http://localhost:3000/app-{id}/`。

## 开发

```bash
deno task check                          # 类型检查
deno task test                           # 全量测试（161 个用例）
deno task fmt                            # 格式化
deno task lint                           # lint
```

## 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|------|------|------|--------|
| `AGENT_SITES_MASTER_KEY` | **是** | 平台主密钥（`X-Master-Key` 鉴权用，生成方式 `openssl rand -hex 32`） | 无 |
| `HOST` | 否 | 监听地址 | `0.0.0.0` |
| `PORT` | 否 | 监听端口（也可用 `--port` CLI 参数） | `3000` |
| `PB_BINARY` | 否 | PocketBase 二进制路径 | `bin/pocketbase` |
| `DATA_DIR` | 否 | App 数据根目录（每个 App 一个子目录 + `apps.json` + `tokens.json`） | `data` |
| `PUBLIC_DIR` | 否 | App 前端静态文件根目录 + `_panel` 控制台 | `public` |
| `PB_PORT_MIN` | 否 | PocketBase 端口范围起 | `9000` |
| `PB_PORT_MAX` | 否 | PocketBase 端口范围止 | `11000` |
| `MAX_APPS` | 否 | App 数量上限 | `50` |

完整变量样例见 [`.env.example`](.env.example)。

## 项目结构

```
src/
├── api/            # REST API handlers（/api/apps + /api/tokens + 文件上传）
├── app/            # App 数据模型 + JSON 持久化
├── auth/           # Token store + master key + PB token 凭证代换缓存
├── process/        # PocketBase 进程管理器 + 端口分配器
├── proxy/          # 反向代理 handler
├── static_files/   # 静态文件服务 + 路径防护 + HTML fetch shim 注入
├── state.ts        # AppState
├── error.ts        # 统一错误类型（AppError 工厂）
├── logging.ts      # 结构化日志
├── lib.ts          # createApp + 路由装配
└── main.ts         # 入口 + CLI 参数
```

## License

MIT
