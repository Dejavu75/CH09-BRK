const assert = require("node:assert/strict");
const test = require("node:test");

const generatorUrl = new URL("../scripts/generate-build-info.mjs", `file://${__filename}`);

test("uses the explicit GitHub run version without mixing traceability metadata into it", async () => {
  const { resolveBrokerVersion } = await import(generatorUrl);

  assert.equal(
    resolveBrokerVersion({
      override: "1.0.184",
      packageVersion: "1.0.0",
      buildNumber: "20260801T120000Z",
      gitSha: "abcdef123456",
      gitDirty: true
    }),
    "1.0.184"
  );
});

test("rejects invalid explicit versions before they can become image tags", async () => {
  const { resolveBrokerVersion } = await import(generatorUrl);

  for (const value of ["1.0.0", "1.0.12+sha", "latest", "1.0.12/unsafe", "  "]) {
    assert.throws(
      () =>
        resolveBrokerVersion({
          override: value,
          packageVersion: "1.0.0",
          buildNumber: "20260801T120000Z",
          gitSha: "abcdef123456",
          gitDirty: false
        }),
      /Invalid BROKER_VERSION/
    );
  }
});

test("keeps the traceable legacy version as the local-build fallback", async () => {
  const { resolveBrokerVersion } = await import(generatorUrl);

  assert.equal(
    resolveBrokerVersion({
      override: undefined,
      packageVersion: "1.0.0",
      buildNumber: "20260801T120000Z",
      gitSha: "abcdef123456",
      gitDirty: true
    }),
    "1.0.0+20260801T120000Z.abcdef123456.dirty"
  );
});
