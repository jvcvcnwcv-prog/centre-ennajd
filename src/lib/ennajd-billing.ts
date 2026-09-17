// Centre Ennajd payment engine — Session-Based Pricing for Rule A
// (standard classes: monthly fee ÷ fixed sessions × sessions the student
// will actually attend that month) and Rule B (2Bac s.x Small groups,
// rolling join-date cycle). Pure data/functions, zero React/Zustand —
// mirrors the "Shield" pattern of ennajd-taxonomy.ts.
// All functions take explicit Date params (enrolledAt/asOf), no hidden `new Date()`.
//
// BUSINESS RULES (strict implementation):
// 1. Session-Based Pricing (Rule A):
//      fixedCount   = 4 × scheduledDaysOfWeek.length   (1x/week → 4, 2x/week → 8)
//      perSession   = monthlyFee ÷ fixedCount
//      month amount = perSession × sessions the student will attend that month
//    A month with a 5th occurrence bills it FREE (billable capped at fixedCount).
//    monthlyFee is pulled dynamically via PriceEntry/customPrice.
// 2. Standard vs Extra: ONLY standard/fixed sessions (kind !== "one_off")
//    count. Extra "حصة إضافية" (one_off) is 100% free, excluded from the count.
// 3. Attendance vs Billing: a scheduled standard class = CONSUMED SESSION
//    even if absent. Attendance is tracking only.
// 4. Join month: only sessions from enrolledAt → month-end count. When the
//    student joins with ≤1 billable session left, that single session is
//    FREE (no installment emitted for the join month).
// 5. Months before enrollment / months with zero scheduled occurrences (gap
//    months) / combos with no timetable: NO installment ("–").
// 6. Reste guard: dueDate <= today only, future auto-generated sessions excluded.

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

/** One generated installment with an ABSOLUTE amount (MAD). */
export interface SessionInstallment {
  monthKey: string; // "YYYY-MM"
  dueDate: string; // "YYYY-MM-DD"
  amount: number; // MAD, absolute
}

/**
 * Rule B (rolling, no calendar alignment) — unified for ALL 2Bac s.x
 * Small groups (Math/PC/SVT) per the old small-group app screenshots.
 * PROCHAINE ÉCHÉANCE = DATE DE LA PREMIÈRE SÉANCE + n mois.
 * Every other combo remains on Rule A (session-based pricing).
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
 * When no standard Session exists for the combo, `hasSession` is false and
 * `scheduledDaysOfWeek` is empty → the session-based engine emits NO installment
 * (a subject with no timetable is not billable).
 */
export interface DeliveredDatesContext {
  hasSession: boolean;
  scheduledDaysOfWeek: number[]; // unique dayOfWeek values for standard sessions of this combo
  fallbackDayOfWeek: number; // enrolledAt's day-of-week; unused by the session-based engine
  /** "YYYY-MM" months where this combo has ZERO standard scheduled occurrences
   *  (gap months). A recurring weekly slot lands on every weekday of every
   *  calendar month, so this set is empty for a normal timetable. No installment
   *  is emitted for a gap month. */
  gapMonthKeys: ReadonlySet<string>;
}

export function buildDeliveredDatesContext(
  sessions: Session[],
  _attendanceRecords: AttendanceRecord[], // kept for signature compat — IGNORED for billing (Rule 3)
  combo: EnrollmentCombo,
  _enrolledAt: Date,
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
    fallbackDayOfWeek: 0,
    // Rule 5 — gap months: months where the combo has zero STANDARD
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
 * Counts STANDARD scheduled occurrences within an inclusive date range.
 * Extra sessions never counted (Rule 2). Attendance never consulted (Rule 3).
 */
function countOccurrencesInRange(ctx: DeliveredDatesContext, from: Date, to: Date): number {
  const start = normalizeDateOnly(from);
  const end = normalizeDateOnly(to);
  if (start > end) return 0;
  const days = ctx.scheduledDaysOfWeek;
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
 * The fixed number of billable sessions per month for a combo:
 * 4 × (scheduled days per week). 1 day/week → 4, 2 days/week → 8.
 * Zero when the combo has no timetable → not billable.
 */
export function getFixedSessionCount(ctx: DeliveredDatesContext): number {
  return 4 * ctx.scheduledDaysOfWeek.length;
}

/**
 * How many sessions a student who enrolled at `enrolledAt` will be billed
 * for in the calendar month containing `monthDate` — the count of STANDARD
 * scheduled occurrences in the billable window, capped at `fixedCount` (the
 * 5th occurrence in a month is free).
 *
 * Returns `null` when NO installment should be emitted for that month:
 *  - the combo has no timetable (fixedCount === 0),
 *  - the month is entirely before the enrollment month,
 *  - the month has zero scheduled occurrences (gap month),
 *  - the join month has ≤1 billable session left (single session = free).
 */
function computeMonthBillable(
  enrolledAt: Date,
  monthDate: Date,
  ctx: DeliveredDatesContext,
): number | null {
  const fixedCount = getFixedSessionCount(ctx);
  if (fixedCount === 0) return null;

  const monthStart = startOfMonth(monthDate);
  const monthEnd = new Date(
    monthStart.getFullYear(),
    monthStart.getMonth(),
    daysInMonth(monthStart.getFullYear(), monthStart.getMonth()),
  );

  // Months entirely before enrollment are never billed.
  if (monthEnd < normalizeDateOnly(enrolledAt)) return null;

  // Explicit gap month (term break / timetable added mid-year) → no installment.
  if (ctx.gapMonthKeys.has(formatMonthKey(monthDate))) return null;

  const isJoinMonth =
    monthDate.getFullYear() === enrolledAt.getFullYear() &&
    monthDate.getMonth() === enrolledAt.getMonth();

  const count = isJoinMonth
    ? countOccurrencesInRange(ctx, enrolledAt, monthEnd)
    : countOccurrencesInRange(ctx, monthStart, monthEnd);

  // A month with zero scheduled occurrences is a gap month too.
  if (count === 0) return null;

  const billable = Math.min(count, fixedCount);

  // Join month with a single remaining session → that session is free.
  if (isJoinMonth && billable <= 1) return null;

  return billable;
}

/**
 * Expected installment amount (MAD) for one calendar month, using the
 * session-based formula: perSession × billable sessions. Returns `null`
 * when no installment should exist for that month (see computeMonthBillable).
 *
 * `price` is the monthly fee for this student+subject (already resolved with
 * customPrice by the caller). Pure — used both by the generator and by
 * `buildPaymentMatrix` / `reconcilePaymentAmounts` to detect stale or
 * discounted rows.
 */
export function computeExpectedMonthAmount(
  enrolledAt: Date,
  monthKey: string, // "YYYY-MM"
  ctx: DeliveredDatesContext,
  price: number,
): number | null {
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number(yearStr);
  const monthIndex0 = Number(monthStr) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex0)) return null;

  const billable = computeMonthBillable(enrolledAt, new Date(year, monthIndex0, 1), ctx);
  if (billable === null) return null;

  const fixedCount = getFixedSessionCount(ctx);
  return Math.round((price / fixedCount) * billable);
}

/**
 * Rule A schedule — session-based pricing. For every month from the join
 * month through `asOf`, emits one installment whose amount is
 * perSession × (sessions the student will attend that month):
 *
 *  - join month: occurrences in [enrolledAt, month-end],
 *  - other months: occurrences in the full month,
 *  - billable capped at fixedCount (a 5th weekly occurrence is free),
 *  - join month with ≤1 session left → free (no installment),
 *  - gap months / pre-enrollment months / no timetable → no installment.
 *
 * Due date: `enrolledAt` itself for the join month, the 1st of the month
 * for every later month.
 */
export function generateSessionBasedSchedule(
  enrolledAt: Date,
  asOf: Date,
  ctx: DeliveredDatesContext,
  price: number,
): SessionInstallment[] {
  if (!ctx.hasSession || ctx.scheduledDaysOfWeek.length === 0) return [];
  if (enrolledAt > asOf) return [];

  const fixedCount = getFixedSessionCount(ctx);
  const perSession = price / fixedCount;

  const results: SessionInstallment[] = [];
  const asOfMonth = startOfMonth(asOf);
  let cursor = startOfMonth(enrolledAt);
  while (cursor <= asOfMonth) {
    const billable = computeMonthBillable(enrolledAt, cursor, ctx);
    if (billable !== null) {
      const isJoinMonth =
        cursor.getFullYear() === enrolledAt.getFullYear() &&
        cursor.getMonth() === enrolledAt.getMonth();
      const dueDate = isJoinMonth ? enrolledAt : cursor;
      results.push({
        monthKey: formatMonthKey(cursor),
        dueDate: formatDateKey(dueDate),
        amount: Math.round(perSession * billable),
      });
    }
    cursor = addMonthsClamped(cursor, 1);
  }
  return results;
}

/**
 * Rule B schedule (2Bac s.x Small Math/PC/SVT only): no calendar alignment
 * at all — a full-price charge on the join date, then every month on that
 * same day-of-month, forever.
 */
export function generateRuleBSchedule(
  enrolledAt: Date,
  asOf: Date,
  price: number,
): SessionInstallment[] {
  if (enrolledAt > asOf) return [];

  const results: SessionInstallment[] = [];
  let i = 0;
  let cursor = enrolledAt;
  while (cursor <= asOf) {
    results.push({
      monthKey: formatMonthKey(cursor),
      dueDate: formatDateKey(cursor),
      amount: Math.round(price),
    });
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
  price: number,
): SessionInstallment[] {
  return rule === "B"
    ? generateRuleBSchedule(enrolledAt, asOf, price)
    : generateSessionBasedSchedule(enrolledAt, asOf, ctx, price);
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

// ---------------------------------------------------------------------------//
// Ledger reconciliation — self-heal stale Rule A amounts after a price or
// timetable change. Rule B rows and customPrice rows are never touched.
// ---------------------------------------------------------------------------//

export interface ReconcilePatch {
  id: string;
  amountDue: number;
  /** Recomputed isPaid: true only when amountPaid covers the NEW amountDue. */
  isPaid: boolean;
}

/**
 * Recomputes the expected `amountDue` of every Rule A installment and
 * reports the ones that drifted (price change, timetable edit, engine
 * migration). `isPaid` is recomputed strictly from `amountPaid` — a row
 * stays paid only when the paid amount covers the new expected amount.
 * Rule B rows and rows whose expected amount is null (no timetable / gap
 * month) are left untouched. Pure — the store layer applies the patches.
 */
export function reconcilePaymentAmounts(
  payments: Payment[],
  students: Student[],
  sessions: Session[],
  prices: PriceEntry[],
): ReconcilePatch[] {
  const studentsById = new Map(students.map((s) => [s.id, s]));
  const patches: ReconcilePatch[] = [];

  for (const payment of payments) {
    if (payment.rule !== "A") continue;
    const student = studentsById.get(payment.studentId);
    if (!student) continue;
    const enrollment = student.enrollments.find((e) => e.subject === payment.subject);
    if (!enrollment) continue;

    const price = getEffectivePriceFor(
      student,
      enrollment,
      prices,
    );
    if (price === undefined) continue;

    const enrolledAt = new Date(enrollment.enrolledAt ?? student.createdAt);
    const ctx = buildDeliveredDatesContext(
      sessions,
      [],
      {
        level: student.level,
        subject: enrollment.subject,
        track: enrollment.track,
        groupType: enrollment.groupType,
      },
      enrolledAt,
    );

    const expected = computeExpectedMonthAmount(enrolledAt, payment.month, ctx, price);
    if (expected === null || expected === payment.amountDue) continue;

    patches.push({
      id: payment.id,
      amountDue: expected,
      isPaid: (payment.amountPaid ?? 0) >= expected,
    });
  }

  return patches;
}

/**
 * Resolves the monthly fee for one enrollment: `customPrice` wins over the
 * base PriceEntry (Takhfid). Returns undefined when no price is defined at
 * all (not billable).
 */
export function getEffectivePriceFor(
  student: Student,
  enrollment: SubjectEnrollment,
  prices: PriceEntry[],
): number | undefined {
  if (enrollment.customPrice !== undefined) return enrollment.customPrice;
  return prices.find(
    (p) =>
      p.level === student.level &&
      p.subject === enrollment.subject &&
      p.track === enrollment.track &&
      p.groupType === enrollment.groupType,
  )?.price;
}

// ---------------------------------------------------------------------------//
// Partial-payment helpers
// ---------------------------------------------------------------------------//

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

// ---------------------------------------------------------------------------//
// Advance-credit waterfall (simple dueDate-ascending gap filling)
// ---------------------------------------------------------------------------//

export interface CreditWaterfallResult {
  /** New payment objects reflecting the credit applied (only installment rows that changed).
   *  Unchanged installments are omitted — the caller merges by id. */
  updated: Payment[];
  /** Credit that could not be absorbed by any installment (dueDate-ascending).
   *  This leftover must be stored as `advanceBalance` on the student. */
  remaining: number;
  /** True when at least one installment was fully or partially changed. */
  anyChanged: boolean;
}

/**
 * Distributes `credit` (MAD) across installments in `dueDate`-ascending
 * order, applying to each installment's remaining gap (`amountDue - amountPaid`).
 *
 * With the session-based engine the installment amounts are already exact,
 * so plain gap-filling is all that's needed: no proration tiers, no
 * current/future month split.
 *
 * - `subject === null` means cross-subject (any subject for that student) —
 *   used by the creation-time `applyInitialTuitionPayment` waterfall.
 * - Only installments that genuinely have a remaining gap (not fully paid)
 *   are credited. Once credit is exhausted or all gaps are filled, the
 *   function returns the leftover as `remaining` for the caller to stash in
 *   `advanceBalance`.
 * - Returns a minimal `updated` array (changed rows only) so callers can
 *   merge by `id` without rewriting the whole ledger.
 *
 * Pure — no React/Zustand, no hidden date().
 */
export function applyCreditWaterfall(
  payments: Payment[],
  studentId: string,
  subject: Subject | null,
  credit: number,
  _asOfKey: string,
  updatedAt: string,
): CreditWaterfallResult {
  const emptyResult: CreditWaterfallResult = {
    updated: [],
    remaining: Math.max(0, Math.round(credit)),
    anyChanged: false,
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

  const updated: Payment[] = [];
  let remaining = Math.max(0, Math.round(credit));

  for (const payment of eligible) {
    if (remaining <= 0) break;

    const currentPaid = payment.amountPaid ?? 0;
    const gap = Math.max(0, payment.amountDue - currentPaid);
    if (gap <= 0) continue;

    const apply = Math.min(gap, remaining);
    if (apply <= 0) continue;

    const amountPaid = currentPaid + apply;
    const isPaid = amountPaid >= payment.amountDue;
    updated.push({ ...payment, amountPaid, isPaid, updatedAt });
    remaining -= apply;
  }

  return {
    updated,
    remaining: Math.max(0, remaining),
    anyChanged: updated.length > 0,
  };
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

// ---------------------------------------------------------------------------//
// Overdue worklist aggregation (Payments page)
// ---------------------------------------------------------------------------//

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

// ---------------------------------------------------------------------------//
// Settled worklist aggregation (Payments page — "Payés / أدوا الواجب" panel)
// ---------------------------------------------------------------------------//

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

// ---------------------------------------------------------------------------//
// Ledger de-duplication (defensive self-heal)
// ---------------------------------------------------------------------------//

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

// ---------------------------------------------------------------------------//
// Registration fee (رسوم التسجيل — one-time 100 DH, fully separate from
// the Rule A/B installment engine: never flows into any installment total)
// ---------------------------------------------------------------------------//

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
