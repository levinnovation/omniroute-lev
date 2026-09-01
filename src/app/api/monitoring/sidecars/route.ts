import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { checkAllSidecars } from "@/../open-sse/services/sidecars";

/**
 * GET /api/monitoring/sidecars — Sidecar service health
 *
 * Returns health status for Browserless, LiteLLM, and Mem0 sidecar services.
 * Requires management auth.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  try {
    const healths = await checkAllSidecars();
    const allHealthy = healths.length > 0 && healths.every((h) => h.healthy);
    return NextResponse.json({
      status: allHealthy ? "healthy" : "degraded",
      sidecars: healths,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        sidecars: [],
      },
      { status: 500 }
    );
  }
}
