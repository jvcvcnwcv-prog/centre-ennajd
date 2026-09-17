// Unit tests for the advance-credit waterfall.
// Run with: npx vitest run src/lib/ennajd-billing.test.ts

import { describe, it, expect } from "vitest";
import {
  applyCreditWaterfall,
  formatMonthKey,
  generateRuleASchedule,
  getPaymentRuleFor,
  isPaymentFullyPaid,
  isProratedSubject,
} from "./ennajd-billing";
import type {
  GroupType,
  Level,
  Payment,
  Session,
  Student,
  Subject,
  SubjectEnrollment,
  Track,
} from "../types/ennajd";

// Helper to build a DeliveredDatesContext for testing generateRuleASchedule.
// `hasSession=true` means standard sessions on the given weekdays; the count
// function counts how many of those fall in a date range. `gapMonthKeys`
// marks Rule D gap months (zero standard scheduled occurrences).
function makeCtx(opts: {
  hasSession?: boolean;
  scheduledDaysOfWeek?: number[];
  fallbackDayOfWeek?: number;
  gapMonthKeys?: ReadonlySet<string>;
}) {
  return {
    hasSession: opts.hasSession ?? true,
    scheduledDaysOfWeek: opts.scheduledDaysOfWeek ?? [],
    fallbackDayOfWeek: opts.fallbackDayOfWeek ?? 1,
    gapMonthKeys: opts.gapMonthKeys ?? new Set<string>(),
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

// --- Proration test fixtures (Rules A-D + 2BAC Small exemption) ---

/** Noontime ISO so local-calendar fields are stable in any timezone. */
const NOON = "T12:00:00.000Z";

function makeStudent(opts: {
  id?: string;
  level?: Level;
  track?: Track | null;
  enrollments: SubjectEnrollment[];
  advanceBalance?: number;
}): Student {
  return {
    id: opts.id ?? STUDENT_ID,
    firstName: "Test",
    lastName: "Student",
    whatsappPhone: "",
    parentPhone: "",
    level: opts.level ?? "T.C",
    track: opts.track ?? null,
    enrollments: opts.enrollments,
    createdAt: "2025-01-01T00:00:00.000Z",
    advanceBalance: opts.advanceBalance,
  };
}

function makeRecurringSession(
  subject: Subject,
  level: Level,
  track: Track | null,
  groupType: GroupType | null,
  dayOfWeek: number,
): Session {
  return {
    id: `session-${subject}-${level}-${dayOfWeek}`,
    subject,
    level,
    track,
    groupType,
    dayOfWeek,
    startTime: "16:00",
    endTime: "18:00",
    kind: "recurring",
    date: null,
  };
}

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

// ---------------------------------------------------------------------------
// Rule D — gap months in generateRuleASchedule
// ---------------------------------------------------------------------------

describe("generateRuleASchedule — Rule D gap months", () => {
  it("emits NO installment for a month with zero standard scheduled occurrences", () => {
    // Combo not scheduled at all → every month has 0 occurrences → no debt.
    const ctx = makeCtx({
      hasSession: true,
      scheduledDaysOfWeek: [],
      fallbackDayOfWeek: 3,
    });
    const schedule = generateRuleASchedule(
      new Date(2025, 0, 8),
      new Date(2025, 4, 15),
      ctx,
    );
    expect(schedule).toHaveLength(0);
  });

  it("skips an explicitly-marked gap month and resumes the next month", () => {
    // Wednesday combo; March 2025 is a term break (gap month). Joining Jan 8
    // 2025 (Wednesday) with 4/5 sessions remaining → custom tier (M2 ratio
    // 4/5 on Feb 1), then full months from March onward — except March,
    // which emits nothing.
    const ctx = makeCtx({
      hasSession: true,
      scheduledDaysOfWeek: [3], // Wednesday
      fallbackDayOfWeek: 3,
      gapMonthKeys: new Set(["2025-03"]),
    });
    const schedule = generateRuleASchedule(
      new Date(2025, 0, 8),
      new Date(2025, 4, 15),
      ctx,
    );
    const dueMonthKeys = schedule.map((s) => formatMonthKey(s.dueDate));

    // March is skipped entirely — no installment, no debt.
    expect(dueMonthKeys).not.toContain("2025-03");
    // Surrounding months are still emitted.
    expect(dueMonthKeys).toContain("2025-01");
    expect(dueMonthKeys).toContain("2025-02");
    expect(dueMonthKeys).toContain("2025-04");
    expect(dueMonthKeys).toContain("2025-05");
  });

  it("skips gap months in the single-session-skip branch too", () => {
    // 1 remaining session in the join month (Rule A skip of month 1), with
    // April marked as a gap month.
    const ctx = makeCtx({
      hasSession: true,
      scheduledDaysOfWeek: [3],
      fallbackDayOfWeek: 3,
      gapMonthKeys: new Set(["2025-04"]),
    });
    const schedule = generateRuleASchedule(
      new Date(2025, 0, 29), // last Wednesday of Jan → 1 remaining
      new Date(2025, 4, 15),
      ctx,
    );
    const dueMonthKeys = schedule.map((s) => formatMonthKey(s.dueDate));
    expect(dueMonthKeys).not.toContain("2025-04");
    expect(dueMonthKeys).toContain("2025-02");
    expect(dueMonthKeys).toContain("2025-03");
    expect(dueMonthKeys).toContain("2025-05");
  });
});

// ---------------------------------------------------------------------------
// Waterfall Rules A-D + 2BAC Small exemption
// ---------------------------------------------------------------------------

describe("applyCreditWaterfall — Rule A join-month-only skip", () => {
  it("skips the join-month installment but credits a LATER month (scope fix)", () => {
    // 1x/week Wednesday combo; student joins Jan 29 2025 (Wednesday) →
    // exactly 1 standard session remains in the join month → Rule A skip,
    // scoped to "2025-01" only.
    const student = makeStudent({
      level: "T.C",
      enrollments: [
        { subject: "Math", track: null, groupType: "Large", enrolledAt: `2025-01-29${NOON}` },
      ],
    });
    const sessions = [makeRecurringSession("Math", "T.C", null, "Large", 3)];
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-29", 1000), // join month
      makePayment("p2", STUDENT_ID, "Math", "2025-02-01", 1000), // later month
      makePayment("p3", STUDENT_ID, "Math", "2025-03-01", 1000), // later month
    ];

    const result = applyCreditWaterfall(payments, STUDENT_ID, "Math", 1500, "2025-02-15", NOW, {
      student,
      sessions,
      prices: [],
    });

    // Join-month installment is untouched (Rule A skip).
    expect(result.updated.find((p) => p.id === "p1")).toBeUndefined();
    // Later months are still creditable (the scope fix): Feb cleared, Mar partial.
    expect(result.updated.find((p) => p.id === "p2")?.amountPaid).toBe(1000);
    expect(result.updated.find((p) => p.id === "p3")?.amountPaid).toBe(500);
    expect(result.remaining).toBe(0);
  });
});

describe("applyCreditWaterfall — Rule B partial month (once-per-subject budget)", () => {
  it("caps current-month credit at round(credit * ratio) and rolls the surplus forward", () => {
    // Join Jan 8 2025 (Wednesday) with 4 of 5 Wednesday sessions remaining →
    // ratio 4/5. A 1000 MAD credit must put round(1000 * 0.8) = 800 on the
    // current month and roll the 200 surplus to the next installment.
    const student = makeStudent({
      level: "T.C",
      enrollments: [
        { subject: "Math", track: null, groupType: "Large", enrolledAt: `2025-01-08${NOON}` },
      ],
    });
    const sessions = [makeRecurringSession("Math", "T.C", null, "Large", 3)];
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-08", 1000), // current month
      makePayment("p2", STUDENT_ID, "Math", "2025-02-01", 1000), // future
      makePayment("p3", STUDENT_ID, "Math", "2025-03-01", 1000), // future
    ];

    const result = applyCreditWaterfall(payments, STUDENT_ID, "Math", 1000, "2025-01-20", NOW, {
      student,
      sessions,
      prices: [],
    });

    const p1 = result.updated.find((p) => p.id === "p1");
    const p2 = result.updated.find((p) => p.id === "p2");
    expect(p1?.amountPaid).toBe(800); // budget-capped, NOT the full 1000
    expect(isPaymentFullyPaid(p1!)).toBe(false);
    expect(p2?.amountPaid).toBe(200); // surplus rolled forward
    expect(result.updated.find((p) => p.id === "p3")).toBeUndefined(); // nothing left
    expect(result.remaining).toBe(0);
    expect(result.currentMonthCredit).toBe(800);
    expect(result.futureMonthCredit).toBe(200);
  });
});

describe("applyCreditWaterfall — Rule C full month", () => {
  it("applies 100% of credit to the current month when remaining === total", () => {
    // Joined Jan 1 2025 (first Wednesday) → all 5 sessions remain → ratio 1.
    const student = makeStudent({
      level: "T.C",
      enrollments: [
        { subject: "Math", track: null, groupType: "Large", enrolledAt: `2025-01-01${NOON}` },
      ],
    });
    const sessions = [makeRecurringSession("Math", "T.C", null, "Large", 3)];
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 500), // current month
      makePayment("p2", STUDENT_ID, "Math", "2025-02-01", 500), // future
    ];

    const result = applyCreditWaterfall(payments, STUDENT_ID, "Math", 500, "2025-01-20", NOW, {
      student,
      sessions,
      prices: [],
    });

    const p1 = result.updated.find((p) => p.id === "p1");
    expect(p1?.amountPaid).toBe(500);
    expect(isPaymentFullyPaid(p1!)).toBe(true);
    expect(result.updated.find((p) => p.id === "p2")).toBeUndefined();
    expect(result.remaining).toBe(0);
    expect(result.currentMonthCredit).toBe(500);
    expect(result.futureMonthCredit).toBe(0);
  });
});

describe("applyCreditWaterfall — 2BAC Small (P.G) exemption", () => {
  const SMALL_2BAC_COMBOS: Array<{ subject: Subject; track: Track }> = [
    { subject: "Math", track: "s.x" },
    { subject: "PC", track: "s.x" },
    { subject: "SVT", track: "s.x" },
  ];

  for (const { subject, track } of SMALL_2BAC_COMBOS) {
    it(`falls back to plain gap-filling for 2Bac ${track} Small ${subject} (no proration)`, () => {
      expect(getPaymentRuleFor("2Bac", subject, "Small", track)).toBe("B");

      const student = makeStudent({
        level: "2Bac",
        track,
        enrollments: [
          { subject, track, groupType: "Small", enrolledAt: `2025-01-29${NOON}` },
        ],
      });
      expect(isProratedSubject(student, subject)).toBe(false);

      const sessions = [makeRecurringSession(subject, "2Bac", track, "Small", 3)];
      const payments: Payment[] = [
        makePayment("p1", STUDENT_ID, subject, "2025-01-29", 300), // current month
        makePayment("p2", STUDENT_ID, subject, "2025-02-01", 300), // future
      ];

      const result = applyCreditWaterfall(payments, STUDENT_ID, subject, 400, "2025-02-15", NOW, {
        student,
        sessions,
        prices: [],
      });

      // Plain gap-filling: the current month is NOT capped by any ratio — it
      // is cleared outright and the surplus lands on the next installment.
      expect(result.updated.find((p) => p.id === "p1")?.amountPaid).toBe(300);
      expect(result.updated.find((p) => p.id === "p2")?.amountPaid).toBe(100);
      expect(result.remaining).toBe(0);
    });
  }

  it("a non-exempt 2Bac combo still prorates (s.m is not P.G)", () => {
    const student = makeStudent({
      level: "2Bac",
      track: "s.m",
      enrollments: [
        { subject: "Math", track: "s.m", groupType: "Small", enrolledAt: `2025-01-29${NOON}` },
      ],
    });
    expect(getPaymentRuleFor("2Bac", "Math", "Small", "s.m")).toBe("A");
    expect(isProratedSubject(student, "Math")).toBe(true);
  });
});
