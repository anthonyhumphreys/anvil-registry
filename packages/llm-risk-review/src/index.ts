import { z } from "zod";
import type { LlmRiskReview, LlmRiskReviewInput } from "@anvil/shared";

export const llmRiskTypeSchema = z.enum([
  "typosquatting",
  "dependency_confusion",
  "credential_exfiltration",
  "install_script_abuse",
  "obfuscation",
  "unexpected_network_access",
  "suspicious_maintainer_change",
  "overbroad_dependency_tree",
  "unknown"
]);

export const llmEvidenceSourceSchema = z.enum(["metadata", "package_json", "diff", "code_snippet", "download_stats"]);

export const llmRiskReviewSchema = z.object({
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1),
  suspectedRiskTypes: z.array(llmRiskTypeSchema),
  evidence: z.array(
    z.object({
      signal: z.string(),
      explanation: z.string(),
      source: llmEvidenceSourceSchema
    })
  ),
  recommendedAction: z.enum(["allow", "warn", "quarantine", "block"])
}) satisfies z.ZodType<LlmRiskReview>;

export interface LlmRiskReviewProvider {
  review(input: LlmRiskReviewInput): Promise<LlmRiskReview | undefined>;
}

export class DisabledLlmRiskReviewProvider implements LlmRiskReviewProvider {
  async review(): Promise<undefined> {
    return undefined;
  }
}

export class HttpLlmRiskReviewProvider implements LlmRiskReviewProvider {
  private readonly fetch: typeof fetch;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly model?: string;

  constructor(options: { endpoint: string; apiKey?: string; model?: string; fetch?: typeof fetch }) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async review(input: LlmRiskReviewInput): Promise<LlmRiskReview | undefined> {
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.model,
        input,
        instructions:
          "Return only JSON matching the Anvil LlmRiskReview schema. Do not recommend allow solely because evidence is inconclusive."
      })
    });

    if (!response.ok) return undefined;
    const body = await safeResponseJson(response);
    const candidate = extractReviewCandidate(body);
    const parsed = llmRiskReviewSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
  }
}

export function createLlmRiskReviewProvider(options: {
  enabled: boolean;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}): LlmRiskReviewProvider {
  if (!options.enabled || !options.endpoint) return new DisabledLlmRiskReviewProvider();
  return new HttpLlmRiskReviewProvider({
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    model: options.model,
    fetch: options.fetch
  });
}

function extractReviewCandidate(body: unknown): unknown {
  if (!isRecord(body)) return body;
  if (isRecord(body.review)) return body.review;
  if (typeof body.output_text === "string") return parseJson(body.output_text);

  const choice = arrayValue(body.choices)[0];
  if (isRecord(choice)) {
    const message = isRecord(choice.message) ? choice.message : undefined;
    if (typeof message?.content === "string") return parseJson(message.content);
  }

  const output = arrayValue(body.output)[0];
  if (isRecord(output)) {
    const content = arrayValue(output.content)[0];
    if (isRecord(content) && typeof content.text === "string") return parseJson(content.text);
  }

  return body;
}

async function safeResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
