import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ParsedMessage } from "./client.js";
import { ORDER_STATUSES, type OrderStatus } from "../types.js";

// Cap the email body sent to the model. Shipping mail puts the signal up top;
// this bounds per-call token cost and keeps marketing footers out of the prompt.
const MAX_BODY_CHARS = 4000;
const MAX_TOKENS = 256;

const SYSTEM_PROMPT = [
  "You classify shipping/delivery notification emails for physical orders.",
  "Decide whether the email reports a shipment status, and if so which one:",
  '- "In Transit": shipped, dispatched, on the way, label created.',
  '- "Arriving Soon": out for delivery, arriving today/tomorrow, an expected delivery date.',
  '- "Delivered": the package was delivered.',
  "If the email is not a shipping/delivery notification for a physical product",
  "(marketing, password reset, a plain receipt with no shipment, etc.), set",
  "isShipping=false and status=null.",
  "itemName: the product/item name if clearly stated, otherwise null.",
  "Never infer or output tracking numbers.",
].join("\n");

// Hand-written JSON Schema (the SDK's zodOutputFormat helper targets zod v4;
// this project is on zod v3). `additionalProperties: false` is required by
// structured outputs; nullable fields use `anyOf` (numeric/length constraints
// are unsupported and intentionally omitted).
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    isShipping: {
      type: "boolean",
      description: "True if this is a shipment status notification for a physical order.",
    },
    status: {
      anyOf: [
        { type: "string", enum: [...ORDER_STATUSES] },
        { type: "null" },
      ],
      description: "The shipment status, or null when isShipping is false.",
    },
    itemName: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Product/item name if clearly stated, else null.",
    },
  },
  required: ["isShipping", "status", "itemName"],
} as const;

const classificationSchema = z.object({
  isShipping: z.boolean(),
  status: z.enum(ORDER_STATUSES).nullable(),
  itemName: z.string().nullable(),
});

/** What the LLM contributes: a status (and optional item name) only. */
export interface LlmClassification {
  status: OrderStatus;
  itemName?: string;
}

/**
 * Optional fallback classifier for shipping emails the deterministic parser
 * can't read. Sends the email subject + (truncated) body to Claude and asks for
 * a structured verdict, validated with zod before use. Construction is cheap;
 * the caller gates *when* to call {@link classify} (opt-in, per-tick cap,
 * watermark dedup, never in dry-run) — this class just makes one bounded call.
 */
export class LlmParser {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Classify one message. Returns a status (+ optional item name) for a
   * shipping email, or null when the model judges it not a shipment. Throws on
   * API/parse errors so the caller can log-and-continue per message.
   */
  async classify(msg: ParsedMessage): Promise<LlmClassification | null> {
    const body = (msg.body || msg.snippet).slice(0, MAX_BODY_CHARS);
    const userContent =
      `Subject: ${msg.subject}\nFrom: ${msg.from}\n\nBody:\n${body}`;

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    });

    const json = extractJson(res);
    const parsed = classificationSchema.parse(json);
    if (!parsed.isShipping || !parsed.status) return null;
    return { status: parsed.status, itemName: parsed.itemName ?? undefined };
  }
}

/** Pull the JSON object out of the (structured-output) response text block. */
function extractJson(res: Anthropic.Message): unknown {
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!text) throw new Error("LLM response contained no text block");
  return JSON.parse(text.text);
}
