/** Replace a string with bullet placeholders. `show` keeps that many leading chars visible. */
export function redactString(value: string, show = 0): string {
  if (show <= 0) {
    return "••••••";
  }
  if (value.length <= show) {
    return "••••••";
  }
  return value.slice(0, show) + "••••••";
}

export function redactNumber(): string {
  return "•••";
}

export function redactCost(): string {
  return "$•.••";
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//••••••••`;
  } catch {
    return "••••••••";
  }
}

const PHONE_RE =
  /\+\d[\d\s\-().]{6,}\d|\(\d{3}\)\s*\d{3}[\s.-]\d{4}|\d{3}[\s.-]\d{3}[\s.-]\d{4}|\b\d{10,15}\b/g;

/** Always-on phone number masking (not gated by stream mode). */
export function maskPhoneNumbers(text: string): string {
  return text.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 7) {
      return match;
    }
    return `***${digits.slice(-2)}`;
  });
}
