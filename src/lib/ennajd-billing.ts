// Centre Ennajd payment engine — Rule A (standard classes, calendar-aligned,
// with a mid-month-join auto-adjustment) and Rule B (2Bac s.x Small groups,
// rolling join-date cycle). Pure data/functions, zero React/Zustand —
// mirrors the "Shield" pattern of ennajd-taxonomy.ts.
// All functions take explicit Date params (enrolledAt/asOf), no hidden `new Date()`.
//
// BUSINESS RULES (strict implementation):
// 1. Dynamic Pricing & Sessions per Subject/Level:
//    monthlyFee and totalMonthlySessions vary by subject/level (1x/week=4/mois, 2x/week=8/mois).
//    monthlyFee is pulled dynamically via PriceEntry/customPrice, totalMonthlySessions is
//    the count of STANDARD scheduled occurrences in the calendar month.
// 2. Standard vs Extra: ONLY standard/fixed sessions (kind !== "one_off") count.
//    Extra "حصة إضافية" (kind==="one_off") is 100% free, excluded from tier thresholds & per-session rate.
// 3. Attendance vs Billing: scheduled standard class = CONSUMED SESSION even if absent. Attendance is tracking only.
// 4. Mid-Month Tiers (enrolledAt -> month-end, standard sessions only):
//    - Late (<=2 remaining): those sessions FREE bonus, upfront full fee credited 100% to NEXT month (autoPaid).
//    - Half (exactly half, e.g. 2/4 or 4/8): upfront full covers half M1 + half M2, next invoice HALF fee due on 15th, then 1st M3 onwards full.
//    - Custom (3,5,6,7…): perSessionRate = monthlyFee / totalMonthlySessions, M1 cost = remaining*perSessionRate, excess credited to M2 (ratio = remaining/total).
// 5. Reste guard: dueDate <= today only, future auto-generated sessions excluded.

import { getSessionKind } from "@/lib/ennajd-taxonomy";
import type { EnrollmentCombo } from "@/lib/ennajd-taxonomy";
import type {
  AttendanceRecord,
  GroupType,
  Level,
  Payment,
  PriceEntry,
  Session,
  Student,
  Subject,
  SubjectEnrollment,
  Track,
} from "@/types/ennajd";

export type PaymentRule = "A" | "B";

/** Subjects that carry the rolling Rule B cycle for 2Bac s.x Small — unified per the old small-group app screenshots. */
const SMALL_GROUP_RULE_B_SUBJECTS: Subject[] = ["Math", "PC", "SVT"];

export interface ScheduledInstallment {
  dueDate: Date;
  isHalfMonth: boolean;
  amountRatio: number; // fraction of the full monthly price this installment is worth
  autoPaid: boolean; // whether this installment should be created already marked paid
}

/**
 * Rule B (rolling, no calendar alignment) — unified for ALL 2Bac s.x
 * Small groups (Math/PC/SVT) per the old small-group app screenshots.
 * PROCHAINE ÉCHÉANCE = DATE DE LA PREMIÈRE SÉANCE + n mois.
 * Every other combo remains on Rule A.
 */
export function getPaymentRuleFor(
  level: Level,
  subject: Subject,
  groupType: GroupType | null,
  track?: Track | null,
): PaymentRule {
  if (level !== "2Bac" || groupType !== "Small") return "A";
  if (!SMALL_GROUP_RULE_B_SUBJECTS.includes(subject)) return "A";
  if (track !== undefined && track !== null && track !== "s.x") return "A";
  return "B";
}

/**
 * If a student had at most this many STANDARD sessions between their join
 * date and the end of their join month, month 1 was effectively a bonus.
 */
const FREE_BONUS_MAX_SESSIONS = 2;

/** The day-of-month treated as "the middle of the month" for Rule A. */
const MID_MONTH_HALF_DAY = 15;

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function normalizeDateOnly(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Calendar-month arithmetic that clamps to the last valid day of the target
 * month (e.g. Jan 31 + 1 month → Feb 28/29, not an overflow into March).
 */
export function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getDate();
  const targetMonthIndex = date.getMonth() + months;
  const target = new Date(date.getFullYear(), targetMonthIndex, 1);
  const lastDay = daysInMonth(target.getFullYear(), target.getMonth());
  target.setDate(Math.min(day, lastDay));
  return target;
}

// ---- Standard vs Extra helper ----
// ONLY standard/fixed schedule counts for billing. Extra "حصة إضافية" (one_off) is 100% free.
function isStandardSession(s: Session): boolean {
  return getSessionKind(s) !== "one_off";
}

/**
 * Which STANDARD scheduled days a given Level/Subject/Track/GroupType combo has.
 * Attendance records are IGNORED for billing (Rule 3) — a scheduled class counts as
 * CONSUMED SESSION regardless of individual absence. Extra sessions are excluded 100% (Rule 2).
 * When no standard Session exists yet for the combo, `hasSession` is false and callers
 * should fall back to the theoretical weekly cadence (once a week, on `fallbackDayOfWeek`),
 * still counting only standard frequency (dynamic via 4 or 8 per month depending on schedule).
 */
export interface DeliveredDatesContext {
  hasSession: boolean;
  scheduledDaysOfWeek: number[]; // unique dayOfWeek values for standard sessions of this combo
  fallbackDayOfWeek: number; // enrolledAt's day-of-week; only used when hasSession is false
  /** "YYYY-MM" months where this combo has ZERO standard scheduled occurrences
   *  (Rule D — gap months). A recurring weekly slot lands on every weekday of
   *  every calendar month, so this set is empty for a normal timetable; it is
   *  populated for combos that were only ever scheduled via dated (one_off)
   *  sessions, and callers/tests may mark extra gap months (term breaks,
   *  timetable added mid-year). No installment is emitted for a gap month. */
  gapMonthKeys: ReadonlySet<string>;
}

export function buildDeliveredDatesContext(
  sessions: Session[],
  _attendanceRecords: AttendanceRecord[], // kept for signature compat — IGNORED for billing (Rule 3)
  combo: EnrollmentCombo,
  enrolledAt: Date,
): DeliveredDatesContext {
  const matchingStandard = sessions.filter(
    (s) =>
      isStandardSession(s) &&
      s.level === combo.level &&
      s.subject === combo.subject &&
      s.track === combo.track &&
      s.groupType === combo.groupType,
  );

  return {
    hasSession: matchingStandard.length > 0,
    scheduledDaysOfWeek: [...new Set(matchingStandard.map((s) => s.dayOfWeek))],
    fallbackDayOfWeek: enrolledAt.getDay(),
    // Rule D — gap months: months where the combo has zero STANDARD
    // scheduled occurrences. A recurring weekly slot covers every calendar
    // month, so only dated (one_off) standard sessions can produce real
    // gaps here; the set stays empty for a normal recurring timetable.
    gapMonthKeys: new Set(
      matchingStandard
        .filter((s) => getSessionKind(s) === "one_off" && s.date)
        .map((s) => s.date!.slice(0, 7)),
    ),
  };
}

/**
 * Counts STANDARD scheduled occurrences within an inclusive date range,
 * dynamically per subject/level schedule (1x/week≈4/mois, 2x/week≈8/mois).
 * Extra sessions never counted (Rule 2). Attendance never consulted (Rule 3).
 */
function countOccurrencesInRange(ctx: DeliveredDatesContext, from: Date, to: Date): number {
  const start = normalizeDateOnly(from);
  const end = normalizeDateOnly(to);
  if (start > end) return 0;
  const days = ctx.hasSession ? ctx.scheduledDaysOfWeek : [ctx.fallbackDayOfWeek];
  if (days.length === 0) return 0;
  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    if (days.includes(cursor.getDay())) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

/**
 * Rule D — gap month: the combo has ZERO standard scheduled occurrences in
 * the calendar month containing `date`. Deterministic (purely schedule-based;
 * attendance is never consulted, consistent with Rule 3) and can't be gamed:
 * with a recurring weekly timetable every month has ≥1 occurrence, so a gap
 * only arises when the combo isn't scheduled that month at all (timetable
 * added mid-year, term breaks, combo not yet scheduled, or an explicit
 * `gapMonthKeys` entry). A gap month emits NO installment → no debt accumulates
 * and the Payments/Reports UI renders "-".
 */
function isGapMonth(ctx: DeliveredDatesContext, date: Date): boolean {
  const year = date.getFullYear();
  const monthIndex0 = date.getMonth();
  const monthStart = new Date(year, monthIndex0, 1);
  const monthEnd = new Date(year, monthIndex0, daysInMonth(year, monthIndex0));
  if (countOccurrencesInRange(ctx, monthStart, monthEnd) === 0) return true;
  return ctx.gapMonthKeys.has(formatMonthKey(date));
}

/**
 * Rule A schedule (every combo except 2Bac PC-Small):
 * Dynamic per subject/level — totalMonthlySessions and monthlyFee are not hardcoded.
 * Extra sessions excluded 100%. Attendance does not affect billing.
 *
 * - Month 1 charges the full fee upfront, due on the join date itself (Rule D:
 *   skipped entirely when the combo has zero standard scheduled occurrences in
 *   the join month — no sessions, no charge, no debt).
 * - Month 2 (next calendar month) is tiered based on STANDARD sessions remaining in join month:
 *   - Exactly half (e.g. 2/4 or 4/8) → half-month: HALF fee due on the 15th of next month to align cycle to 1st of M3.
 *     Checked FIRST so 2/4 is half, not late-bonus.
 *   - ≤2 remaining (and not exactly half) → late-join FREE bonus: those sessions free, upfront credited to next month (autoPaid on 1st).
 *   - Otherwise (3,5,6,7…) → custom prorated: perSessionRate = monthlyFee / totalMonthlySessions,
 *     M1 cost = remaining * perSessionRate, excess credited → M2 ratio = remaining/total on 1st.
 * - Every month from the month after the tier adjustment onward is plain full-price on the 1st.
 * - Rule D (gap months): any month with ZERO standard scheduled occurrences of
 *   the combo emits NO installment at all (term breaks, timetable added
 *   mid-year, combo not yet scheduled) — no debt accumulates and the UI
 *   renders "-".
 */
export function generateRuleASchedule(
  enrolledAt: Date,
  asOf: Date,
  ctx: DeliveredDatesContext,
): ScheduledInstallment[] {
  if (enrolledAt > asOf) return [];

  const monthStart = startOfMonth(enrolledAt);
  const monthEnd = new Date(
    monthStart.getFullYear(),
    monthStart.getMonth(),
    daysInMonth(monthStart.getFullYear(), monthStart.getMonth()),
  );
  const nextMonthDue = addMonthsClamped(monthStart, 1); // 1st of next month

  const remaining = countOccurrencesInRange(ctx, enrolledAt, monthEnd);
  const total = countOccurrencesInRange(ctx, monthStart, monthEnd);

  // Rule A — Single Session Skip Exception: exactly 1 remaining session
  // → DO NOT charge current month (leave EMPTY/BLANK — display as '-').
  // Apply 100% of tuition to next month's installment (autoPaid: true).
  if (remaining === 1) {
    if (nextMonthDue > asOf) return [];
    const results: ScheduledInstallment[] = [];
    // Rule D: skip months with zero standard scheduled occurrences.
    if (!isGapMonth(ctx, nextMonthDue)) {
      results.push({
        dueDate: nextMonthDue,
        isHalfMonth: false,
        amountRatio: 1,
        autoPaid: true,
      });
    }
    let next = addMonthsClamped(nextMonthDue, 1);
    while (next <= asOf) {
      if (!isGapMonth(ctx, next)) {
        results.push({ dueDate: next, isHalfMonth: false, amountRatio: 1, autoPaid: false });
      }
      next = addMonthsClamped(next, 1);
    }
    return results;
  }

  // Default: Month 1 full fee upfront on the join date.
  // Rule D: emit nothing for the join month when the combo has zero standard
  // scheduled occurrences in it (no sessions → no charge).
  const results: ScheduledInstallment[] = [];
  if (!isGapMonth(ctx, enrolledAt)) {
    results.push({ dueDate: enrolledAt, isHalfMonth: false, amountRatio: 1, autoPaid: false });
  }

  if (nextMonthDue > asOf) return results;

  // Dynamic half check: exactly half of standard monthly sessions (2/4, 4/8, 3/6, etc.)
  const isExactlyHalf = total > 0 && remaining * 2 === total;

  // Tier 2 — Half-Month Join (exactly half) takes precedence over Late when overlapping (e.g. 2/4)
  if (isExactlyHalf) {
    const midNextMonth = new Date(nextMonthDue.getFullYear(), nextMonthDue.getMonth(), MID_MONTH_HALF_DAY);
    if (midNextMonth <= asOf && !isGapMonth(ctx, midNextMonth)) {
      results.push({
        dueDate: midNextMonth, // 15th to align cycle to 1st of M3
        isHalfMonth: true,
        amountRatio: 0.5, // dynamically monthlyFee/2 at sync time
        autoPaid: false,
      });
    }
    // From M3 (monthStart+2) onwards, billing shifts permanently to 1st of every month at FULL fee
    let next = addMonthsClamped(monthStart, 2);
    while (next <= asOf) {
      if (!isGapMonth(ctx, next)) {
        results.push({ dueDate: next, isHalfMonth: false, amountRatio: 1, autoPaid: false });
      }
      next = addMonthsClamped(next, 1);
    }
    return results;
  }

  // Tier 1 — Late-Month Join (<=2 standard sessions remaining) → FREE bonus
  if (remaining <= FREE_BONUS_MAX_SESSIONS) {
    if (!isGapMonth(ctx, nextMonthDue)) {
      results.push({
        dueDate: nextMonthDue,
        isHalfMonth: false,
        amountRatio: 1,
        autoPaid: true, // upfront full fee credited 100% toward next month's invoice; the <=2 sessions are FREE
      });
    }
    let next = addMonthsClamped(nextMonthDue, 1);
    while (next <= asOf) {
      if (!isGapMonth(ctx, next)) {
        results.push({ dueDate: next, isHalfMonth: false, amountRatio: 1, autoPaid: false });
      }
      next = addMonthsClamped(next, 1);
    }
    return results;
  }

  // Tier 3 — Custom Session Join (3,5,6,7…)
  // perSessionRate = monthlyFee / totalMonthlySessions (dynamic)
  // join month cost = sessionsRemaining * perSessionRate
  // excess upfront credited toward next month => M2 ratio = remaining/total
  const ratio = total > 0 ? remaining / total : 1;
  if (!isGapMonth(ctx, nextMonthDue)) {
    results.push({
      dueDate: nextMonthDue,
      isHalfMonth: false,
      amountRatio: ratio,
      autoPaid: false,
    });
  }

  let next = addMonthsClamped(nextMonthDue, 1);
  while (next <= asOf) {
    if (!isGapMonth(ctx, next)) {
      results.push({ dueDate: next, isHalfMonth: false, amountRatio: 1, autoPaid: false });
    }
    next = addMonthsClamped(next, 1);
  }
  return results;
}

/**
 * Rule B schedule (2Bac PC-Small only): no calendar alignment at all —
 * a full-price charge on the join date, then every month on that same
 * day-of-month, forever.
 */
export function generateRuleBSchedule(enrolledAt: Date, asOf: Date): ScheduledInstallment[] {
  if (enrolledAt > asOf) return [];

  const results: ScheduledInstallment[] = [];
  let i = 0;
  let cursor = enrolledAt;
  while (cursor <= asOf) {
    results.push({ dueDate: cursor, isHalfMonth: false, amountRatio: 1, autoPaid: false });
    i += 1;
    cursor = addMonthsClamped(enrolledAt, i);
  }
  return results;
}

export function generateScheduleFor(
  rule: PaymentRule,
  enrolledAt: Date,
  asOf: Date,
  ctx: DeliveredDatesContext,
): ScheduledInstallment[] {
  return rule === "B"
    ? generateRuleBSchedule(enrolledAt, asOf)
    : generateRuleASchedule(enrolledAt, asOf, ctx);
}

/** "YYYY-MM-DD" using local calendar fields (not UTC — avoids TZ day-shift bugs). */
export function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "YYYY-MM" using local calendar fields. */
export function formatMonthKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// ---------------------------------------------------------------------------
// Partial-payment helpers
// ---------------------------------------------------------------------------

export function getPaymentRemaining(payment: Payment): number {
  const paid = payment.amountPaid ?? 0;
  return Math.max(0, payment.amountDue - paid);
}

export function isPaymentPartiallyPaid(payment: Payment): boolean {
  const paid = payment.amountPaid ?? 0;
  return paid > 0 && paid < payment.amountDue && !payment.isPaid;
}

export function isPaymentFullyPaid(payment: Payment): boolean {
  return payment.isPaid || (payment.amountPaid ?? 0) >= payment.amountDue;
}

// ---------------------------------------------------------------------------
// Advance-credit waterfall (cross-month surplus distribution)
// ---------------------------------------------------------------------------

/** Context passed by the store layer so the waterfall can apply attendance-
 * sheet proration Rules A-D. When omitted, applyCreditWaterfall falls back
 * to plain gap-filling (backward compatible). */
export interface WaterfallContext {
  student: Student;
  sessions: Session[];
  prices: PriceEntry[];
}

/** Null/undefined normalizer for track/groupType comparison — mirrors the
 * helper in ennajd-taxonomy.ts but kept local to avoid a cross-module import
 * in the pure billing layer. */
export function normalizeNull<T extends string | null | undefined>(
  value: T,
): string | null {
  return (value ?? null) as string | null;
}

/**
 * Whether a subject carries session-based proration Rules A-D.
 * 2BAC Small Groups (P.G 2BAC — 2Bac s.x Small on Math/PC/SVT) are EXEMPT:
 * `getPaymentRuleFor` returns "B" (rolling join-date cycle) for them, so
 * there is no calendar-aligned "current month" to prorate against — the
 * waterfall falls back to plain gap-filling.
 */
export function isProratedSubject(student: Student, subject: Subject): boolean {
  // Find the relevant enrollment for this subject.
  for (const enrollment of student.enrollments) {
    if (enrollment.subject !== subject) continue;
    // Rule B combos are exempt (2Bac s.x Small on Math/PC/SVT).
    if (getPaymentRuleFor(student.level, subject, enrollment.groupType, enrollment.track) === "B") {
      return false;
    }
    return true;
  }
  // No enrollment found — treat as non-prorated (no-op).
  return false;
}

/**
 * Counts the STANDARD (non-one_off) sessions remaining in the current month
 * for a given student+subject, from `from` (enrolledAt) through month-end.
 * Uses the same combo-matching logic as `buildDeliveredDatesContext`.
 *
 * Returns `null` when no standard sessions exist for the combo
 * (hasSession=false) — callers must fall back to plain gap-fill in that case.
 */
export function computeRemainingSessionsInMonth(
  student: Student,
  subject: Subject,
  sessions: Session[],
  from: Date,
  asOfKey: string,
): number | null {
  // Find the enrollment's track/groupType for this subject.
  const enrollment = student.enrollments.find((e) => e.subject === subject);
  if (!enrollment) return null;

  const monthEnd = new Date(
    from.getFullYear(),
    from.getMonth(),
    daysInMonth(from.getFullYear(), from.getMonth()),
  );

  // Count standard sessions matching this combo whose date falls within
  // [from, monthEnd] for recurring sessions, or whose date key falls in
  // the same calendar month for one-off sessions.
  let remaining = 0;
  for (const session of sessions) {
    if (!isStandardSession(session)) continue;
    if (session.subject !== subject) continue;
    if (session.level !== student.level) continue;
    if (normalizeNull(session.track) !== normalizeNull(enrollment.track)) continue;
    if (normalizeNull(session.groupType) !== normalizeNull(enrollment.groupType)) continue;

    // Recurring sessions: count occurrences of dayOfWeek in [from, monthEnd].
    // (In this simplified model, each recurring session represents a weekly
    // slot. We count one occurrence per matching day-of-week in range.)
    if (getSessionKind(session) === "recurring") {
      const cursor = new Date(from);
      while (cursor <= monthEnd) {
        if (cursor.getDay() === session.dayOfWeek) remaining++;
        cursor.setDate(cursor.getDate() + 1);
      }
    }
  }

  if (remaining === 0) return null;
  return remaining;
}

/** Per-subject proration profile used by the credit waterfall Rules A-D. */
export interface SubjectProration {
  /** Fraction of credit that belongs on the current month (remaining/total).
   *  Rule C (full month) = 1.0; Rule B (partial) < 1.0; Rule A skip = 0. */
  ratio: number;
  /** Rule A (Single Session Skip): only 1 standard session remains in the
   *  join month -> skip current-month installments entirely, direct
   *  100% to future months. Scoped to the join month only via
   *  `joinMonthKey` — later months are always creditable. */
  skipCurrent: boolean;
  /** "YYYY-MM" of the student's enrollment join date for this subject.
   *  `skipCurrent` only applies to installments whose dueDate falls in this
   *  calendar month; every other month owes its full installment. */
  joinMonthKey: string;
}

/**
 * Pre-computes the attendance-sheet proration (Rules A/B/C/D) for a single
 * subject. Returns null when the subject is exempt (Rule B cycle, i.e.
 * 2Bac s.x Small) or no standard session data is available, so the caller
 * falls back to plain gap-filling.
 *
 * Extracted from applyCreditWaterfall so the same logic runs once per
 * subject (instead of once per call), enabling cross-subject mode.
 */
function computeSubjectProration(
  student: Student,
  subject: Subject,
  sessions: Session[],
  from: Date,
  asOfKey: string,
): SubjectProration | null {
  // Rule B combos (2Bac s.x Small on Math/PC/SVT) are exempt — rolling cycle.
  if (!isProratedSubject(student, subject)) return null;

  const enrollment = student.enrollments.find((e) => e.subject === subject);
  if (!enrollment) return null;

  const remainingSessions = computeRemainingSessionsInMonth(
    student,
    subject,
    sessions,
    from,
    asOfKey,
  );

  if (remainingSessions === null) return null;

  // joinMonthKey = the calendar month the student enrolled in this subject.
  // Rule A's skipCurrent only applies to installments in THIS month.
  const joinMonthKey = formatMonthKey(from);

  // --- Rule A: Single Session Skip ---
  // Only 1 standard session remains in the join month -> skip current-month
  // installments entirely, direct 100% to future months.
  if (remainingSessions === 1) {
    return { ratio: 0, skipCurrent: true, joinMonthKey };
  }

  // --- Rules B (Partial) & C (Full Month) ---
  // Compute total standard sessions in the current month to derive the
  // proration ratio: remaining / total.
  const monthStart = startOfMonth(from);
  const monthEnd = new Date(
    monthStart.getFullYear(),
    monthStart.getMonth(),
    daysInMonth(monthStart.getFullYear(), monthStart.getMonth()),
  );
  let total = 0;
  for (const session of sessions) {
    if (!isStandardSession(session)) continue;
    if (session.subject !== subject) continue;
    if (session.level !== student.level) continue;
    if (normalizeNull(session.track) !== normalizeNull(enrollment.track)) continue;
    if (normalizeNull(session.groupType) !== normalizeNull(enrollment.groupType)) continue;

    if (getSessionKind(session) === "recurring") {
      const cursor = new Date(monthStart);
      while (cursor <= monthEnd) {
        if (cursor.getDay() === session.dayOfWeek) total++;
        cursor.setDate(cursor.getDate() + 1);
      }
    }
  }

  const ratio = total > 0 ? remainingSessions / total : 1;
  // Rule C: remaining == total -> ratio = 1.0 -> 100% current month.
  // Rule B: remaining < total -> ratio < 1.0 -> prorated.
  return { ratio, skipCurrent: false, joinMonthKey };
}

export interface CreditWaterfallResult {
  /** New payment objects reflecting the credit applied (only installment rows that changed).
   *  Unchanged installments are omitted — the caller merges by id. */
  updated: Payment[];
  /** Credit that could not be absorbed by any installment (dueDate-ascending).
   *  This leftover must be stored as `advanceBalance` on the student. */
  remaining: number;
  /** True when at least one installment was fully or partially changed. */
  anyChanged: boolean;
  /** Total credit applied to the current month's installment(s) (dueDate <= asOfKey).
   *  Populated only when `context` is provided; 0 otherwise. */
  currentMonthCredit: number;
  /** Total credit applied to future-month installment(s) (dueDate > asOfKey).
   *  Populated only when `context` is provided; 0 otherwise. */
  futureMonthCredit: number;
}

/**
 * Distributes `credit` (MAD) across installments in `dueDate`-ascending
 * order, applying to each installment's remaining gap (`amountDue - amountPaid`).
 *
 * When `context` is provided AND the subject is proration-eligible
 * (`isProratedSubject` returns true), the attendance-sheet proration
 * Rules A-D are applied:
 *
 * - **Rule A (Single Session Skip)**: only 1 standard session remains in the
 *   current month → skip crediting current-month installments entirely,
 *   direct 100% to future installments.
 * - **Rule B (Partial Attendance)**: 2+ standard sessions remain → credit a
 *   prorated proportion (remaining / total) to the current month; surplus
 *   carries forward to future months as advance credit.
 * - **Rule C (Full Month)**: all sessions remain (joined at start of month)
 *   → remaining == total → ratio = 1.0 → 100% to current month.
 * - **Rule D (Gap Months)**: no installments exist for gap months (handled by
 *   `generateRuleASchedule`) → the waterfall has no rows to credit, leaving
 *   them as `-` automatically.
 *
 * When `context` is omitted OR the subject is exempt (2BAC Small Groups /
 * Rule B cycle), falls back to plain gap-filling (backward compatible).
 *
 * - `subject === null` means cross-subject (any subject for that student) —
 *   used by the creation-time `applyInitialTuitionPayment` waterfall.
 * - Only installments that genuinely have a remaining gap (not fully paid)
 *   are credited. Once credit is exhausted or all gaps are filled, the
 *   function returns the leftover as `remaining` for the caller to stash in
 *   `advanceBalance`.
 * - Returns a minimal `updated` array (changed rows only) so callers can
 *   merge by `id` without rewriting the whole ledger.
 * - `currentMonthCredit` and `futureMonthCredit` break down how much credit
 *   landed on due vs. future installments (0 when no context).
 *
 * Pure — no React/Zustand, no hidden date().
 */
export function applyCreditWaterfall(
  payments: Payment[],
  studentId: string,
  subject: Subject | null,
  credit: number,
  asOfKey: string,
  updatedAt: string,
  context?: WaterfallContext,
): CreditWaterfallResult {
  const emptyResult: CreditWaterfallResult = {
    updated: [],
    remaining: Math.max(0, Math.round(credit)),
    anyChanged: false,
    currentMonthCredit: 0,
    futureMonthCredit: 0,
  };

  if (!Number.isFinite(credit) || credit <= 0) {
    return emptyResult;
  }

  // Walk every installment for this student that isn't already fully paid,
  // in dueDate-ascending order — due AND future. Cross-subject mode scans
  // all subjects; per-subject mode filters to one.
  const eligible = payments.filter(
    (p) =>
      p.studentId === studentId &&
      (subject === null || p.subject === subject) &&
      !isPaymentFullyPaid(p),
  );
  eligible.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // --- Proration Rules A-D (per-subject, pre-computed in a Map) ---
  // In per-subject mode (subject !== null) only that subject is prorated.
  // In cross-subject mode (subject === null) every proration-eligible
  // enrollment is pre-computed so each payment looks up its own subject
  // during the loop — this is what fixes the cross-subject bug where a single
  // global flag previously blocked Rules A-D entirely during creation-time
  // distribution (applyInitialTuitionPayment passes subject=null).
  let subjectProration: Map<Subject, SubjectProration> | undefined;
  if (context) {
    subjectProration = new Map();
    for (const enrollment of context.student.enrollments) {
      // Per-subject mode: only compute for the requested subject.
      if (subject !== null && enrollment.subject !== subject) continue;
      const enrolledAt = new Date(
        enrollment.enrolledAt ?? context.student.createdAt,
      );
      const from =
        enrolledAt <= new Date(asOfKey) ? enrolledAt : new Date(asOfKey);
      const proration = computeSubjectProration(
        context.student,
        enrollment.subject,
        context.sessions,
        from,
        asOfKey,
      );
      if (proration) subjectProration.set(enrollment.subject, proration);
    }
  }

  const updated: Payment[] = [];
  let remaining = Math.max(0, Math.round(credit));
  let currentMonthCredit = 0;
  let futureMonthCredit = 0;

  // Per-subject current-month budget (Rule B/C): the total credit earmarked
  // for this subject's current-month installments, computed ONCE as
  // Math.round(credit * ratio). Tracked via budgetSpent so repeated
  // Math.round per row never overshoots — unspent budget stays in `remaining`
  // and naturally flows to the next due installment / advanceBalance.
  const budgetBySubject = new Map<Subject, number>();
  const budgetSpentBySubject = new Map<Subject, number>();
  if (subjectProration) {
    for (const [subj, proration] of subjectProration) {
      if (proration.ratio > 0) {
        budgetBySubject.set(subj, Math.round(credit * proration.ratio));
        budgetSpentBySubject.set(subj, 0);
      }
    }
  }

  for (const payment of eligible) {
    if (remaining <= 0) break;

    const isCurrentMonth = payment.dueDate <= asOfKey;

    // Look up this payment's own subject proration profile (Rules A-D).
    const proration = subjectProration?.get(payment.subject);

    // Rule A skip: only for installments in the JOIN month (scoped fix).
    // Later months always remain creditable.
    if (
      proration?.skipCurrent &&
      isCurrentMonth &&
      payment.dueDate.slice(0, 7) === proration.joinMonthKey
    ) {
      continue;
    }

    const currentPaid = payment.amountPaid ?? 0;
    const gap = Math.max(0, payment.amountDue - currentPaid);
    if (gap <= 0) continue;

    let apply: number;

    if (proration && isCurrentMonth && proration.ratio > 0) {
      // Rule B / C: apply prorated proportion of credit to current month,
      // bounded by the once-per-subject budget (not a fresh credit*ratio
      // per row, which could overshoot). Unspent budget stays in
      // `remaining` and flows to the next installment.
      const spent = budgetSpentBySubject.get(payment.subject) ?? 0;
      const budget = budgetBySubject.get(payment.subject) ?? 0;
      apply = Math.min(gap, budget - spent, remaining);
      budgetSpentBySubject.set(payment.subject, spent + apply);
    } else {
      apply = Math.min(gap, remaining);
    }

    if (apply <= 0) continue;

    const amountPaid = currentPaid + apply;
    const isPaid = amountPaid >= payment.amountDue;
    updated.push({ ...payment, amountPaid, isPaid, updatedAt });
    remaining -= apply;

    if (isCurrentMonth) {
      currentMonthCredit += apply;
    } else {
      futureMonthCredit += apply;
    }
  }

  return {
    updated,
    remaining: Math.max(0, remaining),
    anyChanged: updated.length > 0,
    currentMonthCredit,
    futureMonthCredit,
  };
}

/**
 * Computes the prorated cost for the current month — the sum of remaining
 * gaps on unpaid installments whose dueDate <= asOfKey (the app-wide "due"
 * definition). Used by the dialog to show how much the current month actually
 * owes before showing the carry-over surplus.
 */
export function computeProratedCurrentMonthCost(
  payments: Payment[],
  studentId: string,
  subject: Subject,
  asOfKey: string,
): number {
  let cost = 0;
  for (const p of payments) {
    if (
      p.studentId === studentId &&
      p.subject === subject &&
      !isPaymentFullyPaid(p) &&
      p.dueDate <= asOfKey
    ) {
      cost += getPaymentRemaining(p);
    }
  }
  return cost;
}

/**
 * One student's due position for a single subject, relative to an explicit
 * "as of" date key. "Due" uses the app-wide outstanding definition (same as
 * `hasOutstandingBalance`): unpaid AND dueDate <= asOf — future installments
 * never count (Reste guard). Single pass over the payments list.
 */
export interface StudentSubjectDueBalance {
  /** Unpaid installments that are due (dueDate <= asOfKey), dueDate ascending. */
  dueUnpaid: Payment[];
  /** Sum of remaining amounts for dueUnpaid (MAD) — true outstanding. */
  dueTotal: number;
  /** dueDate of the earliest due installment, or null when none is due. */
  earliestDueDate: string | null;
  /** True when at least one due installment is strictly past its due date. */
  isOverdue: boolean;
  /** Earliest unpaid future installment (dueDate > asOfKey), or null. */
  nextUpcoming: Payment | null;
  /** Latest paid installment that is due (dueDate <= asOfKey), or null. */
  lastPaidDue: Payment | null;
  /** False when no payment row exists for this student+subject yet
   *  (e.g. no price defined → syncPayments generated nothing). */
  hasInstallments: boolean;
  /** Sum of amountPaid across dueUnpaid */
  amountPaid: number;
  /** Alias for dueTotal — total remaining to pay */
  remaining: number;
  /** True when any due installment has 0 < amountPaid < amountDue */
  isPartiallyPaid: boolean;
}

/**
 * Per-subject due position for a single student. Accepts an optional
 * `advanceBalance` to net off cross-subject credit that has been carried
 * forward — the `remaining` field reflects the true net amount owed for
 * this subject after advance credit is applied.
 */
export function getDueBalanceForStudentSubject(
  payments: Payment[],
  studentId: string,
  subject: Subject,
  asOfKey: string,
  advanceBalance = 0,
): StudentSubjectDueBalance {
  const dueUnpaid: Payment[] = [];
  let dueTotal = 0;
  let amountPaid = 0;
  let earliestDueDate: string | null = null;
  let isOverdue = false;
  let nextUpcoming: Payment | null = null;
  let lastPaidDue: Payment | null = null;
  let hasInstallments = false;
  let isPartiallyPaid = false;

  for (const payment of payments) {
    if (payment.studentId !== studentId || payment.subject !== subject) continue;
    hasInstallments = true;

    const remaining = getPaymentRemaining(payment);
    const partiallyPaid = isPaymentPartiallyPaid(payment);

    // Paid includes both isPaid flag and fully-covered by amountPaid
    if (payment.isPaid || remaining === 0) {
      if (
        payment.dueDate <= asOfKey &&
        (lastPaidDue === null || payment.dueDate > lastPaidDue.dueDate)
      ) {
        lastPaidDue = payment;
      }
      continue;
    }

    // Reste guard: strictly dueDate <= asOfKey only — future never counts
    if (payment.dueDate <= asOfKey) {
      dueUnpaid.push(payment);
      dueTotal += remaining;
      amountPaid += payment.amountPaid ?? 0;
      if (partiallyPaid) isPartiallyPaid = true;
      if (earliestDueDate === null || payment.dueDate < earliestDueDate) {
        earliestDueDate = payment.dueDate;
      }
      if (payment.dueDate < asOfKey) isOverdue = true;
    } else if (nextUpcoming === null || payment.dueDate < nextUpcoming.dueDate) {
      nextUpcoming = payment;
    }
  }

  dueUnpaid.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return {
    dueUnpaid,
    dueTotal,
    earliestDueDate,
    isOverdue,
    nextUpcoming,
    lastPaidDue,
    hasInstallments,
    amountPaid,
    remaining: dueTotal,
    isPartiallyPaid,
  };
}

/**
 * Reste guard helper for StudentTable: recomputes balance strictly
 * where dueDate <= todayKey, ignoring all future auto-generated sessions.
 */
export function getResteForPayments(payments: Payment[], todayKey: string): number {
  let reste = 0;
  for (const p of payments) {
    if (!p.isPaid && p.dueDate <= todayKey) {
      reste += getPaymentRemaining(p);
    }
  }
  return reste;
}

// ---------------------------------------------------------------------------
// Overdue worklist aggregation (Payments page)
// ---------------------------------------------------------------------------

/**
 * ONE aggregated worklist row per student + subject: every currently-due
 * unpaid installment of that subject collapsed together, so the Payments
 * page shows exactly one row per student+subject and تسوية settles the
 * whole visible subject debt at once. Mirrors the "due" semantics of
 * `getDueBalanceForStudentSubject` (unpaid AND dueDate <= todayKey,
 * remaining-aware) in a single pass, grouped by `studentId__subject`.
 */
export interface SubjectOverdueRow {
  studentId: string;
  subject: Subject;
  /** Due + unpaid installments, dueDate ascending. */
  installments: Payment[];
  /** Σ remaining across the row's installments (MAD, partial-aware). */
  totalRemaining: number;
  /** Partial credit accumulated so far across the row's installments. */
  totalAmountPaid: number;
  /** Earliest unpaid dueDate — shown in the Échéance column. */
  earliestDueDate: string;
  /** Latest unpaid dueDate — the current cycle (receipt month). */
  latestDueDate: string;
  /** True when any installment is strictly past its due date (< todayKey). */
  isOverdue: boolean;
  /** True when any installment has 0 < amountPaid < amountDue. */
  isPartiallyPaid: boolean;
  /** True when any installment is a half-month charge. */
  isHalfMonth: boolean;
  /** The earliest future installment with a remaining gap (dueDate > todayKey).
   *  Tracks how much surplus has been pre-paid forward via advanceBalance. */
  nextDueDate: string | null;
  /** Remaining gap on that next-due installment (MAD). 0 when fully pre-paid. */
  nextDueRemaining: number;
}

export function aggregateOverdueInstallments(
  payments: Payment[],
  todayKey: string,
): Map<string /* `${studentId}__${subject}` */, SubjectOverdueRow> {
  const rows = new Map<string, SubjectOverdueRow>();

  for (const payment of payments) {
    const key = `${payment.studentId}__${payment.subject}`;
    let row = rows.get(key);

    // --- Due & unpaid (dueDate <= todayKey, not fully paid) ---
    if (!isPaymentFullyPaid(payment) && payment.dueDate <= todayKey) {
      if (!row) {
        row = {
          studentId: payment.studentId,
          subject: payment.subject,
          installments: [],
          totalRemaining: 0,
          totalAmountPaid: 0,
          earliestDueDate: payment.dueDate,
          latestDueDate: payment.dueDate,
          isOverdue: false,
          isPartiallyPaid: false,
          isHalfMonth: false,
          nextDueDate: null,
          nextDueRemaining: 0,
        };
        rows.set(key, row);
      }

      row.installments.push(payment);
      row.totalRemaining += getPaymentRemaining(payment);
      row.totalAmountPaid += payment.amountPaid ?? 0;
      if (payment.dueDate < row.earliestDueDate) row.earliestDueDate = payment.dueDate;
      if (payment.dueDate > row.latestDueDate) row.latestDueDate = payment.dueDate;
      if (payment.dueDate < todayKey) row.isOverdue = true;
      if (isPaymentPartiallyPaid(payment)) row.isPartiallyPaid = true;
      if (payment.isHalfMonth) row.isHalfMonth = true;
    }

    // --- Future installment with a remaining gap (dueDate > todayKey) ---
    // Tracks how much surplus has been pre-paid forward via advanceBalance.
    if (!isPaymentFullyPaid(payment) && payment.dueDate > todayKey) {
      if (!row) {
        // No due installments yet — seed a row so the next-due shows even
        // before anything is past due.
        row = {
          studentId: payment.studentId,
          subject: payment.subject,
          installments: [],
          totalRemaining: 0,
          totalAmountPaid: 0,
          earliestDueDate: payment.dueDate,
          latestDueDate: payment.dueDate,
          isOverdue: false,
          isPartiallyPaid: false,
          isHalfMonth: false,
          nextDueDate: payment.dueDate,
          nextDueRemaining: getPaymentRemaining(payment),
        };
        rows.set(key, row);
      } else if (
        row.nextDueDate === null ||
        payment.dueDate < row.nextDueDate
      ) {
        row.nextDueDate = payment.dueDate;
        row.nextDueRemaining = getPaymentRemaining(payment);
      }
    }
  }

  // dueDate ascending within each row (earliest first for settle/partial credit).
  for (const row of rows.values()) {
    row.installments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Settled worklist aggregation (Payments page — "Payés / أدوا الواجب" panel)
// ---------------------------------------------------------------------------

/**
 * ONE aggregated row per student + subject that HAS generated installments
 * and NOTHING due today: every installment is either fully paid (isPaid flag
 * or amountPaid covering amountDue) or a strictly-future one (dueDate >
 * todayKey, Reste guard). Combos with no installments at all (e.g. missing
 * price) never appear here. Single O(payments) pass, mirroring
 * `aggregateOverdueInstallments`.
 */
export interface SubjectSettledRow {
  studentId: string;
  subject: Subject;
  /** Sum of amountDue across the due-paid installments (MAD covered today). */
  totalCovered: number;
  /** Id of the latest fully-paid installment with dueDate <= todayKey — the mark-unpaid target. */
  latestSettledPaymentId: string | null;
  /** dueDate of that latest settled installment, or null. */
  latestSettledDueDate: string | null;
  /** dueDate of the earliest unpaid future installment, or null. */
  nextUpcomingDueDate: string | null;
  /** Remaining (MAD) of that earliest future installment — 0 when absent. */
  nextUpcomingRemaining: number;
}

export function aggregateSettledInstallments(
  payments: Payment[],
  todayKey: string,
): Map<string /* `${studentId}__${subject}` */, SubjectSettledRow> {
  const rows = new Map<string, SubjectSettledRow>();
  // Sticky guard: once ANY due-unpaid installment is seen for a combo, the
  // combo is unsettled today — no later paid-due row can resurrect it.
  const unsettledKeys = new Set<string>();

  for (const payment of payments) {
    const key = `${payment.studentId}__${payment.subject}`;
    if (unsettledKeys.has(key)) continue;
    let row = rows.get(key);
    if (!row) {
      row = {
        studentId: payment.studentId,
        subject: payment.subject,
        totalCovered: 0,
        latestSettledPaymentId: null,
        latestSettledDueDate: null,
        nextUpcomingDueDate: null,
        nextUpcomingRemaining: 0,
      };
      rows.set(key, row);
    }

    if (payment.dueDate <= todayKey) {
      // App-wide "fully paid" definition: isPaid flag OR amountPaid covering
      // amountDue — a flag-settled row keeps amountPaid = 0, so the flag must
      // take precedence (same as isPaymentFullyPaid everywhere else).
      if (isPaymentFullyPaid(payment)) {
        // Due & fully covered — counts toward "Payés".
        row.totalCovered += payment.amountDue;
        if (
          row.latestSettledDueDate === null ||
          payment.dueDate > row.latestSettledDueDate
        ) {
          row.latestSettledDueDate = payment.dueDate;
          row.latestSettledPaymentId = payment.id;
        }
      } else {
        // Due & still unpaid/partial → the combo is NOT settled today.
        unsettledKeys.add(key);
        rows.delete(key);
      }
    } else if (getPaymentRemaining(payment) > 0) {
      // Strictly-future unpaid installment — candidate for "next due".
      if (
        row.nextUpcomingDueDate === null ||
        payment.dueDate < row.nextUpcomingDueDate
      ) {
        row.nextUpcomingDueDate = payment.dueDate;
        row.nextUpcomingRemaining = getPaymentRemaining(payment);
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Ledger de-duplication (defensive self-heal)
// ---------------------------------------------------------------------------

/** Logical identity of an installment — the same key `syncPayments` dedupes on. */
function paymentLogicalKey(payment: Payment): string {
  return `${payment.studentId}__${payment.subject}__${payment.dueDate}`;
}

/**
 * Which of two same-key rows to keep. Prefers the row that reflects the most
 * payment progress so a settled/partial duplicate is never discarded in favor
 * of a pristine one: settled flag first, then largest amountPaid, then most
 * recent updatedAt.
 */
function isMoreSettledPayment(a: Payment, b: Payment): boolean {
  if (a.isPaid !== b.isPaid) return a.isPaid;
  const aPaid = a.amountPaid ?? 0;
  const bPaid = b.amountPaid ?? 0;
  if (aPaid !== bPaid) return aPaid > bPaid;
  return a.updatedAt > b.updatedAt;
}

export interface PaymentDedupeResult {
  /** One row per logical key, in first-seen order (same reference when clean). */
  kept: Payment[];
  /** Ids of the surplus duplicate rows — safe to delete from Firestore. */
  duplicateIds: string[];
}

/**
 * Collapses a ledger to exactly one row per `studentId__subject__dueDate`.
 * Duplicates slip in when the schedule generator runs before the payments
 * listener has hydrated (empty local ledger → whole schedule regenerated with
 * fresh ids). Pure defensive pass: rows are identical-by-design (same key =
 * same installment), so surplus rows are reported for deletion. Returns the
 * original array reference untouched when the ledger is already clean, so
 * `replaceIfChanged` can short-circuit.
 */
export function dedupePayments(payments: Payment[]): PaymentDedupeResult {
  const bestByKey = new Map<string, Payment>();
  const order: string[] = [];
  for (const payment of payments) {
    const key = paymentLogicalKey(payment);
    const current = bestByKey.get(key);
    if (!current) {
      bestByKey.set(key, payment);
      order.push(key);
    } else if (isMoreSettledPayment(payment, current)) {
      bestByKey.set(key, payment);
    }
  }

  if (bestByKey.size === payments.length) {
    return { kept: payments, duplicateIds: [] };
  }

  const kept: Payment[] = [];
  const keptIds = new Set<string>();
  for (const key of order) {
    const best = bestByKey.get(key)!;
    kept.push(best);
    keptIds.add(best.id);
  }

  const duplicateIds = payments
    .filter((payment) => !keptIds.has(payment.id))
    .map((payment) => payment.id);

  return { kept, duplicateIds };
}

// ---------------------------------------------------------------------------
// Registration fee (رسوم التسجيل — one-time 100 DH, fully separate from
// the Rule A/B installment engine: never flows into any installment total)
// ---------------------------------------------------------------------------

/** Default one-time registration fee in MAD — editable per student. */
export const REGISTRATION_FEE_DEFAULT = 100;

/**
 * A student owes the registration fee when enrolled in at least ONE
 * non-Small (Rule A standard) class. Small-group-only students (2Bac s.x)
 * are exempt.
 */
export function isRegistrationFeeApplicable(student: Student): boolean {
  return student.enrollments.some((e) => e.groupType !== "Small");
}

/**
 * Remaining registration fee (MAD). Students with NO stored fee field are
 * legacy = implicitly PAID → 0. Otherwise max(0, due − paid) — partial aware.
 */
export function getRegistrationFeeRemaining(student: Student): number {
  const fee = student.registrationFee;
  if (!fee) return 0;
  return Math.max(0, fee.amountDue - fee.amountPaid);
}

/** True when the fee applies AND is not fully paid — drives every red surface. */
export function isRegistrationFeeUnpaid(student: Student): boolean {
  return (
    isRegistrationFeeApplicable(student) && getRegistrationFeeRemaining(student) > 0
  );
}

/** One aggregated row per debtor student, sorted A→Z by name. */
export interface RegistrationFeeRow {
  studentId: string;
  amountDue: number;
  amountPaid: number;
  remaining: number;
  note?: string;
}

export interface RegistrationFeeDebtors {
  rows: RegistrationFeeRow[];
  count: number;
  totalRemaining: number;
}

/**
 * Every currently-owing student collapsed to ONE row each (name-sorted),
 * with the Σ remaining for the panel header badge. Pure — callers memoize.
 */
export function aggregateRegistrationFeeDebtors(
  students: Student[],
): RegistrationFeeDebtors {
  const debtors = students.filter(isRegistrationFeeUnpaid);
  const nameOf = (s: Student) => s.firstName + " " + s.lastName;
  debtors.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const rows: RegistrationFeeRow[] = debtors.map((student) => {
    // Non-null: isRegistrationFeeUnpaid guarantees the fee field exists.
    const fee = student.registrationFee!;
    return {
      studentId: student.id,
      amountDue: fee.amountDue,
      amountPaid: fee.amountPaid,
      remaining: Math.max(0, fee.amountDue - fee.amountPaid),
      note: fee.note,
    };
  });
  return {
    rows,
    count: rows.length,
    totalRemaining: rows.reduce((sum, row) => sum + row.remaining, 0),
  };
}

/**
 * Pure helper — computes the total tuition (MAD) for a set of enrollments
 * WITHOUT requiring a persisted student.id (used at creation time, before
 * the student doc exists). Mirrors `getEffectivePrice` + `getBasePrice`:
 * `customPrice ?? base price` per enrollment. Returns 0 when no price is
 * defined for any enrollment (the caller disables the Paid input in that case).
 */
export function computeTuitionTotal(
  enrollments: SubjectEnrollment[],
  level: Level,
  prices: PriceEntry[],
): number {
  let total = 0;
  for (const enrollment of enrollments) {
    if (enrollment.customPrice !== undefined) {
      total += enrollment.customPrice;
      continue;
    }
    const base = prices.find(
      (p) =>
        p.level === level &&
        p.subject === enrollment.subject &&
        p.track === enrollment.track &&
        p.groupType === enrollment.groupType,
    )?.price;
    if (base !== undefined) total += base;
  }
  return total;
}
