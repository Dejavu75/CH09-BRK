const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load shipped pool logic without operational logging, environment files, or services.
exports.loadPool = () => {
  const loaded = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../build/services/ages_pool.js"), "utf8"), {
    exports: loaded, Buffer, URL, Headers, AbortController, setTimeout, clearTimeout,
    process: { env: { AGES_API_KEY: "synthetic-pool-key" } },
    fetch: (...args) => global.fetch(...args),
    require(name) {
      if (name === "dotenv/config") return {};
      if (name === "../utils/logger") return { log() {}, warn() {}, sendDebugMail: async () => {} };
      if (name === "./timing_store") return require("../../build/services/timing_store");
      return require(name);
    }
  });
  loaded.agesConnectionPool.closeTimingStore();
  return loaded.AgesConnectionPool;
};
