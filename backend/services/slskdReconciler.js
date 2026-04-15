import fs from "fs/promises";
import path from "path";
import { externalSlskdDownloadOps } from "../config/db-helpers.js";
import { downloadTracker } from "./weeklyFlowDownloadTracker.js";
import { slskdClient } from "./slskdClient.js";

const fileExists = async (filePath) => {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
};

const getExtension = (filePath) => {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return ext || ".mp3";
};

export class SlskdReconciler {
  async reconcileEntry(entry) {
    if (!entry?.id) return null;
    const currentState = String(entry.backendState || "")
      .trim()
      .toLowerCase();
    const finalExists = await fileExists(entry.finalPath);
    const sourceExists = await fileExists(entry.slskdLocalPath);

    if (currentState === "cleaned") {
      return { entryId: entry.id, state: currentState, action: "ignored" };
    }

    if (currentState === "finalized" && finalExists) {
      const job = downloadTracker.getJob(entry.jobId);
      if (job && job.status !== "done") {
        downloadTracker.setDone(
          job.id,
          entry.finalPath,
          entry.albumName || null,
        );
      }
      return {
        entryId: entry.id,
        state: "finalized",
        action: "restored-finalized",
      };
    }

    if (currentState === "finalized" && !finalExists && sourceExists) {
      externalSlskdDownloadOps.update(entry.id, {
        backendState: "completed",
        finalizedAt: null,
      });
      return {
        entryId: entry.id,
        state: "completed",
        action: "downgraded-to-completed",
      };
    }

    if (
      sourceExists &&
      (currentState === "completed" ||
        currentState === "downloading" ||
        currentState === "enqueued")
    ) {
      let transfer = null;
      try {
        transfer = await slskdClient.findDownload({
          username: entry.slskdUsername,
          remotePath: entry.remotePath,
          size: entry.remoteSize,
          transferId: entry.slskdTransferId,
        });
      } catch {}

      if (transfer) {
        const nextState = transfer.isComplete
          ? "completed"
          : transfer.isFailed
            ? "failed"
            : transfer.isActive
              ? "downloading"
              : currentState;
        externalSlskdDownloadOps.update(entry.id, {
          backendState: nextState,
          slskdTransferId: transfer.id || entry.slskdTransferId,
          slskdState: transfer.state || entry.slskdState,
          slskdLocalPath:
            transfer.localPath ||
            entry.slskdLocalPath ||
            slskdClient.buildExpectedLocalPath(transfer),
          lastError: transfer.error || entry.lastError,
          completedAt:
            transfer.isComplete && !entry.completedAt
              ? new Date().toISOString()
              : entry.completedAt,
        });
        return {
          entryId: entry.id,
          state: nextState,
          action: "synced-transfer",
        };
      }

      if (sourceExists) {
        externalSlskdDownloadOps.update(entry.id, {
          backendState: "completed",
          completedAt: entry.completedAt || new Date().toISOString(),
        });
        return {
          entryId: entry.id,
          state: "completed",
          action: "confirmed-source",
        };
      }
    }

    if (
      !sourceExists &&
      !finalExists &&
      (currentState === "completed" || currentState === "finalized")
    ) {
      externalSlskdDownloadOps.update(entry.id, {
        backendState: "failed",
        lastError:
          entry.lastError ||
          "Tracked slskd file is missing during reconciliation",
      });
      return { entryId: entry.id, state: "failed", action: "marked-missing" };
    }

    return { entryId: entry.id, state: currentState, action: "no-change" };
  }

  async reconcileAll() {
    const entries = externalSlskdDownloadOps
      .getAll()
      .filter(
        (entry) => String(entry.backendState || "").toLowerCase() !== "cleaned",
      );
    const results = [];
    for (const entry of entries) {
      results.push(await this.reconcileEntry(entry));
    }
    return {
      count: results.length,
      results,
    };
  }

  getReusableDownloadForJob(jobId) {
    const entries = externalSlskdDownloadOps
      .getByJobId(jobId)
      .filter(
        (entry) => String(entry.backendState || "").toLowerCase() !== "cleaned",
      )
      .sort((a, b) =>
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
      );
    return entries[0] || null;
  }

  async buildReusableAcquisition(jobId) {
    const entry = this.getReusableDownloadForJob(jobId);
    if (!entry) return null;

    if (String(entry.backendState || "").toLowerCase() === "finalized") {
      const finalExists = await fileExists(entry.finalPath);
      if (finalExists) {
        return {
          manifestRow: entry,
          selectedMatch: {
            remotePath: entry.remotePath,
            file: entry.remotePath,
          },
          sourcePath: entry.finalPath,
          finalPath: entry.finalPath,
          selectedExt: getExtension(entry.finalPath),
          resolvedAlbum: entry.albumName || null,
          alreadyFinalized: true,
        };
      }
    }

    if (
      ["enqueued", "downloading", "completed"].includes(
        String(entry.backendState || "").toLowerCase(),
      )
    ) {
      return entry;
    }

    return null;
  }
}

export const slskdReconciler = new SlskdReconciler();
