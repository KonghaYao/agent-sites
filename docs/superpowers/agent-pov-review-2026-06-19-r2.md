# Agent 视角体验审查报告（2026-06-19 R2）

**审查者身份**：假设的外部 AI agent，目标是在 `agent-sites` 平台上从零做一个 Todo 应用。
**测试环境**：本地起服务（`deno run --allow-all src/main.ts --port 3199`），master key `openssl rand -hex 32` 临时生成，`DATA_DIR`/`PUBLIC_DIR` 指向 `mktemp -d`。全流程 curl 模拟。报告写作时服务仍在运行（PID 在 `/tmp/agent-pov-2.pid`，env 在 `/tmp/agent-pov-2-env.sh`），便于复核。
**结论摘要**：R1 报告的 2 个 Blocker + 3 个 Major 全部已修复；新加的 gzip bundle API 能用但有 2 个 Major 安全/健壮性问题；同时**新发现一个 Blocker**：CLAUDE.md 大段宣传的「前端 fetch 相对路径自动 shim」功能实测**完全不工作**——文档与实现严重不符。

| 严重度 | R2 计数 | 备注 |
|--------|---------|------|
| Blocker | 1 | 新发现：fetch shim 不工作 |
| Major  | 3 | bundle 拒绝 `tar -C dir .` 标准打包、bundle 无总大小上限、JSON 解析失败被静默吞 |
| Minor  | 4 | PB 透传响应没 wrap 进 `{data,error}`、collection 创建返 200 不是 201、`last_used_at` 永远 null、bundle 不校验 Content-Type |

---

## 0. 我作为 agent 能/不能从文档知道什么

**能从文档知道的**（CLAUDE.md + spec §3）：
- 三层鉴权模型清晰：master key（创建/删除 app、申请/吊销 token）→ platform token（agent 操作 collection）→ PB Rules（业务前端）。
- API 路径齐全：`/api/apps*`、`/api/tokens*`、`/{app_id}/api/*`、`PUT /api/apps/{id}/files/{*path}`。
- `POST /api/apps` 的 body schema 写得很清楚（`{name?:string}`，name 不去重、不唯一、仅展示用、长度 1..32 仅 `a-z 0-9 -`）。
- `POST /api/tokens` body `{app_id:string}`，response 字段齐全。
- 错误响应统一格式 `{data:null, error:{code, message, request_id}}`，所有错误实测都有 `request_id`。
- 鉴权失败、跨 app token、已吊销 token 的语义清晰。

**文档没说清楚 / friction 点**：
1. **gzip bundle API 完全未在 CLAUDE.md / spec 中文档化**。spec §3 只列了 `PUT /api/apps/{id}/files/{*path}` 单文件上传。bundle 的路径 `/api/apps/{id}/files/bundle`、请求体格式（`application/gzip`）、响应 schema（`{files,total_files,total_bytes}`）、解压失败时的「已写入 0 个文件」语义，全是 reverse engineering 出来的。这是我作为 agent 上手时**最大的摩擦**：要么读源码、要么瞎试。
2. **PUT 单文件 vs bundle 的取舍没说明**：什么时候该用哪个？bundle 能否包含 `index.html` 之外任意路径？嵌套子目录是否支持？实测支持，但文档没承诺。
3. **「自动 shim」描述与实测不符**（详见 §3 B1），文档撒谎比没文档更糟。
4. PB 响应字段保留原生 camelCase，spec §3 注明；但 PB 错误响应（如 `Missing or invalid collection context`）没 wrap 进平台 `{data, error}` 壳，agent 解析错误时需要处理两种格式——spec 没提示这一点。
5. `POST /api/collections`（PB）实测返 200 不是 PB 文档承诺的 201，agent 写客户端时不能盲信 status code。

---

## 1. R1 修复点验证

### B1（DELETE 500）— **已修复**
```bash
curl -X DELETE "http://localhost:3199/app-c9c950c7/api/collections/todos/records/o2dn5pp4k38h798" \
  -H "Authorization: Bearer $TOK"
# → HTTP 204 No Content（响应体空）
# 后续 GET 该记录 → HTTP 404 {"message":"The requested resource wasn't found."}
```
返 204，符合 HTTP 语义。

### B2（前端发布 + 占位 index.html）— **已修复**
```bash
# 创建 app 后立即 GET（PUT 之前）
curl http://localhost:3199/app-c9c950c7/
# → HTTP 200，返回占位 HTML：
#   <h1>app app-c9c950c7</h1>
#   <p>这是平台自动生成的占位页。前端尚未发布。</p>
#   <p>上传方式：<code>PUT /api/apps/app-c9c950c7/files/index.html</code>（需 X-Master-Key）。</p>

# 单文件 PUT
curl -X PUT http://localhost:3199/api/apps/app-c9c950c7/files/index.html \
  -H "X-Master-Key: $MK" --data-binary @index.html
# → HTTP 200 {"data":{"path":"/app-c9c950c7/index.html","bytes":91},"error":null}
```
占位页 + PUT 上传 + GET 验证全链路工作。

### 初始化竞态（创建后立即代理）— **已修复**
```bash
# 连续两条命令，无 sleep
curl -X POST /api/apps -H "X-Master-Key: $MK" -d '{"name":"todo"}'      # app 创建返 200
curl -X POST /api/tokens -H "X-Master-Key: $MK" -d '{"app_id":"app-c9c950c7"}'  # token 申请返 200
curl http://localhost:3199/app-c9c950c7/api/collections -H "Authorization: Bearer $TOK"
# → HTTP 200，返回 PB 内置 6 个系统 collection
```
全程无 503，初始化竞态解决。

### Admin UI `_/` — **行为符合新 spec**
```bash
curl http://localhost:3199/app-c9c950c7/_/
# → HTTP 404 {"data":null,"error":{"code":"NOT_FOUND","message":"文件不存在: _/index.html",...}}
```
spec §3 已声明「不透传 PB Admin UI」，实测 404，符合。**但错误消息有歧义**：「文件不存在」暗示这是一个文件缺失问题，而实际是路由被刻意屏蔽。建议返更明确的 message 如「Admin UI 不开放，请用 platform token + API」。

### spec body schema — **已文档化**
spec §3「Request body schema（接口契约）」段落明确列出三个 endpoint 的 body schema。实测全部符合：
```bash
# 空 body → 用 id 当 name
curl -X POST /api/apps -H "X-Master-Key: $MK" -d '{}'
# → {"data":{"id":"app-f4aa0ca9","name":"app-f4aa0ca9",...}}

# 大写 name → 400
curl -X POST /api/apps -H "X-Master-Key: $MK" -d '{"name":"BadName"}'
# → {"error":{"code":"BAD_REQUEST","message":"name 只允许 a-z 0-9 -，长度 1..32",...}}

# 空格 name → 400
# 长度 33 → 400
# 缺 app_id in POST /api/tokens → 400 {"message":"缺少 app_id"}
# POST /api/tokens 不存在 app → 404 {"message":"App 不存在: app-nonexist"}
```

### name 不去重 — **已实现且文档化**
```bash
# 第一次
curl -X POST /api/apps -d '{"name":"todo"}'  # → app-c9c950c7
# 第二次同名
curl -X POST /api/apps -d '{"name":"todo"}'  # → app-e54f3e9d （不同 id，同 name）
```
spec §3 明确写「name 仅展示用，不唯一，不去重」，实测一致。

### token warning — **已实现**
```bash
curl -X POST /api/tokens -H "X-Master-Key: $MK" -d '{"app_id":"app-c9c950c7"}'
# → {"data":{"token_id":"tok-7a65ae13","app_id":"app-c9c950c7",
#            "token":"eyJ0aWQiOiJ0b2st...","status":"active",
#            "issued_at":"2026-06-19T15:29:58.792Z",
#            "warning":"此 token 仅展示一次，请立即持久化；丢失需吊销重新申请"},
#    "error":null}
```
`warning` 字段存在，文案清楚。

### request_id — **已实现**
所有平台错误响应都带 `request_id`：
- 401 `{"error":{"code":"UNAUTHORIZED","message":"缺少或错误的 X-Master-Key","request_id":"93ad3add"}}`
- 403 `{"error":{"code":"FORBIDDEN","message":"token 与 app_id 不匹配","request_id":"1eb2ddd5"}}`
- 400 `{"error":{"code":"BAD_REQUEST","message":"文件后缀 .exe 不在允许列表...","request_id":"7379aab3"}}`

注：PB 透传层错误（如 `Missing or invalid collection context`）不带 `request_id`——见 §3 Minor 3。

---

## 2. 新增 gzip bundle API 体验

### 易用性：6/10
- API 路径直觉清晰：`POST /api/apps/{id}/files/bundle`，与 `PUT /api/apps/{id}/files/{path}` 同前缀。
- 响应 schema 标准：`{data:{files:[{path,bytes}],total_files,total_bytes}, error:null}`。
- 支持嵌套子目录（实测 `sub/nested.txt` 写入成功）。
- **减分项**：拒绝 `tar -C dir .` 生成的标准包（见 §3 Major 1），这是最常见的打包方式，第一次用会踩坑。

### 文档化程度：0/10
**bundle API 在 CLAUDE.md 和 spec 中完全没有出现**。spec §3 只列了单文件 PUT。作为 agent 我只能 reverse engineering：试 Content-Type、试响应字段、试错误格式。

### 错误响应质量：7/10
- 后缀白名单错误：`{"error":{"code":"BAD_REQUEST","message":"文件后缀 .exe 不在允许列表：.html, .htm, .css, .js, .json, .svg, .png, .jpg, .jpeg, .webp, .ico, .txt, .map（已写入 0 个文件，共 0 字节）",...}}` —— message 顺手列出完整白名单，**很贴心**。
- 非 gzip 数据：`{"message":"请求体不是 gzip 压缩数据（缺少 gzip magic 1f 8b）"}` —— 指明 magic bytes，便于调试。
- 非有效 tar：`{"message":"解压失败：Cannot extract the tar archive: The tarball is too small to be valid（已写入 0 个文件）"}` —— 把底层错误透传出来，可读性可接受。
- 「已写入 N 个文件，共 N 字节」字段对部分成功的 bundle 很有用——但我没测过部分文件合法、部分非法的混合场景，不知道平台是否会「先全部校验再写」还是「边写边校验」（前者更安全）。

### 安全性测试结果

| 攻击向量 | 实测响应 | 评价 |
|---------|---------|------|
| zip slip（`../evil.txt`） | HTTP 400 `上传路径不允许 '..' 或 '.' 段` | 正确拦截 |
| 后缀白名单（`bad.exe`） | HTTP 400，message 列出允许列表 | 正确 |
| 单文件 > 5MB（PUT） | HTTP 413 `上传 body 6000000 字节超过上限 1048576 字节` | 正确（spec 承诺 1MiB） |
| bundle 总大小 6MB（5×1.2MB 文件） | **HTTP 200 全部写入成功** | **❌ 无总大小上限**（见 §3 Major 2） |
| 缺 master key | HTTP 401 | 正确 |
| 缺 Content-Type | HTTP 200 | 见 §3 Minor 4 |
| Content-Type: application/json（错配） | HTTP 200 | 见 §3 Minor 4 |

---

## 3. 残留 / 新发现问题

### Blocker

#### B1：CLAUDE.md 宣称的「前端 fetch 相对路径自动 shim」完全不工作
- **现象**：
  ```bash
  # 上传一个含相对路径 fetch 的 HTML
  cat > idx2.html <<'EOF'
  <!DOCTYPE html><html><body>
  <script>
  fetch('./api/x');
  fetch('api/y');
  fetch('/api/z');
  </script>
  </body></html>
  EOF
  curl -X PUT "http://localhost:3199/api/apps/app-c9c950c7/files/index.html" \
    -H "X-Master-Key: $MK" --data-binary @idx2.html
  # → 200

  # GET 出来验证 shim 是否注入
  curl http://localhost:3199/app-c9c950c7/
  # → <!DOCTYPE html><html><body>
  #   <script>
  #   fetch('./api/x');          ← 原样，未 shim
  #   fetch('api/y');            ← 原样，未 shim
  #   fetch('/api/z');           ← 原样，未 shim
  #   </script>
  #   </body></html>
  ```
  日志（`/tmp/agent-pov-2.log`）显示这个 GET 请求 status 200 latency 0ms，**没有任何 shim 相关的注入/失败记录**——逻辑根本没跑或跑了但没改内容。

- **期望**：CLAUDE.md 「鉴权模型」段落最后两条关键不变量明确写：
  > **前端 fetch 相对路径自动 shim**：上传到 `/{app_id}/` 的 HTML 里写相对路径（`./api/...` 或 `api/...`）会被平台自动重写为 `/{app_id}/api/...`，前端无需关心部署子路径。

  agent 按这条说明写 HTML 时会被严重误导——部署后浏览器 fetch `./api/x` 会去 `/{app_id}/api/x`（恰好对），但 fetch `api/y` 会去 `/{app_id}/api/y`（也对，因为当前页是 `/{app_id}/`），所以**相对路径 fetch 在浏览器侧碰巧能工作**，但这不是平台 shim 的功劳，是浏览器自己的相对 URL 解析。如果 agent 把前端部署到 `/{app_id}/subpage/` 这种深层路径，相对路径就会失效，而平台承诺的 shim 不会兜底。

- **严重度**：Blocker。文档撒谎比没文档更糟。要么修实现，要么删 CLAUDE.md 这两条声明。

### Major

#### M1：gzip bundle 拒绝标准 `tar -C dir .` 打包格式
- **现象**：
  ```bash
  # 最常用的打包方式
  BUNDLE_DIR=$(mktemp -d)
  echo '<html>...' > $BUNDLE_DIR/index.html
  tar czf /tmp/bundle.tar.gz -C $BUNDLE_DIR .
  # tar 包内容（标准 GNU tar 行为）：
  # ./
  # ./index.html

  curl -X POST "http://localhost:3199/api/apps/app-c9c950c7/files/bundle" \
    -H "X-Master-Key: $MK" -H "Content-Type: application/gzip" \
    --data-binary @/tmp/bundle.tar.gz
  # → HTTP 400 {"error":{"code":"BAD_REQUEST",
  #     "message":"上传路径不允许 '..' 或 '.' 段（已写入 0 个文件，共 0 字节）"}}
  ```
  我换成显式列文件名 `tar czf x.tar.gz index.html app.js style.css`（包内无 `./` 条目）就成功了。

- **期望**：tar 包内的 `./` 和 `.` 顶层目录条目是 GNU tar / BSD tar 默认行为，平台应当**跳过**这些条目而不是拒绝整个 bundle。要么放宽校验（允许 `.` 和 `./` 作为独立 entry，只拒绝路径段中**中间**的 `..`），要么文档明确告诉 agent 用 `tar czf x.tar.gz -C dir file1 file2` 而不是 `tar czf -C dir .`。

- **严重度**：Major。最常见的打包方式直接不能用，agent 第一次用必踩坑。

#### M2：gzip bundle 无总大小上限（潜在磁盘滥用 / DoS）
- **现象**：
  ```bash
  # 5 个 1.2MB 的随机文件
  for i in 1 2 3 4 5; do head -c 1200000 /dev/urandom > /tmp/bigbundle/file$i.txt; done
  cd /tmp/bigbundle && tar czf /tmp/bigbundle.tar.gz file1.txt ... file5.txt && cd /
  ls -la /tmp/bigbundle.tar.gz   # 6,002,654 字节（gzip 压缩后 6MB）

  curl -X POST "http://localhost:3199/api/apps/app-c9c950c7/files/bundle" \
    -H "X-Master-Key: $MK" -H "Content-Type: application/gzip" \
    --data-binary @/tmp/bigbundle.tar.gz
  # → HTTP 200 全部写入成功，total_bytes 6,000,000
  ```
  单文件 PUT 有 1MiB 上限（spec §3），bundle 路径**没有**等效上限。攻击者（持有 master key 的内部角色，或 master key 泄漏场景）可以用一个 bundle 灌满磁盘，攻击面远大于单文件 PUT。

- **期望**：bundle 应有总解压后大小上限（如 10MB 或 50MB），并在超过时返 413。响应应包含 `total_bytes_limit` 字段提示。

- **严重度**：Major。鉴权层有 master key 把关所以不是公网攻击，但缺少限制违反 defense-in-depth 原则。

#### M3：`POST /api/apps` 解析 JSON 失败时静默吞，创建空 body app
- **现象**：
  ```bash
  curl -X POST http://localhost:3199/api/apps -H "X-Master-Key: $MK" \
    -H "Content-Type: application/json" -d '{not valid json'
  # → HTTP 200 {"data":{"id":"app-c7866af8","name":"app-c7866af8",...},"error":null}
  ```
  malformed JSON 被当成空 body 处理。这违反 fail-fast：客户端发了 `Content-Type: application/json` 说明「我接下来发的是 JSON」，解析失败应当 400 而不是默默按缺省创建。

- **期望**：JSON 解析失败返 400 `{"error":{"code":"BAD_REQUEST","message":"JSON 解析失败：..."}}`。

- **严重度**：Major。错误吞没会导致 agent 端的 bug 不可见——agent 写错字段名（typo）会被默默忽略，产生错误的 app 配置。

### Minor

#### m1：PB 透传响应没 wrap 进平台 `{data, error}` 壳
- **现象**：
  ```bash
  # 平台错误（带壳）
  curl http://localhost:3199/api/apps  # 不带 key
  # → {"data":null,"error":{"code":"UNAUTHORIZED","message":"...","request_id":"..."}}

  # PB 透传响应（无壳）
  curl http://localhost:3199/app-c9c950c7/api/collections -H "Authorization: Bearer $TOK"
  # → {"items":[...],"page":1,"perPage":30,...}  ← PB 原生 schema

  # PB 透传错误（无壳）
  curl -X POST http://localhost:3199/app-c9c950c7/api/collections/todos/records
  # → {"data":{},"message":"Missing or invalid collection context.","status":404}
  #   ← PB 原生错误格式，无 request_id
  ```
- **期望**：spec §3 注明「PB 字段保留原生 camelCase」是合理的，但**错误响应**的格式不一致需要文档明示。建议在 CLAUDE.md 加一条：「`/{app_id}/api/*` 路径下的响应直接来自 PocketBase，使用 PB 原生 schema（`items` / `page` / `message`），不进平台 `{data,error,request_id}` 壳。平台错误（鉴权失败、app 不存在等）才用平台 schema。」

- **严重度**：Minor。功能正确，仅文档摩擦。

#### m2：`POST /api/collections`（建表）返 200 而非 PB 标准的 201
- **现象**：
  ```bash
  curl -X POST http://localhost:3199/app-c9c950c7/api/collections \
    -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
    -d '{"name":"todos","type":"base","fields":[...]}'
  # → HTTP 200 + 新建 collection 的完整 JSON
  ```
  PocketBase 文档承诺创建返 201 Created。这里返 200，agent 写客户端如果按 status code 判定成功会失败（200 也是成功，但 201 vs 200 会让一些严格检查 status code 的客户端迷惑）。

- **期望**：透传层应当原样保留 PB 的 status code，不要改成 200。需要确认是 PB 本身改了行为（PB 0.20+ 改成 200？）还是平台代理层主动改写。

- **严重度**：Minor。不影响功能，仅规范层面。

#### m3：`last_used_at` 字段永远 null
- **现象**：
  ```bash
  # 跑过几十次 GET /{app_id}/api/collections 之后
  curl http://localhost:3199/api/tokens?app_id=app-c9c950c7 -H "X-Master-Key: $MK"
  # → {"data":[{"token_id":"tok-7a65ae13",...,"last_used_at":null}]}
  ```
  spec §3 TokenResponse 写 `last_used_at: string | null;  // 可选：代理层每次成功转发时更新`，spec §9 边界未列入「不做」。实测永远 null。

- **期望**：要么实现更新（便于审计 token 使用情况），要么在 spec §9 边界明确「不做 last_used_at 更新」（避免 agent 期待这个字段）。

- **严重度**：Minor。功能未实现但 spec 标了「可选」，不算违约。

#### m4：bundle API 不校验 `Content-Type`
- **现象**：
  ```bash
  # 缺 Content-Type
  curl -X POST "http://localhost:3199/api/apps/.../files/bundle" -H "X-Master-Key: $MK" \
    --data-binary @bundle.tar.gz
  # → HTTP 200 成功

  # Content-Type 错配（声明 JSON，实发 gzip）
  curl -X POST "http://localhost:3199/api/apps/.../files/bundle" -H "X-Master-Key: $MK" \
    -H "Content-Type: application/json" --data-binary @bundle.tar.gz
  # → HTTP 200 成功
  ```
  平台靠 gzip magic bytes (`1f 8b`) 探测格式，不看 Content-Type。这其实是好的容错（agent 容易忘记设 Content-Type），但**没有文档说明这一行为**，agent 不知道该不该传 Content-Type。

- **期望**：文档明示「bundle API 通过 magic bytes 识别 gzip，Content-Type 可有可无」。或反过来，强制 `Content-Type: application/gzip` 提早失败。二选一，写进文档。

- **严重度**：Minor。

---

## 4. 改进优先级

| 优先级 | 项 | 章节 | 类型 |
|--------|----|------|------|
| P0 | **修 fetch shim 实现或删 CLAUDE.md 声明** | §3 B1 | 文档/实现一致性 |
| P0 | gzip bundle 文档化（路径、body 格式、响应 schema、错误格式） | §0 | 文档 |
| P1 | bundle 接受 `tar -C dir .` 标准打包（跳过 `./` 顶层 entry） | §3 M1 | 健壮性 |
| P1 | bundle 加总大小上限（建议 10-50MB），返 413 | §3 M2 | 安全 |
| P1 | `POST /api/apps` JSON 解析失败返 400，不静默吞 | §3 M3 | 正确性 |
| P2 | 文档说明 PB 透传响应不进 `{data,error}` 壳 | §3 m1 | 文档 |
| P2 | 透传层保留 PB 原生 status code（201 等） | §3 m2 | 规范 |
| P3 | 实现 `last_used_at` 更新，或在 spec §9 明确不做 | §3 m3 | 文档/实现 |
| P3 | bundle API Content-Type 行为文档化 | §3 m4 | 文档 |
| P3 | Admin UI `_/` 错误消息更明确（如「Admin UI 不开放」） | §1 | UX |

---

## 5. 整体感受

R1 报的 5 个问题全部已修，鉴权三层模型实现得很扎实——错误响应质量、token 吊销语义、跨 app token 隔离、占位 index.html、DELETE 不再 500，都是生产级水平。这部分体验比 R1 大幅提升，可以作为 agent 的稳定基座。

但 **R2 暴露了「文档与实现脱节」这个更深层问题**。CLAUDE.md 里大段宣传的「前端 fetch 相对路径自动 shim」实测完全不工作（B1），而新加的 gzip bundle API 在 CLAUDE.md 和 spec 里**完全没提**——agent 必须靠抓包反推。这两件事让 agent 在「能不能信任文档」这件事上失去信心：读到一条特性，先得跑 curl 验证一遍才知道是真是假。这比单纯缺文档更消耗时间。建议下一轮：(1) 立刻修 B1，要么实现要么删；(2) 把 bundle API 完整文档化进 spec §3，跟 PUT 单文件并列；(3) 加一个「文档与实现一致性」的自动化检查（每周跑一次端到端 curl 校验）。
