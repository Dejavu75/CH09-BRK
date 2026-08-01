const assert = require("node:assert/strict");
const test = require("node:test");

const { BROKER_BUILD_INFO } = require("../build/generated/build_info.js");
const { buildHeartbeatExtraData, configureHeartbeatExtraData } = require("../build/services/heartbeat_metadata.js");
const { getHeartBeat, registerService } = require("se_configbase");

test("builds deterministic code-owned heartbeat metadata while preserving custom data", () => {
  const encoded = buildHeartbeatExtraData(
    JSON.stringify({ zeta: 2, component: "caller", build: { version: "caller" }, alpha: 1 }),
    {
      MSASSOCIATEDSYSTEM: " SYS01 ",
      MSASSOCIATEDINSTANCE: " AGES01 ",
      MSINSTANCE: "BROKER01"
    }
  );

  assert.equal(
    encoded,
    JSON.stringify({
      alpha: 1,
      zeta: 2,
      component: "ch09-broker",
      associatedSystem: "SYS01",
      associatedInstance: "AGES01",
      build: {
        version: BROKER_BUILD_INFO.version,
        builtAt: BROKER_BUILD_INFO.builtAt,
        buildNumber: BROKER_BUILD_INFO.buildNumber,
        gitSha: BROKER_BUILD_INFO.gitSha,
        gitDirty: BROKER_BUILD_INFO.gitDirty
      }
    })
  );
});

test("falls back to MSINSTANCE and ignores malformed existing extraData", () => {
  const encoded = buildHeartbeatExtraData("{not-json", {
    MSASSOCIATEDSYSTEM: "SYS02",
    MSASSOCIATEDINSTANCE: "  ",
    MSINSTANCE: "BROKER02"
  });

  const extraData = JSON.parse(encoded);
  assert.equal(extraData.component, "ch09-broker");
  assert.equal(extraData.associatedSystem, "SYS02");
  assert.equal(extraData.associatedInstance, "BROKER02");
  assert.deepEqual(extraData.build, {
    version: BROKER_BUILD_INFO.version,
    builtAt: BROKER_BUILD_INFO.builtAt,
    buildNumber: BROKER_BUILD_INFO.buildNumber,
    gitSha: BROKER_BUILD_INFO.gitSha,
    gitDirty: BROKER_BUILD_INFO.gitDirty
  });
});

test("writes the encoded metadata used by registration and heartbeat generation", () => {
  const environment = {
    MSEXTRADATA: JSON.stringify({ custom: true }),
    MSASSOCIATEDSYSTEM: "SYS03",
    MSINSTANCE: "BROKER03"
  };

  const encoded = configureHeartbeatExtraData(environment);

  assert.equal(environment.MSEXTRADATA, encoded);
  assert.equal(JSON.parse(encoded).custom, true);
});

test("keeps legacy heartbeat identity for both registration and beat payloads", async (context) => {
  const keys = [
    "MSCODE",
    "MSINSTANCE",
    "MSVERSION",
    "MSURL",
    "MSMONINTERVAL",
    "MSSERVICETYPE",
    "MSHEARTBEATMONITOR",
    "MSASSOCIATEDSYSTEM",
    "MSASSOCIATEDINSTANCE",
    "MSEXTRADATA"
  ];
  const originalEnvironment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;
  let registrationPayload;

  context.after(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = originalFetch;
  });

  Object.assign(process.env, {
    MSCODE: "CH09-2",
    MSINSTANCE: "BROKER04",
    MSVERSION: "1",
    MSURL: "http://broker/foreign/broker/heartbeat/beat",
    MSMONINTERVAL: "600",
    MSSERVICETYPE: "ms",
    MSHEARTBEATMONITOR: "http://monitor/heartbeat/register",
    MSASSOCIATEDSYSTEM: "SYS04",
    MSASSOCIATEDINSTANCE: "AGES04",
    MSEXTRADATA: JSON.stringify({ custom: "retained" })
  });
  global.fetch = async (_url, init) => {
    registrationPayload = JSON.parse(init.body);
    return { ok: true };
  };

  configureHeartbeatExtraData();
  await registerService();
  const beatPayload = getHeartBeat();

  for (const payload of [registrationPayload, beatPayload]) {
    assert.equal(payload.version, 1);
    assert.equal(typeof payload.version, "number");
    assert.equal(payload.serviceType, "ms");
    const extraData = JSON.parse(payload.extraData);
    assert.equal(extraData.component, "ch09-broker");
    assert.equal(extraData.associatedSystem, "SYS04");
    assert.equal(extraData.associatedInstance, "AGES04");
    assert.equal(extraData.custom, "retained");
  }
  assert.equal(registrationPayload.action, "register");
  assert.equal(beatPayload.action, "beat");
});
