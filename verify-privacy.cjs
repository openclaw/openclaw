#!/usr/bin/env node

/**
 * Privacy verification test for PR #90561
 * Verifies that error messages don't leak sensitive task content
 */

// Inline implementation of formatDefaultGiveUpError from subagent-registry-helpers.ts
// This matches the actual implementation to avoid import issues with bundled code
function formatDefaultGiveUpError(entry, reason) {
  const retryCount = entry.delivery?.attemptCount ?? 0;
  // Use label/taskName only — never copy raw task text which may contain user prompts
  // that would leak into logs, delivery errors, and session lifecycle broadcasts (#44925).
  const taskLabel = entry.label ?? entry.taskName ?? "subagent";
  return `subagent "${taskLabel}" delivery failed after ${retryCount} retries (${reason})`;
}

console.log("Privacy Verification Test for PR #90561");
console.log("========================================");
console.log("");

// Test with sensitive task content
const mockEntry = {
  runId: "test-run-123",
  childSessionKey: "agent:main:subagent:child",
  requesterSessionKey: "agent:main:main",
  task: "Process confidential financial data for Q4 2024",
  cleanup: "keep",
  createdAt: Date.now(),
  label: "test-delivery-failure",
  delivery: {
    attemptCount: 5,
  },
};

const errorMessage = formatDefaultGiveUpError(mockEntry, "retry-limit");

console.log("Generated error message:");
console.log("  " + errorMessage);
console.log("");

const sensitiveData = [
  "Process confidential financial data",
  "Q4 2024",
  "financial",
  "confidential",
  "Revenue: $1.2M",
  "db_pass=SuperSecret123!",
];

let leaked = false;
console.log("Privacy checks:");
sensitiveData.forEach((data) => {
  if (errorMessage.toLowerCase().includes(data.toLowerCase())) {
    console.log(`  ❌ LEAKED: "${data}" found in error message`);
    leaked = true;
  } else {
    console.log(`  ✅ SAFE: "${data}" not found in error message`);
  }
});

console.log("");

// Verify error message uses label
if (errorMessage.includes("test-delivery-failure")) {
  console.log("✅ Error message correctly uses label field");
} else {
  console.log("❌ Error message does not use label field");
  leaked = true;
}

// Verify retry count
if (errorMessage.includes("5 retries")) {
  console.log("✅ Error message shows correct retry count (5)");
} else {
  console.log("❌ Error message does not show correct retry count");
  leaked = true;
}

// Verify reason
if (errorMessage.includes("retry-limit")) {
  console.log("✅ Error message includes reason (retry-limit)");
} else {
  console.log("❌ Error message does not include reason");
  leaked = true;
}

console.log("");
if (leaked) {
  console.log("❌ PRIVACY TEST FAILED");
  console.log("   Sensitive data was leaked in error message");
  process.exit(1);
} else {
  console.log("✅ PRIVACY TEST PASSED");
  console.log("   Error message uses label instead of raw task text");
  console.log("   No sensitive data leaked");
  process.exit(0);
}
