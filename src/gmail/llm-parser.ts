import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ParsedMessage } from "./client.js";
import {
  ORDER_CATEGORIES,
  ORDER_STATUSES,
  type OrderCategory,
  type OrderStatus,
} from "../types.js";

// Cap the email body sent to the model. Shipping mail puts the signal up top;
// this bounds per-call token cost and keeps marketing footers out of the prompt.
const MAX_BODY_CHARS = 4000;
const MAX_TOKENS = 320;

const SYSTEM_PROMPT = [
  "You classify order/shipping notification emails (any language) for physical orders.",
  "Decide if the email reports an order/shipment status, and if so which one:",
  '- "Ordered": order placed/confirmed, not yet shipped.',
  '- "In Transit": shipped, dispatched, on the way, label created.',
  '- "Delayed": delivery delayed, attempted/failed delivery.',
  '- "Arriving Soon": out for delivery, arriving today/tomorrow, an expected delivery date.',
  '- "Delivered": the package was delivered.',
  '- "Cancelled": the order was cancelled.',
  '- "Returned": a return or refund was processed.',
  "If it is not an order/shipping notification for a physical product (marketing,",
  "password reset, a plain receipt, a digital code), set isShipping=false, status=null.",
  "itemName: the product/item name if clearly stated, else null.",
  "category: one of Game, Book, Accessory, Electronics, Digital, Other — or null if unclear.",
  "tags: up to 6 short tags — franchise (e.g. Zelda, Mario) and attributes",
  "(Preorder, Guide, Limited Edition, Switch 2, amiibo, Digital). Empty array if none.",
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
      description:
        "True if this is an order/shipment status notification for a physical product.",
    },
    status: {
      anyOf: [{ type: "string", enum: [...ORDER_STATUSES] }, { type: "null" }],
      description: "The order/shipment status, or null when isShipping is false.",
    },
    itemName: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Product/item name if clearly stated, else null.",
    },
    category: {
      anyOf: [{ type: "string", enum: [...ORDER_CATEGORIES] }, { type: "null" }],
      description: "Item type, or null if unclear.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Up to 6 short franchise/attribute tags; empty if none.",
    },
  },
  required: ["isShipping", "status", "itemName", "category", "tags"],
} as const;

const classificationSchema = z.object({
  isShipping: z.boolean(),
  status: z.enum(ORDER_STATUSES).nullable(),
  itemName: z.string().nullable(),
  category: z.enum(ORDER_CATEGORIES).nullable(),
  tags: z.array(z.string()),
});

/** The LLM's structured verdict: status, item name, category, and tags. */
export interface LlmClassification {
  isShipping: boolean;
  status: OrderStatus | null;
  itemName: string | null;
  category: OrderCategory | null;
  tags: string[];
}

/**
 * Optional classifier for order/shipping emails the deterministic parser can't
 * read (foreign-language, ambiguous) or items its keyword lists can't tag/type.
 * Sends the subject + (truncated) body to Claude for a structured verdict,
 * validated with zod before use. Construction is cheap; the caller gates *when*
 * to call {@link classify} (opt-in, per-tick cap, watermark dedup, never in
 * dry-run) — this class just makes one bounded call.
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
   * Classify one message into a {@link LlmClassification}. Throws on API/parse
   * errors so the caller can log-and-continue per message.
   */
  async classify(msg: ParsedMessage): Promise<LlmClassification> {
    const body = (msg.body || msg.snippet).slice(0, MAX_BODY_CHARS);
    const userContent = `Subject: ${msg.subject}\nFrom: ${msg.from}\n\nBody:\n${body}`;

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    });

    return classificationSchema.parse(extractJson(res));
  }

  /**
   * Categorize a single purchased item into exactly one of `categories` (the
   * general spend taxonomy, already excluding domain-owned Books/Games). Returns
   * the chosen category, or null if the model returns something off-list. One
   * bounded call; the caller gates *when* to call it (gap-only + per-tick cap).
   */
  async categorizeGeneral(
    item: string,
    merchant: string,
    categories: string[],
  ): Promise<string | null> {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { category: { type: "string", enum: [...categories] } },
      required: ["category"],
    } as const;

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 40,
      system:
        "You categorize a purchased product into exactly one spending category. " +
        'Pick the single best fit from the allowed list; use "Other" only if none clearly fit.',
      messages: [
        {
          role: "user",
          content: `Merchant: ${merchant}\nItem: ${item}\n\nAllowed categories: ${categories.join(", ")}`,
        },
      ],
      output_config: { format: { type: "json_schema", schema } },
    });

    const parsed = z.object({ category: z.string() }).parse(extractJson(res));
    return categories.includes(parsed.category) ? parsed.category : null;
  }
}

/** Pull the JSON object out of the (structured-output) response text block. */
function extractJson(res: Anthropic.Message): unknown {
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!text) throw new Error("LLM response contained no text block");
  return JSON.parse(text.text);
}
