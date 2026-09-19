import OpenAI from "openai";

import { checkOpenAIUsage } from "../services/openaiUsageGuard.js";
import {
  JsonOpenAIUsageTracker,
  type OpenAIUsageRecord,
  type OpenAIUsageTracker
} from "../services/openaiUsageTracker.js";

interface OpenAIResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface MinimalOpenAIResponse {
  output_text: string;
  usage?: OpenAIResponseUsage | null;
}

interface OpenAIRequest {
  model: string;
  input: string;
  max_output_tokens: number;
}

export interface OpenAIResult {
  outputText: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

interface OpenAIServiceDependencies {
  usageTracker?: OpenAIUsageTracker;
  createResponse?: (request: OpenAIRequest) => Promise<MinimalOpenAIResponse>;
}

function getApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured. Add it to your .env file.");
  }

  return apiKey;
}

function getModel(): string {
  const model = process.env.OPENAI_MODEL?.trim();
  if (!model) {
    throw new Error("OPENAI_MODEL is not configured. Add it to your .env file.");
  }

  return model;
}

function getUsageRecord(usage: OpenAIResponseUsage | null | undefined): Omit<OpenAIUsageRecord, "timestamp" | "provider" | "operation" | "requestCount"> {
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  const totalTokens = usage?.total_tokens;

  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number" ||
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(totalTokens) ||
    inputTokens < 0 ||
    outputTokens < 0 ||
    totalTokens !== inputTokens + outputTokens
  ) {
    throw new Error("OpenAI response did not include valid token usage.");
  }

  return { inputTokens, outputTokens, totalTokens };
}

export async function analyzeWithOpenAI(
  input: string,
  dependencies: OpenAIServiceDependencies = {}
): Promise<OpenAIResult> {
  const apiKey = getApiKey();
  const model = getModel();
  const usageTracker = dependencies.usageTracker ?? new JsonOpenAIUsageTracker();
  const usageCheck = await checkOpenAIUsage(usageTracker);

  if (!usageCheck.allowed) {
    throw new Error("OpenAI request blocked by usage guard.");
  }

  const request: OpenAIRequest = {
    model,
    input,
    max_output_tokens: 32
  };
  const createResponse = dependencies.createResponse ?? (async (responseRequest: OpenAIRequest) => {
    const client = new OpenAI({ apiKey });
    return client.responses.create(responseRequest);
  });

  let response: MinimalOpenAIResponse;
  try {
    response = await createResponse(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OpenAI API error";
    throw new Error(`OpenAI API request failed: ${message}`);
  }

  let usage: OpenAIResult["usage"];
  try {
    usage = getUsageRecord(response.usage);
  } catch (error) {
    try {
      await usageTracker.markUsageUnknown();
    } catch {
      // The request is still treated as unsafe if the marker cannot be persisted.
    }
    throw error;
  }

  try {
    await usageTracker.recordRequest({
      timestamp: new Date().toISOString(),
      provider: "openai",
      operation: "minimal-test",
      requestCount: 1,
      ...usage
    });
  } catch {
    throw new Error("OpenAI request succeeded, but its usage could not be recorded safely.");
  }

  console.info("[INFO] OpenAI request completed.");
  console.info(`[INFO] OpenAI tokens used: ${usage.totalTokens}`);

  return { outputText: response.output_text, usage };
}
