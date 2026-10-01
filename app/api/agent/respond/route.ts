import { handleTurn } from "@/lib/agent";
import { toPublicSession } from "@/lib/public-session";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { sessionId?: string; message?: string };
    if (!body.sessionId || !body.message?.trim()) {
      return Response.json({ error: "sessionId and message are required" }, { status: 400 });
    }
    const reply = await handleTurn(body.sessionId, body.message.trim());
    return Response.json({ ...reply, session: toPublicSession(reply.session) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected agent error";
    return Response.json({ error: message }, { status: 500 });
  }
}
