import { NextRequest } from "next/server";
import { getGemini } from "@/lib/gemini";
import { callAgentLLM } from "@/lib/agents";
import simConfig from "@/config/simulation.json";

export async function POST(req: NextRequest) {
  try {
    const { actor, worldState } = (await req.json().catch(() => ({}))) as {
      actor?: any;
      worldState?: any;
    };
    if (!actor || !worldState) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing actor or worldState" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

  const client = getGemini();
  const { decisions, comment } = await callAgentLLM(client, actor, worldState, simConfig as any);
    return new Response(
      JSON.stringify({ ok: true, decisions, comment }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[CrisisVerse] Agent decide error:", err?.message || err);
    return new Response(
      JSON.stringify({ ok: false, error: "failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
