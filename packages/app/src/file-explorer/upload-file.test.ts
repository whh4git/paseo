import { describe, expect, test, vi, afterEach } from "vitest";
import { buildUpdateUrl, uploadExplorerFile, type UploadProgress } from "./upload-file";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface FakeXhrInit {
  status: number;
  responseText: string;
  progressEvents?: number[];
}

function stubXhr(init: FakeXhrInit): {
  sent: { url: string; method: string; body: unknown; headers: Record<string, string> } | null;
  fireProgress: (percent: number) => void;
} {
  const state: {
    sent: { url: string; method: string; body: unknown; headers: Record<string, string> } | null;
  } = { sent: null };

  class FakeXhr {
    status = 0;
    responseText = "";
    responseType = "";
    upload = {
      addEventListener: (
        _type: string,
        listener: (event: { lengthComputable: boolean; loaded: number; total: number }) => void,
      ) => {
        this.uploadProgressListener = listener;
      },
    };
    private uploadProgressListener:
      | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null = null;
    private listeners: Record<string, (() => void) | null> = {};
    private headers: Record<string, string> = {};

    addEventListener(type: string, listener: () => void) {
      this.listeners[type] = listener;
    }

    open(method: string, url: string) {
      state.sent = { method, url, body: null, headers: {} };
    }

    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }

    send(body: unknown) {
      if (!state.sent) {
        throw new Error("open() must be called before send()");
      }
      state.sent.body = body;
      state.sent.headers = this.headers;
      // Simulate upload progress before the response completes.
      for (const percent of init.progressEvents ?? []) {
        this.uploadProgressListener?.({ lengthComputable: true, loaded: percent, total: 1 });
      }
      this.status = init.status;
      this.responseText = init.responseText;
      this.listeners["load"]?.();
    }
  }

  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return {
    get sent() {
      return state.sent;
    },
    fireProgress: () => undefined,
  };
}

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
    const xhr = stubXhr({
      status: 200,
      responseText: JSON.stringify({
        path: "a.bin",
        size: 3,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        revision: "r1",
      }),
    });

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
    expect(xhr.sent).toEqual({
      url: "http://127.0.0.1:6767/api/files/update?token=tok-1",
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(result).toEqual({
      path: "a.bin",
      size: 3,
      modifiedAt: "2026-01-01T00:00:00.000Z",
      revision: "r1",
    });
  });

  test("reports upload progress when provided", async () => {
    const requestFileUpdateToken = vi.fn(async () => ({ token: "tok-1", error: null }));
    stubXhr({
      status: 200,
      responseText: JSON.stringify({ path: "a.bin", size: 1, modifiedAt: "t", revision: "r" }),
      progressEvents: [0.25, 0.75],
    });
    const progress: UploadProgress[] = [];

    await uploadExplorerFile({
      requestFileUpdateToken,
      baseUrl: "http://127.0.0.1:6767",
      path: "a.bin",
      fileName: "a.bin",
      bytes: new Uint8Array([1]),
      mimeType: "application/octet-stream",
      overwrite: false,
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toEqual([
      { percent: 0.25, bytesWritten: 0.25, totalBytes: 1 },
      { percent: 0.75, bytesWritten: 0.75, totalBytes: 1 },
    ]);
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
    stubXhr({
      status: 409,
      responseText: JSON.stringify({ error: "Target already exists" }),
    });

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
