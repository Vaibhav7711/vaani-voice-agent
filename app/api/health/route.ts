import { infrastructureHealth } from "@/lib/infrastructure";
import { plannerHealth, plannerName } from "@/lib/planner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [infrastructure, planner] = await Promise.all([infrastructureHealth(), plannerHealth()]);
    const healthy = infrastructure.database !== "unavailable" && infrastructure.cache !== "unavailable" && planner !== "unavailable";
    return Response.json({
      status: healthy ? "ready" : "degraded",
      infrastructure,
      planner: { name: plannerName(), status: planner },
    }, { status: healthy ? 200 : 503 });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
