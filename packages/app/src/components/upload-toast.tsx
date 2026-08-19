import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, X, XCircle } from "lucide-react-native";
import { useUploadStore, type Upload } from "@/stores/upload-store";
import { formatSpeed, formatEta } from "@/stores/download-store";
import { SPACING } from "@/styles/theme";
import type { Theme } from "@/styles/theme";

const AUTO_DISMISS_DELAY = 3000;

const primaryColorMapping = (theme: Theme) => ({ color: theme.colors.primary });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const ThemedXCircle = withUnistyles(XCircle);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

function getUploadStatusText(upload: Upload, t: ReturnType<typeof useTranslation>["t"]): string {
  if (upload.status === "uploading") {
    if (upload.progress) {
      return `${Math.round(upload.progress.percent * 100)}% · ${formatSpeed(upload.progress.speed)} · ${formatEta(upload.progress.eta)}`;
    }
    return t("uploads.uploading");
  }
  if (upload.status === "complete") return t("uploads.uploadComplete");
  return upload.message ?? t("uploads.uploadFailed");
}

export function UploadToast() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const uploads = useUploadStore((state) => state.uploads);
  const activeUploadId = useUploadStore((state) => state.activeUploadId);
  const dismissUpload = useUploadStore((state) => state.dismissUpload);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeUpload = activeUploadId ? uploads.get(activeUploadId) : null;

  useEffect(() => {
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
      dismissTimeoutRef.current = null;
    }

    if (activeUpload && activeUpload.status !== "uploading") {
      dismissTimeoutRef.current = setTimeout(() => {
        dismissUpload(activeUpload.id);
      }, AUTO_DISMISS_DELAY);
    }

    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, [activeUpload, dismissUpload]);

  const containerStyle = useMemo(
    () => [styles.container, { bottom: SPACING[4] + insets.bottom + 56 }],
    [insets.bottom],
  );

  const handleDismiss = useCallback(() => {
    if (activeUpload) {
      dismissUpload(activeUpload.id);
    }
  }, [activeUpload, dismissUpload]);

  if (!activeUpload) {
    return null;
  }

  return (
    <View style={containerStyle} pointerEvents="box-none">
      <View style={styles.toast}>
        {activeUpload.status === "uploading" ? (
          <ThemedLoadingSpinner size="small" uniProps={foregroundColorMapping} />
        ) : null}
        {activeUpload.status === "complete" ? (
          <ThemedCheck size={18} uniProps={primaryColorMapping} />
        ) : null}
        {activeUpload.status !== "uploading" && activeUpload.status !== "complete" ? (
          <ThemedXCircle size={18} uniProps={destructiveColorMapping} />
        ) : null}
        <View style={styles.textContainer}>
          <Text style={styles.fileName} numberOfLines={1}>
            {activeUpload.fileName}
          </Text>
          <Text style={styles.status}>{getUploadStatusText(activeUpload, t)}</Text>
          {activeUpload.status === "uploading" && activeUpload.progress && (
            <View style={styles.progressBar}>
              <ProgressFill percent={activeUpload.progress.percent} />
            </View>
          )}
        </View>
        {activeUpload.status !== "uploading" && (
          <Pressable onPress={handleDismiss} hitSlop={8} style={styles.dismiss}>
            <ThemedX size={16} uniProps={foregroundMutedColorMapping} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function ProgressFill({ percent }: { percent: number }) {
  const width: `${number}%` = `${Math.round(percent * 100)}%`;
  const fillStyle = useMemo(() => [styles.progressFill, { width }], [width]);
  return <View style={fillStyle} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    zIndex: 1000,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    ...theme.shadow.md,
  },
  textContainer: {
    flex: 1,
    gap: theme.spacing[1],
  },
  fileName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  progressBar: {
    height: 3,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    marginTop: theme.spacing[1],
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius.full,
  },
  dismiss: {
    padding: theme.spacing[1],
  },
}));
