require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Every module has to at least load. This is the tripwire for the
// @stellar/stellar-sdk 15 -> 17 bump: a moved or renamed export shows up here
// immediately instead of on a live route.
const LIB = path.join(__dirname, "..", "lib");

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? jsFiles(path.join(dir, e.name))
      : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []
  );
}

for (const file of jsFiles(LIB)) {
  test(`loads ${path.relative(LIB, file)}`, () => {
    const mod = require(file);
    assert.ok(mod !== undefined, "module should export something");
  });
}

test("requiring server.js does not start a server or background work", () => {
  const { app, __setTestDeps } = require("../server.js");
  assert.equal(typeof app, "function", "app should be an express handler");
  assert.equal(typeof __setTestDeps, "function", "test seam should be exported");
});

test("every protocol adapter declares a protocolId", () => {
  const { assertAdaptersConfigured, PROTOCOL_ADAPTERS } = require("../server.js");
  assertAdaptersConfigured();
  for (const adapter of PROTOCOL_ADAPTERS) {
    assert.equal(typeof adapter.protocolId, "string");
    assert.ok(adapter.protocolId.length > 0);
  }
});

test("boot assertion rejects an adapter with no protocolId", () => {
  const { assertAdaptersConfigured } = require("../server.js");
  assert.throws(
    () => assertAdaptersConfigured([{ name: "Nameless", isConfigured: () => true }]),
    /no protocolId/
  );
});
