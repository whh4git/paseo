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
