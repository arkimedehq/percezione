import assert from "node:assert/strict";
import { test } from "node:test";
import { hostAllowed, sameOrigin } from "../src/host.ts";

test("the UI answers to local names only, plus the configured ones / l'interfaccia risponde solo ai nomi locali, più quelli configurati", () => {
  for (const h of ["192.0.2.5:8090", "[::1]:8090", "localhost:8090", "server:8090", "percezione.local", "nas.lan:8091", "box.home.arpa"]) assert.ok(hostAllowed(h), h);
  // DNS rebinding: a public name that now points here
  for (const h of ["evil.example.com:8090", "rebind.attacker.net", "", undefined]) assert.ok(!hostAllowed(h), String(h));
  assert.ok(hostAllowed("cams.example.org:8090", ["cams.example.org"]));
});

test("changes only from Percezione's own pages; programs send no Origin / modifiche solo dalle pagine di Percezione; i programmi non mandano Origin", () => {
  assert.ok(sameOrigin(undefined, "192.0.2.5:8090"));
  assert.ok(sameOrigin("http://192.0.2.5:8090", "192.0.2.5:8090"));
  assert.ok(!sameOrigin("https://evil.example.com", "192.0.2.5:8090"));
  assert.ok(!sameOrigin("null", "192.0.2.5:8090"));
});
