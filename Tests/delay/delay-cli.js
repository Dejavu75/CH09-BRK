#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const envPath = path.join(__dirname, ".env");
const env = readEnvFile(envPath);
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const config = {
  server: normalizeServer(args.server ?? env.SERVER ?? env.TEST_SERVER ?? "http://merclin.gotdns.org"),
  delay: readNumber(args.delay ?? env.DELAY_MS ?? env.DELAY ?? 3000, "delay"),
  count: readNumber(args.count ?? env.COUNT ?? 10, "count"),
  timeout: readNumber(args.timeout ?? env.TIMEOUT_MS ?? env.TIMEOUT ?? 30000, "timeout"),
  parallel: args.sync ? false : true,
  endpoint: args.endpoint ?? env.ENDPOINT ?? "/ages/~mini~/delay.ages"
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

async function main() {
  console.log(
    [
      `server=${config.server}`,
      `endpoint=${config.endpoint}`,
      `delay=${config.delay}ms`,
      `count=${config.count}`,
      `timeout=${config.timeout}ms`,
      `mode=${config.parallel ? "parallel" : "sync"}`
    ].join(" | ")
  );

  const batchStart = performance.now();
  const calls = [];

  if (config.parallel) {
    for (let index = 1; index <= config.count; index += 1) {
      calls.push(callEndpoint(index, batchStart).then((row) => {
        printRow(row);
        return row;
      }));
    }
  } else {
    for (let index = 1; index <= config.count; index += 1) {
      const row = await callEndpoint(index, batchStart);
      printRow(row);
      calls.push(Promise.resolve(row));
    }
  }

  const rows = await Promise.all(calls);
  const total = performance.now() - batchStart;
  printSummary(rows, total);
}

async function callEndpoint(index, batchStart) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);
  const start = performance.now();
  const startOffset = start - batchStart;
  const url = buildUrl(index);
  const testId = `delay-cli-${Date.now()}-${index}`;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "X-CH09-BRK-Test-Id": testId,
        "X-CH09-BRK-Test-Start": new Date().toISOString()
      }
    });
    const text = await response.text();
    const end = performance.now();
    const brokerTotalMs = getHeaderNumber(response, "X-CH09-BRK-Total-Ms");

    return {
      index,
      ok: response.ok,
      status: response.status,
      slot: response.headers.get("X-CH09-BRK-Pool-Slot") ?? "-",
      trace: response.headers.get("X-CH09-BRK-Trace-Id") ?? "-",
      startOffset,
      endOffset: end - batchStart,
      clientMs: end - start,
      brokerMs: brokerTotalMs,
      brokerInOffset: brokerTotalMs === null ? null : end - batchStart - brokerTotalMs,
      waitMs: getHeaderNumber(response, "X-CH09-BRK-Wait-Ms"),
      agesMs: getHeaderNumber(response, "X-CH09-BRK-AGES-Ms"),
      bytes: text.length,
      response: text,
      error: response.ok ? "" : response.statusText
    };
  } catch (error) {
    const end = performance.now();

    return {
      index,
      ok: false,
      status: "-",
      slot: "-",
      trace: "-",
      startOffset,
      brokerInOffset: null,
      endOffset: end - batchStart,
      clientMs: end - start,
      brokerMs: null,
      waitMs: null,
      agesMs: null,
      bytes: 0,
      response: "",
      error: error?.name === "AbortError" ? `Timeout ${config.timeout} ms` : String(error?.message ?? error)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function printRow(row) {
  const values = [
    pad(row.index, 2),
    row.ok ? "OK " : "ERR",
    pad(row.status, 3),
    pad(row.slot, 2),
    ms(row.startOffset),
    ms(row.brokerInOffset),
    ms(row.endOffset),
    ms(row.clientMs),
    ms(row.brokerMs),
    ms(row.waitMs),
    ms(row.agesMs),
    pad(row.bytes, 5),
    row.trace,
    preview(row.response || row.error)
  ];

  console.log(values.join(" | "));
}

function printSummary(rows, total) {
  const okRows = rows.filter((row) => row.ok);
  const avgClient = average(okRows.map((row) => row.clientMs));
  const avgBroker = average(okRows.map((row) => row.brokerMs).filter((value) => value !== null));
  const maxGap = Math.max(
    0,
    ...okRows.map((row) => row.brokerMs === null ? 0 : row.clientMs - row.brokerMs)
  );

  console.log("");
  console.log(`total=${ms(total)} | ok=${okRows.length}/${rows.length} | avgClient=${ms(avgClient)} | avgBroker=${ms(avgBroker)} | maxClientMinusBroker=${ms(maxGap)}`);
}

function buildUrl(index) {
  const url = new URL(`${config.server}${normalizePath(config.endpoint)}`);
  url.searchParams.set("delay", String(config.delay));
  url.searchParams.set("_request", String(index));
  url.searchParams.set("_ts", String(Date.now()));
  return url.toString();
}

function getHeaderNumber(response, header) {
  const value = response.headers.get(header);
  const number = value === null ? NaN : Number(value);
  return Number.isFinite(number) ? number : null;
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((result, line) => {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        return result;
      }

      const equalIndex = trimmed.indexOf("=");

      if (equalIndex < 0) {
        return result;
      }

      const key = trimmed.slice(0, equalIndex).trim();
      const value = trimmed.slice(equalIndex + 1).trim();
      result[key] = value.replace(/^["']|["']$/g, "");
      return result;
    }, {});
}

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }

    if (arg === "--sync") {
      result.sync = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, rawValue] = arg.slice(2).split("=", 2);
    const key = toCamelCase(rawKey);
    result[key] = rawValue ?? argv[index + 1];

    if (rawValue === undefined) {
      index += 1;
    }
  }

  return result;
}

function readNumber(value, name) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Parametro invalido: ${name}=${value}`);
  }

  return number;
}

function normalizeServer(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function normalizePath(value) {
  const pathValue = String(value || "").trim();
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ms(value) {
  return value === null || value === undefined ? "     -" : `${Number(value).toFixed(0).padStart(6)}ms`;
}

function pad(value, length) {
  return String(value).padStart(length, " ");
}

function preview(value) {
  return String(value ?? "").replace(/\s+/g, " ").slice(0, 80);
}

function printHelp() {
  console.log(`Uso:
  node Tests/delay/delay-cli.js [opciones]

Opciones:
  --server <url>       Default: SERVER/TEST_SERVER del .env o http://merclin.gotdns.org
  --endpoint <path>    Default: /ages/~mini~/delay.ages
  --delay <ms>         Default: 3000
  --count <n>          Default: 10
  --timeout <ms>       Default: 30000
  --sync               Ejecuta secuencial en vez de paralelo
  --help               Muestra esta ayuda

Columnas:
  # | estado | http | slot | inicio | brokerIn | fin | cliente | broker | espera | AGES | bytes | trace | respuesta
`);
}
