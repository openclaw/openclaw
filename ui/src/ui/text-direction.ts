/**
 * RTL (Right-to-Left) text direction detection.
 * Detects Hebrew, Arabic, Syriac, Thaana, Nko, Samaritan, Mandaic, Adlam,
 * Phoenician, and Lydian scripts using Unicode Script Properties.
 */

const RTL_CHAR_REGEX =
  /\p{Script=Hebrew}|\p{Script=Arabic}|\p{Script=Syriac}|\p{Script=Thaana}|\p{Script=Nko}|\p{Script=Samaritan}|\p{Script=Mandaic}|\p{Script=Adlam}|\p{Script=Phoenician}|\p{Script=Lydian}/u;

const LETTER_CHAR_REGEX = /\p{L}/u;
const LEADING_REPLY_TAG_REGEX = /^\s*\[\[\s*reply_to(?:_current|\s*:\s*[^\]]+)?\s*\]\]\s*/iu;
const FENCED_CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`\n]+`/g;

/**
 * Detect text direction from significant letters in the message.
 *
 * Uses a light-weight heuristic:
 * - skip whitespace/punctuation/symbols
 * - count RTL vs non-RTL letters
 * - fall back to the first significant strong character on ties
 */
export function detectTextDirection(
  text: string | null,
  skipPattern: RegExp = /[\s\p{P}\p{S}]/u,
): "rtl" | "ltr" {
  if (!text) {
    return "ltr";
  }

  // Ignore OpenClaw reply tags and code snippets when inferring direction.
  // Code blocks are often English-heavy and can skew base direction.
  const normalized = text
    .replace(LEADING_REPLY_TAG_REGEX, "")
    .replace(FENCED_CODE_BLOCK_REGEX, " ")
    .replace(INLINE_CODE_REGEX, " ");

  let rtlCount = 0;
  let ltrCount = 0;
  let firstStrong: "rtl" | "ltr" | null = null;

  for (const char of normalized) {
    if (skipPattern.test(char)) {
      continue;
    }

    if (RTL_CHAR_REGEX.test(char)) {
      rtlCount++;
      firstStrong ??= "rtl";
      continue;
    }

    if (LETTER_CHAR_REGEX.test(char)) {
      ltrCount++;
      firstStrong ??= "ltr";
    }
  }

  if (rtlCount === 0 && ltrCount === 0) {
    return "ltr";
  }
  if (rtlCount === ltrCount) {
    return firstStrong ?? "ltr";
  }
  return rtlCount > ltrCount ? "rtl" : "ltr";
}
