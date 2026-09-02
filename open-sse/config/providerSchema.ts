import { z } from "zod";

export const ProviderConnectionSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  authType: z.string(),
  apiKey: z.string().nullable().optional(),
  oauthToken: z.string().nullable().optional(),
  refreshToken: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
  testStatus: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  lastErrorType: z.string().nullable().optional(),
  backoffLevel: z.number().int().optional(),
  rateLimitedUntil: z.string().nullable().optional(),
  providerSpecificData: z.unknown().nullable().optional(),
});

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().url().nullable().optional(),
  supportedModels: z.array(z.string()).optional(),
  format: z.string().optional(),
  executor: z.string().optional(),
  authType: z.string().optional(),
  authHeader: z.string().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export type ValidatedProviderConnection = z.infer<typeof ProviderConnectionSchema>;
export type ValidatedProviderConfig = z.infer<typeof ProviderConfigSchema>;

export type ProviderValidationResult<T> =
  { success: true; data: T } | { success: false; errors: string[] };

export function validateProviderEntry(
  entry: unknown
): ProviderValidationResult<ValidatedProviderConnection> {
  const result = ProviderConnectionSchema.safeParse(entry);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}

export function validateProviderConfig(
  entry: unknown
): ProviderValidationResult<ValidatedProviderConfig> {
  const result = ProviderConfigSchema.safeParse(entry);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
