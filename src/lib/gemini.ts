import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

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
    model: GEMINI_MODEL,
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
