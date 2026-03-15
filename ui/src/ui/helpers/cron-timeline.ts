import type { CronJob, CronSchedule } from "../types.ts";

// --- Types ---

export type TimelineZoom = "all" | "work" | "now";

export type TimelineMarker = {
  jobId: string;
  jobName: string;
  schedule: string;
  hour: number;
  pct: number;
  status: "ok" | "pending";
  color: string;
};

export type TimelineCluster = {
  pct: number;
  items: TimelineMarker[];
};

export type TimelineFreqChip = {
  jobId: string;
  jobName: string;
  schedule: string;
  color: string;
  lastStatus: string | undefined;
};

// --- Constants ---

const JOB_COLORS = [
  "#22c55e",
  "#3b82f6",
  "#f59e0b",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
  "#ef4444",
  "#6366f1",
  "#84cc16",
  "#f97316",
];

const HIGH_FREQ_EVERY_MS = 10 * 60 * 1000; // 10 minutes
const CLUSTER_THRESHOLD_PCT = 2.5;

// --- Helpers ---

function jobColor(index: number): string {
  return JOB_COLORS[index % JOB_COLORS.length];
}

function scheduleLabel(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "cron":
      return schedule.expr;
    case "every":
      return `every ${formatEveryMs(schedule.everyMs)}`;
    case "at":
      return `at ${schedule.at}`;
  }
}

function formatEveryMs(ms: number): string {
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  if (ms < 3_600_000) {
    return `${Math.round(ms / 60_000)}m`;
  }
  return `${Math.round(ms / 3_600_000)}h`;
}

/** Check if a job is high-frequency (runs more often than every 10 min). */
function isHighFrequency(schedule: CronSchedule): boolean {
  if (schedule.kind === "every") {
    return schedule.everyMs < HIGH_FREQ_EVERY_MS;
  }
  if (schedule.kind === "cron") {
    const rawParts = schedule.expr.trim().split(/\s+/);
    // Support 6-field cron (with seconds): minute is field index 1
    const minField = rawParts.length >= 6 ? rawParts[1] : rawParts[0];
    if (!minField) {
      return false;
    }
    // "* * * * *" runs every minute — definitely high freq
    if (minField === "*") {
      return true;
    }
    // "*/N ..." runs every N minutes
    const stepMatch = minField.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      return parseInt(stepMatch[1], 10) <= 10;
    }
  }
  return false;
}

/** Get zoom range in hours [start, end]. */
export function getZoomRange(zoom: TimelineZoom): [number, number] {
  switch (zoom) {
    case "all":
      return [0, 24];
    case "work":
      return [8, 20];
    case "now": {
      const now = new Date();
      const h = now.getHours() + now.getMinutes() / 60;
      return [Math.max(0, h - 3), Math.min(24, h + 3)];
    }
  }
}

/** Convert an hour value to a percentage within the zoom range. */
function hourToPct(hour: number, zoomStart: number, zoomEnd: number): number {
  return ((hour - zoomStart) / (zoomEnd - zoomStart)) * 100;
}

/** Get a Date-like object representing "now" in a specific timezone.
 *  Returns a Date whose getHours/getDate/getDay reflect the given tz. */
function dateInTimezone(tz: string): Date {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    // Construct a Date in local time that has the tz's date/time values
    const d = new Date(
      parseInt(get("year")),
      parseInt(get("month")) - 1,
      parseInt(get("day")),
      parseInt(get("hour")),
      parseInt(get("minute")),
    );
    // Preserve weekday from tz (Date constructor may differ at day boundaries)
    const weekdays: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const tzDow = weekdays[get("weekday")] ?? d.getDay();
    if (d.getDay() !== tzDow) {
      // Adjust date to match the tz's day-of-week
      d.setDate(d.getDate() + (tzDow - d.getDay()));
    }
    return d;
  } catch {
    return new Date();
  }
}

/** Convert an hour:minute in a given timezone to a local fractional hour.
 *  Returns null if the converted time falls on a different local day. */
function convertTzHourToLocal(
  hour: number,
  minute: number,
  tzToday: Date,
  tz: string,
): number | null {
  try {
    // Strategy: construct a UTC guess, read what time that is in the target tz,
    // compute the full offset (including date difference), then adjust.
    const y = tzToday.getFullYear();
    const mon = tzToday.getMonth();
    const d = tzToday.getDate();
    // Initial guess: assume UTC = wanted tz time (will be off by the tz offset)
    const guess = new Date(Date.UTC(y, mon, d, hour, minute, 0));
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    // Read what our guess looks like in the target tz
    const parts = fmt.formatToParts(guess);
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0");
    const guessInTz = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
    );
    const wantedInTz = Date.UTC(y, mon, d, hour, minute);
    // The difference tells us the full offset including any day rollover
    const offsetMs = guessInTz - wantedInTz;
    // The actual UTC instant when the job runs
    const actualUtc = new Date(guess.getTime() - offsetMs);
    // Convert to browser local time
    const localH = actualUtc.getHours() + actualUtc.getMinutes() / 60;
    // Check it's still "today" in local time
    const localToday = new Date();
    if (
      actualUtc.getDate() !== localToday.getDate() ||
      actualUtc.getMonth() !== localToday.getMonth()
    ) {
      return null;
    }
    return localH;
  } catch {
    // Invalid timezone — drop the marker rather than showing wrong position
    return null;
  }
}

/** Compute scheduled run hours for today for a cron job. */
function getTodayRunHours(schedule: CronSchedule): number[] {
  if (schedule.kind === "at") {
    const d = new Date(schedule.at);
    const today = new Date();
    if (
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    ) {
      return [d.getHours() + d.getMinutes() / 60];
    }
    return [];
  }

  if (schedule.kind === "every") {
    // For "every" schedules, compute actual run times for today using absolute anchor.
    // This correctly handles intervals that don't evenly divide 24h (e.g. every 7h)
    // where run hours drift across days.
    const intervalMs = schedule.everyMs;
    if (intervalMs <= 0) {
      return [];
    }
    const anchorMs = schedule.anchorMs ?? Date.now();

    // Get today's midnight as epoch ms
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    // Get next local midnight (handles DST transitions correctly)
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    const tomorrowMs = tomorrowStart.getTime();

    // Find the first run at or after today's midnight
    let firstRunMs: number;
    if (anchorMs >= todayMs) {
      firstRunMs = anchorMs;
    } else {
      const elapsed = todayMs - anchorMs;
      const remainder = elapsed % intervalMs;
      firstRunMs = remainder === 0 ? todayMs : todayMs + (intervalMs - remainder);
    }

    const hours: number[] = [];
    for (let runMs = firstRunMs; runMs < tomorrowMs; runMs += intervalMs) {
      const d = new Date(runMs);
      hours.push(d.getHours() + d.getMinutes() / 60);
    }
    return hours;
  }

  // Cron expression — parse with day-of-month and day-of-week awareness
  const rawParts = schedule.expr.trim().split(/\s+/);
  // Support 6-field cron (with seconds): skip the first field
  const parts = rawParts.length >= 6 ? rawParts.slice(1) : rawParts;
  if (parts.length < 5) {
    return [];
  }

  const [minField, hourField, domField, monField, dowField] = parts;

  // Determine "today" in the job's timezone (if specified).
  // TODO(P1-8): For tz-less cron expressions, we should use the gateway's
  // configured timezone (not browser local time) as the default. The gateway
  // timezone is not currently exposed to the UI layer. Once it is (e.g. via
  // gatewayTimezone in CronStatus or a global config store), use it here
  // instead of falling back to the browser's local time.
  const today = schedule.tz ? dateInTimezone(schedule.tz) : new Date();

  const minutes = parseCronField(minField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);

  if (!minutes.length || !hours.length) {
    return [];
  }

  // Helper function to check if a date satisfies the cron constraints
  function satisfiesDateConstraints(date: Date): boolean {
    // Check month constraint
    if (monField !== "*") {
      const validMons = parseCronField(monField, 1, 12);
      if (!validMons.includes(date.getMonth() + 1)) {
        return false;
      }
    }

    // Check day-of-month constraint
    if (domField !== "*" && domField !== "?") {
      const validDoms = parseCronField(domField, 1, 31);
      if (!validDoms.includes(date.getDate())) {
        return false;
      }
    }

    // Check day-of-week constraint
    if (dowField !== "*" && dowField !== "?") {
      const validDows = parseCronField(dowField, 0, 7);
      const dateDow = date.getDay();
      if (!validDows.includes(dateDow) && !(dateDow === 0 && validDows.includes(7))) {
        return false;
      }
    }

    return true;
  }

  // Build hours in the job's timezone, then convert to browser local time.
  // For cross-timezone jobs, a run on the previous/next job-TZ day may land
  // on the local "today", so we check adjacent days as well.
  const jobTz = schedule.tz;
  const result: number[] = [];
  if (jobTz) {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    for (const tzDay of [yesterday, today, tomorrow]) {
      // Re-check date constraints for each candidate day
      if (!satisfiesDateConstraints(tzDay)) {
        continue;
      }
      for (const h of hours) {
        for (const m of minutes) {
          const localHour = convertTzHourToLocal(h, m, tzDay, jobTz);
          if (localHour != null) {
            result.push(localHour);
          }
        }
      }
    }
  } else {
    // For non-timezone jobs, only check today
    if (satisfiesDateConstraints(today)) {
      for (const h of hours) {
        for (const m of minutes) {
          result.push(h + m / 60);
        }
      }
    }
  }
  // Apply average stagger offset (staggerMs / 2) to approximate actual run times
  const staggerHours =
    schedule.kind === "cron" && schedule.staggerMs ? schedule.staggerMs / 2 / 3_600_000 : 0;
  if (staggerHours > 0) {
    return result.map((h) => h + staggerHours).toSorted((a, b) => a - b);
  }
  return result.toSorted((a, b) => a - b);
}

/** Parse a single cron field into an array of values. */
function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    const result: number[] = [];
    for (let i = min; i <= max; i++) {
      result.push(i);
    }
    return result;
  }

  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10);
      if (step <= 0) {
        continue;
      }
      let start = min;
      let end = max;
      if (stepMatch[1] !== "*") {
        const [s, e] = stepMatch[1].split("-").map(Number);
        start = Math.max(min, s);
        end = Math.min(max, e);
        if (start > end) continue;
      }
      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
      continue;
    }

    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Math.max(min, parseInt(rangeMatch[1], 10));
      const end = Math.min(max, parseInt(rangeMatch[2], 10));
      if (start > end) continue;
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
      continue;
    }

    const num = parseInt(part, 10);
    if (!isNaN(num) && num >= min && num <= max) {
      values.add(num);
    }
  }

  return Array.from(values).toSorted((a, b) => a - b);
}

/** Extract high-frequency job chips from the jobs list.
 *  Uses the job's index in the full array for stable color assignment. */
export function getFreqChips(jobs: CronJob[]): TimelineFreqChip[] {
  const chips: TimelineFreqChip[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (!job.enabled || !isHighFrequency(job.schedule)) {
      continue;
    }
    chips.push({
      jobId: job.id,
      jobName: job.name,
      schedule: scheduleLabel(job.schedule),
      color: jobColor(i), // use full-array index, not filtered index
      lastStatus: job.state?.lastStatus,
    });
  }
  return chips;
}

/** Compute timeline markers for non-high-frequency jobs for today. */
export function getTimelineMarkers(
  jobs: CronJob[],
  zoomStart: number,
  zoomEnd: number,
): TimelineMarker[] {
  const nowH = new Date().getHours() + new Date().getMinutes() / 60;
  // Stable color assignment: use index in full array
  const markers: TimelineMarker[] = [];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (!job.enabled || isHighFrequency(job.schedule)) {
      continue;
    }

    const hours = getTodayRunHours(job.schedule);
    for (const hour of hours) {
      if (hour < zoomStart || hour > zoomEnd) {
        continue;
      }
      const pct = hourToPct(hour, zoomStart, zoomEnd);
      markers.push({
        jobId: job.id,
        jobName: job.name,
        schedule: scheduleLabel(job.schedule),
        hour,
        pct,
        status: hour <= nowH ? "ok" : "pending",
        color: jobColor(i),
      });
    }
  }

  return markers.toSorted((a, b) => a.pct - b.pct);
}

/** Cluster markers that are within CLUSTER_THRESHOLD_PCT of each other.
 *  Compares against the first item's pct (cluster start) to prevent drift. */
export function clusterMarkers(markers: TimelineMarker[]): TimelineCluster[] {
  const clusters: TimelineCluster[] = [];
  let current: TimelineCluster | null = null;

  for (const m of markers) {
    if (current && m.pct - current.items[0].pct < CLUSTER_THRESHOLD_PCT) {
      current.items.push(m);
      // Display position is the average of all items
      current.pct = current.items.reduce((sum, item) => sum + item.pct, 0) / current.items.length;
    } else {
      current = { pct: m.pct, items: [m] };
      clusters.push(current);
    }
  }

  return clusters;
}

/** Get the NOW position as a percentage within the zoom range. Returns null if out of range. */
export function getNowPct(zoomStart: number, zoomEnd: number): number | null {
  const now = new Date();
  const h = now.getHours() + now.getMinutes() / 60;
  const pct = hourToPct(h, zoomStart, zoomEnd);
  if (pct < 0 || pct > 100) {
    return null;
  }
  return pct;
}

/** Get current time formatted as HH:MM. */
export function getNowLabel(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** Get the zoom range label string. */
export function getZoomLabel(zoomStart: number, zoomEnd: number): string {
  const fmt = (h: number) => {
    const hh = String(Math.floor(h)).padStart(2, "0");
    const mm = String(Math.round((h % 1) * 60)).padStart(2, "0");
    return `${hh}:${mm}`;
  };
  return `${fmt(zoomStart)} \u2013 ${fmt(zoomEnd)}`;
}

/** Generate grid line count for the zoom range. */
export function getGridLineCount(zoomStart: number, zoomEnd: number): number {
  const span = zoomEnd - zoomStart;
  const step = span <= 6 ? 1 : span <= 12 ? 2 : span <= 18 ? 3 : 4;
  return Math.floor(span / step);
}

/** Generate hour labels for the timeline. */
export function getHourLabels(zoomStart: number, zoomEnd: number): string[] {
  const span = zoomEnd - zoomStart;
  const step = span <= 6 ? 1 : span <= 12 ? 2 : 4;
  const labels: string[] = [];
  for (let h = Math.ceil(zoomStart); h <= Math.floor(zoomEnd); h += step) {
    labels.push(String(h).padStart(2, "0"));
  }
  return labels;
}

/** Get the current timezone string. */
export function getTimezoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** Get today's date formatted for the header, respecting browser locale. */
export function getTodayLabel(): string {
  try {
    return new Date().toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    // Fallback for environments without Intl support
    const now = new Date();
    return `${now.getMonth() + 1}/${now.getDate()}`;
  }
}

/** Format an hour value as HH:MM string. */
export function formatHour(hour: number): string {
  const hh = String(Math.floor(hour)).padStart(2, "0");
  const mm = String(Math.round((hour % 1) * 60)).padStart(2, "0");
  return `${hh}:${mm}`;
}
