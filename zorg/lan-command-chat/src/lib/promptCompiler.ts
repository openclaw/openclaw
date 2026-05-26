import { getDbPool } from "@/lib/db";

export async function compileSystemPrompt(inputText: string, metadata: Record<string, unknown> = {}) {
  const p = getDbPool();
  if (!p) {
    return null;
  }

  const sql = `
    select compiled_prompt, detected_intent, matched_rule_keys, matched_tool_keys, matched_categories
    from zorg_compile_system_prompt($1, $2::jsonb)
    limit 1
  `;

  const { rows } = await p.query(sql, [inputText, JSON.stringify(metadata)]);
  return rows?.[0] || null;
}
