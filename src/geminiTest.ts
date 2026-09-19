import "dotenv/config";
import { generateWithGemini } from "./tools/llm/gemini.js";

try {
  const result = await generateWithGemini("Reply with exactly: GEMINI_OK");
  console.info(result.outputText);
  console.info(`Input tokens: ${result.usage.inputTokens}`);
  console.info(`Output tokens: ${result.usage.outputTokens}`);
  if (result.usage.thoughtTokens !== undefined) console.info(`Thought tokens: ${result.usage.thoughtTokens}`);
  console.info(`Total tokens: ${result.usage.totalTokens}`);
} catch (error) {
  console.error(`[ERROR] Gemini test failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
}
