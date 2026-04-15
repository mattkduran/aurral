import fs from "fs/promises";
import path from "path";
import { dbOps } from "../config/db-helpers.js";
import { soulseekClient } from "./simpleSoulseekClient.js";
import { externalSlskdBackend } from "./externalSlskdBackend.js";
import { slskdClient } from "./slskdClient.js";

const SUPPORTED_EXTENSIONS = /\.(flac|mp3|m4a|ogg|wav)$/i;

const getExtensionFromMatch = (match) => {
  const rawPath =
    String(match?.file || match?.remotePath || match?.localPath || "").trim();
  const ext = path.extname(rawPath).toLowerCase();
  return SUPPORTED_EXTENSIONS.test(ext) ? ext : ".mp3";
};

class BuiltinSoulseekDownloadBackend {
  get name() {
    return "builtin";
  }

  async disconnect() {
    await soulseekClient.disconnect();
  }

  async search(job, options = {}) {
    return soulseekClient.search(job.artistName, job.trackName, {
      forceFresh: options.forceFresh === true,
    });
  }

  rankCandidates(results, trackName, limit) {
    return soulseekClient.pickBestMatches(results, trackName, limit);
  }

  async acquireCandidate(candidate, context = {}) {
    const sourcePath = await soulseekClient.download(
      candidate,
      context.stagingFilePath,
      context.onProgress,
      {
        queuedTimeoutMs: context.queuedTimeoutMs,
      },
    );

    return {
      selectedMatch: candidate,
      sourcePath,
      selectedExt: getExtensionFromMatch(candidate),
    };
  }

  async finalizeDownload({ sourcePath, finalDir, finalPath }) {
    await fs.mkdir(finalDir, { recursive: true });
    await fs.rename(sourcePath, finalPath);
    return { finalPath };
  }
}

class ExternalSlskdDownloadBackend {
  get name() {
    return "external_slskd";
  }

  async disconnect() {
    return null;
  }

  async search(job, options = {}) {
    return externalSlskdBackend.searchTrack({
      artistName: job.artistName,
      trackName: job.trackName,
      albumName: job.albumName,
      options: {
        preferredFormat: options.preferredFormat,
        limit: options.limit,
        timeoutMs: options.searchTimeoutMs,
        pollIntervalMs: options.searchPollIntervalMs,
      },
    });
  }

  rankCandidates(results, trackName, limit, options = {}) {
    return externalSlskdBackend.rankSearchResults(results, {
      trackName,
      preferredFormat: options.preferredFormat,
      limit,
    });
  }

  async acquireCandidate(candidate, context = {}) {
    return externalSlskdBackend.acquireTrack({
      playlistType: context.job?.playlistType,
      playlistId: context.job?.playlistId || null,
      jobId: context.job?.id,
      artistName: context.job?.artistName,
      trackName: context.job?.trackName,
      albumName: context.job?.albumName || null,
      match: candidate,
      onProgress: context.onProgress,
      timeoutMs: context.transferTimeoutMs,
      pollIntervalMs: context.transferPollIntervalMs,
    });
  }

  async finalizeDownload({ sourcePath, finalDir, finalPath, match }) {
    const { finalizationMode } = externalSlskdBackend.getConfig();
    await fs.mkdir(finalDir, { recursive: true });
    await fs.rm(finalPath, { force: true }).catch(() => {});
    if (finalizationMode === "copy") {
      await fs.copyFile(sourcePath, finalPath);
    } else {
      try {
        await fs.link(sourcePath, finalPath);
      } catch (error) {
        if (error?.code === "EXDEV") {
          throw new Error(
            "Hardlink finalization failed across filesystems. Switch external slskd finalization mode to copy or mount both paths on the same filesystem.",
          );
        }
        throw error;
      }
    }
    return {
      finalPath,
      sourcePath,
      selectedMatch: match,
    };
  }
}

const builtinBackend = new BuiltinSoulseekDownloadBackend();
const externalBackend = new ExternalSlskdDownloadBackend();

export const getWeeklyFlowDownloadBackendName = () => {
  const settings = dbOps.getSettings();
  return String(settings.integrations?.slskd?.downloadBackend || "builtin")
    .trim()
    .toLowerCase();
};

export const getWeeklyFlowDownloadBackend = () => {
  const backend = getWeeklyFlowDownloadBackendName();

  if (backend === "external_slskd") {
    return externalBackend;
  }
  return builtinBackend;
};

export const getWeeklyFlowDownloadBackendStatus = () => {
  const backend = getWeeklyFlowDownloadBackendName();
  if (backend === "external_slskd") {
    const config = externalSlskdBackend.getConfig();
    const configured =
      slskdClient.isConfigured() && !!String(config.completeDir || "").trim();
    return {
      name: backend,
      configured,
      error: configured
        ? null
        : "External slskd requires URL, API key, and complete directory configuration",
    };
  }

  const configured = soulseekClient.isConfigured();
  return {
    name: backend,
    configured,
    error: configured ? null : "Soulseek credentials not configured",
  };
};
