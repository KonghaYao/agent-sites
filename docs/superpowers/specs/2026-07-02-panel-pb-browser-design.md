# 管理面板 PB 数据浏览功能设计

> 状态: Draft | 日期: 2026-07-02

## 1. 概述

在现有管理面板（`public/_panel/index.html`）中增加 PB 数据库浏览功能。用户可以在 App 列表中点击任意 App，进入该 App 的 PB 数据浏览视图，查看 collections 列表、records 数据和 schema 定义。

## 2. 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 范围 | 每个 App 独立查看 | 数据隔离，操作粒度精准 |
| 浏览深度 | Collections + Records + Schema（C 级） | 满足日常诊断和开发调试需求 |
| Auth 方案 | 面板用 master key 申请 platform token + 走 `/{app_id}/api/collections/*` 代理 | 复用现有鉴权和代理层，零后端变更 |
| 交互方式 | 全屏详情页（hash 路由切换） | 零额外文件、状态在内存、维持 brutalist 风格 |
| Token 生命周期 | 打开详情页时创建，关闭时吊销 | 不悬挂 token，安全原则 |
| 分页 | PB 原生 `?page=N&perPage=20` | 无需后端改动 |

## 3. 非目标

- 不支持在面板中创建/编辑/删除 collection 或 records（只读浏览）
- 不新增后端 API（纯前端变更）
- 不改变现有面板的 Master Key 存储方式（仍为 sessionStorage）
- 不支持多 App 同时浏览（一次只看一个 App）
- 不改变现有轮询行为（进入详情页时暂停全局轮询，避免不必要请求）

## 4. 架构

### 4.1 路由结构

在 `_panel/index.html` 内用 JS hash 路由切换视图：

| hash | 视图 | DOM 区域 |
|------|------|----------|
| `#` 或空 | App 列表（现有） | `.table-wrap` + `.toolbar` + `.stats` |
| `#{app_id}` | App 详情页 | `#detail`（新建 DOM 容器） |

`window.onhashchange` 事件监听路由切换。

### 4.2 详情页 UI 结构（从上到下）

```
┌─ header ────────────────────────────────────────────────────┐
│  ← BACK    App: my-app (app-xxxx)    type: custom/pocketbase │
│             PB: up (3ms) | port: 9000 | records: 42 total   │
└──────────────────────────────────────────────────────────────┘

┌─ collections 列表 ──────────────────────────────────────────┐
│  ○ posts         base    3 fields   12 records               │
│  ○ users         auth    3 fields   —                        │
│  ○ messages      base    5 fields   45 records               │
└──────────────────────────────────────────────────────────────┘

┌─ 选中 collection 的展开区 ──────────────────────────────────┐
│  [Schema] [Records]                                          │
│                                                              │
│  Schema 标签页:                                               │
│  ┌──────────┬────────┬──────────┬───────┬───────────┐       │
│  │ Name     │ Type   │ Required │ Min/Max │ Rules     │       │
│  ├──────────┼────────┼──────────┼───────┼───────────┤       │
│  │ title    │ text   │ true     │ 1/200  │ —         │       │
│  │ body     │ text   │ false    │ 0/5000 │ —         │       │
│  │ author   │ user   │ false    │ —      │ —         │       │
│  └──────────┴────────┴──────────┴───────┴───────────┘       │
│  collection rules: list="" view="" create="" update=null ... │
│                                                              │
│  Records 标签页:                                              │
│  ┌──────────────────────┬────────────────────────────────┐   │
│  │ id: abc123...        │ title: "Hello"                  │   │
│  │ created: 2026-...    │ body: "world"                   │   │
│  │ updated: 2026-...    │ author: user-xxx                │   │
│  └──────────────────────┴────────────────────────────────┘   │
│  ...(more records)...                                        │
│  ◀ Page 1 / 3 ▶       showing 1-20 of 45                    │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 数据流

```
用户点击 App 行
  │
  ├─ 1. hash 变为 #{app_id} → onhashchange 触发
  ├─ 2. POST /api/tokens {app_id} (X-Master-Key) → 拿到 platform_token
  ├─ 3. GET /{app_id}/api/collections (Bearer token) → collections 列表
  │     → 渲染左侧 collections 列表
  ├─ 4. 用户点击某个 collection
  │     ├─ GET /{app_id}/api/collections/{id} → schema + rules
  │     └─ GET /{app_id}/api/collections/{id}/records?page=1&perPage=20 → records
  │         → 渲染展开区（Schema / Records 标签页）
  ├─ 5. 分页：GET /{app_id}/api/collections/{id}/records?page=N&perPage=20
  │
  ├─ 6. 用户点击 BACK
  │     ├─ DELETE /api/tokens/{token_id} (X-Master-Key) → 吊销 token
  │     ├─ hash 变回 # → 恢复列表视图
  │     └─ 恢复全局轮询
  └─ 7. 异常退出（直接关闭标签页）→ token 悬挂但不泄漏凭证
        （token 仅面向前端展示，PB 凭证由平台代换层保护）
```

### 4.4 Token 缓存策略

为避免频繁创建 token（用户反复进出详情页），详情页生命周期内缓存在 JS 变量中：

```
let detailToken: { token: string; token_id: string } | null = null;
```

- 进入详情页：检查缓存 → 无则 `POST /api/tokens` 创建 → 存入缓存
- 离开详情页：`DELETE /api/tokens/{token_id}` 吊销 → 清缓存
- 页面刷新（缓存丢失）：token 悬挂，但不影响安全（下次进详情页重新创建）

## 5. 实现范围

### 5.1 前端代码变更（仅 `public/_panel/index.html`）

**新增 CSS**（~80 行）：
- `#detail` 容器样式（全屏布局、header bar、collections 列表、展开区）
- 卡片式 records 展示样式（每行一条 record，字段名/值对应）
- Schema 表格样式（复用现有 `.table-wrap` 风格）
- 分页控件样式

**新增 JS 逻辑**（~200 行）：
- `navigate(appId)` / `goBack()` — hash 路由切换 + DOM 显示/隐藏
- `fetchCollections(appId, token)` — 拉 collections 列表
- `selectCollection(id)` — 选中某个 collection，拉 schema + records
- `renderSchema(fields, rules)` — 渲染 Schema 标签页
- `renderRecords(items, page, totalItems)` — 渲染 Records 标签页 + 分页
- `renderDetailHeader(app)` — 渲染详情页头部
- `loadPage(page)` — 分页切换
- Token 管理：`acquireToken(appId)` / `releaseToken(tokenId)`

**修改现有逻辑**（~5 处）：
- `renderRows()` 中每行 App ID 改为 `<a href="#{id}">` 触发 hash 导航
- `tick()` 增加判断：在详情页时不执行全局轮询
- `onhashchange` 事件注册（`window.addEventListener`）

### 5.2 后端变更

**零变更**。所有 API 已存在：

- `POST /api/tokens` — 申请 token
- `DELETE /api/tokens/{id}` — 吊销 token
- `GET /{app_id}/api/collections` — 列 collections
- `GET /{app_id}/api/collections/{id}` — 单个 collection 详情（含 schema）
- `GET /{app_id}/api/collections/{id}/records` — records 列表（含分页）

records 响应格式（PocketBase 原生）：
```json
{
  "items": [
    { "id": "xxx", "collectionId": "...", "collectionName": "posts",
      "created": "...", "updated": "...", "title": "Hello", "body": "world" }
  ],
  "page": 1,
  "perPage": 20,
  "totalItems": 45,
  "totalPages": 3
}
```

### 5.3 不修改的部分

- `src/` 下的任何 TS 代码
- `Dockerfile`
- `deno.json`
- skill 文档
- 现有面板的轮询逻辑（进入详情页时暂停，回到列表时恢复）

## 6. 错误处理

| 场景 | UI 行为 |
|------|--------|
| token 创建失败（401 bad master key） | 详情页显示 "无法获取凭证，请检查 Master Key 状态" |
| collections 请求失败 | 详情页显示 "无法加载 Collections 列表"，BACK 按钮仍然可用 |
| collection schema 请求失败 | Schema 标签页显示错误信息 |
| records 请求失败（含分页） | Records 标签页显示错误信息 + 重试按钮 |
| 详情页打开时 token 被外部吊销 | 重试 token 创建（`acquireToken` 自动重试） |
| 网络超时 | 5s AbortController 超时，显示 "请求超时" |
| 空的 collection | Records 标签页显示 "暂无记录" |
| PB 不可达（503） | 详情页 header 显示 "PB: down"，collections 列表显示错误但仍可退回 |

## 7. 测试策略

由于是纯前端变更，测试方式：

- **手工验证**：
  - 创建 2 个 App（1 pocketbase + 1 custom enable_pb）
  - 在面板中点击 App → 进入详情页 → 浏览 collections/records/schema
  - 验证分页、空 collection、PB 不可达等边界
  - 验证 BACK 返回列表 + token 被吊销
- **不新增单元测试**：面板是静态 HTML 文件，无测试基础设施

## 8. 与现有代码的关系

| 现有元素 | 行为 | 变更 |
|----------|------|------|
| `renderRows()` | 渲染 App 列表行 | App ID 改为 `<a href="#{id}">` |
| `tick()` | 全局轮询主循环 | 详情页模式跳过轮询 |
| `polling` | 轮询开关状态 | 详情页模式暂停，退出时恢复 |
| `MK_KEY` | sessionStorage master key | 不变，token 创建时仍从 `sessionStorage` 读取 |
| `.toolbar` / `.stats` | 工具栏和统计区 | 详情页模式下隐藏 |
| `.table-wrap` | 表格容器 | 详情页模式下隐藏 |
| 暗色模式 | `prefers-color-scheme` | 详情页完全继承 CSS 变量 |

## 9. 风险与限制

| 风险 | 缓解 |
|------|------|
| 面板文件变大（~725→~1000 行） | 保持 IIFE 自执行结构，函数职责清晰，注释分隔不混叠 |
| records 数据量大（如 >1000 条） | PB 原生分页每页 20 条，不会一次性加载全部 |
| 多条 records 的字段数量不一 | PB records API 对每条 record 都返回完整字段（含空值），前端渲染按实际字段遍历 |
| Token 创建频率（反复进出详情页） | Token 详情页内缓存；即使频繁创建，token 在入口退出时吊销，不累积 |
| 新版 PB 字段格式变化 | Schema 依赖 PB API 返回结构的稳定性，面板不做硬编码假设 |

## 10. 文件清单

| 文件 | 操作 | 行数变化 |
|------|------|----------|
| `public/_panel/index.html` | 修改 | +~300 行（CSS ~80 + JS ~200 + HTML ~20）|

## 11. Spec 自我审查

- [x] 无 TBD/TODO
- [x] 架构与功能描述一致：hash 路由 + token 代换 + PB API
- [x] 范围聚焦：纯前端变更，零后端改动
- [x] 无歧义：所有 API 端点、数据结构、交互流程均有明确描述
- [x] 错误处理覆盖：6 种错误场景均有对应 UI 行为
