import "dotenv/config";

import { analyzeWithOpenAI } from "./tools/openai.js";

try {
  const result = await analyzeWithOpenAI("Reply with exactly: OPENAI_OK");
  console.info(result.outputText);
  console.info(`Input tokens: ${result.usage.inputTokens}`);
  console.info(`Output tokens: ${result.usage.outputTokens}`);
  console.info(`Total tokens: ${result.usage.totalTokens}`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[ERROR] OpenAI test failed: ${message}`);
  process.exitCode = 1;
}
