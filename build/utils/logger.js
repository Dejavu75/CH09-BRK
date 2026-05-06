"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
exports.warn = warn;
exports.error = error;
exports.isConfigEnabled = isConfigEnabled;
require("dotenv/config");
const se_configbase_1 = require("se_configbase");
function log(message) {
    se_configbase_1.AgesLog.log(message);
}
function warn(message) {
    se_configbase_1.AgesLog.warn(message);
}
function error(message) {
    se_configbase_1.AgesLog.error(message);
}
function isConfigEnabled(name) {
    var _a;
    return ["1", "true", "yes", "on", "enabled"].includes(((_a = process.env[name]) !== null && _a !== void 0 ? _a : "").trim().toLowerCase());
}
