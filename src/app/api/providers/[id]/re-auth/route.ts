/**
 * POST /api/providers/[id]/re-auth
 *
 * LEV fork addition.
 *
 * Initiates a re-authentication session for a web-cookie provider.
 * Launches a headless browser pointing to the provider's login page
 * and returns a session ID for subsequent screenshot/command calls.
 */
import { NextResponse } from "next/server";
import { getCachedProviderConnectionById } from "@/lib/db/providers";
import {
  startReAuthSession,
  RE_AUTH_CONFIGS,
} from "@omniroute/open-sse/services/reAuthBrowserManager.ts";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: connectionId } = await params;

  const connection = await getCachedProviderConnectionById(connectionId);
  if (!connection) {
    return NextResponse.json({ error: "Provider connection not found" }, { status: 404 });
  }

  const providerId = connection.provider as string;
  if (!RE_AUTH_CONFIGS[providerId]) {
    return NextResponse.json(
      {
        error: `Re-authentication not supported for provider: ${providerId}. Supported providers: ${Object.keys(RE_AUTH_CONFIGS).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const result = await startReAuthSession(providerId, connectionId);

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 503 });
  }

  return NextResponse.json({
    sessionId: result.sessionId,
    loginUrl: result.loginUrl,
    providerId,
    message:
      "Re-authentication session started. Poll /screenshot for live browser view, send commands via /command.",
  });
}
