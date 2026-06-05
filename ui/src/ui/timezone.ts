let configuredTimezone: string | undefined;

export function setTimezone(tz: string | undefined) {
  configuredTimezone = tz;
}

export function getTimezone(): string | undefined {
  return configuredTimezone;
}

function tzOpts(opts?: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions | undefined {
  if (!configuredTimezone) {
    return opts;
  }
  return { ...opts, timeZone: configuredTimezone };
}

export function toLocaleDateString(
  date: Date,
  locales?: string | string[],
  opts?: Intl.DateTimeFormatOptions,
): string {
  return date.toLocaleDateString(locales, tzOpts(opts));
}

export function toLocaleTimeString(
  date: Date,
  locales?: string | string[],
  opts?: Intl.DateTimeFormatOptions,
): string {
  return date.toLocaleTimeString(locales, tzOpts(opts));
}

export function toLocaleString(
  date: Date,
  locales?: string | string[],
  opts?: Intl.DateTimeFormatOptions,
): string {
  return date.toLocaleString(locales, tzOpts(opts));
}
