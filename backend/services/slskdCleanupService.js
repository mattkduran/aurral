import fs from "fs/promises";
import { externalSlskdDownloadOps } from "../config/db-helpers.js";
import { slskdClient } from "./slskdClient.js";

const ACTIVE_STATES = new Set(["queued", "enqueued", "downloading", "completed", "finalized"]);

const fileExists = async (filePath) => {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const removeFileIfPresent = async (filePath) => {
  if (!filePath) return false;
  const existed = await fileExists(filePath);
  if (!existed) return false;
  await fs.rm(filePath, { force: true });
  return true;
};

export class SlskdCleanupService {
  _isLiveReference(entry) {
    return ACTIVE_STATES.has(String(entry?.backendState || "").trim().toLowerCase());
  }

  _getEntriesForSameSource(sourcePath, excludeId = null) {
    if (!sourcePath) return [];
    return externalSlskdDownloadOps
      .getAll()
      .filter((entry) => entry.id !== excludeId && entry.slskdLocalPath === sourcePath)
      .filter((entry) => this._isLiveReference(entry));
  }

  async cleanupManifestEntry(entry, options = {}) {
    if (!entry?.id) return null;
    const cleanupMode = String(options.cleanupMode || "none").trim().toLowerCase();
    const removedFinal = await removeFileIfPresent(entry.finalPath);
    let removedSource = false;
    let sourceCleanupSkipped = false;

    if (cleanupMode === "aurral_owned_safe_only" && entry.slskdLocalPath) {
      const otherRefs = this._getEntriesForSameSource(entry.slskdLocalPath, entry.id);
      if (otherRefs.length === 0) {
        removedSource = await removeFileIfPresent(entry.slskdLocalPath);
      } else {
        sourceCleanupSkipped = true;
      }
    } else {
      sourceCleanupSkipped = true;
    }

    if (entry.slskdUsername && entry.slskdTransferId) {
      await slskdClient
        .deleteDownload({
          username: entry.slskdUsername,
          transferId: entry.slskdTransferId,
        })
        .catch(() => {});
    }

    return externalSlskdDownloadOps.update(entry.id, {
      backendState: "cleaned",
      cleanedAt: new Date().toISOString(),
      lastError: sourceCleanupSkipped ? entry.lastError : null,
    }) && {
      removedFinal,
      removedSource,
      sourceCleanupSkipped,
    };
  }

  async cleanupPlaylist(playlistType, options = {}) {
    const entries = externalSlskdDownloadOps
      .getByPlaylistType(playlistType)
      .filter((entry) => String(entry.backendState || "").toLowerCase() !== "cleaned");
    const results = [];
    for (const entry of entries) {
      results.push({
        entryId: entry.id,
        jobId: entry.jobId,
        ...(await this.cleanupManifestEntry(entry, options)),
      });
    }
    return {
      playlistType,
      count: results.length,
      results,
    };
  }

  async cleanupJob(jobId, options = {}) {
    const entries = externalSlskdDownloadOps
      .getByJobId(jobId)
      .filter((entry) => String(entry.backendState || "").toLowerCase() !== "cleaned");
    const results = [];
    for (const entry of entries) {
      results.push({
        entryId: entry.id,
        ...(await this.cleanupManifestEntry(entry, options)),
      });
    }
    return {
      jobId,
      count: results.length,
      results,
    };
  }
}

export const slskdCleanupService = new SlskdCleanupService();
