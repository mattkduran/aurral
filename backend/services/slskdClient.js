import axios from "axios";
import { dbOps } from "../config/db-helpers.js";

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
      url: String(dbConfig.url || process.env.SLSKD_URL || "").trim().replace(
        /\/+$/,
        "",
      ),
      apiKey: String(dbConfig.apiKey || process.env.SLSKD_API_KEY || "").trim(),
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
