import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
if (!process.env.GEMINI_API_KEY) throw new Error('Set GEMINI_API_KEY in the backend environment');
try {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 20000 } });
  const result = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite', contents: 'Return a status field set to connected.', config: { responseMimeType: 'application/json', responseJsonSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] }, maxOutputTokens: 64 } });
  console.log(JSON.stringify({ connected: JSON.parse(result.text).status === 'connected', model: process.env.GEMINI_MODEL, tokens: result.usageMetadata?.totalTokenCount }));
} catch (error) { console.error(JSON.stringify({ connected: false, status: error.status || null, errorType: error.constructor.name })); process.exitCode = 1; }
