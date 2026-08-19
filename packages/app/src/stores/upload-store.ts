import { create } from "zustand";

export interface UploadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

export interface Upload {
  id: string;
  fileName: string;
  status: "uploading" | "complete" | "error";
  message?: string;
  progress?: UploadProgress;
  startedAt: number;
}

interface UploadState {
  uploads: Map<string, Upload>;
  activeUploadId: string | null;

  startUpload: (fileName: string) => string;
  updateUploadProgress: (id: string, progress: Omit<UploadProgress, "speed" | "eta">) => void;
  completeUpload: (id: string) => void;
  failUpload: (id: string, message: string) => void;
  dismissUpload: (id: string) => void;
  dismissAllCompleted: () => void;
}

function generateUploadId(): string {
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useUploadStore = create<UploadState>()((set) => ({
  uploads: new Map(),
  activeUploadId: null,

  startUpload: (fileName) => {
    const id = generateUploadId();
    const upload: Upload = {
      id,
      fileName,
      status: "uploading",
      startedAt: Date.now(),
    };
    set((state) => {
      const uploads = new Map(state.uploads);
      uploads.set(id, upload);
      return { uploads, activeUploadId: id };
    });
    return id;
  },

  updateUploadProgress: (id, progress) => {
    set((state) => {
      const upload = state.uploads.get(id);
      if (!upload || upload.status !== "uploading") {
        return state;
      }
      const elapsed = (Date.now() - upload.startedAt) / 1000;
      const speed = elapsed > 0 ? progress.bytesWritten / elapsed : 0;
      const remaining = progress.totalBytes - progress.bytesWritten;
      const eta = speed > 0 ? remaining / speed : 0;
      const uploads = new Map(state.uploads);
      uploads.set(id, { ...upload, progress: { ...progress, speed, eta } });
      return { uploads };
    });
  },

  completeUpload: (id) => {
    set((state) => {
      const upload = state.uploads.get(id);
      if (!upload) {
        return state;
      }
      const uploads = new Map(state.uploads);
      uploads.set(id, { ...upload, status: "complete" });
      return { uploads };
    });
  },

  failUpload: (id, message) => {
    set((state) => {
      const upload = state.uploads.get(id);
      if (!upload) {
        return state;
      }
      const uploads = new Map(state.uploads);
      uploads.set(id, { ...upload, status: "error", message });
      return { uploads };
    });
  },

  dismissUpload: (id) => {
    set((state) => {
      const uploads = new Map(state.uploads);
      uploads.delete(id);
      const activeUploadId = state.activeUploadId === id ? null : state.activeUploadId;
      return { uploads, activeUploadId };
    });
  },

  dismissAllCompleted: () => {
    set((state) => {
      const uploads = new Map(state.uploads);
      for (const [id, upload] of uploads) {
        if (upload.status !== "uploading") {
          uploads.delete(id);
        }
      }
      const activeUploadId =
        state.activeUploadId && uploads.has(state.activeUploadId) ? state.activeUploadId : null;
      return { uploads, activeUploadId };
    });
  },
}));
