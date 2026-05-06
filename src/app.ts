import express, { json, raw } from "express";
import http from "http";
import { DoormanController, getFullCors, getServingConfig } from "se_configbase";

import { BrokerRouter } from "./routes/rou_broker";
import { agesConnectionPool } from "./services/ages_pool";
import { error, isConfigEnabled, log } from "./utils/logger";

const doorMan = DoormanController.getInstance();
const app = express();

app.set("trust proxy", true);
app.use(["/foreign/broker/ages", "/ages"], raw({ type: "*/*" }));
app.use(json());
app.disable("x-powered-by");
app.use(getFullCors());
app.use(doorMan.getSession.bind(doorMan));

app.use("/foreign/broker", BrokerRouter);
app.use("/ages", BrokerRouter);

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
