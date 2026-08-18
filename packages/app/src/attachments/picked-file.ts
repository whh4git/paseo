import { getFileExtension } from "@/attachments/file-types";
import { copyDesktopAttachmentFile } from "@/desktop/attachments/desktop-file-commands";
import { readDesktopFileBase64 } from "@/desktop/attachments/desktop-preview-url";

export interface PickedFile {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** Extracts the base file name from a platform file path (POSIX or Windows). */
export function baseNameFromPath(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts.pop() || filePath;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function readDesktopFileBytes(path: string): Promise<Uint8Array> {
  const { path: managedPath } = await copyDesktopAttachmentFile({
    attachmentId: crypto.randomUUID(),
    sourcePath: path,
    extension: getFileExtension(path) || null,
  });
  const base64 = await readDesktopFileBase64(managedPath);
  return base64ToUint8Array(base64);
}
