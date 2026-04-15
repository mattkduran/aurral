import { dbOps } from "../config/db-helpers.js";
import { slskdClient } from "./slskdClient.js";
import { slskdTransferStore } from "./slskdTransferStore.js";

const DEFAULT_MAX_MATCHES = 25;

const normalizePath = (value) =>
  String(value || "")
    .replace(/\\/g, "/")
    .trim();

export class ExternalSlskdBackend {
  getConfig() {
    const settings = dbOps.getSettings();
    const integrations = settings.integrations?.slskd || {};
    return {
      downloadBackend: String(integrations.downloadBackend || "builtin"),
      finalizationMode: String(integrations.finalizationMode || "hardlink"),
      cleanupMode: String(integrations.cleanupMode || "none"),
      completeDir: String(integrations.completeDir || "").trim(),
    };
  }

  isEnabled() {
    return this.getConfig().downloadBackend === "external_slskd";
  }

  rankSearchResults(results = [], options = {}) {
    const desiredTrack = String(options.trackName || "").trim().toLowerCase();
    const preferredFormat = String(options.preferredFormat || "flac")
      .trim()
      .toLowerCase();
    const preferredExt = preferredFormat === "mp3" ? ".mp3" : ".flac";
    const fallbackExt = preferredFormat === "mp3" ? ".flac" : ".mp3";
    const limit = Number.isFinite(Number(options.limit))
      ? Math.max(1, Math.floor(Number(options.limit)))
      : DEFAULT_MAX_MATCHES;

    return [...results]
      .filter((result) => result?.username && result?.remotePath)
      .map((result, index) => {
        const normalizedPath = normalizePath(result.remotePath).toLowerCase();
        const ext = String(result.extension || "").toLowerCase();
        const titleHit = desiredTrack
          ? normalizedPath.includes(desiredTrack.toLowerCase())
          : false;
        const formatRank =
          ext === preferredExt ? 0 : ext === fallbackExt ? 1 : 2;
        const queueLength = Number.isFinite(result.queueLength)
          ? result.queueLength
          : Number.MAX_SAFE_INTEGER;
        const uploadSpeed = Number.isFinite(result.uploadSpeed)
          ? result.uploadSpeed
          : 0;
        return {
          result,
          score: [
            titleHit ? 0 : 1,
            formatRank,
            result.freeUploadSlots ? 0 : 1,
            queueLength,
            -uploadSpeed,
            index,
          ],
        };
      })
      .sort((a, b) => {
        for (let index = 0; index < a.score.length; index += 1) {
          if (a.score[index] !== b.score[index]) {
            return a.score[index] - b.score[index];
          }
        }
        return 0;
      })
      .slice(0, limit)
      .map((entry) => entry.result);
  }

  async searchTrack({ artistName, trackName, albumName = null, options = {} }) {
    const results = await slskdClient.searchTrack(artistName, trackName, {
      albumName,
      searchText: options.searchText,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      filterResponses: options.filterResponses,
      deleteSearch: options.deleteSearch,
      maximumPeerQueue: options.maximumPeerQueue,
      minimumPeerUploadSpeed: options.minimumPeerUploadSpeed,
    });

    return this.rankSearchResults(results, {
      trackName,
      preferredFormat: options.preferredFormat,
      limit: options.limit,
    });
  }

  async enqueueTrack({
    playlistType,
    playlistId = null,
    jobId,
    artistName,
    trackName,
    albumName = null,
    match,
    finalizeMode,
  }) {
    if (!match?.username || !match?.remotePath) {
      throw new Error("A normalized slskd match is required to enqueue");
    }

    const enqueueResult = await slskdClient.enqueueDownload({
      username: match.username,
      filename: match.remotePath,
      size: match.size,
    });
    const transfer = await slskdClient
      .getOrResolveDownload({
        username: enqueueResult.username,
        remotePath: enqueueResult.remotePath,
        size: enqueueResult.size,
        transferId: enqueueResult.transferIds?.[0] || null,
      })
      .catch(() => null);

    return slskdTransferStore.createFromEnqueue({
      playlistType,
      playlistId,
      jobId,
      artistName,
      trackName,
      albumName,
      match,
      enqueueResult,
      transfer,
      finalizeMode: finalizeMode || this.getConfig().finalizationMode,
    });
  }
}

export const externalSlskdBackend = new ExternalSlskdBackend();
