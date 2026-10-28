// Deterministic scripted driver (F3-R4, ADR-2). A fixed grammar maps a mention to a plan; nothing here is
// model reasoning, and every plan and reply is labelled `mode: "scripted"`.
export const DRIVER = { mode: "scripted", name: "scripted-v1" } as const;

export type Plan =
  | { workflow: "W01"; summary: string }
  | { workflow: "W02"; amount_cents: number; item: string }
  | { workflow: "W02-edit"; ref: string; amount_cents: number }
  | { workflow: "W03"; fields: Record<string, string> }
  | { workflow: "help" };

export function plan(text: string): Plan {
  const t = text.replace(/<@[^>]+>/g, "").trim();
  let m: RegExpExecArray | null;
  if ((m = /^service[- ]request\s+(.{1,200})$/is.exec(t))) return { workflow: "W01", summary: m[1]!.trim() };
  if ((m = /^purchase[- ]request\s+(-?\d{1,12})\s+(.{1,120})$/is.exec(t))) return { workflow: "W02", amount_cents: Number(m[1]), item: m[2]!.trim() };
  if ((m = /^purchase[- ]edit\s+(apr-[0-9a-f]{12})\s+(-?\d{1,12})$/i.exec(t))) return { workflow: "W02-edit", ref: m[1]!, amount_cents: Number(m[2]) };
  if ((m = /^crm[- ]update\b(.*)$/is.exec(t))) return { workflow: "W03", fields: fields(m[1]!) };
  return { workflow: "help" };
}

// key=value or key="quoted value" pairs; anything else in the text is ignored.
function fields(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([a-z][a-z-]*)=(?:"([^"]*)"|(\S+))/gi)) out[m[1]!.toLowerCase()] = m[2] ?? m[3]!;
  return out;
}
