// Tool schema for the live-model lane (F5-R5). The model may only propose the six C3 operations the scripted
// driver uses. It never supplies tenant, actor, connection, authorization_decision or policy_version: the runtime
// binds those, and deterministic policy decides every action outside the model (F3-R4).
// Input field names are provisional: the scripted driver's C3 operation schemas are canonical; reconcile when they land.
export const OPERATIONS = [
  "ticket.create",
  "receipt.put",
  "approval.request",
  "approval.resolve",
  "crm.description.update",
  "slack.reply",
] as const;
export type Operation = (typeof OPERATIONS)[number];

interface ToolDef {
  name: string; // provider-safe name (many providers reject dots); maps 1:1 to `operation`
  operation: Operation;
  description: string;
  input_schema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });

export const LIVE_MODEL_TOOLS: ToolDef[] = [
  {
    name: "ticket_create", operation: "ticket.create",
    description: "Propose a service ticket for the current request.",
    input_schema: obj({ summary: text(200) }, ["summary"]),
  },
  {
    name: "receipt_put", operation: "receipt.put",
    description: "Propose storing a receipt for an existing ticket.",
    input_schema: obj({ ticket_id: text(64), body: text(4000) }, ["ticket_id", "body"]),
  },
  {
    name: "approval_request", operation: "approval.request",
    description: "Propose requesting human approval for a fictional purchase. No payment is executed.",
    input_schema: obj({ summary: text(200), amount_cents: { type: "integer", minimum: 1 } }, ["summary", "amount_cents"]),
  },
  {
    name: "approval_resolve", operation: "approval.resolve",
    description: "Relay an approver's recorded decision. Policy checks approver identity and expiry; the model cannot approve.",
    input_schema: obj({ approval_id: text(64), decision: { enum: ["approve", "reject"] } }, ["approval_id", "decision"]),
  },
  {
    name: "crm_description_update", operation: "crm.description.update",
    description: "Propose a compare-and-write update to the bound account's description.",
    input_schema: obj(
      { account_ref: text(64), description: text(255), expected_version: { type: "integer", minimum: 1 } },
      ["account_ref", "description", "expected_version"],
    ),
  },
  {
    name: "slack_reply", operation: "slack.reply",
    description: "Propose a reply in the originating thread. The runtime binds channel and thread.",
    input_schema: obj({ text: text(3000) }, ["text"]),
  },
];
