import { parseTickets, ticketV2Fields, type TicketV2 } from "./plan.js";

/** Read back structured v2 data, applying the same structural checks as plans. */
export function parseTicketV2(body: string): TicketV2 {
  const json = /^## Ticket metadata \(v2\)\r?\n\r?\n```json\r?\n([\s\S]*?)\r?\n```[ \t]*$/m.exec(body)?.[1];
  if (json === undefined) return {};
  const fields: unknown = JSON.parse(json);
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("ticket metadata must be an object");
  return ticketV2Fields(parseTickets(JSON.stringify([{ ...fields, title: "metadata" }]))[0]);
}


/** Versioned JSON preserves argv boundaries and empty optional arrays exactly.
 * This is data only; issue-supplied verify commands are never executed here. */
export function renderTicketV2(ticket: TicketV2): string {
  const fields = ticketV2Fields(ticket);
  if (!Object.keys(fields).length) return "";
  return `## Ticket metadata (v2)\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``;
}

