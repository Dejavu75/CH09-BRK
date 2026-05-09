import "dotenv/config";

import { execFile } from "child_process";
import { promisify } from "util";

import { log, warn } from "../utils/logger";

const AGES_BASE_URL = process.env.HAAGES ?? "http://localhost/ages";
const ASP_NET_SESSION_COOKIE = "ASP.NET_SessionId";
const AGES_TOKEN_HEADER = "AGES_TOKEN";
const WARMUP_TIMEOUT_MS = 50_000;
const WARMUP_MAX_ATTEMPTS = 2;
const PING_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MINI_SLOTS = 5;
const DEFAULT_BIGB_SLOTS = 5;
const ERROR_DEBUG_DETAILS = isConfigEnabled("ERROR_DEBUG_DETAILS", true);
const AGES_SSH_HOST = process.env.AGES_SSH_HOST ?? getHostFromUrl(AGES_BASE_URL);
const AGES_SSH_USER = process.env.AGES_SSH_USER ?? "";
const AGES_SSH_KEY_PATH = process.env.AGES_SSH_KEY_PATH ?? "/app/keys/ch09_brk_iis";
const AGES_SSH_RESTART_COMMAND =
  process.env.AGES_SSH_RESTART_COMMAND ?? "powershell -NoProfile -ExecutionPolicy Bypass -Command \"iisreset /restart\"";
const execFileAsync = promisify(execFile);

type AgesPoolSlotStatus = "idle" | "warming" | "ready" | "error";
type AgesPoolSlotKind = "bigb" | "mini";
type AgesPoolEndpoint = {
  kind: AgesPoolSlotKind;
  endpoint: string;
};

type AgesPoolSlot = {
  id: number;
  kind: AgesPoolSlotKind;
  endpoint: string;
  url: string;
  warmupResponse: string;
  agesToken: string;
  aspNetSessionId: string;
  status: AgesPoolSlotStatus;
  lastStatusCode?: number;
  lastInitializedAt?: string;
  lastError?: string;
  lastEndpoint?: string;
  lastUsedAt?: string;
  lastResponsePreview?: string;
};

export type AgesPoolSummary = {
  baseUrl: string;
  size: number;
  ready: number;
  warming: number;
  error: number;
  slots: Array<{
    id: number;
    kind: AgesPoolSlotKind;
    status: AgesPoolSlotStatus;
    lastStatusCode?: number;
    lastInitializedAt?: string;
    lastError?: string;
    lastEndpoint?: string;
    lastUsedAt?: string;
    lastResponsePreview?: string;
    warmupResponse: string;
    agesToken: string;
    aspNetSessionId: string;
  }>;
};

export type AgesProxyResult = {
  slotId: number;
  slotKind: AgesPoolSlotKind;
  agesUrl: string;
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
};

const initialEndpoints = createInitialEndpoints();

export class AgesConnectionPool {
  private readonly slots: AgesPoolSlot[];
  private nextSlotIndex = 0;
  private warmupPromise?: Promise<AgesPoolSummary>;
  private pingMonitor?: NodeJS.Timeout;
  private pingSweepRunning = false;
  private agesHostRestartRunning = false;

  constructor(
    private readonly baseUrl: string = AGES_BASE_URL,
    endpoints: AgesPoolEndpoint[] = initialEndpoints
  ) {
    this.slots = endpoints.map((item, index) => ({
      id: index + 1,
      kind: item.kind,
      endpoint: item.endpoint,
      url: this.resolveEndpoint(item.endpoint),
      warmupResponse: "",
      agesToken: "",
      aspNetSessionId: "",
      status: "idle"
    }));
  }

  async warmUp(): Promise<AgesPoolSummary> {
    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    this.warmupPromise = this.runWarmUp().finally(() => {
      this.warmupPromise = undefined;
    });

    return this.warmupPromise;
  }

  private async runWarmUp(): Promise<AgesPoolSummary> {
    log(
      [
        `warmup start`,
        `n=${this.slots.length}`,
        `mini=${this.slots.filter((slot) => slot.kind === "mini").length}`,
        `BigBoy=${this.slots.filter((slot) => slot.kind === "bigb").length}`,
        `base=${this.baseUrl}`,
        `host=${getHostFromUrl(this.baseUrl) || "unknown"}`,
        `proto=${getProtocolFromUrl(this.baseUrl) || "unknown"}`,
        `ssh=${AGES_SSH_HOST || "unset"}`
      ].join(" | ")
    );

    for (const slot of this.slots) {
      await this.initializeSlot(slot);

      if (slot.status !== "ready") {
        warn(
          [
            `warmup stop`,
            this.formatSlot(slot),
            `err=${slot.lastError ?? "unknown"}`
          ].join(" | ")
        );
        break;
      }
    }

    return this.getSummary();
  }

  getSummary(): AgesPoolSummary {
    const slots = this.slots.map((slot) => ({
      id: slot.id,
      kind: slot.kind,
      status: slot.status,
      lastStatusCode: slot.lastStatusCode,
      lastInitializedAt: slot.lastInitializedAt,
      lastError: slot.lastError,
      lastEndpoint: slot.lastEndpoint,
      lastUsedAt: slot.lastUsedAt,
      lastResponsePreview: slot.lastResponsePreview,
      warmupResponse: slot.warmupResponse,
      agesToken: slot.agesToken,
      aspNetSessionId: slot.aspNetSessionId
    }));

    return {
      baseUrl: this.baseUrl,
      size: this.slots.length,
      ready: this.slots.filter((slot) => slot.status === "ready").length,
      warming: this.slots.filter((slot) => slot.status === "warming").length,
      error: this.slots.filter((slot) => slot.status === "error").length,
      slots
    };
  }

  async request(slotId: number, endpoint: string, init: RequestInit = {}): Promise<Response> {
    const slot = this.getSlot(slotId);
    const response = await fetch(this.resolveEndpoint(endpoint), {
      ...init,
      headers: this.buildSessionHeaders(slot, init.headers)
    });

    this.captureSessionState(slot, response);
    return response;
  }

  startPingMonitor(): void {
    if (this.pingMonitor) {
      return;
    }

    this.pingMonitor = setInterval(() => {
      void this.runPingSweep();
    }, PING_INTERVAL_MS);
    this.pingMonitor.unref?.();
  }

  async recycleSlotByReference(slotReference: string): Promise<AgesPoolSummary> {
    const slot = this.getSlotByReference(slotReference);
    slot.lastError = "manual recycle requested";
    await this.recycleSlot(slot, this.resolveEndpoint(this.buildFunctionEndpoint(slot.kind, "manual")));
    return this.getSummary();
  }

  async restartAgesHostManually(): Promise<{ status: string; host: string; reason: string }> {
    const reason = "manual_iis_restart";
    const restarted = await this.restartAgesHost(reason);

    return {
      status: restarted ? "ok" : "error",
      host: AGES_SSH_HOST,
      reason
    };
  }

  async proxyCall(
    kind: AgesPoolSlotKind,
    functionName: string,
    queryString: string = "",
    init: RequestInit = {},
    sourceIp: string = "",
    sourceIpSource: string = ""
  ): Promise<AgesProxyResult> {
    if (!this.isReady(kind)) {
      throw new Error(`AGES ${kind} pool is still in warmup`);
    }

    const slot = this.getNextReadySlot(kind);
    const endpoint = this.buildFunctionEndpoint(kind, functionName);
    const agesUrl = this.appendQueryString(this.resolveEndpoint(endpoint), queryString);

    this.logProxyCall(slot, init.method ?? "GET", agesUrl, sourceIp, sourceIpSource);

    const requestHeaders = this.buildSessionHeaders(slot, init.headers);
    let response: Response;

    try {
      response = await fetch(agesUrl, {
        ...init,
        headers: requestHeaders
      });
    } catch (error) {
      slot.lastError = formatError(error);
      this.logProxyError(slot, init.method ?? "GET", agesUrl, sourceIp, sourceIpSource, {
        error,
        requestHeaders,
        requestBodySize: getBodySize(init.body)
      });
      throw error;
    }

    this.captureSessionState(slot, response);
    slot.lastStatusCode = response.status;

    const body = Buffer.from(await response.arrayBuffer());
    this.recordSlotUse(slot, agesUrl, body);

    if (response.status >= 400) {
      this.logProxyError(slot, init.method ?? "GET", agesUrl, sourceIp, sourceIpSource, {
        status: response.status,
        responseHeaders: this.responseHeadersToObject(response.headers),
        responsePreview: this.previewBody(body),
        requestHeaders,
        requestBodySize: getBodySize(init.body)
      });
    }

    if (this.isDllInitError(response.status, body)) {
      await this.restartAgesHost("dll_init_error");
    }

    const recycleReason = this.getRecycleReason(response.status, body);

    if (recycleReason) {
      slot.lastError = recycleReason;
      await this.recycleSlot(slot, agesUrl);
    }

    return {
      slotId: slot.id,
      slotKind: slot.kind,
      agesUrl,
      status: response.status,
      headers: this.responseHeadersToObject(response.headers),
      body
    };
  }

  private async initializeSlot(slot: AgesPoolSlot): Promise<AgesPoolSlotStatus> {
    slot.status = "warming";
    slot.lastError = undefined;

    for (let attempt = 1; attempt <= WARMUP_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.fetchWarmup(slot);

        slot.lastStatusCode = response.status;
        slot.lastInitializedAt = new Date().toISOString();
        this.captureSessionState(slot, response);
        slot.warmupResponse = await response.text();

        if (slot.agesToken && slot.aspNetSessionId) {
          slot.status = "ready";
          this.logSlotReady(slot, attempt);
          return slot.status;
        }

        slot.status = "error";
        slot.lastError = `AGES did not return ${AGES_TOKEN_HEADER} and ${ASP_NET_SESSION_COOKIE}`;
      } catch (error) {
        slot.status = "error";
        slot.lastInitializedAt = new Date().toISOString();
        slot.lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt < WARMUP_MAX_ATTEMPTS) {
        this.logSlotRetry(slot, attempt + 1);
      }
    }

    this.logSlotError(slot);
    return slot.status;
  }

  private async runPingSweep(): Promise<void> {
    if (this.pingSweepRunning) {
      warn("ping skip | err=previous sweep running");
      return;
    }

    this.pingSweepRunning = true;
    try {
      for (const slot of this.slots) {
        await this.pingSlot(slot);
      }
    } finally {
      this.pingSweepRunning = false;
    }
  }

  private async pingSlot(slot: AgesPoolSlot): Promise<void> {
    if (slot.status !== "ready") {
      if (slot.status === "warming") {
        warn(
          [
            `ping skip`,
            this.formatSlot(slot),
            `st=${slot.status}`
          ].join(" | ")
        );
        return;
      }

      slot.lastError = `slot status is ${slot.status}`;
      warn(
        [
          `ping recycle`,
          this.formatSlot(slot),
          `st=${slot.status}`
        ].join(" | ")
      );
      await this.recycleSlot(slot, this.resolveEndpoint(this.buildFunctionEndpoint(slot.kind, "ping")));
      return;
    }

    const pingUrl = this.resolveEndpoint(this.buildFunctionEndpoint(slot.kind, "ping"));

    try {
      const response = await this.fetchWithTimeout(pingUrl, {
        method: "GET",
        headers: this.buildSessionHeaders(slot)
      });

      this.captureSessionState(slot, response);
      slot.lastStatusCode = response.status;

      if (response.status === 200) {
        return;
      }

      slot.lastError = `ping returned status ${response.status}`;
      await this.recycleSlot(slot, pingUrl);
    } catch (error) {
      slot.lastError = error instanceof Error ? error.message : String(error);
      await this.recycleSlot(slot, pingUrl);
    }
  }

  private async recycleSlot(slot: AgesPoolSlot, pingUrl: string): Promise<void> {
    warn(
      [
        `recycle start`,
        this.formatSlot(slot),
        `u=${this.formatUrl(pingUrl)}`,
        `err=${slot.lastError ?? "unknown"}`
      ].join(" | ")
    );

    slot.agesToken = "";
    slot.aspNetSessionId = "";
    slot.warmupResponse = "";
    slot.status = "idle";
    const recycledStatus = await this.initializeSlot(slot);

    if (recycledStatus === "ready") {
      log(
        [
          `recycle ok`,
          this.formatSlot(slot),
          `st=${recycledStatus}`
        ].join(" | ")
      );
      return;
    }

    warn(
      [
        `recycle fail`,
        this.formatSlot(slot),
        `st=${recycledStatus}`,
        `err=${slot.lastError ?? "unknown"}`
      ].join(" | ")
    );
  }

  private async fetchWarmup(slot: AgesPoolSlot): Promise<Response> {
    return this.fetchWithTimeout(slot.url, {
      method: "GET",
      headers: {
        [AGES_TOKEN_HEADER]: "",
        Cookie: `${ASP_NET_SESSION_COOKIE}=`
      }
    });
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), WARMUP_TIMEOUT_MS);

    try {
      return await fetch(url, {
        ...init,
        signal: abortController.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private logSlotReady(slot: AgesPoolSlot, attempt: number): void {
    log(
      [
        `ready`,
        this.formatSlot(slot),
        `u=${this.formatUrl(slot.url)}`,
        `a=${attempt}`,
        `st=${slot.lastStatusCode ?? "unknown"}`,
        `${AGES_TOKEN_HEADER}=${slot.agesToken}`,
        `${ASP_NET_SESSION_COOKIE}=${slot.aspNetSessionId}`,
        `response=${slot.warmupResponse}`
      ].join(" | ")
    );
  }

  private logProxyCall(slot: AgesPoolSlot, method: string, url: string, sourceIp: string, sourceIpSource: string): void {
    const formattedUrl = this.formatUrl(url);

    if (formattedUrl.startsWith("/ages/~mini~/beat.ages")) {
      return;
    }

    log(
      [
        `proxy`,
        this.formatSlot(slot),
        `ip=${sourceIp || "unknown"}`,
        `ips=${sourceIpSource || "unknown"}`,
        `m=${method}`,
        `u=${formattedUrl}`
      ].join(" | ")
    );
  }

  private logProxyError(
    slot: AgesPoolSlot,
    method: string,
    url: string,
    sourceIp: string,
    sourceIpSource: string,
    detail: {
      error?: unknown;
      status?: number;
      responseHeaders?: Record<string, string | string[]>;
      responsePreview?: string;
      requestHeaders?: Record<string, string>;
      requestBodySize?: number;
    }
  ): void {
    warn(
      (ERROR_DEBUG_DETAILS
        ? [
        `proxy err`,
        this.formatSlot(slot),
        `ip=${sourceIp || "unknown"}`,
        `ips=${sourceIpSource || "unknown"}`,
        `m=${method}`,
        `u=${this.formatUrl(url)}`,
        `st=${detail.status ?? "fetch-fail"}`,
        `rb=${detail.requestBodySize ?? 0}`,
        `reqh=${this.formatHeaderNames(detail.requestHeaders)}`,
        detail.responseHeaders ? `resh=${this.formatHeaderNames(detail.responseHeaders)}` : "",
        detail.responsePreview ? `resp=${detail.responsePreview}` : "",
        detail.error ? `err=${formatError(detail.error)}` : ""
      ]
        : [
          `proxy err`,
          this.formatSlot(slot),
          `m=${method}`,
          `u=${this.formatUrl(url)}`,
          `st=${detail.status ?? "fetch-fail"}`,
          detail.error ? `err=${shortError(detail.error)}` : ""
        ])
        .filter(Boolean)
        .join(" | ")
    );
  }

  private logSlotRetry(slot: AgesPoolSlot, nextAttempt: number): void {
    warn(
      [
        `retry`,
        this.formatSlot(slot),
        `u=${this.formatUrl(slot.url)}`,
        `a=${nextAttempt}`,
        `to=${WARMUP_TIMEOUT_MS}`,
        `err=${slot.lastError ?? "unknown"}`
      ].join(" | ")
    );
  }

  private logSlotError(slot: AgesPoolSlot): void {
    warn(
      [
        `slot err`,
        this.formatSlot(slot),
        `u=${this.formatUrl(slot.url)}`,
        `st=${slot.lastStatusCode ?? "unknown"}`,
        `err=${slot.lastError ?? "unknown"}`
      ].join(" | ")
    );
  }

  private captureSessionState(slot: AgesPoolSlot, response: Response): void {
    const agesToken = response.headers.get(AGES_TOKEN_HEADER) ?? response.headers.get("AGES-TOKEN");
    const aspNetSessionId = this.extractAspNetSessionId(response.headers);

    if (agesToken) {
      slot.agesToken = agesToken;
    }

    if (aspNetSessionId) {
      slot.aspNetSessionId = aspNetSessionId;
    }
  }

  private buildSessionHeaders(slot: AgesPoolSlot, headers?: HeadersInit): Record<string, string> {
    const normalizedHeaders = this.normalizeHeaders(headers);
    const currentCookie = normalizedHeaders.Cookie ?? normalizedHeaders.cookie ?? "";

    delete normalizedHeaders.cookie;
    normalizedHeaders[AGES_TOKEN_HEADER] = slot.agesToken;
    normalizedHeaders.Cookie = this.mergeCookies(currentCookie, `${ASP_NET_SESSION_COOKIE}=${slot.aspNetSessionId}`);

    return normalizedHeaders;
  }

  private responseHeadersToObject(headers: Headers): Record<string, string | string[]> {
    const normalizedHeaders: Record<string, string | string[]> = {};

    headers.forEach((value, key) => {
      normalizedHeaders[key] = value;
    });

    const setCookieHeaders = this.getSetCookieHeaders(headers);

    if (setCookieHeaders.length > 0) {
      normalizedHeaders["set-cookie"] = setCookieHeaders;
    }

    return normalizedHeaders;
  }

  private normalizeHeaders(headers?: HeadersInit): Record<string, string> {
    const normalizedHeaders: Record<string, string> = {};

    if (!headers) {
      return normalizedHeaders;
    }

    new Headers(headers).forEach((value, key) => {
      normalizedHeaders[key] = value;
    });

    return normalizedHeaders;
  }

  private extractAspNetSessionId(headers: Headers): string {
    const setCookieHeaders = this.getSetCookieHeaders(headers).join(",");
    const match = setCookieHeaders.match(/ASP\.NET_SessionId=([^;,\s]+)/i);

    return match?.[1] ?? "";
  }

  private getSetCookieHeaders(headers: Headers): string[] {
    const nodeHeaders = headers as Headers & { getSetCookie?: () => string[] };
    const cookies = typeof nodeHeaders.getSetCookie === "function" ? nodeHeaders.getSetCookie() : [];
    const setCookie = headers.get("set-cookie");

    return setCookie ? [...cookies, setCookie] : cookies;
  }

  private mergeCookies(currentCookie: string, sessionCookie: string): string {
    const withoutSession = currentCookie
      .split(";")
      .map((cookie) => cookie.trim())
      .filter((cookie) => cookie && !cookie.toLowerCase().startsWith(`${ASP_NET_SESSION_COOKIE.toLowerCase()}=`));

    return [...withoutSession, sessionCookie].join("; ");
  }

  private getSlot(slotId: number): AgesPoolSlot {
    const slot = this.slots.find((item) => item.id === slotId);

    if (!slot) {
      throw new Error(`AGES pool slot ${slotId} does not exist`);
    }

    return slot;
  }

  private getSlotByReference(slotReference: string): AgesPoolSlot {
    const normalizedReference = slotReference.trim().toUpperCase();
    const idMatch = normalizedReference.match(/^S?(\d{1,2})(?:[MB])?$/);

    if (!idMatch) {
      throw new Error(`Invalid slot reference ${slotReference}`);
    }

    return this.getSlot(Number.parseInt(idMatch[1], 10));
  }

  private getNextReadySlot(kind: AgesPoolSlotKind): AgesPoolSlot {
    const readySlots = this.slots.filter((slot) => slot.kind === kind && slot.status === "ready");

    if (readySlots.length === 0) {
      throw new Error(`AGES ${kind} pool has no ready slots`);
    }

    const slot = readySlots[this.nextSlotIndex % readySlots.length];
    this.nextSlotIndex = (this.nextSlotIndex + 1) % readySlots.length;

    return slot;
  }

  private isReady(kind: AgesPoolSlotKind): boolean {
    const slots = this.slots.filter((slot) => slot.kind === kind);

    return slots.length > 0 && slots.every((slot) => slot.status === "ready");
  }

  private buildFunctionEndpoint(kind: AgesPoolSlotKind, functionName: string): string {
    const normalizedFunctionName = functionName.replace(/^\/+/, "");
    const agesFile = normalizedFunctionName.toLowerCase().endsWith(".ages")
      ? normalizedFunctionName
      : `${normalizedFunctionName}.ages`;

    return kind === "mini" ? `/~mini~/${agesFile}` : agesFile;
  }

  private appendQueryString(url: string, queryString: string): string {
    const normalizedQueryString = queryString.replace(/^\?/, "");

    return normalizedQueryString ? `${url}?${normalizedQueryString}` : url;
  }

  private resolveEndpoint(endpoint: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  }

  private formatSlotId(slotId: number): string {
    return slotId.toString().padStart(2, "0");
  }

  private formatKind(kind: AgesPoolSlotKind): string {
    return kind === "mini" ? "M" : "B";
  }

  private formatSlot(slot: AgesPoolSlot): string {
    return `S${this.formatSlotId(slot.id)}${this.formatKind(slot.kind)}`;
  }

  private formatUrl(url: string): string {
    try {
      const parsedUrl = new URL(url);
      return `${parsedUrl.pathname}${parsedUrl.search}`;
    } catch {
      return url.replace(this.baseUrl.replace(/\/+$/, ""), "");
    }
  }

  private recordSlotUse(slot: AgesPoolSlot, agesUrl: string, body: Buffer): void {
    slot.lastEndpoint = this.formatUrl(agesUrl);
    slot.lastUsedAt = new Date().toISOString();
    slot.lastResponsePreview = this.previewBody(body);
  }

  private previewBody(body: Buffer): string {
    return body.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 100);
  }

  private formatHeaderNames(headers?: Record<string, string | string[]>): string {
    const names = Object.keys(headers ?? {}).sort();

    return names.length > 0 ? names.join(",") : "none";
  }

  private getRecycleReason(status: number, body: Buffer): string {
    if (status >= 500) {
      return `proxy returned status ${status}`;
    }

    const responseText = body.toString("utf8");

    if (/Desde el SCRIPT:\s*(SERVICIOS_AVFP_MINI|SAVFP)\s+no es un objeto/i.test(responseText)) {
      return "AGES script object error";
    }

    return "";
  }

  private isDllInitError(status: number, body: Buffer): boolean {
    if (status !== 503) {
      return false;
    }

    try {
      const payload = JSON.parse(body.toString("utf8")) as { error?: string };
      return payload.error === "dll_init_error";
    } catch {
      return /"error"\s*:\s*"dll_init_error"/i.test(body.toString("utf8"));
    }
  }

  private async restartAgesHost(reason: string): Promise<boolean> {
    if (this.agesHostRestartRunning) {
      warn(`ages restart skip | reason=${reason} | err=restart already running`);
      return false;
    }

    if (!AGES_SSH_HOST || !AGES_SSH_USER) {
      warn(`ages restart skip | reason=${reason} | err=missing AGES_SSH_HOST or AGES_SSH_USER`);
      return false;
    }

    this.agesHostRestartRunning = true;
    warn(`ages restart start | host=${AGES_SSH_HOST} | user=${AGES_SSH_USER} | reason=${reason}`);

    try {
      await execFileAsync("ssh", [
        "-i",
        AGES_SSH_KEY_PATH,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        `${AGES_SSH_USER}@${AGES_SSH_HOST}`,
        AGES_SSH_RESTART_COMMAND
      ]);
      log(`ages restart ok | host=${AGES_SSH_HOST} | reason=${reason}`);
      await this.resetPoolForWarmup(`host restart ${reason}`);
      void this.warmUp();
      return true;
    } catch (error) {
      warn(`ages restart fail | host=${AGES_SSH_HOST} | reason=${reason} | err=${formatError(error)}`);
      return false;
    } finally {
      this.agesHostRestartRunning = false;
    }
  }

  private async resetPoolForWarmup(reason: string): Promise<void> {
    warn(`warmup reset | reason=${reason}`);

    this.slots.forEach((slot) => {
      slot.agesToken = "";
      slot.aspNetSessionId = "";
      slot.warmupResponse = "";
      slot.status = "idle";
      slot.lastError = reason;
    });
  }
}

function getHostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function getProtocolFromUrl(url: string): string {
  try {
    return new URL(url).protocol.replace(/:$/, "");
  } catch {
    return "";
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const details = [
      error.name,
      error.message,
      getErrorCause(error),
      error.stack ? `stack=${error.stack.split("\n").slice(0, 3).join(" <- ")}` : ""
    ].filter(Boolean);

    return details.join(" | ");
  }

  return String(error);
}

function getErrorCause(error: Error): string {
  const withCause = error as Error & { cause?: unknown };

  if (!withCause.cause) {
    return "";
  }

  if (withCause.cause instanceof Error) {
    const causeWithCode = withCause.cause as Error & { code?: string };
    return `cause=${causeWithCode.name}:${causeWithCode.message}${causeWithCode.code ? ` code=${causeWithCode.code}` : ""}`;
  }

  return `cause=${String(withCause.cause)}`;
}

function getBodySize(body: BodyInit | null | undefined): number {
  if (!body) {
    return 0;
  }

  if (typeof body === "string") {
    return Buffer.byteLength(body);
  }

  if (Buffer.isBuffer(body)) {
    return body.length;
  }

  if (body instanceof URLSearchParams) {
    return Buffer.byteLength(body.toString());
  }

  return 0;
}

function createInitialEndpoints(): AgesPoolEndpoint[] {
  return [
    ...Array<AgesPoolEndpoint>(getEnvSlotCount("slots_mini", DEFAULT_MINI_SLOTS)).fill({
      kind: "mini",
      endpoint: "/~mini~/dummy_val.ages"
    }),
    ...Array<AgesPoolEndpoint>(getEnvSlotCount("slots_bigb", DEFAULT_BIGB_SLOTS)).fill({
      kind: "bigb",
      endpoint: "dummy_val.ages"
    })
  ];
}

function getEnvSlotCount(envName: string, fallback: number): number {
  const rawValue = process.env[envName];

  if (!rawValue) {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value) || value < 0) {
    warn(`Invalid ${envName}="${rawValue}". Using fallback ${fallback}.`);
    return fallback;
  }

  return value;
}

function isConfigEnabled(name: string, fallback = false): boolean {
  const rawValue = process.env[name];

  if (rawValue === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on", "enabled"].includes(rawValue.trim().toLowerCase());
}

function shortError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const agesConnectionPool = new AgesConnectionPool();
