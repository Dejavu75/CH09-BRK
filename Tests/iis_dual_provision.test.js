const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const scriptPath = require("node:path").resolve(__dirname, "../scripts/provision-ages-dual-iis.ps1");
const source = readFileSync(scriptPath, "utf8");

test("IIS provisioning script parses without executing IIS mutations", (t) => {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$null = Get-Command pwsh"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") return t.skip("pwsh unavailable");
  const parsed = spawnSync("pwsh", ["-NoProfile", "-Command",
    "$e=$null; [Management.Automation.Language.Parser]::ParseFile($env:SCRIPT_TO_PARSE,[ref]$null,[ref]$e)|Out-Null; if($e.Count){$e|% Message;exit 1}"],
    { encoding: "utf8", env: { ...process.env, SCRIPT_TO_PARSE: scriptPath } });
  assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
});

test("fails closed on unowned resources and records intent before creation", () => {
  assert.match(source, /already exists without ownership state/);
  assert.match(source, /Owned resource.*no longer matches its exact fingerprint/);
  const pendingPool = source.indexOf("type = 'pool'; name = $target.Pool; status = 'pending'");
  const savePool = source.indexOf("Save-Ledger $ledger", pendingPool);
  const createPool = source.indexOf("New-WebAppPool", pendingPool);
  const pendingSite = source.indexOf("type = 'site'; name = $target.Site; status = 'pending'");
  const saveSite = source.indexOf("Save-Ledger $ledger", pendingSite);
  const createSite = source.indexOf("New-Website", pendingSite);
  assert.ok(pendingPool >= 0 && pendingPool < savePool && savePool < createPool);
  assert.ok(pendingSite >= 0 && pendingSite < saveSite && saveSite < createSite);
  assert.match(source, /apply-failed-clean/);
  assert.match(source, /apply-cleanup'; Save-Ledger/);
  assert.match(source, /previous Apply requires recovery; run -Mode Rollback/);
  assert.ok(source.indexOf("try {\n    Backup-WebConfiguration") > source.indexOf("$createdThisRun ="));
});

test("keeps credentials out of output and persisted fingerprints", () => {
  assert.doesNotMatch(source, /Write-(?:Host|Output)[^\r\n]*(?:password|userName)/i);
  assert.doesNotMatch(source, /fingerprint[^\r\n]*(?:password|userName)/i);
  assert.match(source, /SpecificUser credentials cannot be read securely; refusing all mutations/);
  assert.match(source, /processModel\.password -Value \$password/);
});

test("pins the local topology and disables synchronized periodic recycling", () => {
  assert.match(source, /AGES_A_Local'; Port = 18081/);
  assert.match(source, /AGES_B_Local'; Port = 18082/);
  assert.match(source, /periodicRestart\.time -Value \(\[TimeSpan\]::Zero\)/);
  assert.match(source, /processModel\.maxProcesses -Value 1/);
  assert.match(source, /recycling\.disallowOverlappingRotation -Value \$false/);
});

test("rollback persists resumable progress and refuses non-exclusive ownership", () => {
  assert.match(source, /status = 'rolling-back'; Save-Ledger/);
  assert.match(source, /status = 'deleting'; Save-Ledger/);
  assert.match(source, /status = 'deleted'; Save-Ledger/);
  assert.match(source, /status = 'rollback-complete'; Save-Ledger/);
  assert.ok(source.indexOf("status = 'deleting'; Save-Ledger") < source.indexOf("Remove-Website -Name $entry.name"));
  assert.match(source, /applications = \$applications/);
  assert.match(source, /bindings = \$bindings/);
  assert.match(source, /has foreign consumers; refusing deletion/);
});
