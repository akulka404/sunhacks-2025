import { NextRequest } from "next/server";
import OpenAI from "openai";
import simConfig from "@/config/simulation.json";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const { prompt, details } = (await req.json().catch(() => ({ prompt: "" }))) as {
      prompt?: string;
      details?: any;
    };

    const text = (prompt ?? "").trim();
    if (!text) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing prompt" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const temp = (simConfig as any)?.llm?.temperatureSimulate ?? (simConfig as any)?.llm?.temperature ?? 0.2;
  const top_p = (simConfig as any)?.llm?.top_p ?? 1.0;

    // Ask OpenAI to transform the scenario into structured JSON (no fallback)
  const completion = await client.chat.completions.create({
      model,
  temperature: Number(temp),
  top_p: Number(top_p),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You transform crisis scenarios into a structured JSON plan with actors, tasks, constraints, and objectives. Output ONLY valid JSON.",
        },
        {
          role: "user",
              content: `Scenario: ${text}\n\n${details ? `Additional structured context (optional): ${JSON.stringify(details)}` : ''}\n\nReturn STRICT JSON with this shape (fields may vary by scenario; include only what's relevant):\n{\n  "actors": [{\n    "id": "string",\n    "role": "string (e.g., Mayor, Hospital, Ambulances, Power Utility, Citizens, NGO, Police)",\n    "capabilities": ["string"],\n    "capacity": number,\n    "current_load": number\n  }],\n  "tasks": [{\n    "id": "string",\n    "category": "string (e.g., hospital, shelter, evac_zone, power, comms, logistics, traffic, water, etc.)",
    "demand": number,
    "deadline": number, // Unix epoch seconds
    "actor": "id of responsible actor if applicable",
    "location": { "lat": number, "lon": number }
  }],
  "constraints": [{
    "type": "string (e.g., capacity, time, resource, safety, policy)",
    "actor": "string",
    "limit": number,
    "notes": "string optional"
  }],
  "objectives": {
    "<scenario_specific_metric>": number // values in 0..1, e.g., casualties, evac_progress, hospital_power, comms_coverage
  }
}\n\nRules:\n- Use the scenario (and additional context if present) to produce realistic, non-placeholder values.\n- Deadlines must be Unix epoch seconds (now..+24h typical).\n- If some fields are unknown, estimate conservatively or omit that entry.\n- Objectives should reflect scenario-relevant KPIs and roughly sum to ~1.0 across keys.\n- NO commentary, NO markdown — JSON only.`,
        },
      ],
    });

    const content = completion.choices?.[0]?.message?.content || "{}";
    const plan = JSON.parse(content);

    // Normalize deadlines: ensure all task deadlines are future epoch seconds
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      if (Array.isArray(plan?.tasks)) {
        for (const t of plan.tasks) {
          const raw = t?.deadline;
          let dlNum: number | null = null;
          if (typeof raw === 'number') dlNum = raw;
          else if (typeof raw === 'string' && raw.trim().length) {
            const parsed = Number(raw);
            if (!Number.isNaN(parsed)) dlNum = parsed;
          }
          if (dlNum == null) {
            // default 60–180 min from now
            t.deadline = nowSec + (60 + Math.floor(Math.random() * 120)) * 60;
          } else if (dlNum > 1e7) {
            // epoch seconds; bump to at least 60s in future
            t.deadline = dlNum < nowSec + 60 ? nowSec + 60 : dlNum;
          } else {
            // treat as minutes-from-now
            const mins = Math.max(1, Math.round(dlNum));
            t.deadline = nowSec + mins * 60;
          }
        }
      }
    } catch {}

    // Print the structured JSON to the server terminal
    console.log("[CrisisVerse] Structured plan for scenario:\n");
    console.dir(plan, { depth: null });

    // Respond the plan to the client
    return new Response(
      JSON.stringify({ ok: true, plan }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[CrisisVerse] Error generating structured plan:", err?.message || err);
    return new Response(
      JSON.stringify({ ok: false, error: "Failed to generate plan" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
