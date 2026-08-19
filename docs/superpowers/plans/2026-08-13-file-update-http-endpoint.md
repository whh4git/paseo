# PUT /api/files/update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a WS-token-gated `PUT /api/files/update` endpoint so clients can stream local files into a workspace, maximally symmetric with the existing `GET /api/files/download`.

**Architecture:** Reuse the download pipeline shape end-to-end: a WS request (`file_update_token_request`) validates the target path against the workspace cwd and issues a one-time token (existing `DownloadTokenStore`); an HTTP handler consumes the token and streams the raw request body through a new `streamExplorerFileWrite` service function (temp file → fsync → atomic rename). Client decisions (overwrite or not) are made over WS and sealed into the token; HTTP carries only `?token=`.

**Tech Stack:** Node.js (express), zod protocol schemas (`@getpaseo/protocol`), vitest, react-native app + react-i18next, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-08-13-file-update-http-endpoint-design.md`

## Global Constraints

- **最小化改动 (minimal changes):** Do not restructure existing code. Only add: two protocol schemas + union registrations + type exports, one optional field on `DownloadTokenEntry`, two service functions, one session handler + dispatch case, one HTTP handler + route, one auth bypass entry, one CORS method, one client method, one app pure function + hook + menu item + confirm dialog + i18n keys, and tests. Do not create new token stores, multipart parsing, or revision optimistic locking.
- **Comment style:** All comments in English, matching the repo's style: JSDoc `/** ... */` for exported functions/types with rationale (see `auth.ts:122-134` and `bootstrap.ts:584-590` for the "why" style). No Chinese comments. No comments on trivial lines.
- **Style discipline:** Code must pass `npm run format` (oxfmt), `npm run lint` (oxlint), and `npm run typecheck`. Vitest command pattern: `npm run test --workspace=<ws> -- <file> --bail=1`.
- **Naming:** Message family `file_update_token_request` / `file_update_token_response` (underscore family, symmetric with `file_download_token_request`). Never use the `file.upload.*` prefix (that family belongs to the attachment upload path).
- **Confirmed limits:** relay carries no HTTP; the endpoint is only reachable over `directTcp`. Do not add relay HTTP tunneling.
- Each task must end green: run the task's test command, then `npm run typecheck --workspace=<ws>` for that workspace before committing.

---

### Task 1: Protocol schemas and union registration

**Files:**
- Modify: `packages/protocol/src/messages.ts` — request schema after `FileUploadRequestSchema` (`:2419`); response schema after `FileDownloadTokenResponseSchema` (`:5203`); inbound union entry after `FileUploadRequestSchema` (`:2830`); outbound union entry next to `FileDownloadTokenResponseSchema` (`:5787`); type exports next to the existing `FileDownloadTokenRequest`/`FileDownloadTokenResponse` exports (`:6226`)
- Test: Create `packages/protocol/src/messages.file-update-token.test.ts`

**Interfaces:**
- Produces: `FileUpdateTokenRequestSchema`, `FileUpdateTokenResponseSchema` (zod schemas); `FileUpdateTokenRequest`, `FileUpdateTokenResponse` (types); message types `"file_update_token_request"` / `"file_update_token_response"` accepted by `SessionInboundMessageSchema` / `SessionOutboundMessageSchema`.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/messages.file-update-token.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  FileUpdateTokenRequestSchema,
  FileUpdateTokenResponseSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("file update token messages", () => {
  test("parses a file_update_token_request with and without overwrite", () => {
    const request = FileUpdateTokenRequestSchema.parse({
      type: "file_update_token_request",
      cwd: "/workspace",
      path: "uploads/notes.txt",
      requestId: "req-1",
    });
    expect(request.overwrite).toBeUndefined();

    const withOverwrite = FileUpdateTokenRequestSchema.parse({
      type: "file_update_token_request",
      cwd: "/workspace",
      path: "uploads/notes.txt",
      overwrite: true,
      requestId: "req-2",
    });
    expect(withOverwrite.overwrite).toBe(true);
  });

  test("parses a file_update_token_response", () => {
    const response = FileUpdateTokenResponseSchema.parse({
      type: "file_update_token_response",
      payload: {
        cwd: "/workspace",
        path: "uploads/notes.txt",
        token: "abc",
        fileName: "notes.txt",
        mimeType: "text/plain",
        exists: true,
        size: 12,
        error: null,
        requestId: "req-1",
      },
    });
    expect(response.payload.exists).toBe(true);
  });

  test("registers both messages in the session unions", () => {
    const inbound = SessionInboundMessageSchema.safeParse({
      type: "file_update_token_request",
      cwd: "/workspace",
      path: "a.txt",
      requestId: "req-1",
    });
    expect(inbound.success).toBe(true);

    const outbound = SessionOutboundMessageSchema.safeParse({
      type: "file_update_token_response",
      payload: {
        cwd: "/workspace",
        path: "a.txt",
        token: null,
        fileName: null,
        mimeType: null,
        exists: null,
        size: null,
        error: "boom",
        requestId: "req-1",
      },
    });
    expect(outbound.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@getpaseo/protocol -- src/messages.file-update-token.test.ts --bail=1`
Expected: FAIL — schemas/types do not exist.

- [ ] **Step 3: Implement the schemas**

In `packages/protocol/src/messages.ts`, immediately after `FileUploadRequestSchema` (line ~2426) add:

```ts
/**
 * Symmetric to FileDownloadTokenRequestSchema: the client requests a one-time
 * capability token for writing a file into the workspace over plain HTTP
 * (`PUT /api/files/update`). The overwrite decision is made over the
 * authenticated WebSocket and sealed into the token; the HTTP side only
 * consumes the token.
 */
export const FileUpdateTokenRequestSchema = z.object({
  type: z.literal("file_update_token_request"),
  cwd: z.string(),
  path: z.string(),
  overwrite: z.boolean().optional(),
  requestId: z.string(),
});
```

Immediately after `FileDownloadTokenResponseSchema` (line ~5203) add:

```ts
export const FileUpdateTokenResponseSchema = z.object({
  type: z.literal("file_update_token_response"),
  payload: z.object({
    cwd: z.string(),
    path: z.string(),
    token: z.string().nullable(),
    fileName: z.string().nullable(),
    mimeType: z.string().nullable(),
    exists: z.boolean().nullable(),
    size: z.number().nullable(),
    error: z.string().nullable(),
    requestId: z.string(),
  }),
});
```

Register in `SessionInboundMessageSchema` (line ~2830, directly after `FileUploadRequestSchema,`):

```ts
  FileUpdateTokenRequestSchema,
```

Register in `SessionOutboundMessageSchema` (directly after the `FileDownloadTokenResponseSchema,` entry, line ~5787):

```ts
  FileUpdateTokenResponseSchema,
```

Next to the existing exports at `:6226`:

```ts
export type FileUpdateTokenRequest = z.infer<typeof FileUpdateTokenRequestSchema>;
export type FileUpdateTokenResponse = z.infer<typeof FileUpdateTokenResponseSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=@getpaseo/protocol -- src/messages.file-update-token.test.ts --bail=1`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify typecheck and commit**

Run: `npm run typecheck --workspace=@getpaseo/protocol`
Expected: clean.

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.file-update-token.test.ts
git commit -m "feat(protocol): add file update token request/response messages"
```

---

### Task 2: Server — carry `overwrite` on the token entry

**Files:**
- Modify: `packages/server/src/server/file-download/token-store.ts` (interface only, lines 3-11)

**Interfaces:**
- Produces: `DownloadTokenEntry.overwrite?: boolean` — set at issue time by the session handler (Task 4), read by the HTTP handler (Task 5). `issueToken` / `consumeToken` logic is untouched (download tokens simply omit the field).

- [ ] **Step 1: Add the optional field**

In `packages/server/src/server/file-download/token-store.ts`, extend the interface:

```ts
export interface DownloadTokenEntry {
  token: string;
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  size: number;
  /**
   * Update tokens only: whether the client has confirmed overwriting an
   * existing target. The HTTP handler enforces this at consume time.
   */
  overwrite?: boolean;
  expiresAt: number;
}
```

- [ ] **Step 2: Verify the package typechecks**

Run: `npm run typecheck --workspace=@getpaseo/server`
Expected: clean (no callers break; field is optional). There is no dedicated token-store test file in the repo (download behavior is covered via session + e2e tests); this field is exercised by Task 4's unit test and Task 6's e2e.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/server/file-download/token-store.ts
git commit -m "feat(server): carry overwrite flag on file tokens"
```

---

### Task 3: Server — `getUpdatableFileInfo` + `streamExplorerFileWrite`

**Files:**
- Modify: `packages/server/src/server/file-explorer/service.ts` (after `getDownloadableFileInfo`, line ~574)
- Test: Modify `packages/server/src/server/file-explorer/service.test.ts`

**Interfaces:**
- Consumes: `resolveScopedPath` (module-private, `:785`), `isMissingEntryError` (module-private, used at `:481`), `fileRevision` (module-private, used at `:471`), `textMimeTypeForExtension` / `IMAGE_MIME_TYPES` (module-private, used at `:551-561`), `normalizeRelativePath`, `expandUserPath`.
- Produces:
  - `export interface UpdatableFileInfo { path: string; absolutePath: string; fileName: string; mimeType: string; exists: boolean; size: number | null; }`
  - `export async function getUpdatableFileInfo({ root, relativePath }: ReadFileParams): Promise<UpdatableFileInfo>`
  - `export async function streamExplorerFileWrite({ root, relativePath, source }: { root: string; relativePath: string; source: AsyncIterable<Uint8Array> }): Promise<{ path: string; size: number; modifiedAt: string; revision: string }>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/src/server/file-explorer/service.test.ts` (follow the existing `writeExplorerFile` / `getDownloadableFileInfo` describe blocks in that file; reuse its `makeDir`-style temp helpers — adapt helper names to what that file already defines):

```ts
describe("getUpdatableFileInfo", () => {
  test("reports an existing file with its size and mime type", async () => {
    const root = makeDir("updatable-info-");
    writeFileSync(join(root, "notes.txt"), "hello");

    const info = await getUpdatableFileInfo({ root, relativePath: "notes.txt" });

    expect(info.exists).toBe(true);
    expect(info.size).toBe(5);
    expect(info.fileName).toBe("notes.txt");
    expect(info.absolutePath).toBe(join(root, "notes.txt"));
  });

  test("reports a missing file without throwing", async () => {
    const root = makeDir("updatable-missing-");

    const info = await getUpdatableFileInfo({ root, relativePath: "nope.txt" });

    expect(info.exists).toBe(false);
    expect(info.size).toBeNull();
    expect(info.absolutePath).toBe(join(root, "nope.txt"));
  });

  test("rejects paths escaping the workspace root", async () => {
    const root = makeDir("updatable-escape-");

    await expect(getUpdatableFileInfo({ root, relativePath: "../outside.txt" })).rejects.toThrow();
  });
});

describe("streamExplorerFileWrite", () => {
  test("creates a new file in a nested directory and returns revision info", async () => {
    const root = makeDir("stream-write-create-");
    const source = async function* () {
      yield new TextEncoder().encode("part one ");
      yield new TextEncoder().encode("part two");
    };

    const result = await streamExplorerFileWrite({
      root,
      relativePath: "sub/dir/notes.txt",
      source,
    });

    expect(readFileSync(join(root, "sub/dir/notes.txt"), "utf8")).toBe("part one part two");
    expect(result.size).toBe(17);
    expect(result.path).toBe("sub/dir/notes.txt");
    expect(result.revision).toBeTruthy();
    expect(result.modifiedAt).toBeTruthy();
  });

  test("overwrites an existing binary file byte-for-byte", async () => {
    const root = makeDir("stream-write-binary-");
    writeFileSync(join(root, "blob.bin"), Buffer.from([1, 2, 3, 4]));
    const payload = new Uint8Array([0, 255, 254, 1, 2]);
    const source = async function* () {
      yield payload;
    };

    const result = await streamExplorerFileWrite({ root, relativePath: "blob.bin", source });

    expect(Buffer.from(readFileSync(join(root, "blob.bin")))).toEqual(Buffer.from(payload));
    expect(result.size).toBe(payload.byteLength);
  });

  test("cleans up its temp file when the source stream fails", async () => {
    const root = makeDir("stream-write-fail-");
    const source = async function* () {
      yield new TextEncoder().encode("partial");
      throw new Error("stream died");
    };

    await expect(
      streamExplorerFileWrite({ root, relativePath: "notes.txt", source }),
    ).rejects.toThrow("stream died");

    expect(existsSync(join(root, "notes.txt"))).toBe(false);
    const leftovers = readdirSync(root).filter((name) => name.includes(".paseo-"));
    expect(leftovers).toEqual([]);
  });
});
```

(Adjust helper imports at the top of `service.test.ts` if `readdirSync` is not already imported.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=@getpaseo/server -- src/server/file-explorer/service.test.ts --bail=1`
Expected: FAIL — `getUpdatableFileInfo` / `streamExplorerFileWrite` are not exported.

- [ ] **Step 3: Implement the two functions**

In `packages/server/src/server/file-explorer/service.ts`, after `getDownloadableFileInfo` (line ~574), add:

```ts
export interface UpdatableFileInfo {
  path: string;
  absolutePath: string;
  fileName: string;
  mimeType: string;
  exists: boolean;
  size: number | null;
}

/**
 * Resolves an update target inside a workspace. Unlike getDownloadableFileInfo
 * (which requires the file to exist), a missing target is a valid outcome and
 * is reported via `exists: false` so the caller can let the client create it.
 * The mime type of a missing file is derived from its extension only — there
 * is no content to sample.
 */
export async function getUpdatableFileInfo({
  root,
  relativePath,
}: ReadFileParams): Promise<UpdatableFileInfo> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const normalizedPath = normalizeRelativePath({ root, targetPath: filePath.requestedPath });

  let handle: FileHandle | null = null;
  try {
    handle = await openFileForRead(filePath.resolvedPath);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error("Requested path is not a file");
    }
    const ext = path.extname(filePath.resolvedPath).toLowerCase();
    let mimeType = "application/octet-stream";
    if (ext in IMAGE_MIME_TYPES) {
      mimeType = IMAGE_MIME_TYPES[ext];
    } else {
      const sample = Buffer.alloc(FILE_TYPE_SAMPLE_BYTES);
      const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
      const chunk = bytesRead < sample.length ? sample.subarray(0, bytesRead) : sample;
      if (!isLikelyBinary(chunk)) {
        mimeType = textMimeTypeForExtension(ext);
      }
    }
    return {
      path: normalizedPath,
      absolutePath: filePath.resolvedPath,
      fileName: path.basename(filePath.requestedPath),
      mimeType,
      exists: true,
      size: stats.size,
    };
  } catch (error) {
    if (isMissingEntryError(error)) {
      const ext = path.extname(filePath.resolvedPath).toLowerCase();
      const mimeType =
        ext in IMAGE_MIME_TYPES
          ? IMAGE_MIME_TYPES[ext]
          : textMimeTypeForExtension(ext) ?? "application/octet-stream";
      return {
        path: normalizedPath,
        absolutePath: filePath.resolvedPath,
        fileName: path.basename(filePath.requestedPath),
        mimeType,
        exists: false,
        size: null,
      };
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Streams a write into a workspace file with the same atomicity as
 * writeExplorerFile: chunks land in a same-directory temp file, are fsynced,
 * then renamed over the target. Overwrites preserve the existing file mode;
 * new files default to 0o600. Missing parent directories are created.
 */
export async function streamExplorerFileWrite({
  root,
  relativePath,
  source,
}: {
  root: string;
  relativePath: string;
  source: AsyncIterable<Uint8Array>;
}): Promise<{ path: string; size: number; modifiedAt: string; revision: string }> {
  const filePath = await resolveScopedPath({ root, relativePath });
  const targetPath = filePath.resolvedPath;
  const dirPath = path.dirname(targetPath);

  await fs.mkdir(dirPath, { recursive: true });

  let targetMode = 0o600;
  try {
    const stats = await fs.stat(targetPath);
    if (stats.isDirectory()) {
      throw new Error("Requested path is not a file");
    }
    targetMode = Number(stats.mode);
  } catch (error) {
    if (!isMissingEntryError(error)) {
      throw error;
    }
  }

  const temporaryPath = path.join(
    dirPath,
    `.${path.basename(targetPath)}.paseo-${randomUUID()}.tmp`,
  );
  let temporaryHandle: FileHandle | null = null;
  try {
    temporaryHandle = await fs.open(temporaryPath, "wx", targetMode);
    if (process.platform !== "win32") {
      await temporaryHandle.chmod(targetMode & 0o7777);
    }
    let size = 0;
    for await (const chunk of source) {
      await temporaryHandle.writeFile(chunk);
      size += chunk.byteLength;
    }
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;

    await fs.rename(temporaryPath, targetPath);
    const stats = await fs.stat(targetPath);
    return {
      path: normalizeRelativePath({ root, targetPath: filePath.requestedPath }),
      size: Number(stats.size),
      modifiedAt: stats.mtime.toISOString(),
      revision: fileRevision(stats),
    };
  } catch (error) {
    throw error;
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}
```

Check the top of `service.ts` for existing imports: `randomUUID` (already imported — used at `:492`), `FileHandle` (imported from `node:fs` — used at `:494`), `fs` (already imported), `FILE_TYPE_SAMPLE_BYTES` (defined in this file — used at `:556`). If `textMimeTypeForExtension` returns `string` (not `string | null`) adjust the `??` fallback accordingly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=@getpaseo/server -- src/server/file-explorer/service.test.ts --bail=1`
Expected: PASS (existing + 5 new tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck --workspace=@getpaseo/server`
Expected: clean.

```bash
git add packages/server/src/server/file-explorer/service.ts packages/server/src/server/file-explorer/service.test.ts
git commit -m "feat(server): add update-target info and streamed atomic file writes"
```

---

### Task 4: Server — session handler + dispatch

**Files:**
- Modify: `packages/server/src/server/session/files/workspace-files-session.ts` (after `handleFileDownloadTokenRequest`, line ~457)
- Modify: `packages/server/src/server/session.ts` (dispatch case next to `:2191`)
- Test: Modify `packages/server/src/server/session/files/workspace-files-session.test.ts` (after the download-token tests, ~:493)

**Interfaces:**
- Consumes: `FileUpdateTokenRequest` type (`@getpaseo/protocol/messages`), `getUpdatableFileInfo`, `DownloadTokenStore.issueToken`.
- Produces: `WorkspaceFilesSession.handleFileUpdateTokenRequest(request: FileUpdateTokenRequest): Promise<void>` — emits `file_update_token_response`; `session.ts` routes the message.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/src/server/session/files/workspace-files-session.test.ts` (reuse `makeDir` / `makeSubsystem` helpers already in that file; `FileUpdateTokenRequest` is imported from `../../messages.js` like the other request types):

```ts
describe("handleFileUpdateTokenRequest", () => {
  test("issues a token carrying overwrite and target exists state", async () => {
    const cwd = makeDir("file-update-token-");
    writeFileSync(join(cwd, "notes.txt"), "existing");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileUpdateTokenRequest({
      type: "file_update_token_request",
      cwd,
      path: "notes.txt",
      overwrite: true,
      requestId: "req-update-1",
    });

    const response = emitted.find(
      (message) => message.type === "file_update_token_response",
    ) as Extract<SessionOutboundMessage, { type: "file_update_token_response" }>;
    expect(response).toBeDefined();
    expect(response.payload.token).toBeTruthy();
    expect(response.payload.exists).toBe(true);
    expect(response.payload.size).toBe(8);
    expect(response.payload.error).toBeNull();
    expect(response.payload.fileName).toBe("notes.txt");
  });

  test("reports missing targets with exists false", async () => {
    const cwd = makeDir("file-update-missing-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileUpdateTokenRequest({
      type: "file_update_token_request",
      cwd,
      path: "new.txt",
      requestId: "req-update-2",
    });

    const response = emitted.find(
      (message) => message.type === "file_update_token_response",
    ) as Extract<SessionOutboundMessage, { type: "file_update_token_response" }>;
    expect(response.payload.token).toBeTruthy();
    expect(response.payload.exists).toBe(false);
    expect(response.payload.size).toBeNull();
  });

  test("rejects paths outside the workspace cwd", async () => {
    const cwd = makeDir("file-update-escape-");
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileUpdateTokenRequest({
      type: "file_update_token_request",
      cwd,
      path: "../outside.txt",
      requestId: "req-update-3",
    });

    const response = emitted.find(
      (message) => message.type === "file_update_token_response",
    ) as Extract<SessionOutboundMessage, { type: "file_update_token_response" }>;
    expect(response.payload.token).toBeNull();
    expect(response.payload.error).toBeTruthy();
  });

  test("rejects an empty cwd", async () => {
    const { subsystem, emitted } = makeSubsystem();

    await subsystem.handleFileUpdateTokenRequest({
      type: "file_update_token_request",
      cwd: " ",
      path: "notes.txt",
      requestId: "req-update-4",
    });

    const response = emitted.find(
      (message) => message.type === "file_update_token_response",
    ) as Extract<SessionOutboundMessage, { type: "file_update_token_response" }>;
    expect(response.payload.token).toBeNull();
    expect(response.payload.error).toBe("cwd is required");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=@getpaseo/server -- src/server/session/files/workspace-files-session.test.ts --bail=1`
Expected: FAIL — method does not exist.

- [ ] **Step 3: Implement the handler**

In `packages/server/src/server/session/files/workspace-files-session.ts`:

1. Add `FileUpdateTokenRequest` to the `../../messages.js` type import (next to `FileDownloadTokenRequest`).
2. Import `getUpdatableFileInfo` from `../../file-explorer/service.js` (next to `getDownloadableFileInfo`).
3. Append after `handleFileDownloadTokenRequest` (line ~457):

```ts
  async handleFileUpdateTokenRequest(request: FileUpdateTokenRequest): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath, overwrite, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
        type: "file_update_token_response",
        payload: {
          cwd: workspaceCwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          exists: null,
          size: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    this.logger.debug(
      { cwd, path: requestedPath, overwrite },
      `Handling file update token request for workspace ${cwd} (${requestedPath})`,
    );

    try {
      const info = await getUpdatableFileInfo({
        root: cwd,
        relativePath: requestedPath,
      });

      const entry = this.downloadTokenStore.issueToken({
        path: info.path,
        absolutePath: info.absolutePath,
        fileName: info.fileName,
        mimeType: info.mimeType,
        size: info.size ?? 0,
        overwrite: overwrite === true,
      });

      this.host.emit({
        type: "file_update_token_response",
        payload: {
          cwd,
          path: info.path,
          token: entry.token,
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          exists: info.exists,
          size: info.size,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to issue file update token for workspace ${cwd}`,
      );
      this.host.emit({
        type: "file_update_token_response",
        payload: {
          cwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          exists: null,
          size: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }
```

In `packages/server/src/server/session.ts`, add the dispatch case directly after the `file_download_token_request` case (`:2191`):

```ts
      case "file_update_token_request":
        return this.workspaceFilesSession.handleFileUpdateTokenRequest(msg);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=@getpaseo/server -- src/server/session/files/workspace-files-session.test.ts --bail=1`
Expected: PASS (existing + 4 new tests).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck --workspace=@getpaseo/server`
Expected: clean.

```bash
git add packages/server/src/server/session/files/workspace-files-session.ts packages/server/src/server/session/files/workspace-files-session.test.ts packages/server/src/server/session.ts
git commit -m "feat(server): issue file update tokens over the session"
```

---

### Task 5: Server — HTTP endpoint, CORS, auth bypass

**Files:**
- Modify: `packages/server/src/server/bootstrap.ts` (CORS methods `:677`, route registration, handler next to `handleFileDownload` `:727`)
- Modify: `packages/server/src/server/auth.ts` (bypass set `:124-146`)
- Test: Modify `packages/server/src/server/bootstrap-auth.test.ts` (mirror the download cases at `:92-111`)

**Interfaces:**
- Consumes: `streamExplorerFileWrite` (Task 3), `DownloadTokenStore.consumeToken` (existing).
- Produces: `PUT /api/files/update?token=<token>` handler; 400 missing token / 403 invalid-expired / 409 exists-wo-overwrite or directory target / 200 `{ path, size, modifiedAt, revision }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/src/server/bootstrap-auth.test.ts`, mirroring the download-token test at `:85-104` (same `createTestPaseoDaemon({ auth: { password: CORRECT_PASSWORD_HASH } })` / `daemonHandle.port` / try-finally `daemonHandle.close()` pattern):

```ts
  test("allows file updates with only a capability token when password is configured", async () => {
    const daemonHandle = await createTestPaseoDaemon({
      auth: { password: CORRECT_PASSWORD_HASH },
    });
    try {
      // No bearer at all: the route is reachable, but the update token store
      // rejects the request because no token was supplied (400, not 401).
      const missingToken = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/files/update`, {
        method: "PUT",
      });
      expect(missingToken.status).toBe(400);

      // An invalid token is rejected by the token store (403, not 401) — proving
      // the token, not the daemon password, is what guards this route.
      const invalidToken = await fetch(
        `http://127.0.0.1:${daemonHandle.port}/api/files/update?token=invalid-token`,
        { method: "PUT" },
      );
      expect(invalidToken.status).toBe(403);
    } finally {
      await daemonHandle.close();
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=@getpaseo/server -- src/server/bootstrap-auth.test.ts --bail=1`
Expected: FAIL — route not registered (404) or bearer-gated (401).

- [ ] **Step 3: Implement route, CORS, and bypass**

In `packages/server/src/server/auth.ts`, add to `BEARER_AUTH_BYPASS_PATHS` (after the `"/api/files/download",` entry, line ~135):

```ts
  // Guarded by a single-use update token issued over the authenticated
  // WebSocket (same capability-token model as the download route above).
  "/api/files/update",
```

In `packages/server/src/server/bootstrap.ts`:

1. In the CORS middleware (`:677`), add `PUT` to the allowed methods:

```ts
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
```

2. Add the handler next to `handleFileDownload` (`:727-781`) and register the route **before** `app.use(express.json())` (`:707`). The `handleFileUpdate` function (placed right after `handleFileDownload`):

```ts
  const handleFileUpdate = async (req: express.Request, res: express.Response): Promise<void> => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;

    if (!token) {
      res.status(400).json({ error: "Missing update token" });
      return;
    }

    const entry = downloadTokenStore.consumeToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    try {
      const targetStats = await fs.stat(entry.absolutePath);
      if (targetStats.isDirectory()) {
        res.status(409).json({ error: "Target is not a file", path: entry.path });
        return;
      }
      if (entry.overwrite !== true) {
        res.status(409).json({
          error: "Target already exists",
          path: entry.path,
          exists: true,
          size: targetStats.size,
          modifiedAt: targetStats.mtime.toISOString(),
        });
        return;
      }
    } catch (error) {
      if (!isMissingEntryError(error)) {
        logger.error({ err: error }, "Failed to stat update target");
        res.status(500).json({ error: "Failed to write file" });
        return;
      }
    }

    try {
      const result = await streamExplorerFileWrite({
        root: path.dirname(entry.absolutePath),
        relativePath: path.basename(entry.absolutePath),
        source: req,
      });
      res.status(200).json({ ...result, path: entry.path });
    } catch (err) {
      logger.error({ err }, "Failed to update file");
      res.status(500).json({ error: "Failed to write file" });
    }
  };
```

`streamExplorerFileWrite` re-validates the target through `resolveScopedPath` with the token's `absolutePath` (split into dirname root + basename relative path), so the write is atomic and path-scoped without trusting client input. The response `path` is overridden with `entry.path` (the workspace-relative path recorded at token issuance) because `normalizeRelativePath` on a bare basename would not produce it. Import `streamExplorerFileWrite` and `isMissingEntryError` in `bootstrap.ts` (check existing imports for `fs` — it is already imported as `open` + `DOWNLOAD_OPEN_FLAGS` are used at `:746`; verify the actual fs import style and reuse it; `path` is already imported).

Register the route. The route must run before `express.json()` (which sits at `:707` and would otherwise swallow `Content-Type: application/json` bodies) but does not need bearer middleware — it authenticates via its own token. Place registration right after the `/api/terminal-activity` route block (`:689-693`):

```ts
  // Token-gated counterpart to GET /api/files/download: consumes a one-time
  // update token issued over the WebSocket and streams the request body into
  // the workspace. Registered before express.json() so uploads with a JSON
  // content type are not parsed as JSON request bodies.
  app.put("/api/files/update", (req, res) => {
    void handleFileUpdate(req, res);
  });
```

Note: `handleFileUpdate` must be defined before this registration line (hoisting: `const` arrow functions do not hoist — place the `const handleFileUpdate = ...` definition above the `app.put` line, e.g. right after the `handleFileDownload` definition block if the registration stays early; if the registration is early, define the handler with the other route handlers above `app.use(express.json())`). Structure the code so the const is declared before use.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=@getpaseo/server -- src/server/bootstrap-auth.test.ts --bail=1`
Expected: PASS (400 missing token, 403 invalid token).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck --workspace=@getpaseo/server`
Expected: clean.

```bash
git add packages/server/src/server/bootstrap.ts packages/server/src/server/auth.ts packages/server/src/server/bootstrap-auth.test.ts
git commit -m "feat(server): add token-gated PUT /api/files/update endpoint"
```

---

### Task 6: Server — end-to-end test

**Files:**
- Create: `packages/server/src/server/daemon-e2e/file-update.e2e.test.ts` (mirror `file-download.e2e.test.ts`)

**Interfaces:**
- Consumes: `ctx.client.requestFileUpdateToken(...)` — the daemon-client method added in Task 7. **Task ordering note:** Task 7 is small; if executing strictly in order, implement Task 7 before this task's tests can compile. The e2e test uses `ctx.client.requestFileUpdateToken(cwd, path, overwrite)` which must exist.

- [ ] **Step 1: Write the e2e test**

Create `packages/server/src/server/daemon-e2e/file-update.e2e.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Use gpt-5.4-mini with low thinking preset for faster test execution
const CODEX_TEST_MODEL = "gpt-5.4-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("file update tokens", () => {
    test("creates a new file over PUT and verifies binary contents", async () => {
      const cwd = tmpCwd();
      const payload = new Uint8Array([0, 1, 2, 255, 254, 13, 10]);

      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Update Token Test Agent",
      });

      expect(agent.id).toBeTruthy();

      const tokenResponse = await ctx.client.requestFileUpdateToken(cwd, "nested/upload.bin", true);

      expect(tokenResponse.error).toBeNull();
      expect(tokenResponse.token).toBeTruthy();
      expect(tokenResponse.exists).toBe(false);

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/update?token=${tokenResponse.token}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: payload,
        },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.path).toBe("nested/upload.bin");
      expect(body.size).toBe(payload.byteLength);

      const written = readFileSync(path.join(cwd, "nested", "upload.bin"));
      expect(Buffer.from(written)).toEqual(Buffer.from(payload));

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);

    test("rejects overwriting an existing file without the overwrite flag", async () => {
      const cwd = tmpCwd();
      writeFileSync(path.join(cwd, "notes.txt"), "original");

      await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Conflict Token Test Agent",
      });

      const tokenResponse = await ctx.client.requestFileUpdateToken(cwd, "notes.txt", false);

      expect(tokenResponse.token).toBeTruthy();
      expect(tokenResponse.exists).toBe(true);

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/update?token=${tokenResponse.token}`,
        { method: "PUT", body: "replacement" },
      );

      expect(response.status).toBe(409);
      expect(readFileSync(path.join(cwd, "notes.txt"), "utf8")).toBe("original");

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);

    test("overwrites an existing file when the token carries overwrite", async () => {
      const cwd = tmpCwd();
      writeFileSync(path.join(cwd, "notes.txt"), "original");

      await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Overwrite Token Test Agent",
      });

      const tokenResponse = await ctx.client.requestFileUpdateToken(cwd, "notes.txt", true);

      expect(tokenResponse.token).toBeTruthy();
      expect(tokenResponse.exists).toBe(true);

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/update?token=${tokenResponse.token}`,
        { method: "PUT", body: "replacement" },
      );

      expect(response.status).toBe(200);
      expect(readFileSync(path.join(cwd, "notes.txt"), "utf8")).toBe("replacement");

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);

    test("rejects invalid token", async () => {
      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/update?token=invalid-token`,
        { method: "PUT" },
      );

      expect(response.status).toBe(403);
    }, 30000);

    test("rejects expired token", async () => {
      await ctx.cleanup();
      ctx = await createDaemonTestContext({ downloadTokenTtlMs: 50 });

      const cwd = tmpCwd();
      await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Expired Token Test Agent",
      });

      const tokenResponse = await ctx.client.requestFileUpdateToken(cwd, "expired.txt", true);

      expect(tokenResponse.token).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 150));

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/update?token=${tokenResponse.token}`,
        { method: "PUT" },
      );

      expect(response.status).toBe(403);

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);

    test("rejects paths outside the workspace cwd at token issuance", async () => {
      const cwd = tmpCwd();
      await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Outside Path Token Test Agent",
      });

      const tokenResponse = await ctx.client.requestFileUpdateToken(cwd, "../outside.txt", true);

      expect(tokenResponse.token).toBeNull();
      expect(tokenResponse.error).toBeTruthy();

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);
  });
});
```

- [ ] **Step 2: Implement the client method (Task 7) so this compiles**

Follow Task 7 below before running. (If executing out of order, the test will fail to compile — that is expected until Task 7 lands.)

- [ ] **Step 3: Run the e2e test**

Run: `npm run test --workspace=@getpaseo/server -- src/server/daemon-e2e/file-update.e2e.test.ts --bail=1`
Expected: PASS (6 tests; needs a live provider session for agent creation — same as `file-download.e2e.test.ts`).

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/server/daemon-e2e/file-update.e2e.test.ts
git commit -m "test(server): e2e coverage for the file update endpoint"
```

---

### Task 7: Client — `requestFileUpdateToken`

**Files:**
- Modify: `packages/client/src/daemon-client.ts` (type alias next to `:445`, method next to `requestDownloadToken` `:4401`)

**Interfaces:**
- Consumes: `FileUpdateTokenResponse` from `@getpaseo/protocol/messages`.
- Produces: `type FileUpdateTokenPayload = FileUpdateTokenResponse["payload"]` and:

```ts
async requestFileUpdateToken(
  cwd: string,
  path: string,
  overwrite?: boolean,
  requestId?: string,
): Promise<FileUpdateTokenPayload>
```

- [ ] **Step 1: Implement the method**

In `packages/client/src/daemon-client.ts`:

1. Add `FileUpdateTokenResponse` to the `@getpaseo/protocol/messages` type import (next to `FileDownloadTokenResponse`, line ~26).
2. Next to `type FileDownloadTokenPayload` (line ~445):

```ts
type FileUpdateTokenPayload = FileUpdateTokenResponse["payload"];
```

3. Directly after `requestDownloadToken` (line ~4415):

```ts
  async requestFileUpdateToken(
    cwd: string,
    path: string,
    overwrite?: boolean,
    requestId?: string,
  ): Promise<FileUpdateTokenPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: "file_update_token_request",
        cwd,
        path,
        overwrite,
      },
      responseType: "file_update_token_response",
    });
  }
```

(The repo has no dedicated unit test for `requestDownloadToken`; this method follows the same pattern and is covered by the server e2e in Task 6.)

- [ ] **Step 2: Typecheck and commit**

Run: `npm run typecheck --workspace=@getpaseo/client`
Expected: clean.

```bash
git add packages/client/src/daemon-client.ts
git commit -m "feat(client): add requestFileUpdateToken"
```

---

### Task 8: App — upload pure function, actions, hook

**Files:**
- Modify: `packages/app/src/stores/download-store.ts` (export `resolveDaemonDownloadTarget`, line ~247)
- Create: `packages/app/src/file-explorer/upload-file.ts`
- Modify: `packages/app/src/hooks/use-file-explorer-actions.ts` (next to `requestFileDownloadToken` `:239`)
- Create: `packages/app/src/hooks/use-file-upload.ts` (mirror `use-file-download.ts`)
- Test: Create `packages/app/src/file-explorer/upload-file.test.ts`

**Interfaces:**
- Consumes: `requestFileUpdateToken` client method, `resolveDaemonDownloadTarget(daemonProfile)`, `useHosts()` from `@/runtime/host-runtime`, `useFileExplorerActions().requestFileUpdateToken`.
- Produces:
  - `export function buildUpdateUrl(baseUrl: string, token: string): string`
  - `export async function uploadExplorerFile(input: { requestFileUpdateToken: (path: string, overwrite: boolean) => Promise<{ token: string | null; error: string | null }>; baseUrl: string; path: string; fileName: string; bytes: Uint8Array; mimeType: string; overwrite: boolean }): Promise<{ path: string; size: number; modifiedAt: string; revision: string }>`
  - `useFileExplorerActions().requestFileUpdateToken(path: string, overwrite: boolean)`
  - `useFileUpload({ serverId, workspaceId, workspaceRoot }): (input: { path: string; fileName: string; bytes: Uint8Array; mimeType: string; overwrite: boolean }) => Promise<{ path: string; size: number; modifiedAt: string; revision: string }>`

- [ ] **Step 1: Write the failing test**

Create `packages/app/src/file-explorer/upload-file.test.ts`:

```ts
import { describe, expect, test, vi, afterEach } from "vitest";
import { buildUpdateUrl, uploadExplorerFile } from "./upload-file";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildUpdateUrl", () => {
  test("appends the token query parameter", () => {
    expect(buildUpdateUrl("http://127.0.0.1:6767", "abc-123")).toBe(
      "http://127.0.0.1:6767/api/files/update?token=abc-123",
    );
  });
});

describe("uploadExplorerFile", () => {
  test("requests a token and PUTs the bytes, returning the write result", async () => {
    const requestFileUpdateToken = vi.fn(async () => ({ token: "tok-1", error: null }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ path: "a.bin", size: 3, modifiedAt: "2026-01-01T00:00:00.000Z", revision: "r1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadExplorerFile({
      requestFileUpdateToken,
      baseUrl: "http://127.0.0.1:6767",
      path: "a.bin",
      fileName: "a.bin",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "application/octet-stream",
      overwrite: true,
    });

    expect(requestFileUpdateToken).toHaveBeenCalledWith("a.bin", true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:6767/api/files/update?token=tok-1");
    expect(init.method).toBe("PUT");
    expect(init.headers["Content-Type"]).toBe("application/octet-stream");
    expect(init.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(result).toEqual({ path: "a.bin", size: 3, modifiedAt: "2026-01-01T00:00:00.000Z", revision: "r1" });
  });

  test("throws when token issuance fails", async () => {
    const requestFileUpdateToken = vi.fn(async () => ({ token: null, error: "nope" }));

    await expect(
      uploadExplorerFile({
        requestFileUpdateToken,
        baseUrl: "http://127.0.0.1:6767",
        path: "a.bin",
        fileName: "a.bin",
        bytes: new Uint8Array(),
        mimeType: "application/octet-stream",
        overwrite: false,
      }),
    ).rejects.toThrow("nope");
  });

  test("surfaces non-2xx responses", async () => {
    const requestFileUpdateToken = vi.fn(async () => ({ token: "tok-1", error: null }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "Target already exists" }) })),
    );

    await expect(
      uploadExplorerFile({
        requestFileUpdateToken,
        baseUrl: "http://127.0.0.1:6767",
        path: "a.bin",
        fileName: "a.bin",
        bytes: new Uint8Array(),
        mimeType: "application/octet-stream",
        overwrite: false,
      }),
    ).rejects.toThrow("Target already exists");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=@getpaseo/app -- src/file-explorer/upload-file.test.ts --bail=1`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the pure function**

Create `packages/app/src/file-explorer/upload-file.ts`:

```ts
export function buildUpdateUrl(baseUrl: string, token: string): string {
  const url = new URL("/api/files/update", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * Uploads one file into a workspace through the token-gated HTTP endpoint:
 * the overwrite decision is sealed into the WS-issued token, then the raw
 * bytes are PUT to /api/files/update. Mirrors the download pipeline in
 * stores/download-store.ts.
 */
export async function uploadExplorerFile(input: {
  requestFileUpdateToken: (path: string, overwrite: boolean) => Promise<{
    token: string | null;
    error: string | null;
  }>;
  baseUrl: string;
  path: string;
  fileName: string;
  bytes: Uint8Array;
  mimeType: string;
  overwrite: boolean;
}): Promise<{ path: string; size: number; modifiedAt: string; revision: string }> {
  const tokenResponse = await input.requestFileUpdateToken(input.path, input.overwrite);
  if (tokenResponse.error || !tokenResponse.token) {
    throw new Error(tokenResponse.error ?? "Failed to request upload token.");
  }

  const response = await fetch(buildUpdateUrl(input.baseUrl, tokenResponse.token), {
    method: "PUT",
    headers: { "Content-Type": input.mimeType },
    body: input.bytes,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Upload failed (${response.status}).`);
  }

  return (await response.json()) as { path: string; size: number; modifiedAt: string; revision: string };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=@getpaseo/app -- src/file-explorer/upload-file.test.ts --bail=1`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the hook and actions**

In `packages/app/src/stores/download-store.ts`, change the private function to exported (line ~247):

```ts
export function resolveDaemonDownloadTarget(daemon?: HostProfile): DownloadTarget {
```

(It stays in place; `use-file-upload.ts` imports it.)

In `packages/app/src/hooks/use-file-explorer-actions.ts`, add next to `requestFileDownloadToken` (`:239-254`):

```ts
  const requestFileUpdateToken = useCallback(
    async (path: string, overwrite: boolean) => {
      if (!normalizedWorkspaceRoot) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.requestFileUpdateToken(normalizedWorkspaceRoot, path, overwrite);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, t],
  );
```

Return `requestFileUpdateToken` from the hook (add to the return object next to `requestFileDownloadToken`, line ~344).

Create `packages/app/src/hooks/use-file-upload.ts` (mirror `use-file-download.ts`):

```ts
import { useCallback, useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { resolveDaemonDownloadTarget } from "@/stores/download-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { uploadExplorerFile } from "@/file-explorer/upload-file";

interface UseFileUploadParams {
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
}

/**
 * Returns a stable callback that uploads a local file into the workspace at a
 * workspace-relative path. Overwrite decisions are made by the caller (the
 * file explorer prompts first) and sealed into the WS-issued update token.
 */
export function useFileUpload({
  serverId,
  workspaceId,
  workspaceRoot,
}: UseFileUploadParams): (input: {
  path: string;
  fileName: string;
  bytes: Uint8Array;
  mimeType: string;
  overwrite: boolean;
}) => Promise<{ path: string; size: number; modifiedAt: string; revision: string }> {
  const daemons = useHosts();
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const normalizedWorkspaceRoot = useMemo(() => workspaceRoot.trim(), [workspaceRoot]);
  const workspaceScopeId = useMemo(
    () => workspaceId?.trim() || normalizedWorkspaceRoot,
    [normalizedWorkspaceRoot, workspaceId],
  );
  const { requestFileUpdateToken } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });

  return useCallback(
    async (input) => {
      if (!workspaceScopeId) {
        throw new Error("Workspace is not available.");
      }
      const downloadTarget = resolveDaemonDownloadTarget(daemonProfile);
      if (!downloadTarget.baseUrl) {
        throw new Error("Upload host is unavailable.");
      }
      return uploadExplorerFile({
        requestFileUpdateToken: (path, overwrite) =>
          requestFileUpdateToken(path, overwrite).then(
            (payload) => ({ token: payload.token, error: payload.error }),
            (error: unknown) => ({ token: null, error: error instanceof Error ? error.message : String(error) }),
          ),
        baseUrl: downloadTarget.baseUrl,
        path: input.path,
        fileName: input.fileName,
        bytes: input.bytes,
        mimeType: input.mimeType,
        overwrite: input.overwrite,
      });
    },
    [daemonProfile, requestFileUpdateToken, workspaceScopeId],
  );
}
```

- [ ] **Step 6: Typecheck, format, and commit**

Run: `npm run typecheck --workspace=@getpaseo/app` and `npm run format:check -- packages/app/src/file-explorer/upload-file.ts packages/app/src/file-explorer/upload-file.test.ts packages/app/src/hooks/use-file-upload.ts packages/app/src/hooks/use-file-explorer-actions.ts packages/app/src/stores/download-store.ts`
Expected: clean.

```bash
git add packages/app/src/file-explorer/upload-file.ts packages/app/src/file-explorer/upload-file.test.ts packages/app/src/hooks/use-file-upload.ts packages/app/src/hooks/use-file-explorer-actions.ts packages/app/src/stores/download-store.ts
git commit -m "feat(app): upload files into a workspace over the update endpoint"
```

---

### Task 9: App — file explorer menu item, overwrite confirm, i18n

**Files:**
- Modify: `packages/app/src/components/file-actions-menu.tsx` (props + menu item next to download, `:160-167`)
- Modify: `packages/app/src/components/file-explorer-pane.tsx` (menu wiring `:402`, `handleDownloadEntry` `:644-651`, second menu usage `:1342`, confirm-dialog pattern `:813-823`)
- Modify: `packages/app/src/i18n/resources/en.ts` (`workspace.fileActions` block `:411-435`)
- Modify: `packages/app/src/i18n/resources/ar.ts`, `es.ts`, `fr.ts`, `ja.ts`, `ko.ts`, `pt-BR.ts`, `ru.ts`, `zh-CN.ts` (same keys, translated — `resources.test.ts` requires exact key parity)
- Test: `packages/app/src/i18n/resources.test.ts` (existing — must stay green)

**Interfaces:**
- Consumes: `useFilePicker()` (`@/hooks/use-file-picker`), `useFileUpload` (Task 8), `confirmDialog` (`@/utils/confirm-dialog`, already imported in the pane), `parentExplorerPath` (`@/utils/explorer-paths`, already imported), explorer state maps for the exists check, `requestDirectoryListing`.
- Produces: "Upload" entry in the shared file-actions context menu (directories and files); a confirm flow when the target exists; list refresh after success.

- [ ] **Step 1: Add the menu item**

In `packages/app/src/components/file-actions-menu.tsx`:

1. Add prop to `FileActionsContextMenuContentProps` (after `onDownload`, line ~46):

```ts
  onUpload?: () => void;
```

2. Destructure it (after `onDownload`).

3. Add the menu spec after the download item (`:160-167`):

```ts
      onUpload
        ? {
            key: "upload",
            label: t("workspace.fileActions.upload"),
            icon: Upload,
            onSelect: onUpload,
          }
        : null,
```

4. Import `Upload` from `lucide-react-native` (check the existing icon imports at the top of the file — `Download` etc. are imported there).

5. Add `onUpload` to the `useMemo` dependency array (next to `onDownload`).

- [ ] **Step 2: Wire the pane and confirm dialog**

In `packages/app/src/components/file-explorer-pane.tsx`:

1. Add `onUploadEntry` to `TreeRowItemProps` (next to `onDownloadEntry`, line ~133) and to `TreeRowItem`'s destructuring + `FileActionsContextMenuContent` call (line ~408).
2. Add an `onUpload` prop to the file-explorer context menu call at `:1342` if that menu is for the empty-area/backdrop (pass `undefined` unless there is a natural target — if the pane's second menu has no directory context, leave it out).
3. In `TreeRowItem`, add the handler next to `handleDownload` (`:315-317`):

```ts
  const handleUpload = useCallback(() => {
    onUploadEntry?.(entry);
  }, [onUploadEntry, entry]);
```

4. At the pane level, mirror `handleDownloadEntry` (`:644-651`):

```ts
  const uploadFile = useFileUpload({
    serverId,
    workspaceId,
    workspaceRoot: normalizedWorkspaceRoot,
  });
  const { pickFiles } = useFilePicker();

  const handleUploadEntry = useCallback(
    async (entry: ExplorerEntry) => {
      const files = await pickFiles();
      if (!files || files.length === 0) {
        return;
      }
      const targetDirectory =
        entry.kind === "directory" ? entry.path : parentExplorerPath(entry.path);
      for (const file of files) {
        const targetPath = [targetDirectory, file.fileName].filter(Boolean).join("/");
        const existingEntry = explorerDerived.directories.get(targetPath) ?? explorerDerived.files.get(targetPath);
        let overwrite = false;
        if (existingEntry) {
          const confirmed = await confirmDialog({
            title: t("workspace.fileActions.confirmOverwrite.title"),
            message: t("workspace.fileActions.confirmOverwrite.message", { name: file.fileName }),
            confirmLabel: t("workspace.fileActions.confirmOverwrite.overwrite"),
            cancelLabel: t("common.actions.cancel"),
          });
          if (!confirmed) {
            continue;
          }
          overwrite = true;
        }
        await uploadFile({
          path: targetPath,
          fileName: file.fileName,
          bytes: file.bytes,
          mimeType: file.mimeType,
          overwrite,
        });
        await requestDirectoryListing(targetDirectory, {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
    },
    [
      confirmDialog,
      explorerDerived.directories,
      explorerDerived.files,
      parentExplorerPath,
      pickFiles,
      requestDirectoryListing,
      t,
      uploadFile,
    ],
  );
```

Notes for the implementer: `confirmDialog` takes `{ title, message, confirmLabel?, cancelLabel?, destructive? }` (`@/utils/confirm-dialog.ts:5-11`) and is already imported in the pane (`:81`). `parentExplorerPath` is **not yet imported** in this file — add `import { parentExplorerPath } from "@/utils/explorer-paths";` (the pane currently imports `buildAbsoluteExplorerPath` from that module at `:70`). The pane already has `explorerDerived` (`:504`) with `directories`/`files` maps for the exists check. Match the existing error handling style: wrap the loop in try/catch and surface errors through `toast` like the surrounding handlers do (see `:644-651` and the neighboring toast usage).

- [ ] **Step 3: Add i18n keys**

In `packages/app/src/i18n/resources/en.ts`, in `workspace.fileActions` (after `download`, line ~416):

```ts
      upload: "Upload",
      confirmOverwrite: {
        title: "Overwrite file?",
        message: '"{{name}}" already exists. Replace it with the uploaded file?',
        overwrite: "Overwrite",
        cancel: "Cancel",
      },
```

Add the same keys (translated) at the identical path in `ar.ts`, `es.ts`, `fr.ts`, `ja.ts`, `ko.ts`, `pt-BR.ts`, `ru.ts`, `zh-CN.ts` (`workspace.fileActions` block). `resources.test.ts` enforces exact key parity — keys must match `en.ts` exactly; the "beyond fallback labels" test (≤25% identical English strings) allows a few English fallbacks, but translate properly per existing file conventions (check how each locale translates `download` in its `fileActions` block and mirror that style).

- [ ] **Step 4: Run tests and checks**

Run: `npm run test --workspace=@getpaseo/app -- src/i18n/resources.test.ts --bail=1`
Expected: PASS.

Run: `npm run typecheck --workspace=@getpaseo/app`
Expected: clean.

Run: `npm run format:check -- packages/app/src/components/file-actions-menu.tsx packages/app/src/components/file-explorer-pane.tsx packages/app/src/i18n/resources/`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/components/file-actions-menu.tsx packages/app/src/components/file-explorer-pane.tsx packages/app/src/i18n/resources/
git commit -m "feat(app): add upload entry and overwrite confirm to the file explorer"
```

---

### Task 10: App — Playwright e2e for the explorer upload flow

**Files:**
- Create: `packages/app/e2e/browser/file-explorer-upload.spec.ts` (mirror `file-explorer-context-actions.spec.ts`)

**Interfaces:**
- Consumes: `seedWorkspace({ repoPrefix })` / `openFileExplorer` / `gotoWorkspace` helpers (used by `file-explorer-context-actions.spec.ts:105-119`), the app's web file picker (`input[type="file"]` created on demand by `use-file-picker`), the menu testID scheme `file-explorer-row-<N>-upload` (produced by Task 9 via `testIDPrefix`).

- [ ] **Step 1: Write the spec**

Create `packages/app/e2e/browser/file-explorer-upload.spec.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { openFileExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

let workspace: SeededWorkspace;
let localDir: string;

test.beforeEach(async () => {
  workspace = await seedWorkspace({ repoPrefix: "file-explorer-upload-" });
  localDir = mkdtempSync(path.join(tmpdir(), "file-explorer-upload-local-"));
});

test.afterEach(async () => {
  await workspace?.cleanup();
  rmSync(localDir, { recursive: true, force: true });
});

test("uploads a local file into a workspace folder and lists it", async ({ page }) => {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  await page.getByTestId("files-new-folder").click();
  const nameInput = page.getByTestId("file-explorer-name-input");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("uploads");
  await nameInput.press("Enter");

  const tree = page.getByTestId("file-explorer-tree-scroll");
  const uploadsFolder = tree.getByText("uploads", { exact: true }).first();
  await expect(uploadsFolder).toBeVisible();
  await uploadsFolder.click({ button: "right" });

  const localFile = path.join(localDir, "local-upload.txt");
  writeFileSync(localFile, "uploaded from the browser", "utf8");

  await page.getByTestId(/file-explorer-row-\d+-upload$/).click();
  await page.locator('input[type="file"]').setInputFiles(localFile);

  await expect(tree.getByText("local-upload.txt", { exact: true })).toBeVisible();
  expect(readFileSync(path.join(workspace.workspaceDirectory, "uploads", "local-upload.txt"), "utf8")).toBe(
    "uploaded from the browser",
  );
});
```

(`workspace.workspaceDirectory` is the workspace root on disk per `seed-client.ts:202`.)

- [ ] **Step 2: Run the spec**

Run (check the exact e2e command in `packages/app/package.json` scripts — the repo runs Playwright specs under the app workspace):

`npm run test:e2e --workspace=@getpaseo/app -- file-explorer-upload.spec.ts`
Expected: PASS.

- [ ] **Step 3: Lint and commit**

Run: `npm run lint` (repo-wide oxlint)
Expected: clean.

```bash
git add packages/app/e2e/browser/file-explorer-upload.spec.ts
git commit -m "test(app): e2e upload flow in the file explorer"
```

---

### Final verification

- [ ] Run: `npm run typecheck` (all workspaces)
- [ ] Run: `npm run lint`
- [ ] Run: `npm run format:check`
- [ ] Run the full test suites for touched workspaces: `npm run test --workspace=@getpaseo/protocol`, `npm run test --workspace=@getpaseo/server`, `npm run test --workspace=@getpaseo/app` (unit), and the new e2e specs.
- [ ] Confirm `docs/superpowers/specs/2026-08-13-file-update-http-endpoint-design.md` requirements are all implemented (see Self-Review below).
