/** Encode only the explicitly selected Agent payload; details stay Pi-owned. */
export function agentResult(data, details = {}) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], details };
}
