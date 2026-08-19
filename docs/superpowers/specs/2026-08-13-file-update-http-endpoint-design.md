# 设计文档：`PUT /api/files/update` — 工作区文件 HTTP 上传端点

日期：2026-08-13
状态：已获用户批准（分节确认）

## 背景与动机

当前工作区文件写入只有两条路径：

1. WS `fs.file.write`：文本内容、拒绝二进制、有 `MAX_EDITABLE_FILE_BYTES` 上限（`packages/server/src/server/file-explorer/service.ts:433`）
2. WS `file.upload.request`：只写入 `paseoHome/uploads/` 附件暂存区，不写工作区（`packages/server/src/server/file-upload/index.ts:50`）

下载已有一条完整的"WS 签发 token → HTTP 消费"链路（`GET /api/files/download?token=`，`bootstrap.ts:779`），但上传到文件系统不存在任何 HTTP 通道。本设计新增与下载最大程度对称的 `PUT /api/files/update` 端点，使所有可达 daemon HTTP 端口的客户端（directTcp 连接）能把本地文件上传进远程工作区。

**已确认的限制**：relay 只承载 WebSocket（`packages/relay/src/cloudflare-adapter.ts:591`，仅 `/ws` 与 `/health`），纯 relay 连线的客户端无法访问该 HTTP 端点——与下载的限制完全一致，接受该限制。

## 需求确认（brainstorming 结论）

| 问题 | 结论 |
|---|---|
| 使用场景 | 所有远程客户端（web/移动/桌面）上传本地文件到远程工作区 |
| 传输通道 | HTTP only，接受 relay 限制 |
| 写入语义 | 文件不存在则新建；已存在则由用户决定是否覆盖（服务端以 overwrite 标志强制） |
| 鉴权 | WS 签发一次性 token，与下载完全对称（免 bearer，capability-token 模式） |
| 内容限制 | 支持任意二进制，流式写入，无大小上限 |
| 冲突处理 | 仅 overwrite 标志；不做 revision 乐观锁 |
| 改动范围 | 协议 + 服务端端点 + client 方法 + 文件资源管理器 UI |

## 架构总览

```
客户端                                         服务端 daemon
┌──────────────────┐   WS (直连或 relay)   ┌─────────────────────────────┐
│ 文件资源管理器     │ ── file_update_token_request ──▶ │ session.ts 分发            │
│ (上传入口/确认弹窗)│                        │ WorkspaceFilesSession      │
│        │         │ ◀── file_update_token_response ── │ .handleFileUpdateTokenRequest│
│        ▼         │                        │   ├─ resolveScopedPath 校验  │
│  fetch PUT        │   HTTP (仅 directTcp) │   └─ DownloadTokenStore      │
│ /api/files/update │ ── 原始字节流 ────────▶ │      .issueToken({overwrite})│
│ ?token=           │                        │ bootstrap.ts handleFileUpdate│
└──────────────────┘                        │   ├─ consumeToken(一次性)    │
                                            │   └─ streamExplorerFileWrite │
                                            │      (临时文件 → fsync → 原子 rename)
                                            └─────────────────────────────┘
```

token 是两种通道间的接缝：决策（cwd、路径、overwrite）在 WS 侧完成并封入 token，HTTP 侧只携带 token 消费。

## 协议（`packages/protocol/src/messages.ts`）

与 `FileDownloadTokenRequestSchema`（`messages.ts:2412`）对称。命名采用 `file_update_token_request`（下划线前缀，与 `file_download_token_request` 同族），而非 `file.upload.*`——避免与附件上传 `file.upload.request`（`messages.ts:2419`）混淆：

```ts
export const FileUpdateTokenRequestSchema = z.object({
  type: z.literal("file_update_token_request"),
  cwd: z.string(),
  path: z.string(),
  overwrite: z.boolean().optional(),  // 默认 false
  requestId: z.string(),
});
```

响应 `file_update_token_response`（payload 与下载响应对称，增加 `exists` 供客户端提示）：

```ts
{
  cwd: string; path: string;
  token: string | null;
  fileName: string | null; mimeType: string | null;
  exists: boolean | null; size: number | null;
  error: string | null; requestId: string;
}
```

- 加入 `SessionInboundMessageSchema` / `SessionOutboundMessageSchema`（`messages.ts:2703` / `:5649`）
- `SessionInboundMessage` / `SessionOutboundMessage` 类型同步导出

## HTTP 端点

```
PUT /api/files/update?token=<token>
Content-Type: <客户端声明的 mime（仅信息）>
Body: 原始文件字节流（无 Content-Length 依赖）
```

| 场景 | 状态码 | 响应体 |
|---|---|---|
| 缺少 token | 400 | `{ error }` |
| token 无效/过期 | 403 | `{ error }` |
| 目标已存在（`overwrite !== true`） | 409 | `{ error, path, exists: true, size, modifiedAt }` |
| 目标存在但为目录 | 409 | `{ error: "Target is not a file", path }` |
| 路径非文件/写失败 | 500 | `{ error }` |
| 成功 | 200 | `{ path, size, modifiedAt, revision }` |

- token 在请求开始即消费（一次性），随后流式写——与下载 `consumeToken` 语义一致（`bootstrap.ts:738`）
- 请求体流式写入，无大小上限、不缓冲进内存
- **注册位置关键**：`app.put("/api/files/update", ...)` 必须在 `app.use(express.json())`（`bootstrap.ts:707`）**之前**注册，否则上传 Content-Type 为 `application/json` 的文件会被 body parser 拦截解析（上传 .json 文件即破坏）。建议放在 bearer 中间件（`:701`）之前的免认证区——路由自身以 token 鉴权，安全模型不变（`/api/terminal-activity`、web UI 同处该区域）
- 不在 bearer 认证保护内：`auth.ts:124` 的 `BEARER_AUTH_BYPASS_PATHS` Set 加入 `"/api/files/update"`（`shouldBypassBearerAuth` 为精确匹配 `Set.has`，`:148`）

## 服务端实现

### `packages/server/src/server/file-download/token-store.ts`

`DownloadTokenEntry` 增加可选字段 `overwrite?: boolean`。`issueToken` / `consumeToken` 逻辑不变；下载侧不受影响。

### `packages/server/src/server/file-explorer/service.ts`

新增两个函数（镜像 `getDownloadableFileInfo` 与下载流）：

- `getUpdatableFileInfo({ root, relativePath, overwrite })`：
  - `resolveScopedPath` 校验路径在 cwd 内（同一文件内的模块私有函数，定义于 `service.ts:785`）
  - 返回 `{ absolutePath, fileName, mimeType, exists, size }`（`exists`/`size` 由 stat 决定，文件缺失则 `exists: false, size: null`）
  - **与 `getDownloadableFileInfo`（`:534`）不同**：后者要求文件必须存在（`openFileForRead` 直接抛错），前者必须捕获 ENOENT 返回 `exists: false` 而非抛错；缺失文件的 mimeType 仅按扩展名推导（`textMimeTypeForExtension` / `IMAGE_MIME_TYPES`），跳过内容采样
- `streamExplorerFileWrite({ root, relativePath, source })`：
  - 父目录不存在则自动创建（`mkdir -p`）
  - 覆盖已存在文件时保留原权限；新建默认 `0o600`（与 `writeExplorerFile` 一致）
  - 流式写入同目录 `.${basename}.paseo-${uuid}.tmp` → `sync` → 原子 `rename`
  - 任一失败：清理临时文件后抛错

### `packages/server/src/server/session/files/workspace-files-session.ts`

新增 `handleFileUpdateTokenRequest`（镜像 `handleFileDownloadTokenRequest`，`:386`）：

- cwd 为空 → 错误响应
- `getUpdatableFileInfo` 校验 + 收集信息
- `downloadTokenStore.issueToken({ ..., overwrite })` 签发一次性 token
- 异常 → 错误响应（含路径逃逸等）

### `packages/server/src/server/session.ts`

`dispatchWorkspaceFileMessage` 增加 `case "file_update_token_request"`（`session.ts:2165`，`file_download_token_request` 位于 :2191 旁）。

### `packages/server/src/server/bootstrap.ts`

`handleFileUpdate` 处理器（紧挨 `handleFileDownload`，`:727`）：

- token 校验 → 消费（缺 400 / 无效过期 403）
- **以 HTTP 时点的 stat 为准**重新检查目标状态（不以签发时记录为准，WS→HTTP 之间文件可能已出现）→ `exists && !token.overwrite` → 409
- `streamExplorerFileWrite` 流式写 → 200 返回 `{ path, size, modifiedAt, revision }`
- 流错误 → 500 + 清理

`app.put("/api/files/update", ...)` 注册（见 HTTP 端点节的注册位置要求）。

原子 rename 自然触发 `workspaceFileObserver` 订阅 → git 状态 / 资源管理器列表自动刷新（与 WS 写入相同，无额外工作）。

### `packages/server/src/server/auth.ts`

`BEARER_AUTH_BYPASS_PATHS` Set 加入 `"/api/files/update"`（`:124` 集合，`:135` 的 download 条目旁）。

## 客户端

### `packages/client/src/daemon-client.ts`

`requestFileUpdateToken(cwd, path, overwrite, options?)`：对称实现 `requestDownloadToken`（`:4401`），返回 `FileUpdateTokenPayload`。

### `packages/app/src/hooks/use-file-explorer-actions.ts`

- 新增 `requestFileUpdateToken`（对称于 `requestFileDownloadToken`，`:239`）
- 新增 `uploadFile` 动作：
  1. 复用文件选择抽象：`useFilePicker()` hook 的 `pickFiles`（`packages/app/src/hooks/use-file-picker.ts`，composer 与 project-edit-sheet 均用它）
  2. 目标路径已存在（资源管理器树当前状态）→ 弹"覆盖？"确认
  3. WS 签发 token（携带 overwrite 决定）
  4. 解析 HTTP baseUrl：复用 `download-store.ts` 的 `resolveDaemonDownloadTarget`（当前未导出，需导出或上提至共享 utils）；无 `directTcp` 连接时报"不可用"——与下载完全一致
  5. `fetch` `PUT /api/files/update?token=` 流式上传（body 为文件字节）
  6. 成功后刷新资源管理器列表 / 触发 git 状态刷新

### 文件资源管理器 UI

新增"上传文件"入口（工具栏按钮 + 上下文菜单项）。下载按钮所在组件为 `components/file-explorer-pane.tsx`（`:484` 处使用 `useFileDownload`），上传入口与之一致：目标路径为用户当前选中的目录（或选中文件所在目录），按钮/菜单项样式复用现有模式。

## 测试

| 层 | 文件 | 覆盖 |
|---|---|---|
| 协议单测 | `messages.file-update-token.test.ts` | 新消息 schema 往返、未知字段丢弃、类型分发 |
| token store 单测 | `token-store.test.ts` 扩展 | overwrite 字段携带、一次性、TTL 过期 |
| service 单测 | `service.test.ts` 扩展 | 路径逃逸拒绝、子目录自动创建、二进制往返、覆盖保留权限、写失败清理临时文件 |
| session 单测 | `workspace-files-session.test.ts` 扩展 | 签发成功 / cwd 缺失 / 路径逃逸 / overwrite 透传 |
| e2e | `daemon-e2e/file-update.e2e.test.ts`（镜像 `file-download.e2e.test.ts`） | 真实 daemon：WS 签 token → PUT → 内容校验（含二进制往返）；无效 token 403；过期 token 403；已存在且未 overwrite → 409；子目录新建成功 |
| app 单测 | `use-file-explorer-actions` 相关 | token 请求参数、overwrite 决策、fetch 调用 |
| app e2e (Playwright) | 文件资源管理器 | 选择文件 → 已存在确认弹窗 → 上传 → 列表刷新 |

## 安全考量

- 一次性 token + 60s TTL（`DownloadTokenStore` 默认 `bootstrap.ts:578`）
- 路径逃逸在签发时由 `resolveScopedPath` 拒绝；HTTP 消费只信 token 内封装的 `absolutePath`
- token 经 WS 下发，HTTP 侧无任何凭据；capability-token 模式与 agent MCP token（`bootstrap.ts:584`）一致

## 明确不做（YAGNI）

- revision 乐观锁
- 大小上限 / 配额
- multipart/form-data
- relay HTTP 隧道
- WS 通道的工作区写入上传（`file.upload.request` 保持附件专用）
