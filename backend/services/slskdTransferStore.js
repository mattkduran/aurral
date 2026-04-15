import { randomUUID } from "crypto";
import { dbOps, externalSlskdDownloadOps } from "../config/db-helpers.js";
import { slskdClient } from "./slskdClient.js";

const VALID_FINALIZE_MODES = new Set(["hardlink", "copy"]);

const normalizeText = (value) => {
  const text = String(value || "").trim();
  return text || null;
};

const normalizeFinalizeMode = (value) => {
  const normalized = String(value || "hardlink")
    .trim()
    .toLowerCase();
  return VALID_FINALIZE_MODES.has(normalized) ? normalized : "hardlink";
};

const getDefaultFinalizeMode = () => {
  const settings = dbOps.getSettings();
  const configured = String(
    settings.integrations?.slskd?.finalizationMode || "hardlink",
  )
    .trim()
    .toLowerCase();
  return VALID_FINALIZE_MODES.has(configured) ? configured : "hardlink";
};

export class SlskdTransferStore {
  getAll() {
    return externalSlskdDownloadOps.getAll();
  }

  getById(id) {
    return externalSlskdDownloadOps.getById(id);
  }

  getByTransferId(transferId) {
    return externalSlskdDownloadOps.getByTransferId(transferId);
  }

  getByBackendState(state) {
    return externalSlskdDownloadOps.getByBackendState(state);
  }

  createQueuedDownload({
    playlistType,
    playlistId = null,
    jobId,
    artistName,
    trackName,
    albumName = null,
    username,
    remotePath,
    remoteSize = null,
    transferId = null,
    transferState = null,
    localPath = null,
    localRelativePath = null,
    finalPath = null,
    finalizeMode = "hardlink",
    backendState = "enqueued",
    lastError = null,
  }) {
    const entry = {
      id: randomUUID(),
      playlistType: normalizeText(playlistType),
      playlistId: normalizeText(playlistId),
      jobId: normalizeText(jobId),
      artistName: normalizeText(artistName),
      trackName: normalizeText(trackName),
      albumName: normalizeText(albumName),
      slskdUsername: normalizeText(username),
      remotePath: normalizeText(remotePath),
      remoteSize,
      slskdTransferId: normalizeText(transferId),
      slskdState: normalizeText(transferState),
      localRelativePath: normalizeText(localRelativePath),
      slskdLocalPath: normalizeText(localPath),
      finalPath: normalizeText(finalPath),
      finalizeMode: normalizeFinalizeMode(
        finalizeMode || getDefaultFinalizeMode(),
      ),
      backendState: normalizeText(backendState) || "enqueued",
      retryCount: 0,
      lastError: normalizeText(lastError),
      enqueuedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return externalSlskdDownloadOps.insert(entry);
  }

  createFromEnqueue({
    playlistType,
    playlistId = null,
    jobId,
    artistName,
    trackName,
    albumName = null,
    match,
    enqueueResult,
    transfer = null,
    finalizeMode = "hardlink",
  }) {
    const username =
      transfer?.username || enqueueResult?.username || match?.username;
    const remotePath =
      transfer?.remotePath ||
      enqueueResult?.remotePath ||
      match?.remotePath ||
      match?.file;
    const remoteSize =
      transfer?.size ?? enqueueResult?.size ?? match?.size ?? null;
    const resolvedTransferId =
      transfer?.id ||
      enqueueResult?.transferIds?.[0] ||
      enqueueResult?.transferId ||
      null;
    const resolvedLocalPath =
      transfer?.localPath ||
      slskdClient.buildExpectedLocalPath({ username, remotePath });

    return this.createQueuedDownload({
      playlistType,
      playlistId,
      jobId,
      artistName,
      trackName,
      albumName,
      username,
      remotePath,
      remoteSize,
      transferId: resolvedTransferId,
      transferState: transfer?.state || null,
      localPath: resolvedLocalPath,
      finalizeMode,
      backendState: transfer?.isComplete
        ? "completed"
        : transfer?.isActive
          ? "downloading"
          : "enqueued",
    });
  }

  markState(id, backendState, changes = {}) {
    return externalSlskdDownloadOps.update(id, {
      backendState,
      ...changes,
    });
  }

  syncTransfer(id, transfer, changes = {}) {
    if (!transfer) return this.getById(id);
    const nextBackendState = transfer.isComplete
      ? "completed"
      : transfer.isFailed
        ? "failed"
        : transfer.isActive
          ? "downloading"
          : changes.backendState || "enqueued";
    return externalSlskdDownloadOps.update(id, {
      backendState: nextBackendState,
      slskdTransferId: transfer.id || null,
      slskdState: transfer.state || null,
      slskdLocalPath: transfer.localPath || undefined,
      completedAt: transfer.isComplete
        ? changes.completedAt || new Date().toISOString()
        : changes.completedAt,
      lastError: transfer.error || changes.lastError || null,
      ...changes,
    });
  }
}

export const slskdTransferStore = new SlskdTransferStore();
