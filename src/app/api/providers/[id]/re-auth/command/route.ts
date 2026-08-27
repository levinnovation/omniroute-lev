/**
 * POST /api/providers/[id]/re-auth/command?session=<sessionId>
 *
 * LEV fork addition.
 *
 * Executes a command in the re-auth browser (click, type, press, navigate, done).
 * The dashboard uses this to let the user interact with the login page through
 * the headless browser.
 *
 * Body: { type: "click" | "type" | "press" | "navigate" | "done", selector?, text?, key?, url? }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { executeReAuthCommand } from "@omniroute/open-sse/services/reAuthBrowserManager.ts";

const CommandSchema = z.object({
  type: z.enum(["click", "type", "press", "navigate", "done"]),
  selector: z.string().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  url: z.string().url().optional(),
});

export async function POST(
  request: Request,
  { params: _params }: { params: Promise<{ id: string }> }
) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session");

  if (!sessionId) {
    return NextResponse.json({ error: "Missing 'session' query parameter" }, { status: 400 });
  }

  const rawBody = await request.json().catch(() => ({}));
  const validation = validateBody(CommandSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const result = await executeReAuthCommand(sessionId, validation.data);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
