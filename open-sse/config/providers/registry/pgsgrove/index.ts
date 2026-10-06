import type { RegistryEntry } from "../../shared.ts";
import { buildOpenAiCompatibleRegistryEntry } from "../../shared.ts";

/**
 * PGS Grove / Phoenix Grove (api.pgsgrove.com) — OpenAI-compatible US-based
 * inference host. The live /v1/models catalog lists 20+ models (GLM, DeepSeek,
 * MiMo, Qwen, Kimi, Nemotron, …); `passthroughModels` + `modelsUrl` let the
 * connection sync import the whole catalog, so only the free-tier Flash models
 * are statically declared here.
 */
export const pgsgroveProvider: RegistryEntry = buildOpenAiCompatibleRegistryEntry({
  id: "pgsgrove",
  alias: "pgs",
  baseUrl: "https://api.pgsgrove.com/v1/chat/completions",
  modelsUrl: "https://api.pgsgrove.com/v1/models",
  passthroughModels: true,
  models: [
    {
      id: "glm-5.3-flash",
      name: "GLM 5.3 Flash",
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsReasoning: true,
      toolCalling: true,
    },
    {
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
    },
    {
      id: "mimo-v2.6-flash",
      name: "MiMo V2.6 Flash",
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsReasoning: true,
      supportsVision: true,
      toolCalling: true,
    },
  ],
});
