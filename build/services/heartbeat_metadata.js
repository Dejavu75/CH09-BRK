"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureHeartbeatExtraData = configureHeartbeatExtraData;
exports.buildHeartbeatExtraData = buildHeartbeatExtraData;
const build_info_1 = require("../generated/build_info");
function configureHeartbeatExtraData(environment = process.env) {
    const extraData = buildHeartbeatExtraData(environment.MSEXTRADATA, environment);
    environment.MSEXTRADATA = extraData;
    return extraData;
}
function buildHeartbeatExtraData(existingExtraData, environment) {
    const existing = parseExtraData(existingExtraData);
    const codeOwnedKeys = new Set(["component", "associatedSystem", "associatedInstance", "build"]);
    const sortedExisting = Object.fromEntries(Object.entries(existing)
        .filter(([key]) => !codeOwnedKeys.has(key))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
    return JSON.stringify(Object.assign(Object.assign({}, sortedExisting), { component: "ch09-broker", associatedSystem: getEnvironmentValue(environment.MSASSOCIATEDSYSTEM), associatedInstance: getEnvironmentValue(environment.MSASSOCIATEDINSTANCE) || getEnvironmentValue(environment.MSINSTANCE), build: {
            version: build_info_1.BROKER_BUILD_INFO.version,
            builtAt: build_info_1.BROKER_BUILD_INFO.builtAt,
            buildNumber: build_info_1.BROKER_BUILD_INFO.buildNumber,
            gitSha: build_info_1.BROKER_BUILD_INFO.gitSha,
            gitDirty: build_info_1.BROKER_BUILD_INFO.gitDirty
        } }));
}
function parseExtraData(value) {
    if (!value) {
        return {};
    }
    try {
        const parsed = JSON.parse(value);
        return isJsonObject(parsed) ? parsed : {};
    }
    catch (_a) {
        return {};
    }
}
function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function getEnvironmentValue(value) {
    var _a;
    return (_a = value === null || value === void 0 ? void 0 : value.trim()) !== null && _a !== void 0 ? _a : "";
}
