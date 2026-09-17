// Unit tests for the session-based pricing engine.
// Run with: npx vitest run src/lib/ennajd-billing.test.ts

import { describe, it, expect } from "vitest";
import {
  applyCreditWaterfall,
  buildDeliveredDatesContext,
  computeExpectedMonthAmount,
  generateRuleBSchedule,
  generateScheduleFor,
  generateSessionBasedSchedule,
  getFixedSessionCount,
  getPaymentRuleFor,
  isPaymentFullyPaid,
  reconcilePaymentAmounts,
  reconcileRuleALedger,
} from "./ennajd-billing";
import type {
  GroupType,
  Level,
  Payment,
  PriceEntry,
  Session,
  Student,
  Subject,
  SubjectEnrollment,
  Track,
} from "../types/ennajd";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUDENT_ID = "student-1";
const NOW = "2025-01-15T12:00:00.000Z";
const PRICE = 400; // monthly fee for a 1x/week subject → perSession = 100

/** Noontime ISO so local-calendar fields are stable in any timezone. */
const NOON = "T12:00:00.000Z";

function makeCtx(opts: {
  hasSession?: boolean;
  scheduledDaysOfWeek?: number[];
  gapMonthKeys?: ReadonlySet<string>;
}) {
  return {
    hasSession: opts.hasSession ?? true,
    scheduledDaysOfWeek: opts.scheduledDaysOfWeek ?? [],
    fallbackDayOfWeek: 0,
    gapMonthKeys: opts.gapMonthKeys ?? new Set<string>(),
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

function makePayment(
  id: string,
  studentId: string,
  subject: Subject,
  dueDate: string,
  amountDue: number,
  amountPaid = 0,
  isPaid = false,
  rule: Payment["rule"] = "A",
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
    rule,
    updatedAt: NOW,
  };
}

// January 2025 Wednesdays: 1, 8, 15, 22, 29 (5 occurrences).
// February 2025 Wednesdays: 5, 12, 19, 26 (4 occurrences).
const WED_CTX = makeCtx({ scheduledDaysOfWeek: [3] });

// ---------------------------------------------------------------------------
// Session-based pricing — core formula
// ---------------------------------------------------------------------------

describe("generateSessionBasedSchedule — 1x/week subject (fixedCount = 4)", () => {
  it("charges the full price when joining at the start of the month (4/4)", () => {
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 1), // Jan 1 (Wednesday)
      new Date(2025, 1, 15),
      WED_CTX,
      PRICE,
    );
    const jan = schedule.find((s) => s.monthKey === "2025-01");
    expect(jan).toBeDefined();
    expect(jan!.amount).toBe(400);
    // Join-month installment is due on the enrollment date itself.
    expect(jan!.dueDate).toBe("2025-01-01");
  });

  it("charges 75% when 3 of 4 sessions remain (3/4)", () => {
    // Exclusive window: the enrollment-date session is excluded, so join the
    // day BEFORE a Wednesday (Jan 14, Tue) → 15, 22, 29 remain = 3.
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 14), // Jan 14 (Tuesday) → Jan 15, 22, 29 remain
      new Date(2025, 1, 15),
      WED_CTX,
      PRICE,
    );
    const jan = schedule.find((s) => s.monthKey === "2025-01");
    expect(jan!.amount).toBe(300);
  });

  it("charges 50% when 2 of 4 sessions remain (2/4)", () => {
    // Join Jan 21 (Tue) → sessions strictly after: 22, 29 = 2.
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 21), // Jan 21 (Tuesday) → 22, 29 remain
      new Date(2025, 1, 15),
      WED_CTX,
      PRICE,
    );
    const jan = schedule.find((s) => s.monthKey === "2025-01");
    expect(jan!.amount).toBe(200);
  });

  it("charges nothing when a single session remains (1/4 → FREE)", () => {
    // Join Jan 28 (Tue) → only Jan 29 remains → billable 1 → FREE.
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 28), // Jan 28 (Tuesday) → 29 only remains
      new Date(2025, 1, 15),
      WED_CTX,
      PRICE,
    );
    expect(schedule.find((s) => s.monthKey === "2025-01")).toBeUndefined();
    // The next month is still billed in full.
    expect(schedule.find((s) => s.monthKey === "2025-02")!.amount).toBe(400);
  });

  it("emits no installment when the join date leaves zero sessions", () => {
    // Joining ON the last Wednesday (Jan 29) → nothing strictly after it in
    // January → zero occurrences → no installment for the join month.
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 29),
      new Date(2025, 1, 15),
      WED_CTX,
      PRICE,
    );
    expect(schedule.find((s) => s.monthKey === "2025-01")).toBeUndefined();
    expect(schedule.find((s) => s.monthKey === "2025-02")!.amount).toBe(400);
  });

  it("bills the 5th occurrence of a month for FREE (invoice stays 400)", () => {
    // January 2025 has 5 Wednesdays; joining Jan 1 → 5 occurrences but
    // billable is capped at fixedCount = 4 → full price, 5th is free.
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 1),
      new Date(2025, 1, 15),
      WED_CTX,
      PRICE,
    );
    expect(schedule.find((s) => s.monthKey === "2025-01")!.amount).toBe(400);
  });

  it("charges full price for complete later months, due on the 1st", () => {
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 15),
      new Date(2025, 2, 15), // through March
      WED_CTX,
      PRICE,
    );
    const feb = schedule.find((s) => s.monthKey === "2025-02");
    expect(feb!.amount).toBe(400);
    expect(feb!.dueDate).toBe("2025-02-01");
    const mar = schedule.find((s) => s.monthKey === "2025-03");
    expect(mar!.amount).toBe(400);
    expect(mar!.dueDate).toBe("2025-03-01");
  });

  it("emits no installment for months before the enrollment date", () => {
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 1, 5), // joins in February
      new Date(2025, 2, 15),
      WED_CTX,
      PRICE,
    );
    expect(schedule.find((s) => s.monthKey === "2025-01")).toBeUndefined();
    expect(schedule.find((s) => s.monthKey === "2025-02")).toBeDefined();
  });

  it("emits nothing for a subject with no timetable", () => {
    expect(
      generateSessionBasedSchedule(
        new Date(2025, 0, 1),
        new Date(2025, 2, 15),
        makeCtx({ hasSession: false, scheduledDaysOfWeek: [] }),
        PRICE,
      ),
    ).toHaveLength(0);
  });

  it("emits nothing for a gap month (zero scheduled occurrences)", () => {
    const ctx = makeCtx({
      scheduledDaysOfWeek: [3],
      gapMonthKeys: new Set(["2025-02"]),
    });
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 1),
      new Date(2025, 2, 15),
      ctx,
      PRICE,
    );
    const monthKeys = schedule.map((s) => s.monthKey);
    expect(monthKeys).not.toContain("2025-02");
    expect(monthKeys).toContain("2025-01");
    expect(monthKeys).toContain("2025-03");
  });

  it("respects customPrice in the computation", () => {
    // Same 4/4 join, but the student's effective price is 300 (Takhfid).
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 1),
      new Date(2025, 1, 15),
      WED_CTX,
      300,
    );
    expect(schedule.find((s) => s.monthKey === "2025-01")!.amount).toBe(300);
  });

  it("rounds per-session amounts to whole MAD", () => {
    // price 300 with fixedCount 4 → perSession 75 → 2 sessions = 150.
    // Joining Jan 15 (Wed) excludes the 15th → 22, 29 remain.
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 15), // 2 sessions remain (22, 29)
      new Date(2025, 1, 15),
      WED_CTX,
      300,
    );
    expect(schedule.find((s) => s.monthKey === "2025-01")!.amount).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// 2x/week subject — fixedCount = 8
// ---------------------------------------------------------------------------

describe("generateSessionBasedSchedule — 2x/week subject (fixedCount = 8)", () => {
  // January 2025 Mondays: 6, 13, 20, 27. Thursdays: 2, 9, 16, 23, 30 → 9 total.
  const MON_THU_CTX = makeCtx({ scheduledDaysOfWeek: [1, 4] });
  const PRICE_2X = 800; // perSession = 100

  it("computes fixedCount = 8 for two scheduled days", () => {
    expect(getFixedSessionCount(MON_THU_CTX)).toBe(8);
    expect(getFixedSessionCount(WED_CTX)).toBe(4);
  });

  it("charges 50% when 4 of 8 sessions remain (4/8)", () => {
    // Exclusive window: join Jan 18 (Sat) → sessions strictly after it are
    // Mon 20, 27 + Thu 23, 30 = 4 remain.
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 18),
      new Date(2025, 2, 15),
      MON_THU_CTX,
      PRICE_2X,
    );
    const jan = schedule.find((s) => s.monthKey === "2025-01");
    expect(jan!.amount).toBe(400); // 4 × 100
  });

  it("caps a 9-occurrence month at 8 (full price)", () => {
    // Joining Jan 1 (Wednesday, but sessions are Mon+Thu): occurrences from
    // Jan 1..31 = 9 (5 Thu + 4 Mon) → capped at 8 → 800.
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 1),
      new Date(2025, 1, 15),
      MON_THU_CTX,
      PRICE_2X,
    );
    expect(schedule.find((s) => s.monthKey === "2025-01")!.amount).toBe(800);
  });

  it("charges nothing when only 1 session remains in the join month", () => {
    // Exclusive window: joining Jan 29 (Wed) → only Thu 30 remains →
    // billable 1 → FREE (Rule 4 still applies under the new window).
    const schedule = generateSessionBasedSchedule(
      new Date(2025, 0, 29),
      new Date(2025, 1, 15),
      MON_THU_CTX,
      PRICE_2X,
    );
    expect(schedule.find((s) => s.monthKey === "2025-01")).toBeUndefined();
    expect(schedule.find((s) => s.monthKey === "2025-02")!.amount).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// computeExpectedMonthAmount
// ---------------------------------------------------------------------------

describe("computeExpectedMonthAmount", () => {
  it("matches the schedule for a full-month join", () => {
    expect(
      computeExpectedMonthAmount(new Date(2025, 0, 1), "2025-01", WED_CTX, PRICE),
    ).toBe(400);
  });

  it("prorates a mid-month join", () => {
    // Exclusive window: join Jan 21 (Tue) → 22, 29 remain = 2 sessions.
    expect(
      computeExpectedMonthAmount(new Date(2025, 0, 21), "2025-01", WED_CTX, PRICE),
    ).toBe(200);
  });

  it("returns null for the join month with a single session left", () => {
    // Join Jan 28 (Tue) → only Jan 29 remains → free.
    expect(
      computeExpectedMonthAmount(new Date(2025, 0, 28), "2025-01", WED_CTX, PRICE),
    ).toBeNull();
  });

  it("returns null for months before enrollment", () => {
    expect(
      computeExpectedMonthAmount(new Date(2025, 2, 1), "2025-01", WED_CTX, PRICE),
    ).toBeNull();
  });

  it("returns null for a subject with no timetable", () => {
    expect(
      computeExpectedMonthAmount(
        new Date(2025, 0, 1),
        "2025-01",
        makeCtx({ hasSession: false, scheduledDaysOfWeek: [] }),
        PRICE,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule B — 2Bac s.x Small rolling cycle
// ---------------------------------------------------------------------------

describe("Rule B — 2Bac s.x Small", () => {
  it("keeps Math/PC/SVT 2Bac s.x Small on the rolling Rule B cycle", () => {
    expect(getPaymentRuleFor("2Bac", "Math", "Small", "s.x")).toBe("B");
    expect(getPaymentRuleFor("2Bac", "PC", "Small", "s.x")).toBe("B");
    expect(getPaymentRuleFor("2Bac", "SVT", "Small", "s.x")).toBe("B");
  });

  it("keeps other combos on Rule A (session-based)", () => {
    expect(getPaymentRuleFor("2Bac", "Math", "Small", "s.m")).toBe("A");
    expect(getPaymentRuleFor("2Bac", "Math", "Large", "s.x")).toBe("A");
    expect(getPaymentRuleFor("T.C", "Math", "Large", null)).toBe("A");
  });

  it("bills the full price on the join day and every month on the same day", () => {
    const schedule = generateRuleBSchedule(
      new Date(2025, 0, 12), // joins Jan 12
      new Date(2025, 3, 15),
      500,
    );
    expect(schedule).toHaveLength(4); // Jan 12, Feb 12, Mar 12, Apr 12
    expect(schedule.map((s) => s.dueDate)).toEqual([
      "2025-01-12",
      "2025-02-12",
      "2025-03-12",
      "2025-04-12",
    ]);
    expect(schedule.every((s) => s.amount === 500)).toBe(true);
  });

  it("generateScheduleFor routes Rule A vs Rule B", () => {
    const ruleA = generateScheduleFor(
      "A",
      new Date(2025, 0, 21), // join Jan 21 (Tue) → 22, 29 remain
      new Date(2025, 1, 15),
      WED_CTX,
      PRICE,
    );
    expect(ruleA.find((s) => s.monthKey === "2025-01")!.amount).toBe(200);

    const ruleB = generateScheduleFor(
      "B",
      new Date(2025, 0, 12),
      new Date(2025, 1, 15),
      WED_CTX,
      PRICE,
    );
    expect(ruleB.map((s) => s.dueDate)).toContain("2025-02-12");
  });
});

// ---------------------------------------------------------------------------
// buildDeliveredDatesContext — one_off sessions are free, combos are matched
// ---------------------------------------------------------------------------

describe("buildDeliveredDatesContext", () => {
  it("collects standard recurring days and ignores one_off sessions", () => {
    const sessions: Session[] = [
      makeRecurringSession("Math", "T.C", null, "Large", 3),
      {
        ...makeRecurringSession("Math", "T.C", null, "Large", 5),
        kind: "one_off" as const,
        date: "2025-01-10",
      },
    ];
    const ctx = buildDeliveredDatesContext(sessions, [], {
      level: "T.C",
      subject: "Math",
      track: null,
      groupType: "Large",
    }, new Date(2025, 0, 1));
    expect(ctx.hasSession).toBe(true);
    expect(ctx.scheduledDaysOfWeek).toEqual([3]); // one_off excluded
    expect(getFixedSessionCount(ctx)).toBe(4);
  });

  it("reports no session for a combo without a timetable", () => {
    const ctx = buildDeliveredDatesContext(
      [makeRecurringSession("PC", "T.C", null, "Large", 3)],
      [],
      { level: "T.C", subject: "Math", track: null, groupType: "Large" },
      new Date(2025, 0, 1),
    );
    expect(ctx.hasSession).toBe(false);
    expect(ctx.scheduledDaysOfWeek).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reconcilePaymentAmounts — daily self-heal
// ---------------------------------------------------------------------------

describe("reconcilePaymentAmounts", () => {
  const sessions = [makeRecurringSession("Math", "T.C", null, "Large", 3)];
  const prices: PriceEntry[] = [
    {
      id: "price-1",
      level: "T.C",
      subject: "Math",
      track: null,
      groupType: "Large",
      price: PRICE,
    },
  ];

  function ledgerStudent(customPrice?: number): Student {
    const enrollment: SubjectEnrollment = {
      subject: "Math",
      track: null,
      groupType: "Large",
      enrolledAt: `2025-01-01${NOON}`,
    };
    if (customPrice !== undefined) enrollment.customPrice = customPrice;
    return makeStudent({
      level: "T.C",
      enrollments: [enrollment],
    });
  }

  it("corrects a stale Rule A amount and clears a false isPaid", () => {
    // Full-month join should be 400; the frozen row still says 320 (stale)
    // and is marked paid with 320 paid — the new amountDue 400 is not covered.
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 320, 320, true),
    ];
    const patches = reconcilePaymentAmounts(payments, [ledgerStudent()], sessions, prices);
    expect(patches).toHaveLength(1);
    expect(patches[0].id).toBe("p1");
    expect(patches[0].amountDue).toBe(400);
    expect(patches[0].isPaid).toBe(false); // 320 < 400
  });

  it("keeps isPaid = true only when amountPaid covers the new amount", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 320, 400, true),
    ];
    const patches = reconcilePaymentAmounts(payments, [ledgerStudent()], sessions, prices);
    expect(patches[0].amountDue).toBe(400);
    expect(patches[0].isPaid).toBe(true); // 400 >= 400
  });

  it("leaves correct rows untouched", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 400, 0, false),
    ];
    expect(
      reconcilePaymentAmounts(payments, [ledgerStudent()], sessions, prices),
    ).toHaveLength(0);
  });

  it("never touches Rule B rows", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 999, 0, false, "B"),
    ];
    expect(
      reconcilePaymentAmounts(payments, [ledgerStudent()], sessions, prices),
    ).toHaveLength(0);
  });

  it("respects customPrice when recomputing", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 400, 0, false),
    ];
    const patches = reconcilePaymentAmounts(
      payments,
      [ledgerStudent(300)],
      sessions,
      prices,
    );
    expect(patches[0].amountDue).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// reconcileRuleALedger — authoritative self-heal (update + delete)
// ---------------------------------------------------------------------------

describe("reconcileRuleALedger", () => {
  const sessions = [makeRecurringSession("Math", "T.C", null, "Large", 3)];
  const prices: PriceEntry[] = [
    {
      id: "price-1",
      level: "T.C",
      subject: "Math",
      track: null,
      groupType: "Large",
      price: PRICE,
    },
  ];

  function ledgerStudent(enrolledAt = `2025-01-01${NOON}`): Student {
    const enrollment: SubjectEnrollment = {
      subject: "Math",
      track: null,
      groupType: "Large",
      enrolledAt,
    };
    return makeStudent({ level: "T.C", enrollments: [enrollment] });
  }

  it("reports a stale Rule A amount as an update (paid progress preserved)", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 320, 150, false),
    ];
    const result = reconcileRuleALedger(payments, [ledgerStudent()], sessions, prices);
    expect(result.delete).toEqual([]);
    expect(result.update).toEqual([
      { id: "p1", amountDue: 400, isPaid: false }, // 150 < 400
    ]);
  });

  it("reports a correct row as untouched", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 400, 400, true),
    ];
    const result = reconcileRuleALedger(payments, [ledgerStudent()], sessions, prices);
    expect(result.update).toEqual([]);
    expect(result.delete).toEqual([]);
  });

  it("deletes a row whose month is no longer billable (timetable removed)", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 400, 0, false),
    ];
    const result = reconcileRuleALedger(
      payments,
      [ledgerStudent()],
      [], // no sessions → no timetable
      prices,
    );
    expect(result.update).toEqual([]);
    expect(result.delete).toEqual(["p1"]);
  });

  it("deletes a row whose enrollment was dropped", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 400, 0, false),
    ];
    const studentWithNoEnrollments = makeStudent({
      level: "T.C",
      enrollments: [],
    });
    const result = reconcileRuleALedger(
      payments,
      [studentWithNoEnrollments],
      sessions,
      prices,
    );
    expect(result.delete).toEqual(["p1"]);
  });

  it("deletes a row whose price no longer resolves", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 400, 0, false),
    ];
    const result = reconcileRuleALedger(payments, [ledgerStudent()], sessions, []);
    expect(result.delete).toEqual(["p1"]);
  });

  it("deletes a row predating enrollment", () => {
    // Enrolled Jan 15; a leftover row for December (before enrollment at
    // all) must be deleted — the engine emits nothing for it.
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2024-12-01", 400, 0, false),
    ];
    const result = reconcileRuleALedger(
      payments,
      [ledgerStudent(`2025-01-15${NOON}`)],
      sessions,
      prices,
    );
    expect(result.delete).toEqual(["p1"]);
  });

  it("deletes an orphan row whose student no longer exists", () => {
    const payments: Payment[] = [
      makePayment("p1", "ghost", "Math", "2025-01-01", 400, 0, false),
    ];
    const result = reconcileRuleALedger(payments, [ledgerStudent()], sessions, prices);
    expect(result.delete).toEqual(["p1"]);
  });

  it("never touches Rule B rows, even stale ones", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-01", 999, 0, false, "B"),
    ];
    const result = reconcileRuleALedger(payments, [ledgerStudent()], [], []);
    expect(result.update).toEqual([]);
    expect(result.delete).toEqual([]);
  });

  it("updates a mid-month-join row to the prorated amount", () => {
    // Joined Jan 15 (Wednesday) — the 15th session itself is excluded, so
    // only 22 + 29 remain = 2 of 4 sessions → 200, not 400.
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "Math", "2025-01-15", 400, 0, false),
    ];
    const result = reconcileRuleALedger(
      payments,
      [ledgerStudent(`2025-01-15${NOON}`)],
      sessions,
      prices,
    );
    expect(result.delete).toEqual([]);
    expect(result.update).toEqual([{ id: "p1", amountDue: 200, isPaid: false }]);
  });
});

// ---------------------------------------------------------------------------
// applyCreditWaterfall — plain dueDate-ascending gap filling
// ---------------------------------------------------------------------------

describe("applyCreditWaterfall", () => {
  it("distributes credit across current + future installments (surplus rolls forward)", () => {
    // 3 installments: 300 + 300 + 400 = 1000 of gaps; credit = 500 clears
    // p1 (300) and p2 (200 of its 300), leaving p3 untouched.
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300),
      makePayment("p2", STUDENT_ID, "PC", "2025-02-01", 300),
      makePayment("p3", STUDENT_ID, "PC", "2025-03-01", 400),
    ];

    const result = applyCreditWaterfall(payments, STUDENT_ID, "PC", 500, "2025-01-15", NOW);

    expect(result.remaining).toBe(0);
    expect(result.anyChanged).toBe(true);
    expect(result.updated.find((p) => p.id === "p1")!.amountPaid).toBe(300);
    expect(isPaymentFullyPaid(result.updated.find((p) => p.id === "p1")!)).toBe(true);
    expect(result.updated.find((p) => p.id === "p2")!.amountPaid).toBe(200);
    expect(isPaymentFullyPaid(result.updated.find((p) => p.id === "p2")!)).toBe(false);
    expect(result.updated.find((p) => p.id === "p3")).toBeUndefined();
  });

  it("stores surplus as remaining when credit exceeds all installment gaps", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, "PC", 700, "2025-01-15", NOW);
    expect(result.remaining).toBe(400);
    expect(isPaymentFullyPaid(result.updated[0])).toBe(true);
  });

  it("returns zero credit input unchanged", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, "PC", 0, "2025-01-15", NOW);
    expect(result.remaining).toBe(0);
    expect(result.updated).toHaveLength(0);
    expect(result.anyChanged).toBe(false);
  });

  it("handles negative / NaN credit gracefully", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, "PC", -50, "2025-01-15", NOW);
    expect(result.remaining).toBe(0);
    expect(result.updated).toHaveLength(0);
  });

  it("respects subject filter (cross-subject mode with subject=null)", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300),
      makePayment("p2", STUDENT_ID, "Math", "2025-01-01", 200),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, null, 400, "2025-01-15", NOW);
    expect(result.remaining).toBe(0);
    expect(result.updated).toHaveLength(2);
  });

  it("respects subject filter (per-subject mode only touches one subject)", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300),
      makePayment("p2", STUDENT_ID, "Math", "2025-01-01", 200),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, "PC", 400, "2025-01-15", NOW);
    expect(result.remaining).toBe(100);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe("p1");
  });

  it("sorts by dueDate ascending before applying", () => {
    const payments: Payment[] = [
      makePayment("p2", STUDENT_ID, "PC", "2025-02-01", 300),
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, "PC", 300, "2025-01-15", NOW);
    expect(result.remaining).toBe(0);
    expect(result.updated.find((p) => p.id === "p1")!.amountPaid).toBe(300);
    expect(result.updated.find((p) => p.id === "p2")).toBeUndefined();
  });

  it("skips already-fully-paid installments", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300, 300, true),
      makePayment("p2", STUDENT_ID, "PC", "2025-02-01", 300),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, "PC", 100, "2025-01-15", NOW);
    expect(result.remaining).toBe(200);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe("p2");
    expect(result.updated[0].amountPaid).toBe(100);
  });

  it("respects studentId filter", () => {
    const payments: Payment[] = [
      makePayment("p1", STUDENT_ID, "PC", "2025-01-01", 300),
      makePayment("p2", "other-student", "PC", "2025-01-01", 300),
    ];
    const result = applyCreditWaterfall(payments, STUDENT_ID, "PC", 300, "2025-01-15", NOW);
    expect(result.remaining).toBe(0);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe("p1");
  });
});

// ---------------------------------------------------------------------------
// Spec regression — T.C Math 350 DH · Mardi+Jeudi 19:00 · enrolled 2026-09-15
// ---------------------------------------------------------------------------
// Sept 2026: 2026-09-01 is a Tuesday → Tuesdays 1, 8, 15, 22, 29 (5) +
// Thursdays 3, 10, 17, 24 (4). fixedCount = 4 × 2 = 8,
// perSession = 350 / 8 = 43.75.
// The enrollment-date session (Tue 15) is NOT billable → sessions strictly
// after 15/09 = Thu 17, Tue 22, Thu 24, Tue 29 = 4 → 4 × 43.75 = 175 DH.
// (Buggy inclusive counting gave 5 sessions = 219 DH.)

describe("Spec regression — T.C Math 350 DH · Tue+Thu · enrolled 2026-09-15", () => {
  const TUE_THU_CTX = makeCtx({ scheduledDaysOfWeek: [2, 4] }); // Mardi + Jeudi
  const PRICE_350 = 350;
  const ENROLLED = new Date(2026, 8, 15); // 2026-09-15 (Tuesday)
  const SPEC_NOW = "2026-11-15T12:00:00.000Z";

  it("bills Sept 2026 at 175 DH (4 sessions × 43.75), due on the join date", () => {
    expect(getFixedSessionCount(TUE_THU_CTX)).toBe(8);
    const schedule = generateSessionBasedSchedule(
      ENROLLED,
      new Date(2026, 10, 15), // through Nov 2026
      TUE_THU_CTX,
      PRICE_350,
    );
    const sept = schedule.find((s) => s.monthKey === "2026-09");
    expect(sept).toBeDefined();
    expect(sept!.amount).toBe(175);
    expect(sept!.dueDate).toBe("2026-09-15");
  });

  it("bills Oct 2026 at the full 350 DH (9 occurrences capped at 8), due on the 1st", () => {
    const schedule = generateSessionBasedSchedule(
      ENROLLED,
      new Date(2026, 10, 15),
      TUE_THU_CTX,
      PRICE_350,
    );
    const oct = schedule.find((s) => s.monthKey === "2026-10");
    expect(oct).toBeDefined();
    expect(oct!.amount).toBe(350);
    expect(oct!.dueDate).toBe("2026-10-01");
  });

  it("resumes 350 DH on the 1st of each following month", () => {
    const schedule = generateSessionBasedSchedule(
      ENROLLED,
      new Date(2026, 10, 15),
      TUE_THU_CTX,
      PRICE_350,
    );
    const nov = schedule.find((s) => s.monthKey === "2026-11");
    expect(nov).toBeDefined();
    expect(nov!.amount).toBe(350);
    expect(nov!.dueDate).toBe("2026-11-01");
  });

  it("computeExpectedMonthAmount(\"2026-09\") = 175", () => {
    expect(
      computeExpectedMonthAmount(ENROLLED, "2026-09", TUE_THU_CTX, PRICE_350),
    ).toBe(175);
    expect(
      computeExpectedMonthAmount(ENROLLED, "2026-10", TUE_THU_CTX, PRICE_350),
    ).toBe(350);
  });

  it("charges nothing when joining on 24/09 (Thu) — only the 29/09 session remains", () => {
    // Rule 4 still applies under the exclusive window.
    const schedule = generateSessionBasedSchedule(
      new Date(2026, 8, 24),
      new Date(2026, 10, 15),
      TUE_THU_CTX,
      PRICE_350,
    );
    expect(schedule.find((s) => s.monthKey === "2026-09")).toBeUndefined();
    expect(schedule.find((s) => s.monthKey === "2026-10")!.amount).toBe(350);
  });

  it("settles Sept and pre-pays half of Oct when 350 DH is paid at registration", () => {
    // applyInitialTuitionPayment generates Sept (175, due 15/09) + Oct (350,
    // due 01/10) + Nov (350, due 01/11), then runs applyCreditWaterfall(350).
    const payments: Payment[] = [
      makePayment("sept", STUDENT_ID, "Math", "2026-09-15", 175),
      makePayment("oct", STUDENT_ID, "Math", "2026-10-01", 350),
      makePayment("nov", STUDENT_ID, "Math", "2026-11-01", 350),
    ];

    const result = applyCreditWaterfall(
      payments,
      STUDENT_ID,
      null, // cross-subject mode (creation-time waterfall)
      350,
      "2026-09-15",
      SPEC_NOW,
    );

    // Sept absorbs 175 → fully paid / green.
    const sept = result.updated.find((p) => p.id === "sept");
    expect(sept).toBeDefined();
    expect(sept!.amountPaid).toBe(175);
    expect(isPaymentFullyPaid(sept!)).toBe(true);

    // Oct absorbs the 175 surplus → 175 paid so far, still due 175.
    const oct = result.updated.find((p) => p.id === "oct");
    expect(oct).toBeDefined();
    expect(oct!.amountPaid).toBe(175);
    expect(oct!.amountDue).toBe(350);
    expect(isPaymentFullyPaid(oct!)).toBe(false);

    // Nov untouched, and no orphan credit → advanceBalance stays 0.
    expect(result.updated.find((p) => p.id === "nov")).toBeUndefined();
    expect(result.remaining).toBe(0);
  });

  it("fully pays Oct with a follow-up 175 DH partial payment on 15/10", () => {
    const payments: Payment[] = [
      makePayment("sept", STUDENT_ID, "Math", "2026-09-15", 175, 175, true),
      makePayment("oct", STUDENT_ID, "Math", "2026-10-01", 350, 175, false),
      makePayment("nov", STUDENT_ID, "Math", "2026-11-01", 350),
    ];

    const result = applyCreditWaterfall(
      payments,
      STUDENT_ID,
      "Math",
      175,
      "2026-10-15",
      SPEC_NOW,
    );

    const oct = result.updated.find((p) => p.id === "oct");
    expect(oct).toBeDefined();
    expect(oct!.amountPaid).toBe(350); // 175 + 175 = 350
    expect(isPaymentFullyPaid(oct!)).toBe(true);
    expect(result.remaining).toBe(0); // nothing left over
    expect(result.updated.find((p) => p.id === "nov")).toBeUndefined();
  });
});
