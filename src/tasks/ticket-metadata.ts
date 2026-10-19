import { ticketV2Fields, type TicketV2 } from "./plan.js";

/** Read back structured v2 data; plan.ts owns the parser. */
export { parseTicketV2 } from "./plan.js";

/** Versioned JSON preserves argv boundaries and empty optional arrays exactly.
 * This is data only; issue-supplied verify commands are never executed here. */
export function renderTicketV2(ticket: TicketV2): string {
  const fields = ticketV2Fields(ticket);
  if (!Object.keys(fields).length) return "";
  return `## Ticket metadata (v2)\n\n\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``;
}

