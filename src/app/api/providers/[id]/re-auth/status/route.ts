/**
 * GET /api/providers/[id]/re-auth/status?session=<sessionId>
 *
 * LEV fork addition.
 *
 * Returns the current status of a re-auth session.
 */
import { NextResponse } from "next/server";
import { getSessionStatus } from "@omniroute/open-sse/services/reAuthBrowserManager.ts";

export async function GET(
  request: Request,
  { params: _params }: { params: Promise<{ id: string }> }
) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session");

  if (!sessionId) {
    return NextResponse.json({ error: "Missing 'session' query parameter" }, { status: 400 });
  }

  const result = getSessionStatus(sessionId);

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  return NextResponse.json(result);
}
