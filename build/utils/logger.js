"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
exports.warn = warn;
exports.error = error;
exports.sendDebugMail = sendDebugMail;
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
function sendDebugMail(subject, text) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const result = yield se_configbase_1.AgesLog.sendMailDebug(subject, text, "", "");
            se_configbase_1.AgesLog.log(`mail debug ok | subject=${subject} | result=${result}`);
        }
        catch (mailError) {
            se_configbase_1.AgesLog.warn(`mail debug fail | subject=${subject} | err=${mailError instanceof Error ? mailError.message : String(mailError)}`);
        }
    });
}
function isConfigEnabled(name) {
    var _a;
    return ["1", "true", "yes", "on", "enabled"].includes(((_a = process.env[name]) !== null && _a !== void 0 ? _a : "").trim().toLowerCase());
}
