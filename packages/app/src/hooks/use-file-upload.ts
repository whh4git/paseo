import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useHosts } from "@/runtime/host-runtime";
import { resolveDaemonDownloadTarget } from "@/stores/download-store";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { uploadExplorerFile, type UploadProgressEvent } from "@/file-explorer/upload-file";

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
  onProgress?: (progress: UploadProgressEvent) => void;
}) => Promise<{ path: string; size: number; modifiedAt: string; revision: string }> {
  const daemons = useHosts();
  const { t } = useTranslation();
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
        throw new Error(t("uploads.workspaceUnavailable"));
      }
      const downloadTarget = resolveDaemonDownloadTarget(daemonProfile);
      if (!downloadTarget.baseUrl) {
        throw new Error(t("uploads.hostUnavailable"));
      }
      return uploadExplorerFile({
        requestFileUpdateToken: (path, overwrite) =>
          requestFileUpdateToken(path, overwrite).then(
            (payload) => ({ token: payload.token, error: payload.error }),
            (error: unknown) => ({
              token: null,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        baseUrl: downloadTarget.baseUrl,
        path: input.path,
        fileName: input.fileName,
        bytes: input.bytes,
        mimeType: input.mimeType,
        overwrite: input.overwrite,
        onProgress: input.onProgress,
      });
    },
    [daemonProfile, requestFileUpdateToken, t, workspaceScopeId],
  );
}
