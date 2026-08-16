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
}): Promise<{ path: string; size: number; modifiedAt: string; revision: string }> {
  const tokenResponse = await input.requestFileUpdateToken(input.path, input.overwrite);
  if (tokenResponse.error || !tokenResponse.token) {
    throw new Error(tokenResponse.error ?? "Failed to request upload token.");
  }

  const response = await fetch(buildUpdateUrl(input.baseUrl, tokenResponse.token), {
    method: "PUT",
    headers: { "Content-Type": input.mimeType },
    body: input.bytes as unknown as ArrayBufferView<ArrayBuffer>,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Upload failed (${response.status}).`);
  }

  return (await response.json()) as {
    path: string;
    size: number;
    modifiedAt: string;
    revision: string;
  };
}
