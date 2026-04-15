import os from "os";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { dbOps } from "../config/db-helpers.js";

const getWeeklyFlowRoot = () => {
  const configured = process.env.WEEKLY_FLOW_FOLDER || "/app/downloads";
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(process.cwd(), configured);
};

const toErrorMessage = (error) =>
  error instanceof Error ? error.message : String(error || "Unknown error");

const ensureDirectory = async (targetPath) => {
  await fs.mkdir(targetPath, { recursive: true });
  const stat = await fs.stat(targetPath);
  if (!stat.isDirectory()) {
    throw new Error("Path exists but is not a directory");
  }
};

const cleanupFile = async (filePath) => {
  if (!filePath) return;
  await fs.rm(filePath, { force: true }).catch(() => {});
};

export async function validateSlskdFilesystem(overrides = {}) {
  const settings = dbOps.getSettings();
  const config = settings.integrations?.slskd || {};
  const completeDir = String(
    overrides.completeDir ?? config.completeDir ?? "",
  ).trim();
  const finalizationMode = String(
    overrides.finalizationMode ?? config.finalizationMode ?? "hardlink",
  )
    .trim()
    .toLowerCase();
  const weeklyFlowRoot = getWeeklyFlowRoot();
  const finalLibraryRoot = path.join(weeklyFlowRoot, "aurral-weekly-flow");

  const result = {
    valid: false,
    finalizationMode,
    weeklyFlowRoot,
    finalLibraryRoot,
    checks: {
      completeDir: {
        ok: false,
        path: completeDir || null,
        message: completeDir ? null : "Complete directory is not configured",
      },
      finalLibraryRoot: {
        ok: false,
        path: finalLibraryRoot,
        message: null,
      },
      hardlink: {
        ok: finalizationMode !== "hardlink",
        message:
          finalizationMode === "hardlink"
            ? "Hardlink validation not run yet"
            : "Hardlink validation not required in copy mode",
      },
    },
  };

  if (!completeDir) {
    result.checks.finalLibraryRoot.message = "Validation incomplete";
    return result;
  }

  try {
    await ensureDirectory(completeDir);
    result.checks.completeDir.ok = true;
    result.checks.completeDir.message = "Complete directory is accessible";
  } catch (error) {
    result.checks.completeDir.message = toErrorMessage(error);
  }

  try {
    await ensureDirectory(finalLibraryRoot);
    result.checks.finalLibraryRoot.ok = true;
    result.checks.finalLibraryRoot.message = "Final library root is writable";
  } catch (error) {
    result.checks.finalLibraryRoot.message = toErrorMessage(error);
  }

  if (
    finalizationMode === "hardlink" &&
    result.checks.completeDir.ok &&
    result.checks.finalLibraryRoot.ok
  ) {
    const token = `aurral-slskd-${Date.now()}-${randomUUID()}`;
    const sourcePath = path.join(completeDir, `${token}.tmp`);
    const targetPath = path.join(finalLibraryRoot, `${token}.tmp`);
    try {
      await fs.writeFile(sourcePath, `aurral slskd hardlink validation ${token}${os.EOL}`);
      await cleanupFile(targetPath);
      await fs.link(sourcePath, targetPath);
      result.checks.hardlink.ok = true;
      result.checks.hardlink.message =
        "Hardlink validation succeeded on the current filesystem";
    } catch (error) {
      result.checks.hardlink.ok = false;
      result.checks.hardlink.message = toErrorMessage(error);
    } finally {
      await cleanupFile(targetPath);
      await cleanupFile(sourcePath);
    }
  }

  result.valid =
    result.checks.completeDir.ok &&
    result.checks.finalLibraryRoot.ok &&
    result.checks.hardlink.ok;

  return result;
}
