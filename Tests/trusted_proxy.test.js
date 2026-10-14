const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
const { trustedProxyAddresses } = require("../build/auth/trusted_proxy");

test("proxy trust defaults to direct socket and rejects broad/non-IP values", () => {
  assert.equal(trustedProxyAddresses(undefined), false);
  assert.equal(trustedProxyAddresses(""), false);
  assert.deepEqual(trustedProxyAddresses("192.0.2.10, 2001:db8::1"), ["192.0.2.10", "2001:db8::1"]);
  for (const invalid of ["true", "*", "0.0.0.0/0", "192.0.2.10,", "proxy.example"] ) {
    assert.throws(() => trustedProxyAddresses(invalid));
  }
});

test("Express accepts forwarded client IP only from an explicit proxy address", async () => {
  const app = express();
  app.set("trust proxy", trustedProxyAddresses("127.0.0.1"));
  app.get("/", (req, res) => res.json({ ip: req.ip }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const response = await fetch(url, { headers: { "X-Forwarded-For": "198.51.100.5" } });
    assert.equal((await response.json()).ip, "198.51.100.5");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("Express ignores forged forwarding headers without a trusted proxy", async () => {
  const app = express();
  app.set("trust proxy", trustedProxyAddresses(undefined));
  app.get("/", (req, res) => res.json({ ip: req.ip }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const response = await fetch(url, { headers: { "X-Forwarded-For": "198.51.100.5" } });
    assert.equal((await response.json()).ip, "127.0.0.1");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
