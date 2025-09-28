import { GoogleGenerativeAI } from "@google/generative-ai";

export function getGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY in environment");
  }
  return new GoogleGenerativeAI(apiKey);
}

export async function callGemini(
  client: GoogleGenerativeAI,
  systemPrompt: string,
  userPrompt: string,
  options: {
    temperature?: number;
    topP?: number;
    responseFormat?: 'json' | 'text';
  } = {}
) {
  const model = client.getGenerativeModel({ 
    model: "gemini-2.0-flash-thinking-exp-1219",
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      topP: options.topP ?? 1.0,
      ...(options.responseFormat === 'json' && {
        responseMimeType: "application/json"
      })
    }
  });

  const prompt = `${systemPrompt}\n\n${userPrompt}`;
  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text();
}
