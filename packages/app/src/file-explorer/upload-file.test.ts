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
      json: async () => ({
        path: "a.bin",
        size: 3,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        revision: "r1",
      }),
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
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: unknown },
    ];
    expect(url).toBe("http://127.0.0.1:6767/api/files/update?token=tok-1");
    expect(init.method).toBe("PUT");
    expect(init.headers["Content-Type"]).toBe("application/octet-stream");
    expect(init.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(result).toEqual({
      path: "a.bin",
      size: 3,
      modifiedAt: "2026-01-01T00:00:00.000Z",
      revision: "r1",
    });
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
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: "Target already exists" }),
      })),
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
