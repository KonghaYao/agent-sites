# 前端文件发布

浏览器通过 `GET /{app_id}/{*path}` 访问 `public/{app_id}/` 下的静态文件。两种上传方式，都强制 `X-Master-Key` 鉴权。创建 App 时平台自动写一个占位 `index.html`，所以即使不上传也能 GET 到提示页。

## 单文件上传（PUT）

```bash
curl -s -X PUT $AGENT_SITES_URL/api/apps/{app_id}/files/index.html \
  -H "X-Master-Key: $MASTER_KEY" \
  --data-binary @index.html
```

路径中的 `{*path}` 是相对路径（含子目录），最终落到 `public/{app_id}/{path}`。

**限制**：
- Body ≤ 1 MiB（1,048,576 字节），超限返 413 `上传 body N 字节超过上限 1048576 字节`。
- 后缀白名单：`.html .htm .css .js .json .svg .png .jpg .jpeg .webp .ico .txt .map`。其他后缀返 400 `文件后缀 .xxx 不在允许列表：...`。
- 路径校验：禁 `..` / `.` / 空段 / 反斜杠 / 绝对路径。违例返 400 `上传路径不允许 '..' 或 '.' 段` 等。

**关于 `..` 路径穿越**：浏览器/curl/fetch 在发送前会自动折叠 URL 里的 `..` 段（WHATWG URL 规范），所以 PUT 路径含 `..`（如 `files/../evil.txt`）会被折叠成 `evil.txt` 并被路由层判为「路由不存在」返 404。`..` 段永远到不了 handler，路径穿越无法发生。需要严格显式拒绝时用 bundle API（tar 解包时 `..` 段返 400 `路径不允许 '..' 或 '.' 段`）。

响应：

```json
{
  "data": {"path": "/app-abcd1234/index.html", "bytes": 1024},
  "error": null
}
```

## 整目录上传（bundle）

```bash
tar -C ./my-site -czf site.tar.gz .   # 标准打包，自动跳过 ./ 顶层目录条目

curl -s -X POST $AGENT_SITES_URL/api/apps/{app_id}/files/bundle \
  -H "X-Master-Key: $MASTER_KEY" \
  --data-binary @site.tar.gz
```

也支持 `tar czf site.tar.gz a.html b.css`（多个文件参数）和 `tar -C dir -czf x.tar.gz file1 file2`。

Body 是 gzip 压缩的 tar 归档（**原始字节流**，用 `--data-binary` 而非 `-F` multipart——multipart envelope 不以 gzip magic 开头会被拒）。平台通过 **gzip magic bytes (`1f 8b`) 识别格式，`Content-Type` 可有可无**（agent 忘了设也不影响）。

**限制**：

| 维度 | 上限 | 超限响应 |
|------|------|---------|
| 压缩前 body | 10 MiB (10,485,760) | 413 `压缩 body N 字节超过上限 10485760 字节` |
| 解压后总字节 | 50 MiB (52,428,800) | 413 `解压后总字节超过上限 52428800 字节（已写入 N 个文件）` |
| 单文件 | 5 MiB (5,242,880) | 413 `单文件 {path} 解压后超过上限 5242880 字节` |
| 条目数 | 200 | 400 `tar 条目数超过上限 200（已处理 N 个后遇到第 N+1 个）` |

每个条目路径复用单文件后缀白名单 + 路径校验。失败时 body 含「已写入 N 个文件，共 N 字节」便于断点续传（best-effort，不原子回滚）。

响应：

```json
{
  "data": {
    "files": [
      {"path": "/app-abcd1234/index.html", "bytes": 1024},
      {"path": "/app-abcd1234/style.css", "bytes": 2048}
    ],
    "total_files": 2,
    "total_bytes": 3072,
    "total_bytes_limit": 52428800
  },
  "error": null
}
```

## 前端访问入口

```bash
# 浏览器或 curl GET 静态文件
curl $AGENT_SITES_URL/app-abcd1234/                    # → public/app-abcd1234/index.html
curl $AGENT_SITES_URL/app-abcd1234/style.css           # → public/app-abcd1234/style.css
curl $AGENT_SITES_URL/app-abcd1234/sub/page.html       # → public/app-abcd1234/sub/page.html
```

HTML 响应会自动注入 fetch shim（见 `shim.md`），让前端无需关心部署子路径。
