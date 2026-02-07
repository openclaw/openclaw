#!/usr/bin/env node
/**
 * Injection Detector — 檢測 prompt injection 嘗試
 * 掃描用戶輸入是否包含惡意注入模式
 *
 * Migrated from injection_detector.py → JS (統一語言)
 */

// 注入模式（英文 + 中文）— [regex, name]
const INJECTION_PATTERNS = [
  // 忽略指令類
  [/ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i, "ignore_instructions"],
  [/disregard\s+(your|the|all)\s+(instructions?|rules?|guidelines?)/i, "disregard_rules"],
  [/forget\s+(everything|all|your)\s+(you\s+were\s+told|instructions?)/i, "forget_instructions"],
  [/忽略.*指令/, "ignore_instructions_zh"],
  [/無視.*規則/, "disregard_rules_zh"],

  // 角色扮演類
  [/pretend\s+(you\s+are|to\s+be|you're)\s+/i, "pretend_role"],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)/i, "act_unrestricted"],
  [/you\s+are\s+now\s+(a|an)\s+/i, "role_override"],
  [/假裝你是/, "pretend_role_zh"],
  [/你現在是/, "role_override_zh"],

  // 提取系統提示類
  [
    /(reveal|show|tell\s+me|what\s+(is|are))\s+(your\s+)?(system\s+prompt|instructions?|rules?)/i,
    "extract_prompt",
  ],
  [/repeat\s+(your\s+)?(system\s+prompt|instructions?|initial\s+prompt)/i, "repeat_prompt"],
  [/顯示.*系統提示/, "extract_prompt_zh"],
  [/告訴我你的指令/, "extract_prompt_zh"],

  // DAN / 越獄類
  [/\bDAN\b/, "dan_jailbreak"],
  [/jailbreak/i, "jailbreak"],
  [/developer\s+mode/i, "developer_mode"],
  [/越獄/, "jailbreak_zh"],

  // 權限提升類
  [
    /(give|grant)\s+(me|yourself)\s+(admin|root|full)\s+(access|permissions?)/i,
    "privilege_escalation",
  ],
  [/bypass\s+(security|restrictions?|filters?)/i, "bypass_security"],
  [/繞過.*限制/, "bypass_security_zh"],
];

// 風險權重
const WEIGHTS = {
  ignore_instructions: 8,
  disregard_rules: 8,
  forget_instructions: 7,
  pretend_role: 5,
  act_unrestricted: 7,
  role_override: 4,
  extract_prompt: 6,
  repeat_prompt: 6,
  dan_jailbreak: 9,
  jailbreak: 9,
  developer_mode: 8,
  privilege_escalation: 9,
  bypass_security: 8,
};

/**
 * 檢測文本中的注入模式
 * @param {string} text
 * @returns {{ type: string, matched: string, start: number, end: number }[]}
 */
export function detectInjection(text) {
  const results = [];
  for (const [regex, name] of INJECTION_PATTERNS) {
    // Reset lastIndex for global-like iteration
    const globalRe = new RegExp(
      regex.source,
      regex.flags.includes("g") ? regex.flags : regex.flags + "g",
    );
    let m;
    while ((m = globalRe.exec(text)) !== null) {
      results.push({ type: name, matched: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  return results;
}

/**
 * 分析風險等級
 * @param {{ type: string }[]} detections
 * @returns {{ risk_level: string, score: number, detections: object[] }}
 */
export function analyzeRisk(detections) {
  if (!detections.length) {
    return { risk_level: "safe", score: 0, detections: [] };
  }

  const score = detections.reduce((sum, d) => {
    const key = d.type.replace(/_zh$/, "");
    return sum + (WEIGHTS[key] ?? 5);
  }, 0);

  let risk_level;
  if (score >= 15) risk_level = "critical";
  else if (score >= 10) risk_level = "high";
  else if (score >= 5) risk_level = "medium";
  else risk_level = "low";

  return {
    risk_level,
    score,
    detections: detections.map((d) => ({
      type: d.type,
      matched: d.matched,
      position: [d.start, d.end],
    })),
  };
}

// ── CLI ──
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  const text = process.argv.slice(2).join(" ") || (await readStdin());
  const detections = detectInjection(text);
  const result = analyzeRisk(detections);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.risk_level === "high" || result.risk_level === "critical" ? 1 : 0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}
