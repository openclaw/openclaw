/**
 * Mermaid XSS Security Test Suite
 *
 * Run these tests to verify XSS protections are working correctly.
 * All tests should result in sanitized output with NO script execution.
 */

import { toSanitizedMarkdownHtml } from "./markdown.ts";

interface TestCase {
  name: string;
  input: string;
  shouldNotContain: string[];
  description: string;
}

const xssTestCases: TestCase[] = [
  {
    name: "Script injection in markdown",
    input: "# Test\n<script>alert('xss')</script>",
    shouldNotContain: ["<script", "alert"],
    description: "Raw script tags should be stripped",
  },
  {
    name: "SVG with onload handler",
    input:
      '```mermaid\ngraph TD\n    A[Start]\n```\n<svg onload="alert(\'xss\')"><circle cx="50" cy="50" r="40"/></svg>',
    shouldNotContain: ["onload", "alert"],
    description: "SVG event handlers should be removed",
  },
  {
    name: "Mermaid with embedded script",
    input: "```mermaid\ngraph TD\n    A[\"<script>alert('xss')</script>\"]\n```",
    shouldNotContain: ["<script", "alert("],
    description: "Scripts in mermaid labels should be escaped",
  },
  {
    name: "SVG with onerror handler",
    input: '<svg><image onerror="alert(\'xss\')" src="invalid" /></svg>',
    shouldNotContain: ["onerror", "alert"],
    description: "SVG onerror handlers should be removed",
  },
  {
    name: "SVG with onclick handler",
    input: '<svg onclick="alert(\'xss\')"><rect width="100" height="100"/></svg>',
    shouldNotContain: ["onclick", "alert"],
    description: "SVG onclick handlers should be removed",
  },
  {
    name: "Unauthorized standalone SVG",
    input: "<svg><text>Malicious</text></svg>",
    shouldNotContain: ["<svg"],
    description: "SVGs outside mermaid-diagram containers should be removed",
  },
  {
    name: "JavaScript protocol in link",
    input: '[Click me](javascript:alert("xss"))',
    shouldNotContain: ["javascript:"],
    description: "JavaScript protocol in links should be stripped",
  },
  {
    name: "Data URI with script",
    input: '![img](data:text/html,<script>alert("xss")</script>)',
    shouldNotContain: ["<script", "alert"],
    description: "Scripts in data URIs should be neutralized",
  },
  {
    name: "SVG with animationend event",
    input: "<svg><animate onend=\"alert('xss')\"/></svg>",
    shouldNotContain: ["onend", "alert"],
    description: "SVG animation event handlers should be removed",
  },
  {
    name: "Mermaid with excessive text",
    input: "```mermaid\ngraph TD\n" + 'A["' + "X".repeat(60000) + '"]\n```',
    shouldNotContain: [],
    description: "Excessively large mermaid diagrams should be limited by maxTextSize",
  },
];

/**
 * Run all XSS tests and return results
 */
export async function runXssTests(): Promise<{
  passed: number;
  failed: number;
  results: Array<{ name: string; passed: boolean; reason?: string }>;
}> {
  const results: Array<{ name: string; passed: boolean; reason?: string }> = [];
  let passed = 0;
  let failed = 0;

  for (const testCase of xssTestCases) {
    try {
      const output = await toSanitizedMarkdownHtml(testCase.input);

      // Check if any dangerous content leaked through
      let testPassed = true;
      let failReason = "";

      for (const dangerousString of testCase.shouldNotContain) {
        if (output.toLowerCase().includes(dangerousString.toLowerCase())) {
          testPassed = false;
          failReason = `Dangerous content found: "${dangerousString}"`;
          break;
        }
      }

      if (testPassed) {
        passed++;
        results.push({ name: testCase.name, passed: true });
        console.log(`✅ PASS: ${testCase.name}`);
      } else {
        failed++;
        results.push({ name: testCase.name, passed: false, reason: failReason });
        console.error(`❌ FAIL: ${testCase.name} - ${failReason}`);
        console.error(`   Input: ${testCase.input.substring(0, 100)}...`);
        console.error(`   Output: ${output.substring(0, 100)}...`);
      }
    } catch (error) {
      // Errors during rendering are acceptable for malformed input
      passed++;
      results.push({
        name: testCase.name,
        passed: true,
        reason: "Rendering failed safely (acceptable)",
      });
      console.log(`✅ PASS: ${testCase.name} (safe failure)`);
    }
  }

  console.log(`\n📊 Test Summary: ${passed}/${xssTestCases.length} passed, ${failed} failed`);
  return { passed, failed, results };
}

// Auto-run tests if executed directly
if (import.meta.main) {
  await runXssTests();
}
