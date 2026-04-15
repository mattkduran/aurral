import axios from "axios";
import path from "path";
import { randomUUID } from "crypto";
import { dbOps } from "../config/db-helpers.js";

const DEFAULT_SEARCH_TIMEOUT_MS = 15000;
const DEFAULT_SEARCH_POLL_INTERVAL_MS = 1000;
const SEARCH_STATES_DONE = new Set([
  "completed",
  "complete",
  "responded",
  "finished",
  "done",
]);
const SEARCH_STATES_FAILED = new Set([
  "failed",
  "cancelled",
  "canceled",
  "error",
]);
const TRANSFER_STATES_ACTIVE = new Set([
  "queued",
  "requested",
  "inprogress",
  "downloading",
  "initializing",
]);
const TRANSFER_STATES_DONE = new Set([
  "completed",
  "succeeded",
  "finished",
  "done",
]);
const TRANSFER_STATES_FAILED = new Set([
  "failed",
  "errored",
  "timedout",
  "cancelled",
  "canceled",
  "rejected",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeState = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

const normalizeSlskdPath = (value) =>
  String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();

const firstNonEmptyString = (...values) => {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
};

export class SlskdClient {
  constructor() {
    this.config = null;
    this.updateConfig();
  }

  updateConfig() {
    const settings = dbOps.getSettings();
    const dbConfig = settings.integrations?.slskd || {};
    const envTimeoutMs = Number(process.env.SLSKD_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(envTimeoutMs) && envTimeoutMs > 0 ? envTimeoutMs : 15000;

    this.config = {
      url: String(dbConfig.url || process.env.SLSKD_URL || "")
        .trim()
        .replace(/\/+$/, ""),
      apiKey: String(dbConfig.apiKey || process.env.SLSKD_API_KEY || "").trim(),
      completeDir: String(dbConfig.completeDir || "").trim(),
      timeoutMs,
    };
  }

  getConfig() {
    this.updateConfig();
    return this.config;
  }

  isConfigured() {
    return !!(this.config?.url && this.config?.apiKey);
  }

  buildSearchQuery(artistName, trackName, options = {}) {
    const parts = [];
    const artist = String(artistName || "").trim();
    const track = String(trackName || "").trim();
    const album = String(options.albumName || "").trim();

    if (options.prependArtist !== false && artist) {
      parts.push(artist);
    }
    if (track) {
      parts.push(track);
    }
    if (!track && artist) {
      parts.push(artist);
    }
    if (options.includeAlbum === true && album) {
      parts.push(album);
    }
    return parts.join(" ").trim();
  }

  async request(pathname, options = {}) {
    const skipConfigUpdate = options.skipConfigUpdate === true;
    if (!skipConfigUpdate) {
      this.updateConfig();
    }
    if (!this.isConfigured()) {
      throw new Error("slskd is not configured");
    }

    const url = `${this.config.url}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
    try {
      const response = await axios({
        method: options.method || "GET",
        url,
        data: options.data,
        timeout: this.config.timeoutMs,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-API-Key": this.config.apiKey,
          ...(options.headers || {}),
        },
      });
      return response.data;
    } catch (error) {
      if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error("slskd API authentication failed. Check your API key.");
      }
      if (error.response) {
        const responseData = error.response.data;
        const message =
          responseData?.message ||
          responseData?.error ||
          (typeof responseData === "string" ? responseData : null) ||
          error.message;
        throw new Error(
          `slskd API error: ${error.response.status}${message ? ` - ${message}` : ""}`,
        );
      }
      if (error.request) {
        throw new Error(
          `Cannot connect to slskd at ${this.config.url}. Check if slskd is running and the URL is correct.`,
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  normalizeSearchResult(result) {
    const remotePath = firstNonEmptyString(
      result?.filename,
      result?.fileName,
      result?.path,
      result?.file,
    );
    const extension = path.extname(remotePath).toLowerCase();
    const state = normalizeState(result?.state);
    const uploadSpeed = Number(
      result?.uploadSpeed ?? result?.speed ?? result?.averageSpeed ?? 0,
    );
    const queueLength = Number(
      result?.queueLength ?? result?.queuePosition ?? result?.queue ?? 0,
    );

    return {
      id: firstNonEmptyString(result?.id, result?.token),
      username: firstNonEmptyString(result?.username, result?.user),
      remotePath,
      file: remotePath,
      extension,
      size:
        result?.size == null || result.size === ""
          ? null
          : Number.parseInt(result.size, 10),
      bitrate:
        result?.bitRate == null && result?.bitrate == null
          ? null
          : Number.parseInt(result?.bitRate ?? result?.bitrate, 10),
      sampleRate:
        result?.sampleRate == null && result?.samplerate == null
          ? null
          : Number.parseInt(result?.sampleRate ?? result?.samplerate, 10),
      bitDepth:
        result?.bitDepth == null && result?.bitdepth == null
          ? null
          : Number.parseInt(result?.bitDepth ?? result?.bitdepth, 10),
      freeUploadSlots: Boolean(
        result?.hasFreeUploadSlot ?? result?.freeUploadSlot ?? false,
      ),
      queueLength: Number.isFinite(queueLength) ? queueLength : 0,
      uploadSpeed: Number.isFinite(uploadSpeed) ? uploadSpeed : 0,
      state,
      raw: result,
    };
  }

  normalizeSearch(search) {
    const state = normalizeState(search?.state);
    const responseGroups = Array.isArray(search?.responses)
      ? search.responses
      : Array.isArray(search?.results)
        ? search.results
        : [];
    const flattenedResults = [];

    for (const group of responseGroups) {
      if (Array.isArray(group)) {
        flattenedResults.push(
          ...group.map((entry) => this.normalizeSearchResult(entry)),
        );
        continue;
      }
      const files = Array.isArray(group?.files)
        ? group.files
        : Array.isArray(group?.results)
          ? group.results
          : group?.filename || group?.file || group?.path
            ? [group]
            : [];
      if (files.length > 0) {
        const username = firstNonEmptyString(group?.username, group?.user);
        for (const file of files) {
          flattenedResults.push(
            this.normalizeSearchResult({
              ...file,
              username: file?.username ?? username,
            }),
          );
        }
      }
    }

    return {
      id: firstNonEmptyString(search?.id, search?.token),
      searchText: firstNonEmptyString(search?.searchText, search?.query),
      state,
      isComplete: SEARCH_STATES_DONE.has(state),
      isFailed: SEARCH_STATES_FAILED.has(state),
      resultCount:
        Number(search?.resultCount) ||
        Number(search?.fileCount) ||
        flattenedResults.length,
      results: flattenedResults.filter(
        (entry) => entry.username && entry.remotePath,
      ),
      raw: search,
    };
  }

  async startSearch(searchText, options = {}) {
    const normalizedText = String(searchText || "").trim();
    if (!normalizedText) {
      throw new Error("Search text is required");
    }
    const payload = {
      id: String(options.id || randomUUID()),
      searchText: normalizedText,
      filterResponses: options.filterResponses !== false,
    };
    if (Number.isFinite(Number(options.maximumPeerQueue))) {
      payload.maximumPeerQueue = Math.max(
        0,
        Math.floor(Number(options.maximumPeerQueue)),
      );
    }
    if (Number.isFinite(Number(options.minimumPeerUploadSpeed))) {
      payload.minimumPeerUploadSpeed = Math.max(
        0,
        Math.floor(Number(options.minimumPeerUploadSpeed)),
      );
    }

    const response = await this.request("/api/v0/searches", {
      method: "POST",
      data: payload,
    });
    return this.normalizeSearch(response);
  }

  async getSearch(searchId) {
    if (!searchId) {
      throw new Error("Search ID is required");
    }
    const response = await this.request(
      `/api/v0/searches/${encodeURIComponent(searchId)}`,
    );
    return this.normalizeSearch(response);
  }

  async deleteSearch(searchId) {
    if (!searchId) return null;
    try {
      return await this.request(
        `/api/v0/searches/${encodeURIComponent(searchId)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (/404/.test(String(error?.message || ""))) {
        return null;
      }
      throw error;
    }
  }

  async waitForSearch(searchId, options = {}) {
    const timeoutMs =
      Number.isFinite(Number(options.timeoutMs)) &&
      Number(options.timeoutMs) > 0
        ? Number(options.timeoutMs)
        : DEFAULT_SEARCH_TIMEOUT_MS;
    const pollIntervalMs =
      Number.isFinite(Number(options.pollIntervalMs)) &&
      Number(options.pollIntervalMs) > 0
        ? Number(options.pollIntervalMs)
        : DEFAULT_SEARCH_POLL_INTERVAL_MS;
    const startedAt = Date.now();
    let lastSearch = null;

    while (Date.now() - startedAt <= timeoutMs) {
      lastSearch = await this.getSearch(searchId);
      if (lastSearch.isComplete || lastSearch.results.length > 0) {
        return lastSearch;
      }
      if (lastSearch.isFailed) {
        throw new Error(
          `slskd search failed${lastSearch.state ? `: ${lastSearch.state}` : ""}`,
        );
      }
      await sleep(pollIntervalMs);
    }

    throw new Error(
      `slskd search timed out after ${Math.ceil(timeoutMs / 1000)} seconds`,
    );
  }

  async searchTrack(artistName, trackName, options = {}) {
    const searchText =
      options.searchText ||
      this.buildSearchQuery(artistName, trackName, options);
    const search = await this.startSearch(searchText, options);
    const completed = await this.waitForSearch(search.id, options);
    if (options.deleteSearch !== false) {
      await this.deleteSearch(search.id).catch(() => {});
    }
    return completed.results;
  }

  normalizeTransfer(transfer) {
    const remotePath = firstNonEmptyString(
      transfer?.requestedFilename,
      transfer?.filename,
      transfer?.fileName,
      transfer?.remoteFilename,
      transfer?.remotePath,
      transfer?.path,
    );
    const username = firstNonEmptyString(transfer?.username, transfer?.user);
    const localPath = firstNonEmptyString(
      transfer?.localFilename,
      transfer?.localPath,
      transfer?.downloadPath,
      transfer?.filePath,
    );
    const state = normalizeState(transfer?.state);

    return {
      id: firstNonEmptyString(transfer?.id, transfer?.transferId),
      username,
      remotePath,
      localPath,
      size:
        transfer?.size == null || transfer.size === ""
          ? null
          : Number.parseInt(transfer.size, 10),
      bytesTransferred:
        transfer?.bytesTransferred == null && transfer?.bytesReceived == null
          ? null
          : Number.parseInt(
              transfer?.bytesTransferred ?? transfer?.bytesReceived,
              10,
            ),
      state,
      isActive: TRANSFER_STATES_ACTIVE.has(state),
      isComplete: TRANSFER_STATES_DONE.has(state),
      isFailed: TRANSFER_STATES_FAILED.has(state),
      error: firstNonEmptyString(
        transfer?.errorMessage,
        transfer?.statusMessage,
        transfer?.error,
      ),
      raw: transfer,
    };
  }

  async listDownloads(username) {
    if (!username) {
      throw new Error("Username is required");
    }
    const response = await this.request(
      `/api/v0/transfers/downloads/${encodeURIComponent(username)}`,
    );
    return (Array.isArray(response) ? response : []).map((entry) =>
      this.normalizeTransfer(entry),
    );
  }

  async getAllDownloads() {
    const response = await this.request("/api/v0/transfers/downloads");
    return (Array.isArray(response) ? response : []).map((entry) =>
      this.normalizeTransfer(entry),
    );
  }

  async deleteDownload({ username, transferId }) {
    const normalizedUsername = String(username || "").trim();
    const normalizedTransferId = String(transferId || "").trim();
    if (!normalizedUsername || !normalizedTransferId) {
      return null;
    }
    try {
      return await this.request(
        `/api/v0/transfers/downloads/${encodeURIComponent(normalizedUsername)}/${encodeURIComponent(normalizedTransferId)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (/404/.test(String(error?.message || ""))) {
        return null;
      }
      throw error;
    }
  }

  async enqueueDownload({ username, filename, size }) {
    const normalizedUsername = String(username || "").trim();
    const normalizedFilename = String(filename || "").trim();
    if (!normalizedUsername || !normalizedFilename) {
      throw new Error(
        "Username and filename are required to enqueue a download",
      );
    }

    const payload = [
      {
        filename: normalizedFilename,
        ...(size == null || size === ""
          ? {}
          : { size: Number.parseInt(size, 10) }),
      },
    ];

    const response = await this.request(
      `/api/v0/transfers/downloads/${encodeURIComponent(normalizedUsername)}`,
      {
        method: "POST",
        data: payload,
      },
    );

    const transferIds = Array.isArray(response)
      ? response.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    return {
      username: normalizedUsername,
      remotePath: normalizedFilename,
      size: size == null || size === "" ? null : Number.parseInt(size, 10),
      transferIds,
      raw: response,
    };
  }

  async findDownload({ username, remotePath, size, transferId }) {
    const transfers = await this.listDownloads(username);
    const normalizedTransferId = String(transferId || "").trim();
    const normalizedRemotePath = normalizeSlskdPath(remotePath);
    const parsedSize =
      size == null || size === "" ? null : Number.parseInt(size, 10);

    if (normalizedTransferId) {
      const byId = transfers.find((entry) => entry.id === normalizedTransferId);
      if (byId) return byId;
    }

    return (
      transfers.find((entry) => {
        const samePath =
          normalizeSlskdPath(entry.remotePath) === normalizedRemotePath;
        const sameSize =
          parsedSize == null || entry.size == null || entry.size === parsedSize;
        return samePath && sameSize;
      }) || null
    );
  }

  async getOrResolveDownload(match) {
    const transfer = await this.findDownload(match);
    if (transfer) return transfer;
    throw new Error("Unable to resolve newly enqueued slskd transfer");
  }

  async waitForDownload(match, options = {}) {
    const timeoutMs =
      Number.isFinite(Number(options.timeoutMs)) &&
      Number(options.timeoutMs) > 0
        ? Number(options.timeoutMs)
        : 20 * 60 * 1000;
    const pollIntervalMs =
      Number.isFinite(Number(options.pollIntervalMs)) &&
      Number(options.pollIntervalMs) > 0
        ? Number(options.pollIntervalMs)
        : DEFAULT_SEARCH_POLL_INTERVAL_MS;
    const startedAt = Date.now();
    let lastTransfer = null;

    while (Date.now() - startedAt <= timeoutMs) {
      lastTransfer = await this.findDownload(match);
      if (lastTransfer) {
        if (
          typeof options.onProgress === "function" &&
          Number.isFinite(lastTransfer.bytesTransferred) &&
          Number.isFinite(lastTransfer.size) &&
          lastTransfer.size > 0
        ) {
          const progressPct = Math.max(
            0,
            Math.min(
              100,
              Math.round(
                (lastTransfer.bytesTransferred / lastTransfer.size) * 100,
              ),
            ),
          );
          options.onProgress(progressPct, lastTransfer);
        }
        if (lastTransfer.isFailed) {
          throw new Error(
            lastTransfer.error ||
              `slskd transfer failed${lastTransfer.state ? `: ${lastTransfer.state}` : ""}`,
          );
        }
        if (lastTransfer.isComplete) {
          return {
            ...lastTransfer,
            localPath:
              lastTransfer.localPath ||
              this.buildExpectedLocalPath({
                username: lastTransfer.username,
                remotePath: lastTransfer.remotePath,
              }),
          };
        }
      }
      await sleep(pollIntervalMs);
    }

    throw new Error(
      `slskd download timed out after ${Math.ceil(timeoutMs / 1000)} seconds`,
    );
  }

  buildExpectedLocalPath({ username, remotePath }) {
    const completeDir = String(this.config?.completeDir || "").trim();
    if (!completeDir) {
      return null;
    }
    const normalizedUsername = String(username || "").trim();
    const normalizedRemotePath = normalizeSlskdPath(remotePath);
    if (!normalizedUsername || !normalizedRemotePath) {
      return null;
    }
    return path.join(completeDir, normalizedUsername, normalizedRemotePath);
  }

  async testConnection(skipConfigUpdate = false) {
    if (!skipConfigUpdate) {
      this.updateConfig();
    }
    if (!this.isConfigured()) {
      return { connected: false, error: "slskd not configured" };
    }

    const candidates = ["/api/v0/application", "/api/v0/options"];
    let lastError = null;
    for (const pathname of candidates) {
      try {
        const data = await this.request(pathname, { skipConfigUpdate: true });
        return {
          connected: true,
          instanceName: "slskd",
          apiPath: pathname,
          version:
            data?.version ||
            data?.applicationVersion ||
            data?.semanticVersion ||
            "connected",
        };
      } catch (error) {
        lastError = error;
      }
    }

    return {
      connected: false,
      error: lastError?.message || "Failed to connect to slskd",
      url: this.config.url,
    };
  }
}

export const slskdClient = new SlskdClient();
