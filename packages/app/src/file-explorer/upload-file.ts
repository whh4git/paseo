import { i18n } from "@/i18n/i18next";

export function buildUpdateUrl(baseUrl: string, token: string): string {
  const url = new URL("/api/files/update", baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export interface UploadProgressEvent {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
}

/**
 * Uploads one file into a workspace through the token-gated HTTP endpoint:
 * the overwrite decision is sealed into the WS-issued token, then the raw
 * bytes are PUT to /api/files/update. Mirrors the download pipeline in
 * stores/download-store.ts. Progress is reported through XMLHttpRequest
 * because fetch has no upload progress events.
 */
export async function uploadExplorerFile(input: {
  requestFileUpdateToken: (
    path: string,
    overwrite: boolean,
  ) => Promise<{
    token: string | null;
    error: string | null;
  }>;
  baseUrl: string;
  path: string;
  fileName: string;
  bytes: Uint8Array;
  mimeType: string;
  overwrite: boolean;
  onProgress?: (progress: UploadProgressEvent) => void;
}): Promise<{ path: string; size: number; modifiedAt: string; revision: string }> {
  const tokenResponse = await input.requestFileUpdateToken(input.path, input.overwrite);
  if (tokenResponse.error || !tokenResponse.token) {
    throw new Error(tokenResponse.error ?? i18n.t("uploads.requestTokenFailed"));
  }

  const body = input.bytes;
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", buildUpdateUrl(input.baseUrl, tokenResponse.token as string));
    xhr.setRequestHeader("Content-Type", input.mimeType);
    xhr.responseType = "text";
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || !input.onProgress) {
        return;
      }
      input.onProgress({
        percent: event.total > 0 ? event.loaded / event.total : 0,
        bytesWritten: event.loaded,
        totalBytes: event.total,
      });
    });
    xhr.addEventListener("load", () => resolve({ status: xhr.status, body: xhr.responseText }));
    xhr.addEventListener("error", () => reject(new Error("Upload connection failed.")));
    xhr.addEventListener("abort", () => reject(new Error("Upload was aborted.")));
    xhr.send(body as unknown as BodyInit);
  });

  if (response.status < 200 || response.status >= 300) {
    const errorBody = (JSON.parse(response.body || "null") as { error?: string } | null) ?? null;
    throw new Error(errorBody?.error ?? `Upload failed (${response.status}).`);
  }

  return JSON.parse(response.body) as {
    path: string;
    size: number;
    modifiedAt: string;
    revision: string;
  };
}
