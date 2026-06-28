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
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importStar(require("express"));
const fs_1 = require("fs");
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const path_1 = __importDefault(require("path"));
const se_configbase_1 = require("se_configbase");
const rou_broker_1 = require("./routes/rou_broker");
const ages_pool_1 = require("./services/ages_pool");
const logger_1 = require("./utils/logger");
const doorMan = se_configbase_1.DoormanController.getInstance();
const app = (0, express_1.default)();
const certbotWebroot = (_a = process.env.CERTBOT_WEBROOT) !== null && _a !== void 0 ? _a : "/app/certbot-www";
const certificateRoot = (_b = process.env.CERT_PATH_CONTAINER) !== null && _b !== void 0 ? _b : "/app/certificados";
app.set("trust proxy", true);
app.use("/.well-known/acme-challenge", express_1.default.static(`${certbotWebroot}/.well-known/acme-challenge`, {
    dotfiles: "allow",
    fallthrough: true
}));
app.use(["/foreign/broker/ages", "/ages"], (0, express_1.raw)({ type: "*/*" }));
app.use((0, express_1.json)());
app.disable("x-powered-by");
app.use((0, se_configbase_1.getFullCors)());
app.use("/foreign/broker", rou_broker_1.BrokerRouter);
app.use("/ages", rou_broker_1.BrokerRouter);
app.use(doorMan.getSession.bind(doorMan));
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
const sslConfig = getSslConfig();
if (sslConfig.ready) {
    const httpsServer = https_1.default.createServer({
        cert: (0, fs_1.readFileSync)(sslConfig.certPath),
        key: (0, fs_1.readFileSync)(sslConfig.keyPath)
    }, app);
    httpsServer.listen(sslConfig.port, () => {
        (0, logger_1.log)(`CH09-BRK HTTPS Server running on port ${sslConfig.port} | cert=${sslConfig.certPath}`);
    });
}
else {
    (0, logger_1.log)(`CH09-BRK HTTPS Server not started: ${sslConfig.reason} | ${formatSslConfigLog(sslConfig)}`);
}
function getSslConfig() {
    var _a, _b, _c, _d;
    const domain = (_a = process.env.SSL_CERT_DOMAIN) !== null && _a !== void 0 ? _a : process.env.CERTBOT_DOMAIN;
    const certPath = (_b = process.env.SSL_CERT_PATH) !== null && _b !== void 0 ? _b : (domain ? path_1.default.join(certificateRoot, "live", domain, "fullchain.pem") : "");
    const keyPath = (_c = process.env.SSL_KEY_PATH) !== null && _c !== void 0 ? _c : (domain ? path_1.default.join(certificateRoot, "live", domain, "privkey.pem") : "");
    const port = Number.parseInt((_d = process.env.PORT_SSL) !== null && _d !== void 0 ? _d : "44048", 10);
    const certExists = certPath ? (0, fs_1.existsSync)(certPath) : false;
    const keyExists = keyPath ? (0, fs_1.existsSync)(keyPath) : false;
    if (!domain && (!process.env.SSL_CERT_PATH || !process.env.SSL_KEY_PATH)) {
        return {
            certExists,
            certPath,
            domain: domain !== null && domain !== void 0 ? domain : "",
            keyExists,
            keyPath,
            port,
            ready: false,
            reason: "domain and explicit SSL paths missing"
        };
    }
    if (!Number.isInteger(port) || port < 1) {
        (0, logger_1.error)(`Invalid PORT_SSL="${process.env.PORT_SSL}". HTTPS server not started.`);
        return {
            certExists,
            certPath,
            domain: domain !== null && domain !== void 0 ? domain : "",
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
            domain: domain !== null && domain !== void 0 ? domain : "",
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
        domain: domain !== null && domain !== void 0 ? domain : "",
        keyExists,
        keyPath,
        port,
        ready: true,
        reason: "ready"
    };
}
function formatSslConfigLog(config) {
    var _a, _b, _c, _d;
    return [
        `domain=${config.domain || "(empty)"}`,
        `port=${Number.isNaN(config.port) ? "NaN" : config.port}`,
        `cert=${config.certPath || "(empty)"}`,
        `certExists=${config.certExists}`,
        `key=${config.keyPath || "(empty)"}`,
        `keyExists=${config.keyExists}`,
        `certRoot=${certificateRoot}`,
        `certbotWebroot=${certbotWebroot}`,
        `SSL_CERT_DOMAIN=${(_a = process.env.SSL_CERT_DOMAIN) !== null && _a !== void 0 ? _a : "(unset)"}`,
        `CERTBOT_DOMAIN=${(_b = process.env.CERTBOT_DOMAIN) !== null && _b !== void 0 ? _b : "(unset)"}`,
        `SSL_CERT_PATH=${(_c = process.env.SSL_CERT_PATH) !== null && _c !== void 0 ? _c : "(unset)"}`,
        `SSL_KEY_PATH=${(_d = process.env.SSL_KEY_PATH) !== null && _d !== void 0 ? _d : "(unset)"}`
    ].join(" | ");
}
