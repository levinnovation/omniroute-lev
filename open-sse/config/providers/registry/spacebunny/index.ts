import type { RegistryEntry } from "../../shared.ts";

export const spacebunnyProvider: RegistryEntry = {
  id: "spacebunny",
  alias: "sb",
  format: "openai",
  executor: "spacebunny",
  baseUrl: "https://spacebunny.app/api/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    {
      id: "space-bunny",
      name: "Space Bunny Alpha",
      supportsReasoning: true,
      supportsVision: true,
      supportsVideo: true,
      toolCalling: true,
      supportedThinkingEfforts: ["low", "medium", "high", "xhigh", "max"],
      contextLength: 1_000_000,
      maxOutputTokens: 524_288,
    },
  ],
};
