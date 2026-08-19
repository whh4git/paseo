import { create } from "zustand";

export interface UploadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
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
  updateUploadProgress: (id: string, progress: UploadProgress) => void;
  completeUpload: (id: string) => void;
  failUpload: (id: string, message: string) => void;
  dismissUpload: (id: string) => void;
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
      const uploads = new Map(state.uploads);
      uploads.set(id, { ...upload, progress });
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
      uploads.set(id, { ...upload, status: "complete", progress: { percent: 1, bytesWritten: 0, totalBytes: 0 } });
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
}));
