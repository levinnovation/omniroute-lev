/**
 * Web-cookie providers must advertise their prompt-emulated tool support to
 * external clients.
 *
 * Regression guard for the Zed/Cline "I have no ability to use tools" failure:
 * qwen-web and perplexity-web declare registry `toolCalling: false` (honest —
 * they have no NATIVE function calling) while the provider entry declares
 * `toolCalling: "emulated"` and the executor runs the prompt-emulated shim
 * (prepareToolMessages + robustWebTools).
 *
 * Combo routing already keeps these targets eligible via
 * providerSupportsEmulatedToolCalling(), but external clients only ever read
 * the /v1/models catalog. When that advertised `tool_calling: false`, Zed
 * swapped in its no-tools system prompt and sent no tools[] at all, so the
 * emulated shim could never fire — the model then truthfully reported that it
 * could not read the user's codebase.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AI_PROVIDERS } from "../../src/shared/constants/providers.ts";
import { enrichCatalogModelEntry } from "../../src/lib/modelMetadataRegistry.ts";

function toolCallingOf(provider: string, model: string): unknown {
  const entry = enrichCatalogModelEntry(
    { id: `${provider}/${model}`, object: "model", owned_by: provider, root: model },
    { provider, model }
  ) as Record<string, unknown>;
  const capabilities = (entry.capabilities ?? {}) as Record<string, unknown>;
  return capabilities.tool_calling;
}

describe("web-cookie emulated tool advertisement", () => {
  it("declares the emulated providers under test as toolCalling:'emulated'", () => {
    // Guards the premise of this whole file: if the provider entries ever stop
    // declaring "emulated", the assertions below would pass vacuously.
    const providers = AI_PROVIDERS as Record<string, { toolCalling?: unknown }>;
    assert.equal(providers["qwen-web"]?.toolCalling, "emulated");
    assert.equal(providers["perplexity-web"]?.toolCalling, "emulated");
  });

  it("advertises tool_calling for qwen-web despite registry toolCalling:false", () => {
    assert.equal(toolCallingOf("qwen-web", "qwen3.8-max"), true);
  });

  it("advertises tool_calling for perplexity-web despite registry toolCalling:false", () => {
    assert.equal(toolCallingOf("perplexity-web", "pplx-auto"), true);
  });

  it("scopes the upgrade to providers that actually declare emulation", () => {
    // yuanbao-web is a web-cookie provider that declares NO toolCalling at all
    // and whose registry models are not tool-capable. It must not be swept into
    // the emulated upgrade — that would advertise tool support the executor
    // cannot honour, which is the failure mode #8437 warned about.
    const providers = AI_PROVIDERS as Record<string, { toolCalling?: unknown }>;
    assert.notEqual(providers["yuanbao-web"]?.toolCalling, "emulated");
    assert.notEqual(toolCallingOf("yuanbao-web", "deepseek-v3"), true);
  });
});
