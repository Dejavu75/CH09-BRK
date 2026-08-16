const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

test("Docker image never generates or contains the broker private key", () => {
  const dockerfile = read("Dockerfile");
  assert.doesNotMatch(dockerfile, /ssh-keygen/);
  assert.doesNotMatch(dockerfile, /(?:COPY|ADD).*ch09_brk_iis/i);
  assert.doesNotMatch(dockerfile, /\/app\/keys/);
});

test("Compose templates mount the persistent identity read-only and require validation", () => {
  for (const relativePath of [
    "docker-compose.yml",
    ".deploy-prod-compose.yml",
    ".deploy-test-compose.yml",
    ".deploy-ge01/docker-compose.yml"
  ]) {
    const compose = read(relativePath);
    assert.match(compose, /\$\{SSH_KEY_HOST_PATH\}:\/run\/secrets\/ch09-brk-iis:ro/);
    assert.match(compose, /\/run\/ch09-brk-ssh:mode=0700,size=1m/);
    assert.match(compose, /SSH_IDENTITY_REQUIRED:\s*["']true["']/);
    assert.match(compose, /AGES_SSH_KEY_PATH:\s*\/run\/secrets\/ch09-brk-iis\/ch09_brk_iis/);
    assert.doesNotMatch(compose, /SSH_PUBLIC_KEY_HOST_PATH.*:\/app\/ssh-public/);
  }
});

test("entrypoint fails closed and compares the mounted public and private keys", () => {
  const entrypoint = read("docker-entrypoint.sh");
  assert.match(entrypoint, /-L "\$AGES_SSH_KEY_PATH"/);
  assert.match(entrypoint, /ssh-keygen -y -f "\$runtime_key"/);
  assert.match(entrypoint, /install -m 0600 "\$AGES_SSH_KEY_PATH" "\$runtime_key"/);
  assert.match(entrypoint, /public key does not match the mounted private key/);
  assert.doesNotMatch(entrypoint, /\bcp\s+"?\$SSH_PUBLIC_KEY_SOURCE/);
});

test("host setup never rotates an existing identity and exports only the public key", () => {
  const setup = read("scripts/setup-broker-iis-ssh-key.sh");
  const deploy = read(".deploy-ge01/crear.sh");
  assert.match(setup, /Incomplete broker SSH identity; refusing to replace or repair it automatically/);
  assert.match(setup, /ssh-keygen -q -t ed25519/);
  assert.match(setup, /--validate-only/);
  assert.match(setup, /stat -c '%a'/);
  assert.match(setup, /install -m 0644 "\$PUBLIC_KEY" "\$PUBLIC_EXPORT"/);
  assert.doesNotMatch(setup, /install[^\n]+"\$PRIVATE_KEY"[^\n]+PUBLIC/);
  assert.ok(deploy.indexOf('"$KEY_VALIDATOR" --validate-only') < deploy.indexOf("docker compose down"));
});

test("Windows installer accepts only a public Ed25519 key", () => {
  const installer = read("scripts/install-broker-iis-public-key.ps1");
  assert.match(installer, /GetExtension\(\$PublicKeyPath\) -ne '\.pub'/);
  assert.match(installer, /\^ssh-ed25519/);
  assert.match(installer, /administrators_authorized_keys/);
  assert.match(installer, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(installer, /SetOwner\(\$administratorsSid\)/);
  assert.ok(installer.indexOf("Assert-ClosedAcl $authorizedKeys") < installer.indexOf("Add-Content -LiteralPath $authorizedKeys"));
  assert.match(installer, /Refusing reparse point/);
  assert.doesNotMatch(installer, /icacls\.exe/);
  assert.doesNotMatch(installer, /PRIVATE KEY/);
});
