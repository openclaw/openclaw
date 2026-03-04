/**
 * Real-time validation preview for config form
 * 
 * Validates fields as the user types with debounced validation
 * Shows inline error messages and visual feedback
 * Integrates with enhanced error handling
 */

import { enhanceError, type EnhancedError } from "./error-handling.ts";

export type ValidationResult = {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
    suggestion?: string;
  }>;
};

export type FieldValidationState = {
  valid: boolean | null;
  error?: EnhancedError;
  validating?: boolean;
};

/**
 * Debounce helper for validation
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return function (this: any, ...args: Parameters<T>) {
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      func.apply(this, args);
    }, wait);
  };
}

/**
 * Validate a single field value
 */
export function validateField(
  path: string,
  value: unknown,
  schema: any,
): FieldValidationState {
  try {
    // Basic validation checks
    if (path.includes("token") && typeof value === "string") {
      // Discord token validation
      if (path.includes("discord")) {
        const tokenPattern = /^[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}$/;
        if (!tokenPattern.test(value)) {
          return {
            valid: false,
            error: enhanceError("Invalid Discord token format"),
          };
        }
      }
    }

    // URL validation
    if (
      (path.includes("url") || path.includes("webhook")) &&
      typeof value === "string" &&
      value.trim()
    ) {
      try {
        new URL(value);
      } catch {
        return {
          valid: false,
          error: {
            message: "Invalid URL format",
            suggestion:
              'URLs must include protocol (http:// or https://). Example: "https://example.com"',
            code: "INVALID_URL",
          },
        };
      }
    }

    // Port number validation
    if (path.includes("port") && typeof value === "number") {
      if (value < 1 || value > 65535) {
        return {
          valid: false,
          error: {
            message: "Invalid port number",
            suggestion: "Port numbers must be between 1 and 65535",
            code: "INVALID_PORT",
          },
        };
      }
    }

    // Email validation
    if (path.includes("email") && typeof value === "string" && value.trim()) {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(value)) {
        return {
          valid: false,
          error: {
            message: "Invalid email format",
            suggestion: 'Email should be in format: "user@example.com"',
            code: "INVALID_EMAIL",
          },
        };
      }
    }

    // Cron expression validation
    if (path.includes("cron") && typeof value === "string" && value.trim()) {
      const parts = value.trim().split(/\s+/);
      if (parts.length !== 5) {
        return {
          valid: false,
          error: {
            message: "Invalid cron expression",
            suggestion:
              'Cron expressions need 5 parts: "minute hour day month weekday". Example: "0 * * * *" (hourly)',
            docsUrl: "https://crontab.guru/",
            code: "INVALID_CRON",
          },
        };
      }
    }

    // JSON validation for string fields that should contain JSON
    if (
      path.includes("json") &&
      typeof value === "string" &&
      value.trim()
    ) {
      try {
        JSON.parse(value);
      } catch {
        return {
          valid: false,
          error: {
            message: "Invalid JSON",
            suggestion:
              "Check for missing commas, brackets, or quotes. Use a JSON validator to find the exact error.",
            code: "INVALID_JSON",
          },
        };
      }
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: enhanceError(error as Error),
    };
  }
}

/**
 * Validate entire config object
 */
export async function validateConfig(
  config: unknown,
  schema?: any,
): Promise<ValidationResult> {
  const errors: ValidationResult["errors"] = [];

  try {
    // If schema is provided, use it for validation
    if (schema && typeof schema.parse === "function") {
      try {
        schema.parse(config);
      } catch (err: any) {
        // Zod validation error
        if (err.errors && Array.isArray(err.errors)) {
          for (const zodError of err.errors) {
            const path = zodError.path?.join(".") || "unknown";
            errors.push({
              path,
              message: zodError.message,
              suggestion: getSuggestionForZodError(zodError),
            });
          }
        }
      }
    }

    // Additional custom validations
    if (typeof config === "object" && config !== null) {
      validateConfigObject(config as Record<string, unknown>, "", errors);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          path: "root",
          message: "Failed to validate configuration",
          suggestion: "Check console for detailed error information",
        },
      ],
    };
  }
}

/**
 * Recursively validate config object
 */
function validateConfigObject(
  obj: Record<string, unknown>,
  prefix: string,
  errors: ValidationResult["errors"],
): void {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    const result = validateField(path, value, null);
    if (!result.valid && result.error) {
      errors.push({
        path,
        message: result.error.message,
        suggestion: result.error.suggestion,
      });
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      validateConfigObject(value as Record<string, unknown>, path, errors);
    }
  }
}

/**
 * Get suggestion for Zod validation error
 */
function getSuggestionForZodError(error: any): string | undefined {
  const code = error.code;

  switch (code) {
    case "invalid_type":
      return `Expected ${error.expected}, but got ${error.received}`;
    case "too_small":
      return `Value must be at least ${error.minimum}`;
    case "too_big":
      return `Value must be at most ${error.maximum}`;
    case "invalid_string":
      return `Invalid string format: ${error.validation}`;
    case "invalid_enum_value":
      return `Must be one of: ${error.options?.join(", ")}`;
    default:
      return undefined;
  }
}

/**
 * CSS classes for validation feedback
 */
export const VALIDATION_STYLES = `
.field--valid .field-input {
  border-color: var(--color-success, #10b981);
}

.field--invalid .field-input {
  border-color: var(--color-danger, #ef4444);
}

.field--validating .field-input {
  border-color: var(--color-accent, #6366f1);
}

.field-error {
  margin-top: 4px;
  font-size: 13px;
  color: var(--color-danger, #ef4444);
  display: flex;
  align-items: start;
  gap: 6px;
}

.field-error__icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.field-error__message {
  flex: 1;
}

.field-suggestion {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-secondary, #666);
  padding: 8px;
  background: var(--color-bg-secondary, #f9fafb);
  border-left: 3px solid var(--color-accent, #6366f1);
  border-radius: 4px;
}

.field-success {
  margin-top: 4px;
  font-size: 13px;
  color: var(--color-success, #10b981);
  display: flex;
  align-items: center;
  gap: 6px;
}

.validation-summary {
  padding: 12px;
  margin-bottom: 16px;
  border-radius: 8px;
  border: 1px solid;
}

.validation-summary--error {
  background: var(--color-danger-bg, #fef2f2);
  border-color: var(--color-danger, #ef4444);
  color: var(--color-danger-text, #991b1b);
}

.validation-summary--success {
  background: var(--color-success-bg, #f0fdf4);
  border-color: var(--color-success, #10b981);
  color: var(--color-success-text, #065f46);
}

.validation-summary__title {
  font-weight: 600;
  margin-bottom: 8px;
}

.validation-summary__list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.validation-summary__item {
  padding: 4px 0;
  display: flex;
  gap: 8px;
}

.validation-summary__item-path {
  font-family: monospace;
  font-size: 12px;
  color: var(--color-text-tertiary, #999);
}
`;
