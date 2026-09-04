import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("NopeCHA extension path resolution does not crash browserPool import", async () => {
  delete process.env.OMNIROUTE_NOPECHA_EXTENSION_PATH;
  const mod = await import("../../open-sse/services/browserPool.ts");
  assert.ok(typeof mod.acquireBrowserContext === "function");
  assert.ok(typeof mod.releaseBrowserContext === "function");
});

test("NopeCHA extension is present in the repo for local dev", () => {
  const localPath = join(process.cwd(), "extensions/nopecha/manifest.json");
  if (existsSync(localPath)) {
    const manifest = JSON.parse(readFileSync(localPath, "utf8"));
    assert.ok(manifest.name);
    assert.ok(manifest.version);
    assert.equal(manifest.manifest_version, 3);
  }
});

test("Dockerfile includes NopeCHA extension download step", () => {
  const dockerfilePath = join(process.cwd(), "Dockerfile");
  const dockerfile = readFileSync(dockerfilePath, "utf8");
  assert.ok(dockerfile.includes("nopecha"), "Dockerfile should reference NopeCHA");
  assert.ok(dockerfile.includes("chromium_automation.zip"), "Should download automation variant");
  assert.ok(
    dockerfile.includes("/app/extensions/nopecha"),
    "Should install to /app/extensions/nopecha"
  );
});

test("Python cloudflare-solver sidecar files exist", () => {
  const sidecarDir = join(process.cwd(), "sidecars/cloudflare-solver");
  assert.ok(existsSync(join(sidecarDir, "Dockerfile")), "Dockerfile should exist");
  assert.ok(existsSync(join(sidecarDir, "server.py")), "server.py should exist");
  assert.ok(existsSync(join(sidecarDir, "requirements.txt")), "requirements.txt should exist");
});

test("sidecars.ts includes cfsolver config and health check", async () => {
  const mod = await import("../../open-sse/services/sidecars.ts");
  assert.ok(typeof mod.getCfSolverConfig === "function");
  delete process.env.OMNIROUTE_CFSOLVER_URL;
  assert.equal(mod.getCfSolverConfig(), null);
  process.env.OMNIROUTE_CFSOLVER_URL = "http://localhost:8080";
  const config = mod.getCfSolverConfig();
  assert.ok(config);
  assert.equal(config.url, "http://localhost:8080");
  assert.ok(config.timeoutMs && config.timeoutMs >= 60000);
  delete process.env.OMNIROUTE_CFSOLVER_URL;
});
