import type { RegistryEntry } from "../../../shared.ts";

export const deepseek_webProvider: RegistryEntry = {
  id: "deepseek-web",
  alias: "ds-web",
  format: "openai",
  executor: "deepseek-web",
  baseUrl: "https://chat.deepseek.com/api/v0/chat/completion",
  authType: "apikey",
  authHeader: "bearer",
  // LEV fork: DeepSeek's web interface has a smaller effective context window
  // than the API. Set a provider default so OmniRoute's context-window gate
  // rejects oversized requests before they reach the upstream, instead of
  // returning a generic "Input token limit exceeded" from the web UI.
  defaultContextLength: 65536,
  models: [
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", toolCalling: true, contextLength: 65536 },
    {
      id: "deepseek-v4-pro-think",
      name: "DeepSeek V4 Pro Think",
      toolCalling: true,
      supportsReasoning: true,
      contextLength: 65536,
    },
    {
      id: "deepseek-v4-pro-search",
      name: "DeepSeek V4 Pro Search",
      toolCalling: true,
      contextLength: 65536,
    },
    {
      id: "deepseek-v4-pro-think-search",
      name: "DeepSeek V4 Pro Think+Search",
      toolCalling: true,
      supportsReasoning: true,
      contextLength: 65536,
    },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", toolCalling: true, contextLength: 32768 },
    {
      id: "deepseek-v4-flash-think",
      name: "DeepSeek V4 Flash Think",
      toolCalling: true,
      supportsReasoning: true,
      contextLength: 32768,
    },
    {
      id: "deepseek-v4-flash-search",
      name: "DeepSeek V4 Flash Search",
      toolCalling: true,
      contextLength: 32768,
    },
    {
      id: "deepseek-v4-flash-think-search",
      name: "DeepSeek V4 Flash Think+Search",
      toolCalling: true,
      supportsReasoning: true,
      contextLength: 32768,
    },
    { id: "deepseek-chat", name: "DeepSeek Chat", toolCalling: true, contextLength: 65536 },
    {
      id: "deepseek-reasoner",
      name: "DeepSeek Reasoner",
      toolCalling: true,
      supportsReasoning: true,
      contextLength: 65536,
    },
    {
      id: "DeepSeek-R1",
      name: "DeepSeek R1",
      toolCalling: true,
      supportsReasoning: true,
      contextLength: 65536,
    },
    {
      id: "DeepSeek-R1-Search",
      name: "DeepSeek R1 Search",
      toolCalling: true,
      supportsReasoning: true,
      contextLength: 65536,
    },
    { id: "DeepSeek-V3.2", name: "DeepSeek V3.2", toolCalling: true, contextLength: 65536 },
    { id: "DeepSeek-Search", name: "DeepSeek Search", toolCalling: true, contextLength: 65536 },
  ],
};
