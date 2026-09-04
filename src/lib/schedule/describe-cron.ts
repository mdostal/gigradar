// config-detail-and-scan-hardening epic, config-dashboard-rich-cards story.
// A small, deliberately narrow cron humanizer for the Schedule config
// card — covers the shapes this app's own schedule field actually
// produces (a fixed minute, one or more hours, optionally a weekday
// range/list), never a general-purpose cron parser. Anything outside that
// shape returns null so the caller falls back to the raw cron string
// verbatim — a wrong guess is worse than no guess.
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseIntList(field: string, min: number, max: number): number[] | null {
  const parts = field.split(",");
  const values: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < min || n > max) return null;
    values.push(n);
  }
  return values;
}

function describeDayOfWeek(field: string): string | null {
  if (field === "*") return null; // every day — no clause needed
  const rangeMatch = /^(\d)-(\d)$/.exec(field);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (start < 0 || start > 6 || end < 0 || end > 6) return null;
    if (start === 1 && end === 5) return "weekdays";
    if (start === 0 && end === 6) return null; // every day
    return `${DAY_LABELS[start]}–${DAY_LABELS[end]}`;
  }
  const days = parseIntList(field, 0, 6);
  if (!days) return null;
  return days.map((d) => DAY_LABELS[d]).join(", ");
}

/**
 * Returns a short, human-readable description of a cron expression this
 * app's own schedule field could produce (`M H * * *`, `M H1,H2,H3 * * *`,
 * with an optional weekday clause), or `null` when the expression doesn't
 * match one of those shapes — callers must fall back to the raw string.
 */
export function describeCron(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteField, hourField, dom, mon, dow] = fields as [string, string, string, string, string];

  // Day-of-month and month must be unconstrained — a real calendar-date
  // schedule ("15 9 1 * *", "0 0 25 12 *") is out of this humanizer's
  // scope, not worth guessing at.
  if (dom !== "*" || mon !== "*") return null;

  const minutes = parseIntList(minuteField, 0, 59);
  if (!minutes || minutes.length !== 1) return null; // a distinct minute per hour isn't representable in "H:MM, H:MM" form
  const minute = minutes[0];

  const hours = parseIntList(hourField, 0, 23);
  if (!hours || hours.length === 0) return null;

  const times = hours.map((h) => `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`).join(", ");
  const dayClause = describeDayOfWeek(dow);

  return dayClause ? `Runs at ${times}, ${dayClause}` : `Runs at ${times} daily`;
}
