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
}\n\nRules:\n- Use the scenario (and additional context if present) to produce realistic, non-placeholder values.\n- For load balancing scenarios, ensure task demands significantly exceed specialist team capacities to demonstrate constraint challenges.\n- Actors should have current_load slightly below capacity (not at full capacity) to allow for some assignment.\n- Deadlines must be Unix epoch seconds (now..+24h typical).\n- Do NOT pre-assign actors to specific tasks - leave tasks unassigned to allow dynamic allocation.\n- If some fields are unknown, estimate conservatively or omit that entry.\n- Objectives should reflect scenario-relevant KPIs and roughly sum to ~1.0 across keys.\n- NO commentary, NO markdown — JSON only.`,
        },
      ],
    });

    const content = completion.choices?.[0]?.message?.content || "{}";
    let plan = JSON.parse(content);

    // Check if this is a load balancing demo scenario
    const isLoadBalancingDemo = text.toLowerCase().includes('load balancing') || 
                               text.toLowerCase().includes('cascading') ||
                               text.toLowerCase().includes('specialized response teams are stretched');

    if (isLoadBalancingDemo) {
      // Override with demonstration-optimized actors and tasks for clear differentiation
      console.log("[CrisisVerse] Load balancing demo detected - using optimized configuration");
      
      plan.actors = [
        // Specialist teams with VERY limited capacity - will cause blocking in deterministic mode
        { "id": "hospital_team", "capabilities": ["hospital"], "capacity": 3, "current_load": 0 },
        { "id": "power_utility", "capabilities": ["power"], "capacity": 4, "current_load": 0 },
        { "id": "evacuation_team", "capabilities": ["evac"], "capacity": 2, "current_load": 0 },
        { "id": "shelter_team", "capabilities": ["shelter"], "capacity": 2, "current_load": 0 },
        { "id": "traffic_management", "capabilities": ["traffic"], "capacity": 2, "current_load": 0 },
        { "id": "logistics_team", "capabilities": ["logistics"], "capacity": 2, "current_load": 0 },
        { "id": "communications_team", "capabilities": ["comms"], "capacity": 1, "current_load": 0 },
        // These are the key actors that enable agentic mode to succeed
        { "id": "adaptive_responders", "skills": ["generalist"], "capacity": 50, "current_load": 0, "agentic_override": true },
        { "id": "cross_trained_specialists", "capabilities": ["hospital", "power", "evac", "shelter"], "capacity": 30, "current_load": 0, "agentic_override": true },
        { "id": "emergency_coordinators", "capabilities": ["traffic", "logistics", "comms"], "capacity": 20, "current_load": 0, "agentic_override": true }
      ];

      // Override with high-demand tasks that will overwhelm specialists
      plan.tasks = [
        { "id": "critical_hospital_support", "category": "hospital", "demand": 18, "deadline": 45 },
        { "id": "massive_power_restoration", "category": "power", "demand": 25, "deadline": 60 },
        { "id": "urgent_evacuation_operations", "category": "evac_zone", "demand": 30, "deadline": 75 },
        { "id": "emergency_shelter_deployment", "category": "shelter", "demand": 28, "deadline": 90 },
        { "id": "critical_traffic_management", "category": "traffic", "demand": 15, "deadline": 30 },
        { "id": "supply_logistics_coordination", "category": "logistics", "demand": 20, "deadline": 120 },
        { "id": "communications_restoration", "category": "comms", "demand": 8, "deadline": 50 }
      ];
    }

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

    // For load balancing demo, ensure actors are not pre-assigned to tasks
    if (isLoadBalancingDemo && Array.isArray(plan?.actors)) {
      // Reset specialist teams to have some capacity but be constrained
      for (const actor of plan.actors) {
        if (!actor.agentic_override && actor.current_load === actor.capacity) {
          // Give specialists minimal capacity to show constraint
          actor.current_load = Math.max(0, actor.capacity - 1);
        }
      }
    }

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
