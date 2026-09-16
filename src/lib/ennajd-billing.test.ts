// Unit tests for the advance-credit waterfall.
// Run with: npx vitest run src/lib/ennajd-billing.test.ts

import { describe, it, expect } from "vitest";
import { applyCreditWaterfall, generateRuleASchedule, isPaymentFullyPaid } from "./ennajd-billing";
import type { Payment, Subject } from "../types/ennajd";

// Helper to build a DeliveredDatesContext for testing generateRuleASchedule.
// `hasSession=true` means standard sessions on the given weekdays; the count
// function counts how many of those fall in a date range.
function makeCtx(opts: {
  hasSession?: boolean;
  scheduledDaysOfWeek?: number[];
  fallbackDayOfWeek?: number;
}) {
  return {
    hasSession: opts.hasSession ?? true,
    scheduledDaysOfWeek: opts.scheduledDaysOfWeek ?? [],
    fallbackDayOfWeek: opts.fallbackDayOfWeek ?? 1,
  };
}

const SUBJECT: Subject = "PC";
const RULE: Payment["rule"] = "A";
const NOW = "2025-01-15T00:00:00Z";
const AS_OF = "2025-01-15";

function makePayment(
  id: string,
  studentId: string,
  subject: Subject,
  dueDate: string,
  amountDue: number,
  amountPaid = 0,
  isPaid = false,
): Payment {
  return {
    id,
    studentId,
    subject,
    dueDate,
    month: dueDate.slice(0, 7),
    isPaid,
    amountDue,
    amountPaid,
    isHalfMonth: false,
    rule: RULE,
    updatedAt: NOW,
  };
}

const STUDENT_ID = "student-1";

describe("applyCreditWaterfall", () => {
  it("distributes credit across current + future installments (surplus rolls forward)", () => {
    // 3 installments: current (due Jan), next month (Feb), two months (Mar)
    // credit = 500 → current 300 cleared, next cleared (300), third gets 200 of 400
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, SUBJECT, "2025-01-01", 300),
      makePayment("p2", STUDENT_ID, SUBJECT, "2025-02-01", 300),
      makePayment("p3", STUDENT_ID, SUBJECT, "2025-03-01", 400),
    ];

    const result = applyCreditWaterfall(payments, STUDENT_ID, SUBJECT, 500, AS_OF, NOW);

    expect(result.remaining).toBe(0);
    expect(result.anyChanged).toBe(true);
    // p1 fully paid (300)
    const p1 = result.updated.find((p) => p.id === "p1");
    expect(p1?.amountPaid).toBe(300);
    expect(isPaymentFullyPaid(p1!)).toBe(true);
    // p2 fully paid (300 from the 200 remaining)
    const p2 = result.updated.find((p) => p.id === "p2");
    expect(p2?.amountPaid).toBe(300);
    expect(isPaymentFullyPaid(p2!)).toBe(true);
    // p3 partially paid (200 of 400)
    const p3 = result.updated.find((p) => p.id === "p3");
    expect(p3?.amountPaid).toBe(200);
    expect(isPaymentFullyPaid(p3!)).toBe(false);
  });

  it("stores surplus as remaining when credit exceeds all installment gaps", () => {
    // 1 installment: current month amountDue=300, credit=700
    // → installment settled, remaining=400 (must become advanceBalance)
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, SUBJECT, "2025-01-01", 300),
    ];

    const result = applyCreditWaterfall(payments, STUDENT_ID, SUBJECT, 700, AS_OF, NOW);

    expect(result.remaining).toBe(400);
    expect(result.anyChanged).toBe(true);
    const p1 = result.updated[0];
    expect(isPaymentFullyPaid(p1)).toBe(true);
    expect(p1.amountPaid).toBe(300);
  });

  it("returns zero credit input unchanged", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, SUBJECT, "2025-01-01", 300),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, SUBJECT, 0, AS_OF, NOW);
    expect(result.remaining).toBe(0);
    expect(result.updated).toHaveLength(0);
    expect(result.anyChanged).toBe(false);
  });

  it("handles negative / NaN credit gracefully", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, SUBJECT, "2025-01-01", 300),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, SUBJECT, -50, AS_OF, NOW);
    expect(result.remaining).toBe(0);
    expect(result.updated).toHaveLength(0);
  });

  it("respects subject filter (cross-subject mode with subject=null)", () => {
    // Two subjects for same student — subject=null should scan both
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300),
      makePayment("p2", STUDENT_ID, "Math", "2025-01-01", 200),
    ];
    // 400 credit in cross-subject mode → clears both
    const result = applyCreditWaterfall(payments, STUDENT_ID, null, 400, AS_OF, NOW);
    expect(result.remaining).toBe(0);
    expect(result.updated).toHaveLength(2);
  });

  it("respects subject filter (per-subject mode only touches one subject)", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300),
      makePayment("p2", STUDENT_ID, "Math", "2025-01-01", 200),
    ];
    // 400 credit scoped to PC only → clears PC, 100 remaining
    const result = applyCreditWaterfall(payments, STUDENT_ID, "PC", 400, AS_OF, NOW);
    expect(result.remaining).toBe(100);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe("p1");
  });

  it("sorts by dueDate ascending before applying", () => {
    // Unsorted input — later dueDate first
    const payments: Payment[] = [
      makePayment("p2", STUDENT_ID, SUBJECT, "2025-02-01", 300),
      makePayment("p1", STUDENT_ID, SUBJECT, "2025-01-01", 300),
    ];
    // 300 credit → should clear p1 (Jan), not p2 (Feb)
    const result = applyCreditWaterfall(payments, STUDENT_ID, SUBJECT, 300, AS_OF, NOW);
    expect(result.remaining).toBe(0);
    const p1 = result.updated.find((p) => p.id === "p1");
    expect(p1?.amountPaid).toBe(300);
    // p2 should NOT be in updated
    expect(result.updated.find((p) => p.id === "p2")).toBeUndefined();
  });

  it("skips already-fully-paid installments", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, SUBJECT, "2025-01-01", 300, 300, true),
      makePayment("p2", STUDENT_ID, SUBJECT, "2025-02-01", 300),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, SUBJECT, 100, AS_OF, NOW);
    // p1 is fully paid → skip, apply 100 to p2
    expect(result.remaining).toBe(200);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe("p2");
    expect(result.updated[0].amountPaid).toBe(100);
  });

  it("respects studentId filter", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, SUBJECT, "2025-01-01", 300),
      makePayment("p2", "other-student", SUBJECT, "2025-01-01", 300),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, SUBJECT, 300, AS_OF, NOW);
    expect(result.remaining).toBe(0);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe("p1");
  });
});

// ---------------------------------------------------------------------------
// Rule A — generateRuleASchedule
// ---------------------------------------------------------------------------

describe("generateRuleASchedule — Rule A single-session skip", () => {
  // A 2x/week subject (e.g. PC) has 8 standard sessions in a full month
  // (4 weeks × 2 days). We simulate a student joining on day 6 of January
  // (a Thursday) when sessions run on Monday + Thursday (day 1 and 4).
  // Jan 2025: Mon=6, Thu=9, Mon=13, Thu=16, Mon=20, Thu=23, Mon=27, Thu=30
  // Joining on Jan 6 (Monday) → remaining Mon+Thu from Jan 6..31 = 8 sessions.
  // Joining on Jan 28 (Monday) → remaining = 2 (Mon 27 is before the 28th,
  //   Thu 30, Mon ... no). Let's use a cleaner setup:
  //
  // Setup: student joins mid-month such that exactly 1 standard session
  // remains. Use a 1x/week schedule (sessions on Wednesdays) in Jan 2025:
  // Wednesdays = Jan 1, 8, 15, 22, 29.
  // If enrolledAt = Jan 29 (last Wednesday), remaining = 1 (just Jan 29).
  const WED_CTX = makeCtx({
    hasSession: true,
    scheduledDaysOfWeek: [3], // Wednesday
    fallbackDayOfWeek: 3,
  });

  it("single remaining session → NO Month 1 installment, 100% autoPaid to next month", () => {
    // Jan 29 2025 is a Wednesday. Sessions on Wednesdays in Jan 2025:
    // Jan 1(wed), 8, 15, 22, 29 → 5 total.
    // enrolledAt = Jan 29 → remaining from Jan 29..31 = 1 (Jan 29).
    // total = 5.
    // asOf = Feb 15 2025.
    const enrolledAt = new Date(2025, 0, 29); // Jan 29
    const asOf = new Date(2025, 1, 15); // Feb 15

    const schedule = generateRuleASchedule(enrolledAt, asOf, WED_CTX);

    // Should NOT have a Month-1 installment on enrolledAt (Jan 29).
    const month1 = schedule.find((s) => s.dueDate.getTime() === enrolledAt.getTime());
    expect(month1).toBeUndefined();

    // Should have exactly ONE autoPaid installment on Feb 1 (nextMonthDue)
    // with amountRatio 1.
    const nextMonth = schedule.find((s) => s.dueDate.getTime() === new Date(2025, 1, 1).getTime());
    expect(nextMonth).toBeDefined();
    expect(nextMonth!.amountRatio).toBe(1);
    expect(nextMonth!.autoPaid).toBe(true);
    expect(nextMonth!.isHalfMonth).toBe(false);

    // No other installments — Feb 1 is the only one within asOf window.
    expect(schedule.filter((s) => s.dueDate.getTime() <= asOf.getTime())).toHaveLength(1);
  });

  it("single remaining session with asOf far in future → autoPaid Feb + full-price March onward", () => {
    const enrolledAt = new Date(2025, 0, 29); // Jan 29, one remaining session
    const asOf = new Date(2025, 4, 15); // May 15

    const schedule = generateRuleASchedule(enrolledAt, asOf, WED_CTX);

    // Feb 1: autoPaid (100% pre-pay)
    const feb1 = schedule.find((s) => s.dueDate.getTime() === new Date(2025, 1, 1).getTime());
    expect(feb1).toBeDefined();
    expect(feb1!.autoPaid).toBe(true);
    expect(feb1!.amountRatio).toBe(1);

    // Mar 1 onward: regular full-price, NOT autoPaid
    const mar1 = schedule.find((s) => s.dueDate.getTime() === new Date(2025, 2, 1).getTime());
    expect(mar1).toBeDefined();
    expect(mar1!.autoPaid).toBe(false);
    expect(mar1!.amountRatio).toBe(1);

    const apr1 = schedule.find((s) => s.dueDate.getTime() === new Date(2025, 3, 1).getTime());
    expect(apr1).toBeDefined();
    expect(apr1!.autoPaid).toBe(false);
    expect(apr1!.amountRatio).toBe(1);

    const may1 = schedule.find((s) => s.dueDate.getTime() === new Date(2025, 4, 1).getTime());
    expect(may1).toBeDefined();
    expect(may1!.autoPaid).toBe(false);

    // Total: Feb + Mar + Apr + May = 4 installments
    const dueInWindow = schedule.filter((s) => s.dueDate.getTime() <= asOf.getTime());
    expect(dueInWindow).toHaveLength(4);
  });

  it("single remaining session with asOf before next month → empty array", () => {
    // enrolledAt Jan 29, asOf same day → nextMonthDue (Feb 1) > asOf → no installments
    const enrolledAt = new Date(2025, 0, 29);
    const asOf = new Date(2025, 0, 29);

    const schedule = generateRuleASchedule(enrolledAt, asOf, WED_CTX);
    expect(schedule).toHaveLength(0);
  });

  it("does NOT trigger when remaining is 2 (still uses Late-Join tier, not Rule A skip)", () => {
    // Jan 22 (Wednesday), sessions on Wednesdays: 1, 8, 15, 22, 29
    // enrolledAt Jan 22 → remaining Jan 22..31 = Jan 22 + Jan 29 = 2.
    // remaining === 2 → falls into Tier 1 (Late-Join: autoPaid Month 1 + next month),
    // NOT Rule A skip. Month 1 installment ON enrolledAt should exist.
    const enrolledAt = new Date(2025, 0, 22); // Jan 22
    const asOf = new Date(2025, 1, 15); // Feb 15

    const schedule = generateRuleASchedule(enrolledAt, asOf, WED_CTX);

    // Month 1 installment on enrolledAt (Jan 22) should exist → NOT skipped
    const month1 = schedule.find((s) => s.dueDate.getTime() === enrolledAt.getTime());
    expect(month1).toBeDefined();
    expect(month1!.autoPaid).toBe(false); // Tier 1 creates unpaid Month 1

    // Feb 1: autoPaid (Late-Join bonus credit)
    const feb1 = schedule.find((s) => s.dueDate.getTime() === new Date(2025, 1, 1).getTime());
    expect(feb1).toBeDefined();
    expect(feb1!.autoPaid).toBe(true);
  });
});
