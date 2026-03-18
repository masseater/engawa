export function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  if (!messages) return body;

  // Collect IDs of tool_use blocks with empty names
  const orphanIds = new Set<string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block.type === "tool_use" && !block.name && block.id) {
        orphanIds.add(block.id as string);
      }
    }
  }

  if (
    orphanIds.size === 0 &&
    !(body.tools as Array<Record<string, unknown>> | undefined)?.some((t) => !t.name)
  ) {
    return body;
  }

  const cleaned = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: (msg.content as Array<Record<string, unknown>>).filter((block) => {
        if (block.type === "tool_use" && !block.name) return false;
        if (block.type === "tool_result" && orphanIds.has(block.tool_use_id as string))
          return false;
        return true;
      }),
    };
  });

  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  const cleanedTools = tools?.filter((t) => t.name);

  return { ...body, messages: cleaned, ...(tools ? { tools: cleanedTools } : {}) };
}
