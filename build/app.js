"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importStar(require("express"));
const http_1 = __importDefault(require("http"));
const se_configbase_1 = require("se_configbase");
const rou_broker_1 = require("./routes/rou_broker");
const ages_pool_1 = require("./services/ages_pool");
const logger_1 = require("./utils/logger");
const doorMan = se_configbase_1.DoormanController.getInstance();
const app = (0, express_1.default)();
app.set("trust proxy", true);
app.use(["/foreign/broker/ages", "/ages"], (0, express_1.raw)({ type: "*/*" }));
app.use((0, express_1.json)());
app.disable("x-powered-by");
app.use((0, se_configbase_1.getFullCors)());
app.use(doorMan.getSession.bind(doorMan));
app.use("/foreign/broker", rou_broker_1.BrokerRouter);
app.use("/ages", rou_broker_1.BrokerRouter);
app.get("/foreign", (_req, res) => {
    res.send("Hello from CH09-BRK - Broker !!!");
});
app.get("/", (_req, res) => {
    res.send("Hello from CH09-BRK !!!");
});
app.use((req, res) => {
    if (!(0, logger_1.isConfigEnabled)("HIDE_404")) {
        (0, logger_1.error)(`404 | m=${req.method.padEnd(4)} | u=${req.originalUrl}`);
    }
    res.status(404).send(`<h1>La direccion ${req.originalUrl} no fue encontrada</h1>`);
});
const config = (0, se_configbase_1.getServingConfig)();
const httpServer = http_1.default.createServer(app);
httpServer.listen(config.port, () => {
    (0, logger_1.log)(`CH09-BRK HTTP Server running on port ${config.port}`);
    void ages_pool_1.agesConnectionPool.warmUp().then((summary) => {
        (0, logger_1.log)(`AGES pool warmup finished: ${summary.ready}/${summary.size} ready`);
        ages_pool_1.agesConnectionPool.startPingMonitor();
    });
});
