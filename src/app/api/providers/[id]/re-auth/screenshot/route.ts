/**
 * GET /api/providers/[id]/re-auth/screenshot?session=<sessionId>
 *
 * LEV fork addition.
 *
 * Captures a screenshot of the re-auth browser and returns it as base64 PNG.
 * Also returns the current URL and session status so the dashboard can detect
 * when login succeeds.
 */
import { NextResponse } from "next/server";
import { captureScreenshot } from "@omniroute/open-sse/services/reAuthBrowserManager.ts";

export async function GET(
  request: Request,
  { params: _params }: { params: Promise<{ id: string }> }
) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session");

  if (!sessionId) {
    return NextResponse.json({ error: "Missing 'session' query parameter" }, { status: 400 });
  }

  const result = await captureScreenshot(sessionId);

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 503 });
  }

  return NextResponse.json({
    screenshot: result.screenshot,
    url: result.url,
    status: result.status,
  });
}
