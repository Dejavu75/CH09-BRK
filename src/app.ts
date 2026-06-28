import express, { json, raw } from "express";
import { existsSync, readFileSync } from "fs";
import http from "http";
import https from "https";
import path from "path";
import { DoormanController, getFullCors, getServingConfig } from "se_configbase";

import { BrokerRouter } from "./routes/rou_broker";
import { agesConnectionPool } from "./services/ages_pool";
import { error, isConfigEnabled, log } from "./utils/logger";

const doorMan = DoormanController.getInstance();
const app = express();
const certbotWebroot = process.env.CERTBOT_WEBROOT ?? "/app/certbot-www";
const certificateRoot = process.env.CERT_PATH_CONTAINER ?? "/app/certificados";

app.set("trust proxy", true);
app.use(
  "/.well-known/acme-challenge",
  express.static(`${certbotWebroot}/.well-known/acme-challenge`, {
    dotfiles: "allow",
    fallthrough: true
  })
);
app.use(["/foreign/broker/ages", "/ages"], raw({ type: "*/*" }));
app.use(json());
app.disable("x-powered-by");
app.use(getFullCors());

app.use("/foreign/broker", BrokerRouter);
app.use("/ages", BrokerRouter);

app.use(doorMan.getSession.bind(doorMan));

app.get("/foreign", (_req, res) => {
  res.send("Hello from CH09-BRK - Broker !!!");
});

app.get("/", (_req, res) => {
  res.send("Hello from CH09-BRK !!!");
});

app.use((req, res) => {
  if (!isConfigEnabled("HIDE_404")) {
    error(`404 | m=${req.method.padEnd(4)} | u=${req.originalUrl}`);
  }
  res.status(404).send(`<h1>La direccion ${req.originalUrl} no fue encontrada</h1>`);
});

const config = getServingConfig();
const httpServer = http.createServer(app);

httpServer.listen(config.port, () => {
  log(`CH09-BRK HTTP Server running on port ${config.port}`);
  void agesConnectionPool.warmUp().then((summary) => {
    log(`AGES pool warmup finished: ${summary.ready}/${summary.size} ready`);
    agesConnectionPool.startPingMonitor();
  });
});

const sslConfig = getSslConfig();

if (sslConfig.ready) {
  const httpsServer = https.createServer(
    {
      cert: readFileSync(sslConfig.certPath),
      key: readFileSync(sslConfig.keyPath)
    },
    app
  );

  httpsServer.listen(sslConfig.port, () => {
    log(`CH09-BRK HTTPS Server running on port ${sslConfig.port} | cert=${sslConfig.certPath}`);
  });
} else {
  log(`CH09-BRK HTTPS Server not started: ${sslConfig.reason} | ${formatSslConfigLog(sslConfig)}`);
}

type SslConfig = {
  certExists: boolean;
  certPath: string;
  domain: string;
  keyExists: boolean;
  keyPath: string;
  port: number;
  ready: boolean;
  reason: string;
};

function getSslConfig(): SslConfig {
  const domain = process.env.SSL_CERT_DOMAIN ?? process.env.CERTBOT_DOMAIN;
  const certPath = process.env.SSL_CERT_PATH ?? (domain ? path.join(certificateRoot, "live", domain, "fullchain.pem") : "");
  const keyPath = process.env.SSL_KEY_PATH ?? (domain ? path.join(certificateRoot, "live", domain, "privkey.pem") : "");
  const port = Number.parseInt(process.env.PORT_SSL ?? "44048", 10);
  const certExists = certPath ? existsSync(certPath) : false;
  const keyExists = keyPath ? existsSync(keyPath) : false;

  if (!domain && (!process.env.SSL_CERT_PATH || !process.env.SSL_KEY_PATH)) {
    return {
      certExists,
      certPath,
      domain: domain ?? "",
      keyExists,
      keyPath,
      port,
      ready: false,
      reason: "domain and explicit SSL paths missing"
    };
  }

  if (!Number.isInteger(port) || port < 1) {
    error(`Invalid PORT_SSL="${process.env.PORT_SSL}". HTTPS server not started.`);
    return {
      certExists,
      certPath,
      domain: domain ?? "",
      keyExists,
      keyPath,
      port,
      ready: false,
      reason: "invalid PORT_SSL"
    };
  }

  if (!certExists || !keyExists) {
    return {
      certExists,
      certPath,
      domain: domain ?? "",
      keyExists,
      keyPath,
      port,
      ready: false,
      reason: "certificate not found"
    };
  }

  return {
    certExists,
    certPath,
    domain: domain ?? "",
    keyExists,
    keyPath,
    port,
    ready: true,
    reason: "ready"
  };
}

function formatSslConfigLog(config: SslConfig): string {
  return [
    `domain=${config.domain || "(empty)"}`,
    `port=${Number.isNaN(config.port) ? "NaN" : config.port}`,
    `cert=${config.certPath || "(empty)"}`,
    `certExists=${config.certExists}`,
    `key=${config.keyPath || "(empty)"}`,
    `keyExists=${config.keyExists}`,
    `certRoot=${certificateRoot}`,
    `certbotWebroot=${certbotWebroot}`,
    `SSL_CERT_DOMAIN=${process.env.SSL_CERT_DOMAIN ?? "(unset)"}`,
    `CERTBOT_DOMAIN=${process.env.CERTBOT_DOMAIN ?? "(unset)"}`,
    `SSL_CERT_PATH=${process.env.SSL_CERT_PATH ?? "(unset)"}`,
    `SSL_KEY_PATH=${process.env.SSL_KEY_PATH ?? "(unset)"}`
  ].join(" | ");
}
