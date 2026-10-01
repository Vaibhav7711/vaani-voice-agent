import { createSession } from "@/lib/agent";
import { toPublicSession } from "@/lib/public-session";

export async function POST() {
  const session = await createSession();
  return Response.json({ session: toPublicSession(session) });
}
