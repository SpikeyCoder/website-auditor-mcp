/**
 * Field descriptions as a neutral server (the Claude connector,
 * WA_TOOL_COPY=neutral) publishes them in tools/list.
 *
 * The Claude directory's compliance step asks the submitter to confirm that
 * tool descriptions "contain no instructions about model behavior, other
 * tools, or external instruction sources" (claude.ai/directory/manage,
 * 2026-10-15), and the portal shows the input and output schemas beside each
 * description. NEUTRAL_EDITS (registry.ts) rewrites the descriptions; this
 * does the same for every `.describe()` string inside the schemas: "Relay it",
 * "do not report it as 0", "supply one only when…" become the facts they rested
 * on. Everything else about a schema — its types, optionality, defaults,
 * passthrough — is carried over untouched, because the SDK validates every
 * structuredContent against the output schema and a clone that validated
 * differently would turn working tools into errors.
 *
 * Phrase edits, applied in order to every description string: targeted, like
 * NEUTRAL_EDITS, so the full copy stays the single source and a reworded field
 * fails the test that every phrase still matches (tests/http/claudeConnector).
 */
import { ZodType, type ZodRawShape } from "zod";

export const NEUTRAL_SCHEMA_EDITS: Array<[string, string]> = [
  // business_name (get_ai_visibility, run_audit): when to pass it, as what passing it does.
  [
    "Optional. The business's real name, if you know it. Leave it out and the audit detects the name from the site and flags it when unverified — a guessed name is scored as if confirmed, so supply one only when it is actually known.",
    "Optional. The business's real name. Left out, the audit detects the name from the site and flags it when unverified; a supplied name is scored as confirmed and is never flagged.",
  ],
  ["so there is no score; do not report it as 0.", "so there is no score, which is not the same as 0."],
  [". Relay it — a null delta for this reason reads like one for want of history otherwise.", ". A null delta for this reason is not a lack of history."],
  [". Relay it — a null delta for this reason must not read like a null for want of history.", ". A null delta for this reason is not a lack of history."],
  [". Relay it — a difference between scores that answered different questions is not a change in visibility.",
    ". A difference between scores that answered different questions is not a change in visibility."],
  [". Relay it: the score covers fewer engines than the four this tool can query.", ". The score then covers fewer engines than the four this tool can query."],
  [", so relay this caveat rather than presenting the score as settled.", ", so the score is in question."],
  // generate_schema: the placeholders and the order of the notes, as facts.
  [
    "that the owner must replace with real names confirmed with them, never guessed from the domain or copied from an audit.",
    "meant to be replaced with the business's real names, which the tool does not know; a name an audit detected is not confirmed by the owner.",
  ],
  ["— each name placeholder, confirmed with the owner —", "— each name placeholder —"],
  ["Relay the whole string, in that order: the replacement ask comes before the placement.", "The replacement comes before the placement."],
  // get_gtm_plan
  ["Null means unknown — never render a substitute.", "Null means unknown."],
  [": render `markdown` instead, and do not report it as a plan without actions.", ": `markdown` holds the plan, actions included."],
  // get_sample_audit
  ["Always true. Never present this as a live result.", "Always true: this is sample data, not a live result."],
  // Last, after the sentences above that continue past it: the bare form.
  [" Relay it.", ""],
];

function neutralText(text: string): string {
  let out = text;
  for (const [from, to] of NEUTRAL_SCHEMA_EDITS) out = out.split(from).join(to);
  return out;
}

const cache = new WeakMap<ZodType, ZodType>();

/**
 * A copy of the schema whose descriptions, at every depth, are the neutral
 * ones. Zod v3 keeps a schema's description and its children in `_def`, so the
 * copy is the same class built from a copied `_def`: children are walked
 * wherever they sit (a direct child, a list or Map of them, an object's lazy
 * `shape`, a z.lazy `getter`),
 * and every other part of `_def` is shared as is.
 */
export function neutralSchema<T extends ZodType>(schema: T): T {
  const seen = cache.get(schema);
  if (seen) return seen as T;
  const def: Record<string, unknown> = { ...(schema as unknown as { _def: Record<string, unknown> })._def };
  if (typeof def.description === "string") def.description = neutralText(def.description);
  for (const [key, value] of Object.entries(def)) {
    if (value instanceof ZodType) def[key] = neutralSchema(value);
    else if (Array.isArray(value) && value.some((v) => v instanceof ZodType)) {
      def[key] = value.map((v) => (v instanceof ZodType ? neutralSchema(v) : v));
    } else if (value instanceof Map && [...value.values()].some((v) => v instanceof ZodType)) {
      // A discriminated union's optionsMap, which validation reads.
      def[key] = new Map([...value].map(([k, v]) => [k, v instanceof ZodType ? neutralSchema(v) : v]));
    } else if (key === "shape" && typeof value === "function") {
      const shape = (value as () => ZodRawShape)();
      const copied = neutralShape(shape);
      def[key] = () => copied;
    } else if (key === "getter" && typeof value === "function") {
      // z.lazy: resolved on first use, like the original, and then neutral.
      const getter = value as () => ZodType;
      def[key] = () => neutralSchema(getter());
    }
  }
  const Ctor = schema.constructor as new (d: unknown) => T;
  const copy = new Ctor(def);
  cache.set(schema, copy);
  return copy;
}

const shapeCache = new WeakMap<ZodRawShape, ZodRawShape>();

/** A raw shape (registerTool's inputSchema / outputSchema) with neutral descriptions. */
export function neutralShape(shape: ZodRawShape): ZodRawShape {
  const seen = shapeCache.get(shape);
  if (seen) return seen;
  const copy = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, neutralSchema(v)])) as ZodRawShape;
  shapeCache.set(shape, copy);
  return copy;
}
