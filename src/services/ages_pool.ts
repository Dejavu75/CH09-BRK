import "dotenv/config";

import { execFile } from "child_process";
import { readFileSync, statSync } from "fs";
import { promisify } from "util";

import { log, sendDebugMail, warn } from "../utils/logger";

const AGES_BASE_URL = process.env.HAAGES ?? "http://localhost/ages";
const ASP_NET_SESSION_COOKIE = "ASP.NET_SessionId";
const AGES_TOKEN_HEADER = "AGES_TOKEN";
const AGES_API_KEY_HEADER = "X-AGES-API-Key";
const WARMUP_TIMEOUT_MS = 50_000;
const WARMUP_MAX_ATTEMPTS = 2;
const AGES_WARMUP_STARTING_RESPONSE = "Warmingup";
const PING_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MINI_SLOTS = 5;
const DEFAULT_BIGB_SLOTS = 5;
const INITIAL_MINI_SLOTS = getEnvSlotCount("slots_mini", DEFAULT_MINI_SLOTS);
const INITIAL_BIGB_SLOTS = getEnvSlotCount("slots_bigb", DEFAULT_BIGB_SLOTS);
const MAX_MINI_SLOTS = getEnvMaxSlotCount("slots_mini_max", INITIAL_MINI_SLOTS);
const MAX_BIGB_SLOTS = getEnvMaxSlotCount("slots_bigb_max", INITIAL_BIGB_SLOTS);
const ADAPTIVE_SLOT_HOLD_MS = getEnvDurationMinutes("slots_adaptive_hold_minutes", 30) * 60 * 1000;
const ADAPTIVE_SWEEP_INTERVAL_MS = 60 * 1000;
const ERROR_DEBUG_DETAILS = isConfigEnabled("ERROR_DEBUG_DETAILS", true);
const AGES_SSH_HOST = process.env.AGES_SSH_HOST ?? getHostFromUrl(AGES_BASE_URL);
const AGES_SSH_USER = process.env.AGES_SSH_USER ?? "";
const AGES_SSH_KEY_PATH = process.env.AGES_SSH_KEY_PATH ?? "/run/secrets/ch09-brk-iis/ch09_brk_iis";
const AGES_SSH_RESTART_COMMAND =
  process.env.AGES_SSH_RESTART_COMMAND ?? "powershell -NoProfile -ExecutionPolicy Bypass -Command \"iisreset /restart\"";
const AGES_IIS_RESTART_COOLDOWN_MS = getEnvDurationSeconds("AGES_IIS_RESTART_COOLDOWN_SECONDS", 300) * 1000;
const AGES_SSH_COMMAND_TIMEOUT_MS = getEnvDurationSeconds("AGES_SSH_COMMAND_TIMEOUT_SECONDS", 30) * 1000;
const execFileAsync = promisify(execFile);

type AgesPoolSlotStatus = "idle" | "warming" | "starting" | "ready" | "error";
type AgesPoolSlotKind = "bigb" | "mini";
export type AgesBackendId = "legacy" | "A" | "B";
export type AgesBackendState = "active" | "draining" | "recycling" | "warming" | "degraded";
export type AgesBackendConfiguration = {
  mode: "legacy" | "dual";
  backends: Array<{ id: AgesBackendId; baseUrl: string }>;
};
type AgesPoolEndpoint = {
  kind: AgesPoolSlotKind;
  endpoint: string;
};

type AgesSlotWaiter = () => void;
type AcquireSlotOptions = {
  allowGrow: boolean;
  baseOnly: boolean;
  excludeSlotIds?: Set<number>;
};

type AgesPoolKindSummary = {
  kind: AgesPoolSlotKind;
  base: number;
  current: number;
  ready: number;
  inUse: number;
  dynamic: number;
  dynamicReady: number;
  dynamicInUse: number;
  max: number;
  waiting: number;
  holdMinutes: number;
};

export type AgesTimingTrace = {
  id: string;
  entryType?: "proxy" | "event";
  kind?: AgesPoolSlotKind;
  method?: string;
  url?: string;
  sourceIp?: string;
  sourceIpSource?: string;
  slot?: string;
  slotDynamic?: boolean;
  status?: number;
  bytes?: number;
  error?: string;
  brokerInAt: string;
  slotWaitStartAt?: string;
  slotAcquiredAt?: string;
  agesStartAt?: string;
  agesEndAt?: string;
  brokerOutAt?: string;
  waitMs?: number;
  agesMs?: number;
  totalMs?: number;
};

type AgesPoolSlot = {
  id: number;
  backendId: AgesBackendId;
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
  lastResponseBody?: string;
  inUse: boolean;
  maintenanceInFlight: number;
  dynamic: boolean;
  holdUntil?: number;
};

export type AgesPoolSummary = {
  baseUrl: string;
  mode: "legacy" | "dual";
  backends: Array<{ id: AgesBackendId; baseUrl: string; slots: number; ready: number; state: AgesBackendState; lastError?: string }>;
  size: number;
  ready: number;
  warming: number;
  error: number;
  config: {
    adaptiveHoldMinutes: number;
    mini: AgesPoolKindSummary;
    bigb: AgesPoolKindSummary;
  };
  iisRestart: {
    running: boolean;
    cooldownSeconds: number;
    lastStartedAt?: string;
    lastFinishedAt?: string;
    cooldownUntil?: string;
  };
  slots: Array<{
    id: number;
    backendId: AgesBackendId;
    kind: AgesPoolSlotKind;
    status: AgesPoolSlotStatus;
    lastStatusCode?: number;
    lastInitializedAt?: string;
    lastError?: string;
    lastEndpoint?: string;
    lastUsedAt?: string;
    lastResponsePreview?: string;
    lastResponseBody?: string;
    warmupResponse: string;
    agesToken: string;
    aspNetSessionId: string;
    inUse: boolean;
    dynamic: boolean;
    holdUntil?: string;
  }>;
};

export type AgesProxyResult = {
  slotId: number;
  slotKind: AgesPoolSlotKind;
  backendId: AgesBackendId;
  agesUrl: string;
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  traceId: string;
  traceHeaders: Record<string, string>;
};

const initialEndpoints = createInitialEndpoints();

export class AgesConnectionPool {
  private readonly slots: AgesPoolSlot[] = [];
  private readonly backendConfiguration: AgesBackendConfiguration;
  private readonly backendStates = new Map<AgesBackendId, { state: AgesBackendState; lastError?: string }>();
  private lifecycle?: { id: AgesBackendId; promise: Promise<AgesPoolSummary> };
  private readonly drainTimeoutMs: number;
  private readonly pollMs: number;
  private readonly recycleExecutor: (id: AgesBackendId) => Promise<void>;
  private nextSlotId = 1;
  private nextSlotIndex = 0;
  private warmupPromise?: Promise<AgesPoolSummary>;
  private pingMonitor?: NodeJS.Timeout;
  private adaptiveSweep?: NodeJS.Timeout;
  private pingSweepRunning = false;
  private agesHostRestartRunning = false;
  private agesHostRestartCooldownUntil = 0;
  private lastAgesHostRestartStartedAt?: string;
  private lastAgesHostRestartFinishedAt?: string;
  private initialWarmupFinished = false;
  private traceSequence = 0;
  private readonly timingLog: AgesTimingTrace[] = [];
  private readonly slotWaiters: Record<AgesPoolSlotKind, AgesSlotWaiter[]> = {
    bigb: [],
    mini: []
  };
  private readonly growPromises: Partial<Record<AgesPoolSlotKind, Promise<AgesPoolSlot | undefined>>> = {};

  constructor(
    private readonly baseUrl: string = AGES_BASE_URL,
    endpoints: AgesPoolEndpoint[] = initialEndpoints,
    backendConfiguration: AgesBackendConfiguration = resolveBackendConfiguration(process.env, baseUrl),
    options: { drainTimeoutMs?: number; pollMs?: number; recycleExecutor?: (id: AgesBackendId) => Promise<void> } = {}
  ) {
    this.backendConfiguration = backendConfiguration;
    backendConfiguration.backends.forEach((backend) => this.backendStates.set(backend.id, { state: "active" }));
    this.drainTimeoutMs = options.drainTimeoutMs ?? getEnvDurationSeconds("AGES_BACKEND_DRAIN_TIMEOUT_SECONDS", 120) * 1000;
    this.pollMs = options.pollMs ?? 250;
    this.recycleExecutor = options.recycleExecutor ?? ((id) => this.recycleBackendAppPool(id));
    endpoints.forEach((item) => this.slots.push(this.createSlot(item.kind, false)));
  }

  async warmUp(reason = "warmup requested"): Promise<AgesPoolSummary> {
    if (this.lifecycle) throw new Error(`Cannot warm up while backend ${this.lifecycle.id} is recycling`);
    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    this.warmupPromise = this.runWarmUp({ resetBeforeStart: true, resetReason: reason }).finally(() => {
      this.warmupPromise = undefined;
    });

    return this.warmupPromise;
  }

  private async runWarmUp(options: { resetBeforeStart?: boolean; resetReason?: string } = {}): Promise<AgesPoolSummary> {
    this.initialWarmupFinished = false;
    const warmupSlots = [...this.slots];

    this.backendStates.forEach((backend) => { backend.state = "draining"; });
    try {
      await this.waitForDrain(warmupSlots, "global warmup");
    } catch (error) {
      this.backendStates.forEach((backend) => { backend.state = "degraded"; backend.lastError = formatError(error); });
      throw error;
    }
    this.backendStates.forEach((backend) => { backend.state = "warming"; });

    if (options.resetBeforeStart) {
      await this.resetPoolForWarmup(options.resetReason ?? "warmup requested");
    }

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

    for (const slot of warmupSlots) {
      await this.initializeSlot(slot);

      if (slot.status === "starting") {
        log(`warmup slot starting | ${this.formatSlot(slot)}`);
        continue;
      }

      if (slot.status !== "ready") {
        warn(
          [
            `warmup slot fail`,
            this.formatSlot(slot),
            `err=${slot.lastError ?? "unknown"}`
          ].join(" | ")
        );
        continue;
      }

      this.notifySlotWaiters(slot.kind);
    }

    this.initialWarmupFinished = warmupSlots.every((slot) => slot.status === "ready");
    this.backendStates.forEach((backend, id) => {
      const failed = warmupSlots.find((slot) => slot.backendId === id && slot.status !== "ready");
      backend.state = failed && this.backendConfiguration.mode === "dual" ? "degraded" : "active";
      backend.lastError = failed?.lastError;
    });
    this.notifySlotWaiters("mini");
    this.notifySlotWaiters("bigb");
    return this.getSummary();
  }

  getSummary(): AgesPoolSummary {
    const slots = this.slots.map((slot) => ({
      id: slot.id,
      backendId: slot.backendId,
      kind: slot.kind,
      status: slot.status,
      lastStatusCode: slot.lastStatusCode,
      lastInitializedAt: slot.lastInitializedAt,
      lastError: slot.lastError,
      lastEndpoint: slot.lastEndpoint,
      lastUsedAt: slot.lastUsedAt,
      lastResponsePreview: slot.lastResponsePreview,
      lastResponseBody: slot.lastResponseBody,
      warmupResponse: slot.warmupResponse,
      agesToken: slot.agesToken,
      aspNetSessionId: slot.aspNetSessionId,
      inUse: slot.inUse,
      dynamic: slot.dynamic,
      holdUntil: slot.holdUntil ? new Date(slot.holdUntil).toISOString() : undefined
    }));

    return {
      baseUrl: this.baseUrl,
      mode: this.backendConfiguration.mode,
      backends: this.backendConfiguration.backends.map((backend) => ({
        ...backend,
        slots: this.slots.filter((slot) => slot.backendId === backend.id).length,
        ready: this.slots.filter((slot) => slot.backendId === backend.id && slot.status === "ready").length,
        ...this.backendStates.get(backend.id)!
      })),
      size: this.slots.length,
      ready: this.slots.filter((slot) => slot.status === "ready").length,
      warming: this.slots.filter((slot) => slot.status === "warming").length,
      error: this.slots.filter((slot) => slot.status === "error").length,
      config: {
        adaptiveHoldMinutes: ADAPTIVE_SLOT_HOLD_MS / 60 / 1000,
        mini: this.getKindSummary("mini"),
        bigb: this.getKindSummary("bigb")
      },
      iisRestart: {
        running: this.agesHostRestartRunning,
        cooldownSeconds: AGES_IIS_RESTART_COOLDOWN_MS / 1000,
        lastStartedAt: this.lastAgesHostRestartStartedAt,
        lastFinishedAt: this.lastAgesHostRestartFinishedAt,
        cooldownUntil: this.agesHostRestartCooldownUntil > Date.now()
          ? new Date(this.agesHostRestartCooldownUntil).toISOString()
          : undefined
      },
      slots
    };
  }

  getTimingLog(): AgesTimingTrace[] {
    return [...this.timingLog].reverse();
  }

  clearTimingLog(): { status: string; cleared: number } {
    const cleared = this.timingLog.length;
    this.timingLog.length = 0;

    return {
      status: "ok",
      cleared
    };
  }

  async request(slotId: number, endpoint: string, init: RequestInit = {}): Promise<Response> {
    const slot = this.getSlot(slotId);
    if (!this.isBackendActive(slot)) throw new Error(`Backend ${slot.backendId} is not active`);
    const response = await fetch(this.resolveSlotEndpoint(slot, endpoint), {
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
    this.startAdaptiveSweep();
  }

  async recycleSlotByReference(slotReference: string): Promise<AgesPoolSummary> {
    const slot = this.getSlotByReference(slotReference);
    if (!this.isBackendActive(slot)) throw new Error(`Backend ${slot.backendId} is not active`);
    slot.lastError = "manual recycle requested";
    await this.recycleSlot(slot, this.resolveSlotEndpoint(slot, this.buildFunctionEndpoint(slot.kind, "manual")));
    return this.getSummary();
  }

  async restartAgesHostManually(): Promise<{ status: string; host: string; reason: string }> {
    if (this.backendConfiguration.mode === "dual") {
      return { status: "error", host: AGES_SSH_HOST, reason: "global_iis_restart_disabled_in_dual_mode" };
    }
    const reason = "manual_iis_restart";
    const restarted = await this.restartAgesHost(reason);

    return {
      status: restarted ? "ok" : "error",
      host: AGES_SSH_HOST,
      reason
    };
  }

  async drainAndRecycleBackend(reference: string): Promise<AgesPoolSummary> {
    if (this.backendConfiguration.mode !== "dual") throw new Error("Directed recycle requires dual mode");
    const id = reference.trim().toUpperCase() as AgesBackendId;
    const backend = this.backendStates.get(id);
    if (!backend || id === "legacy") throw new Error(`Unknown AGES backend ${reference}`);
    if (this.warmupPromise) throw new Error("Global warmup is running");
    if (this.lifecycle) {
      if (this.lifecycle.id === id) return this.lifecycle.promise;
      throw new Error(`Backend ${this.lifecycle.id} is already recycling`);
    }
    const peer = this.backendConfiguration.backends.find((item) => item.id !== id)!;
    const peerSlots = this.slots.filter((slot) => slot.backendId === peer.id);
    const requiredKinds = new Set(this.slots.map((slot) => slot.kind));
    if (this.backendStates.get(peer.id)?.state !== "active" ||
        peerSlots.some((slot) => slot.status !== "ready") ||
        [...requiredKinds].some((kind) => !peerSlots.some((slot) => slot.kind === kind && slot.status === "ready"))) {
      throw new Error(`Peer backend ${peer.id} is not active and ready`);
    }
    const promise = this.runDirectedRecycle(id, backend).finally(() => { this.lifecycle = undefined; });
    this.lifecycle = { id, promise };
    return promise;
  }

  async proxyCall(
    kind: AgesPoolSlotKind,
    functionName: string,
    queryString: string = "",
    init: RequestInit = {},
    sourceIp: string = "",
    sourceIpSource: string = ""
  ): Promise<AgesProxyResult> {
    const brokerInMs = Date.now();
    if (!this.hasReadySlot(kind)) {
      throw new Error(`AGES ${kind} pool is still in warmup`);
    }

    const endpoint = this.buildFunctionEndpoint(kind, functionName);
    const isInternalBeat = this.isInternalBeatEndpoint(kind, endpoint);
    const excludedSlotIds = new Set<number>();
    let damagedSlotRetryAttempt = 0;

    while (true) {
      const attemptBrokerInMs = Date.now();
      const trace = this.createTimingTrace(kind, init.method ?? "GET", endpoint, sourceIp, sourceIpSource, attemptBrokerInMs);
      trace.slotWaitStartAt = new Date().toISOString();
      const slot = await this.acquireSlot(kind, {
        allowGrow: !this.warmupPromise && !isInternalBeat,
        baseOnly: isInternalBeat,
        excludeSlotIds: excludedSlotIds
      });
      const slotAcquiredMs = Date.now();
      const agesUrl = this.appendQueryString(this.resolveSlotEndpoint(slot, endpoint), queryString);
      trace.url = this.formatUrl(agesUrl);
      trace.slot = this.formatSlot(slot);
      trace.slotDynamic = slot.dynamic;
      trace.slotAcquiredAt = new Date(slotAcquiredMs).toISOString();
      trace.waitMs = slotAcquiredMs - brokerInMs;

      this.logProxyCall(slot, init.method ?? "GET", agesUrl, sourceIp, sourceIpSource);

      const requestHeaders = this.buildSessionHeaders(slot, init.headers);
      let response: Response;
      let agesStartMs = 0;
      let agesEndMs = 0;

      try {
        try {
          agesStartMs = Date.now();
          trace.agesStartAt = new Date(agesStartMs).toISOString();
          response = await fetch(agesUrl, {
            ...init,
            headers: requestHeaders
          });
          agesEndMs = Date.now();
          trace.agesEndAt = new Date(agesEndMs).toISOString();
          trace.agesMs = agesEndMs - agesStartMs;
        } catch (error) {
          agesEndMs = Date.now();
          trace.agesEndAt = new Date(agesEndMs).toISOString();
          trace.agesMs = agesStartMs ? agesEndMs - agesStartMs : undefined;
          trace.error = formatError(error);
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
        trace.status = response.status;
        trace.bytes = body.length;

        if (!isInternalBeat) {
          this.recordSlotUse(slot, agesUrl, body);
        }

        if (response.status >= 400) {
          this.logProxyError(slot, init.method ?? "GET", agesUrl, sourceIp, sourceIpSource, {
            status: response.status,
            responseHeaders: this.responseHeadersToObject(response.headers),
            responsePreview: this.previewBody(body),
            requestHeaders,
            requestBodySize: getBodySize(init.body)
          });
        }

        if (response.status === 503) {
          if (this.backendConfiguration.mode === "dual") {
            void this.drainAndRecycleBackend(slot.backendId).catch((error) => warn(`backend recycle fail | ${formatError(error)}`));
          } else {
            await this.restartAgesHost(this.isDllInitError(response.status, body) ? "dll_init_error" : "ages_503");
          }
        }

        const avfpInvalidObjectReason = this.getAvfpInvalidObjectReason(body);

        if (avfpInvalidObjectReason) {
          excludedSlotIds.add(slot.id);
          damagedSlotRetryAttempt += 1;
          slot.agesToken = "";
          slot.lastError = avfpInvalidObjectReason;
          slot.status = "error";
          trace.error = avfpInvalidObjectReason;
          this.logProxyError(slot, init.method ?? "GET", agesUrl, sourceIp, sourceIpSource, {
            status: response.status,
            responseHeaders: this.responseHeadersToObject(response.headers),
            responsePreview: this.previewBody(body),
            requestHeaders,
            requestBodySize: getBodySize(init.body)
          });

          const hasExistingRetrySlot = this.hasAvailableAlternateSlot(kind, excludedSlotIds, isInternalBeat);
          const shouldGrowAdaptiveRetrySlot = !hasExistingRetrySlot && this.canGrowAdaptiveRetrySlot(kind, isInternalBeat);

          if (hasExistingRetrySlot || shouldGrowAdaptiveRetrySlot) {
            this.recordDamagedSlotRetry(
              slot,
              avfpInvalidObjectReason,
              damagedSlotRetryAttempt,
              shouldGrowAdaptiveRetrySlot
            );
            void this.recycleDamagedSlot(slot, agesUrl);
            continue;
          }

          throw new Error(`${avfpInvalidObjectReason}; no alternate ${kind} slot available`);
        }

        const recycleReason = this.getRecycleReason(response.status, body);

        if (recycleReason && !(this.backendConfiguration.mode === "dual" && response.status === 503)) {
          slot.lastError = recycleReason;
          await this.recycleSlot(slot, agesUrl);
        }

        return {
          slotId: slot.id,
          slotKind: slot.kind,
          backendId: slot.backendId,
          agesUrl,
          status: response.status,
          headers: this.responseHeadersToObject(response.headers),
          body,
          traceId: trace.id,
          traceHeaders: this.buildTraceHeaders(trace)
        };
      } finally {
        this.completeTimingTrace(trace);
        this.releaseSlot(slot, !isInternalBeat);
      }
    }
  }

  completeTraceResponse(traceId: string, status: number, bytes: number): AgesTimingTrace | undefined {
    const trace = this.timingLog.find((item) => item.id === traceId);

    if (!trace) {
      return undefined;
    }

    trace.status = status;
    trace.bytes = bytes;
    trace.brokerOutAt = new Date().toISOString();
    trace.totalMs = Date.parse(trace.brokerOutAt) - Date.parse(trace.brokerInAt);

    return trace;
  }

  private async initializeSlot(slot: AgesPoolSlot): Promise<AgesPoolSlotStatus> {
    slot.maintenanceInFlight++;
    try {
      return await this.initializeSlotTracked(slot);
    } finally {
      slot.maintenanceInFlight--;
    }
  }

  private async initializeSlotTracked(slot: AgesPoolSlot): Promise<AgesPoolSlotStatus> {
    this.clearSlotForWarmup(slot);
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

        if (slot.warmupResponse.trim() === AGES_WARMUP_STARTING_RESPONSE) {
          if (attempt === WARMUP_MAX_ATTEMPTS) {
            slot.status = "starting";
            return slot.status;
          }

          slot.status = "warming";
        } else {
          slot.status = "error";
          slot.lastError = `AGES did not return ${AGES_TOKEN_HEADER} and ${ASP_NET_SESSION_COOKIE}`;
        }
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
      for (const slot of [...this.slots]) {
        await this.pingSlot(slot);
      }
    } finally {
      this.pingSweepRunning = false;
    }
  }

  private async pingSlot(slot: AgesPoolSlot): Promise<void> {
    slot.maintenanceInFlight++;
    try {
      await this.pingSlotTracked(slot);
    } finally {
      slot.maintenanceInFlight--;
    }
  }

  private async pingSlotTracked(slot: AgesPoolSlot): Promise<void> {
    if (slot.inUse || !this.isBackendAvailableForMaintenance(slot)) {
      return;
    }

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
      await this.recycleSlot(slot, this.resolveSlotEndpoint(slot, this.buildFunctionEndpoint(slot.kind, "ping")));
      return;
    }

    const pingUrl = this.resolveSlotEndpoint(slot, this.buildFunctionEndpoint(slot.kind, "ping"));

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

    this.clearSlotForWarmup(slot);
    slot.status = "idle";
    const recycledStatus = await this.initializeSlot(slot);

    if (recycledStatus === "ready") {
      this.restoreBackendHealthIfRecovered(slot.backendId);
      log(
        [
          `recycle ok`,
          this.formatSlot(slot),
          `st=${recycledStatus}`
        ].join(" | ")
      );
      this.notifySlotWaiters(slot.kind);
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
      headers: this.buildSessionHeaders(slot, undefined, { includeInternalApiKey: true })
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

  private buildSessionHeaders(
    slot: AgesPoolSlot,
    headers?: HeadersInit,
    options: { includeInternalApiKey?: boolean } = {}
  ): Record<string, string> {
    const normalizedHeaders = this.normalizeHeaders(headers);
    const currentCookie = normalizedHeaders.Cookie ?? normalizedHeaders.cookie ?? "";

    delete normalizedHeaders.cookie;
    normalizedHeaders[AGES_TOKEN_HEADER] = slot.agesToken;
    const agesApiKey = process.env.AGES_API_KEY ?? readEnvFileValue("AGES_API_KEY");
    if (options.includeInternalApiKey && agesApiKey && !hasHeader(normalizedHeaders, AGES_API_KEY_HEADER)) {
      normalizedHeaders[AGES_API_KEY_HEADER] = agesApiKey;
    } else if (options.includeInternalApiKey && !agesApiKey && !hasHeader(normalizedHeaders, AGES_API_KEY_HEADER)) {
      warn(`AGES API key is not configured; ${AGES_API_KEY_HEADER} header will not be sent.`);
    }
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
    const readySlots = this.slots.filter((slot) => slot.kind === kind && slot.status === "ready" && this.isBackendRoutable(slot) && !slot.inUse);

    if (readySlots.length === 0) {
      throw new Error(`AGES ${kind} pool has no ready slots`);
    }

    const slot = readySlots[this.nextSlotIndex % readySlots.length];
    this.nextSlotIndex = (this.nextSlotIndex + 1) % readySlots.length;

    return slot;
  }

  private hasReadySlot(kind: AgesPoolSlotKind): boolean {
    const slots = this.slots.filter((slot) => slot.kind === kind);

    return slots.some((slot) => slot.status === "ready" && this.isBackendRoutable(slot));
  }

  private hasAvailableAlternateSlot(kind: AgesPoolSlotKind, excludeSlotIds: Set<number>, baseOnly: boolean): boolean {
    return this.slots.some(
      (slot) =>
        slot.kind === kind &&
        slot.status === "ready" &&
        this.isBackendRoutable(slot) &&
        !slot.inUse &&
        !excludeSlotIds.has(slot.id) &&
        (!baseOnly || !slot.dynamic)
    );
  }

  private canGrowAdaptiveRetrySlot(kind: AgesPoolSlotKind, baseOnly: boolean): boolean {
    return !baseOnly && !this.warmupPromise && this.getSlotCount(kind) < this.getMaxSlots(kind);
  }

  private async acquireSlot(kind: AgesPoolSlotKind, options: AcquireSlotOptions): Promise<AgesPoolSlot> {
    while (true) {
      const readySlot = this.getNextAvailableSlot(kind, options.baseOnly, options.excludeSlotIds);

      if (readySlot) {
        readySlot.inUse = true;
        return readySlot;
      }

      if (options.allowGrow && this.getSlotCount(kind) < this.getMaxSlots(kind)) {
        const grownSlot = await this.growPool(kind);

        if (grownSlot) {
          return grownSlot;
        }
      }

      await this.waitForSlot(kind);
    }
  }

  private getNextAvailableSlot(
    kind: AgesPoolSlotKind,
    baseOnly: boolean,
    excludeSlotIds: Set<number> = new Set()
  ): AgesPoolSlot | undefined {
    const baseReadySlots = this.slots.filter(
      (slot) => slot.kind === kind && slot.status === "ready" && this.isBackendRoutable(slot) && !slot.inUse && !slot.dynamic && !excludeSlotIds.has(slot.id)
    );

    if (baseReadySlots.length > 0) {
      const slot = baseReadySlots[this.nextSlotIndex % baseReadySlots.length];
      this.nextSlotIndex = (this.nextSlotIndex + 1) % baseReadySlots.length;

      return slot;
    }

    if (baseOnly) {
      return undefined;
    }

    const adaptiveReadySlots = this.slots.filter(
      (slot) => slot.kind === kind && slot.status === "ready" && this.isBackendRoutable(slot) && !slot.inUse && slot.dynamic && !excludeSlotIds.has(slot.id)
    );

    if (adaptiveReadySlots.length === 0) {
      return undefined;
    }

    const slot = adaptiveReadySlots[this.nextSlotIndex % adaptiveReadySlots.length];
    this.nextSlotIndex = (this.nextSlotIndex + 1) % adaptiveReadySlots.length;

    return slot;
  }

  private async growPool(kind: AgesPoolSlotKind): Promise<AgesPoolSlot | undefined> {
    if (this.growPromises[kind]) {
      await this.growPromises[kind];
      return undefined;
    }

    this.growPromises[kind] = this.runGrowPool(kind).finally(() => {
      this.growPromises[kind] = undefined;
    });

    return this.growPromises[kind];
  }

  private async runGrowPool(kind: AgesPoolSlotKind): Promise<AgesPoolSlot | undefined> {
    const maxSlots = this.getMaxSlots(kind);
    const kindSlots = this.slots.filter((slot) => slot.kind === kind);

    if (kindSlots.length >= maxSlots) {
      warn(`pool grow skip | kind=${this.formatKind(kind)} | n=${kindSlots.length} | max=${maxSlots}`);
      return undefined;
    }

    const slot = this.createSlot(kind, true);
    this.slots.push(slot);
    warn(`pool grow | ${this.formatSlot(slot)} | n=${kindSlots.length + 1} | max=${maxSlots} | hold=${ADAPTIVE_SLOT_HOLD_MS}`);

    const status = await this.initializeSlot(slot);

    if (status !== "ready") {
      warn(`pool grow fail | ${this.formatSlot(slot)} | st=${status} | err=${slot.lastError ?? "unknown"}`);
      this.removeSlot(slot);
      return undefined;
    }

    if (!this.isBackendActive(slot)) {
      this.removeSlot(slot);
      return undefined;
    }

    slot.inUse = true;
    return slot;
  }

  private releaseSlot(slot: AgesPoolSlot, extendAdaptiveHold = true): void {
    slot.inUse = false;

    if (slot.dynamic && extendAdaptiveHold) {
      slot.holdUntil = Date.now() + ADAPTIVE_SLOT_HOLD_MS;
    }

    this.notifySlotWaiters(slot.kind);
  }

  private waitForSlot(kind: AgesPoolSlotKind): Promise<void> {
    const waiters = this.slotWaiters[kind];

    warn(
      [
        `pool wait`,
        `kind=${this.formatKind(kind)}`,
        `q=${waiters.length + 1}`,
        `n=${this.getSlotCount(kind)}`,
        `max=${this.getMaxSlots(kind)}`
      ].join(" | ")
    );

    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  private notifySlotWaiters(kind: AgesPoolSlotKind): void {
    const waiters = this.slotWaiters[kind].splice(0);

    waiters.forEach((waiter) => {
      waiter();
    });
  }

  private startAdaptiveSweep(): void {
    if (this.adaptiveSweep) {
      return;
    }

    this.adaptiveSweep = setInterval(() => {
      this.shrinkAdaptiveSlots();
    }, ADAPTIVE_SWEEP_INTERVAL_MS);
    this.adaptiveSweep.unref?.();
  }

  private shrinkAdaptiveSlots(): void {
    const now = Date.now();

    for (const kind of ["mini", "bigb"] as const) {
      const minSlots = this.getInitialSlots(kind);
      const kindSlots = this.slots.filter((slot) => slot.kind === kind);
      kindSlots.forEach((slot) => {
        if (slot.dynamic && !slot.inUse && !slot.holdUntil) {
          slot.holdUntil = now + ADAPTIVE_SLOT_HOLD_MS;
        }
      });
      const removableSlots = kindSlots.filter(
        (slot) => slot.dynamic && !slot.inUse && slot.status !== "warming" && (slot.holdUntil ?? 0) <= now
      );

      for (const slot of removableSlots) {
        if (this.slots.filter((item) => item.kind === kind).length <= minSlots) {
          break;
        }

        const index = this.slots.indexOf(slot);

        if (index >= 0) {
          this.removeSlot(slot);
          log(`pool shrink | ${this.formatSlot(slot)} | n=${this.slots.filter((item) => item.kind === kind).length}`);
        }
      }
    }
  }

  private removeSlot(slot: AgesPoolSlot): void {
    const index = this.slots.indexOf(slot);

    if (index >= 0) {
      this.slots.splice(index, 1);
    }
  }

  private createSlot(kind: AgesPoolSlotKind, dynamic: boolean): AgesPoolSlot {
    const endpoint = kind === "mini" ? "/~mini~/dummy_val.ages" : "dummy_val.ages";
    const backend = chooseLeastLoadedBackend(
      this.backendConfiguration.backends.filter((item) => !dynamic || this.backendStates.get(item.id)?.state === "active"),
      this.slots.map((slot) => slot.backendId)
    );

    return {
      id: this.nextSlotId++,
      backendId: backend.id,
      kind,
      endpoint,
      url: resolveBackendEndpoint(backend.baseUrl, endpoint),
      warmupResponse: "",
      agesToken: "",
      aspNetSessionId: "",
      status: "idle",
      inUse: false,
      maintenanceInFlight: 0,
      dynamic,
      holdUntil: dynamic ? Date.now() + ADAPTIVE_SLOT_HOLD_MS : undefined
    };
  }

  private getInitialSlots(kind: AgesPoolSlotKind): number {
    return kind === "mini" ? INITIAL_MINI_SLOTS : INITIAL_BIGB_SLOTS;
  }

  private getMaxSlots(kind: AgesPoolSlotKind): number {
    return kind === "mini" ? MAX_MINI_SLOTS : MAX_BIGB_SLOTS;
  }

  private getSlotCount(kind: AgesPoolSlotKind): number {
    return this.slots.filter((slot) => slot.kind === kind).length;
  }

  private createTimingTrace(
    kind: AgesPoolSlotKind,
    method: string,
    url: string,
    sourceIp: string,
    sourceIpSource: string,
    brokerInMs: number
  ): AgesTimingTrace {
    const trace: AgesTimingTrace = {
      id: this.createTraceId(),
      entryType: "proxy",
      kind,
      method,
      url: this.formatUrl(url),
      sourceIp,
      sourceIpSource,
      brokerInAt: new Date(brokerInMs).toISOString()
    };

    this.pushTimingTrace(trace);

    return trace;
  }

  private pushTimingTrace(trace: AgesTimingTrace): void {
    this.timingLog.push(trace);

    while (this.timingLog.length > 500) {
      this.timingLog.shift();
    }
  }

  private pushTimingEvent(message: string, errorDetail?: string): void {
    this.pushTimingTrace({
      id: this.createTraceId(),
      entryType: "event",
      method: "EVENT",
      url: message,
      sourceIp: "system",
      sourceIpSource: "broker",
      brokerInAt: new Date().toISOString(),
      brokerOutAt: new Date().toISOString(),
      totalMs: 0,
      error: errorDetail
    });
  }

  private recordDamagedSlotRetry(
    slot: AgesPoolSlot,
    reason: string,
    attempt: number,
    nextSlotWillBeAdaptive: boolean
  ): void {
    const nextTarget = nextSlotWillBeAdaptive ? "adaptive" : "existing";
    const message = [
      "damaged-slot retry",
      this.formatSlot(slot),
      `kind=${this.formatKind(slot.kind)}`,
      `attempt=${attempt}`,
      `next=${nextTarget}`
    ].join(" | ");

    warn(`${message} | err=${reason}`);
    this.pushTimingTrace({
      id: this.createTraceId(),
      entryType: "event",
      kind: slot.kind,
      method: "RETRY",
      url: message,
      sourceIp: "system",
      sourceIpSource: "broker",
      slot: this.formatSlot(slot),
      slotDynamic: slot.dynamic,
      brokerInAt: new Date().toISOString(),
      brokerOutAt: new Date().toISOString(),
      totalMs: 0,
      error: reason
    });
  }

  private async recycleDamagedSlot(slot: AgesPoolSlot, agesUrl: string): Promise<void> {
    try {
      await this.recycleSlot(slot, agesUrl);
    } catch (error) {
      warn(`damaged-slot recycle fail | ${this.formatSlot(slot)} | err=${formatError(error)}`);
      this.pushTimingEvent(`damaged-slot recycle fail: ${this.formatSlot(slot)}`, formatError(error));
    }
  }

  private completeTimingTrace(trace: AgesTimingTrace): void {
    if (!trace.brokerOutAt) {
      trace.brokerOutAt = new Date().toISOString();
    }

    trace.totalMs = Date.parse(trace.brokerOutAt) - Date.parse(trace.brokerInAt);
  }

  private buildTraceHeaders(trace: AgesTimingTrace): Record<string, string> {
    return {
      "X-CH09-BRK-Trace-Id": trace.id,
      "X-CH09-BRK-Broker-In": trace.brokerInAt,
      "X-CH09-BRK-Slot-Acquired": trace.slotAcquiredAt ?? "",
      "X-CH09-BRK-AGES-Start": trace.agesStartAt ?? "",
      "X-CH09-BRK-AGES-End": trace.agesEndAt ?? "",
      "X-CH09-BRK-Wait-Ms": String(trace.waitMs ?? 0),
      "X-CH09-BRK-AGES-Ms": String(trace.agesMs ?? 0),
      "X-CH09-BRK-Slot-Dynamic": String(trace.slotDynamic ?? false)
    };
  }

  private createTraceId(): string {
    this.traceSequence = (this.traceSequence + 1) % 1_000_000;

    return `${Date.now().toString(36)}-${this.traceSequence.toString().padStart(6, "0")}`;
  }

  private getKindSummary(kind: AgesPoolSlotKind): AgesPoolKindSummary {
    const slots = this.slots.filter((slot) => slot.kind === kind);
    const dynamicSlots = slots.filter((slot) => slot.dynamic);

    return {
      kind,
      base: this.getInitialSlots(kind),
      current: slots.length,
      ready: slots.filter((slot) => slot.status === "ready").length,
      inUse: slots.filter((slot) => slot.inUse).length,
      dynamic: dynamicSlots.length,
      dynamicReady: dynamicSlots.filter((slot) => slot.status === "ready").length,
      dynamicInUse: dynamicSlots.filter((slot) => slot.inUse).length,
      max: this.getMaxSlots(kind),
      waiting: this.slotWaiters[kind].length,
      holdMinutes: ADAPTIVE_SLOT_HOLD_MS / 60 / 1000
    };
  }

  private isInternalBeatEndpoint(kind: AgesPoolSlotKind, endpoint: string): boolean {
    return kind === "mini" && endpoint.replace(/^\/+/, "").toLowerCase() === "~mini~/beat.ages";
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

  private resolveSlotEndpoint(slot: AgesPoolSlot, endpoint: string): string {
    const backend = this.backendConfiguration.backends.find((item) => item.id === slot.backendId);
    return resolveBackendEndpoint(backend?.baseUrl ?? this.baseUrl, endpoint);
  }

  private isBackendActive(slot: AgesPoolSlot): boolean {
    return this.backendStates.get(slot.backendId)?.state === "active";
  }

  private isBackendRoutable(slot: AgesPoolSlot): boolean {
    const state = this.backendStates.get(slot.backendId)?.state;
    // Only global warmup admits ready sessions incrementally; directed recycle stays isolated.
    return state === "active" || state === "degraded" ||
      (state === "warming" && Boolean(this.warmupPromise) && slot.status === "ready");
  }

  private isBackendAvailableForMaintenance(slot: AgesPoolSlot): boolean {
    const state = this.backendStates.get(slot.backendId)?.state;
    return state === "active" || state === "degraded";
  }

  private restoreBackendHealthIfRecovered(id: AgesBackendId): void {
    const backend = this.backendStates.get(id);
    if (backend?.state !== "degraded") return;

    const failed = this.slots.find((slot) => slot.backendId === id && slot.status !== "ready");
    if (failed) {
      backend.lastError = failed.lastError;
      return;
    }

    backend.state = "active";
    backend.lastError = undefined;
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
    slot.lastResponseBody = body.toString("utf8");
    slot.lastResponsePreview = this.previewBody(body);
  }

  private clearSlotForWarmup(slot: AgesPoolSlot): void {
    slot.agesToken = "";
    slot.aspNetSessionId = "";
    slot.warmupResponse = "";
    slot.lastResponsePreview = undefined;
    slot.lastResponseBody = undefined;
    slot.lastEndpoint = undefined;
    slot.lastUsedAt = undefined;
    slot.lastStatusCode = undefined;
    slot.lastInitializedAt = undefined;
    slot.lastError = undefined;
    slot.inUse = false;
  }

  private prepareSlotsForWarmup(slots: AgesPoolSlot[]): void {
    slots.forEach((slot) => {
      this.clearSlotForWarmup(slot);
      slot.status = "warming";
    });
  }

  private previewBody(body: Buffer): string {
    return body.toString("utf8").replace(/\s+/g, " ").trim().slice(0, 100);
  }

  private formatHeaderNames(headers?: Record<string, string | string[]>): string {
    const names = Object.keys(headers ?? {}).sort();

    return names.length > 0 ? names.join(",") : "none";
  }

  private getRecycleReason(status: number, body: Buffer): string {
    const avfpInvalidObjectReason = this.getAvfpInvalidObjectReason(body);

    if (avfpInvalidObjectReason) {
      return avfpInvalidObjectReason;
    }

    if (status >= 500) {
      return `proxy returned status ${status}`;
    }

    const responseText = body.toString("utf8");

    if (/Desde el SCRIPT:\s*(SERVICIOS_AVFP_MINI|SAVFP)\s+no es un objeto/i.test(responseText)) {
      return "AGES script object error";
    }

    return "";
  }

  private getAvfpInvalidObjectReason(body: Buffer): string {
    return /OSAVFP\s+no es un objeto/i.test(body.toString("utf8")) ? "AGES OSAVFP object error" : "";
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

  private async runDirectedRecycle(
    id: AgesBackendId,
    backend: { state: AgesBackendState; lastError?: string }
  ): Promise<AgesPoolSummary> {
    const slots = this.slots.filter((slot) => slot.backendId === id);
    backend.state = "draining";
    try {
      await this.waitForDrain(slots, `backend ${id}`);
      backend.state = "recycling";
      await this.recycleExecutor(id);
      backend.state = "warming";
      this.prepareSlotsForWarmup(slots);
      const deadline = Date.now() + this.drainTimeoutMs;
      while (slots.some((slot) => slot.status !== "ready") && Date.now() < deadline) {
        for (const slot of slots.filter((item) => item.status !== "ready")) await this.initializeSlot(slot);
        if (slots.some((slot) => slot.status !== "ready")) await delay(this.pollMs);
      }
      const failed = slots.find((slot) => slot.status !== "ready");
      if (failed) throw new Error(failed.lastError ?? `backend ${id} warmup timeout`);
      backend.state = "active";
      backend.lastError = undefined;
      this.notifySlotWaiters("mini");
      this.notifySlotWaiters("bigb");
      return this.getSummary();
    } catch (error) {
      backend.state = "degraded";
      backend.lastError = formatError(error);
      throw error;
    }
  }

  private async waitForDrain(slots: AgesPoolSlot[], label: string): Promise<void> {
    const deadline = Date.now() + this.drainTimeoutMs;
    while (slots.some((slot) => slot.inUse || slot.maintenanceInFlight > 0)) {
      if (Date.now() >= deadline) throw new Error(`${label} drain timeout`);
      await delay(this.pollMs);
    }
  }

  private async recycleBackendAppPool(id: AgesBackendId): Promise<void> {
    if (!AGES_SSH_HOST || !AGES_SSH_USER) throw new Error("AGES SSH target is not configured");
    validateSshPrivateKey(AGES_SSH_KEY_PATH);
    const pool = resolveIisAppPoolName(id, process.env);
    const command = `powershell -NoProfile -NonInteractive -Command "Import-Module WebAdministration; Restart-WebAppPool -Name '${pool}'"`;
    await execFileAsync("ssh", ["-i", AGES_SSH_KEY_PATH, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new", `${AGES_SSH_USER}@${AGES_SSH_HOST}`, command],
    { timeout: AGES_SSH_COMMAND_TIMEOUT_MS });
  }

  private async restartAgesHost(reason: string): Promise<boolean> {
    const now = Date.now();

    if (this.agesHostRestartRunning) {
      warn(`ages restart skip | reason=${reason} | err=restart already running`);
      return false;
    }

    if (now < this.agesHostRestartCooldownUntil) {
      const remainingSeconds = Math.ceil((this.agesHostRestartCooldownUntil - now) / 1000);
      warn(`ages restart skip | reason=${reason} | err=cooldown | left=${remainingSeconds}s`);
      this.pushTimingEvent(`IIS restart cooldown: ${reason}`, `${remainingSeconds}s`);
      return false;
    }

    if (!AGES_SSH_HOST || !AGES_SSH_USER) {
      warn(`ages restart skip | reason=${reason} | err=missing AGES_SSH_HOST or AGES_SSH_USER`);
      return false;
    }

    try {
      validateSshPrivateKey(AGES_SSH_KEY_PATH);
    } catch (error) {
      warn(`ages restart skip | reason=${reason} | err=${formatError(error)}`);
      return false;
    }

    this.agesHostRestartRunning = true;
    this.agesHostRestartCooldownUntil = now + AGES_IIS_RESTART_COOLDOWN_MS;
    this.lastAgesHostRestartStartedAt = new Date(now).toISOString();
    warn(`ages restart start | host=${AGES_SSH_HOST} | user=${AGES_SSH_USER} | reason=${reason}`);
    this.pushTimingEvent(`IIS restart start: ${reason}`);
    void this.notifyAgesRestart(reason);

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
      this.pushTimingEvent(`IIS restart ok: ${reason}`);
      void this.warmUp(`host restart ${reason}`);
      return true;
    } catch (error) {
      warn(`ages restart fail | host=${AGES_SSH_HOST} | reason=${reason} | err=${formatError(error)}`);
      this.pushTimingEvent(`IIS restart fail: ${reason}`, formatError(error));
      return false;
    } finally {
      this.lastAgesHostRestartFinishedAt = new Date().toISOString();
      this.agesHostRestartRunning = false;
    }
  }

  private async notifyAgesRestart(reason: string): Promise<void> {
    await sendDebugMail(
      "CH09-BRK IIS restart",
      [
        `CH09-BRK detecto ${reason} y lanzo reinicio de IIS.`,
        `Host: ${AGES_SSH_HOST}`,
        `AGES: ${this.baseUrl}`,
        `Fecha: ${new Date().toISOString()}`
      ].join("\n")
    );
  }

  private async resetPoolForWarmup(reason: string): Promise<void> {
    warn(`warmup reset | reason=${reason}`);

    this.initialWarmupFinished = false;
    this.prepareSlotsForWarmup(this.slots);
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

function readEnvFileValue(name: string): string {
  try {
    const envText = readFileSync("/app/.env", "utf8");
    const match = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

function hasHeader(headers: Record<string, string>, headerName: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === headerName.toLowerCase());
}

function getEnvMaxSlotCount(envName: string, minimum: number): number {
  const value = getEnvSlotCount(envName, minimum);

  if (value < minimum) {
    warn(`Invalid ${envName}="${process.env[envName]}". Using minimum ${minimum}.`);
    return minimum;
  }

  return value;
}

function getEnvDurationMinutes(envName: string, fallback: number): number {
  const rawValue = process.env[envName];

  if (!rawValue) {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value) || value < 1) {
    warn(`Invalid ${envName}="${rawValue}". Using fallback ${fallback}.`);
    return fallback;
  }

  return value;
}

function getEnvDurationSeconds(envName: string, fallback: number): number {
  const rawValue = process.env[envName];

  if (!rawValue) {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(value) || value < 1) {
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

function validateSshPrivateKey(path: string): void {
  let keyStat;
  try {
    keyStat = statSync(path);
  } catch {
    throw new Error(`AGES SSH private key is unavailable at ${path}`);
  }
  if (!keyStat.isFile() || keyStat.size === 0) {
    throw new Error(`AGES SSH private key is not a non-empty regular file at ${path}`);
  }
  if (process.platform !== "win32" && (keyStat.mode & 0o077) !== 0) {
    throw new Error(`AGES SSH private key permissions are too open at ${path}`);
  }
}

export function resolveBackendConfiguration(
  env: { HAAGES_A?: string; HAAGES_B?: string },
  legacyBaseUrl = AGES_BASE_URL
): AgesBackendConfiguration {
  const backendA = env.HAAGES_A?.trim() ?? "";
  const backendB = env.HAAGES_B?.trim() ?? "";
  if (Boolean(backendA) !== Boolean(backendB)) {
    throw new Error("HAAGES_A and HAAGES_B must be configured together");
  }
  if (!backendA) {
    return { mode: "legacy", backends: [{ id: "legacy", baseUrl: legacyBaseUrl }] };
  }
  for (const value of [backendA, backendB]) {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`Invalid AGES backend URL: ${value}`);
  }
  return { mode: "dual", backends: [{ id: "A", baseUrl: backendA }, { id: "B", baseUrl: backendB }] };
}

export function chooseLeastLoadedBackend(
  backends: AgesBackendConfiguration["backends"],
  assigned: AgesBackendId[]
): AgesBackendConfiguration["backends"][number] {
  if (backends.length === 0) throw new Error("No active AGES backend is available for adaptive growth");
  return backends.reduce((best, candidate) =>
    assigned.filter((id) => id === candidate.id).length < assigned.filter((id) => id === best.id).length
      ? candidate
      : best
  );
}

export function resolveIisAppPoolName(id: AgesBackendId, env: NodeJS.ProcessEnv): string {
  const value = (id === "A" ? env.AGES_IIS_APP_POOL_A : env.AGES_IIS_APP_POOL_B)?.trim() ?? "";
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value)) throw new Error(`Invalid IIS AppPool name for backend ${id}`);
  return value;
}

function resolveBackendEndpoint(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export const agesConnectionPool = new AgesConnectionPool();
