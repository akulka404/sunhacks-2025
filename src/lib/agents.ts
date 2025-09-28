import type OpenAI from "openai";

export function generateAgentPrompt(actor: any, worldState: any) {
  const caps = Array.isArray(actor?.capabilities) ? actor.capabilities.join(", ") : "";
  return `
You are ${actor?.id}, responsible for coordinating disaster response.

Here is the current situation (JSON):

${JSON.stringify(worldState, null, 2)}

Your capabilities: ${caps}
Your current load: ${actor?.current_load ?? 0}/${actor?.capacity ?? 0}

Choose which tasks you want to take on in this step.
You may only select tasks that match your capabilities and for which you have available capacity.

Respond strictly in JSON with this object shape:
{
  "decisions": [
    { "task_id": "string", "assigned_load": number }
  ],
  "comment": "optional short reasoning or insight for the log"
}
  `;
}

export async function callAgentLLM(client: OpenAI, actor: any, worldState: any, simConfig?: any) {
  const prompt = generateAgentPrompt(actor, worldState);
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const temp = simConfig?.llm?.temperatureAgent ?? simConfig?.llm?.temperature ?? 0.2;
  const top_p = simConfig?.llm?.top_p ?? 1.0;
  const completion = await client.chat.completions.create({
    model,
    temperature: Number(temp),
    top_p: Number(top_p),
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "You are a disaster response agent making task decisions. Output only valid JSON with { decisions: [...] }.",
      },
      { role: "user", content: prompt },
    ],
  });
  const content = completion.choices?.[0]?.message?.content || "{}";
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return { decisions: parsed, comment: undefined };
    }
    if (parsed && Array.isArray(parsed.decisions)) return { decisions: parsed.decisions, comment: parsed.comment };
    return { decisions: [], comment: undefined };
  } catch {
    return { decisions: [], comment: undefined };
  }
}
