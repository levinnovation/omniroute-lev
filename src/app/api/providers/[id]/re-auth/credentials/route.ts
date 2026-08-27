/**
 * POST /api/providers/[id]/re-auth/credentials?session=<sessionId>
 *
 * LEV fork addition.
 *
 * Retrieves the extracted credentials after a successful re-auth and persists
 * them to the provider connection. Also clears the session health cache so the
 * WebSessionDriver considers the session healthy on the next request.
 */
import { NextResponse } from "next/server";
import {
  getExtractedCredentials,
  cleanupSession,
} from "@omniroute/open-sse/services/reAuthBrowserManager.ts";
import { getCachedProviderConnectionById } from "@/lib/db/readCache";
import { updateProviderConnection } from "@/lib/db/providers";
import { __clearSessionHealthCacheForTest } from "@omniroute/open-sse/services/webSessionDriver.ts";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session");

  if (!sessionId) {
    return NextResponse.json({ error: "Missing 'session' query parameter" }, { status: 400 });
  }

  const { id: connectionId } = await params;
  const connection = await getCachedProviderConnectionById(connectionId);
  if (!connection) {
    return NextResponse.json({ error: "Provider connection not found" }, { status: 404 });
  }

  const credResult = getExtractedCredentials(sessionId);

  if ("error" in credResult) {
    return NextResponse.json({ error: credResult.error }, { status: 400 });
  }

  const { token, cookies } = credResult;

  // Persist the new credentials to the provider connection.
  // The credential field name depends on the provider — most use apiKey.
  const newApiKey = token || cookies;
  if (!newApiKey) {
    return NextResponse.json(
      { error: "No credentials were extracted from the re-auth session" },
      { status: 400 }
    );
  }

  try {
    updateProviderConnection(connectionId, {
      apiKey: newApiKey,
      testStatus: "active",
      rateLimitedUntil: null,
      lastError: null,
      lastErrorType: null,
    });

    // Clear the session health cache so the driver re-validates on next request
    __clearSessionHealthCacheForTest();

    // Clean up the browser session
    await cleanupSession(sessionId);

    return NextResponse.json({
      ok: true,
      message: "Credentials persisted successfully. The provider connection is now active.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: `Failed to persist credentials: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 }
    );
  }
}
