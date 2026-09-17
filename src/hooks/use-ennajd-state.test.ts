// Reactive ledger tests — the markAttendance → recalculatePaymentsForStudentSubject
// wiring. The persistence layer (Supabase doc writes) and toasts are mocked so
// these exercise the store's reactive contract, not the network.
//
// Run with: npx vitest run src/hooks/use-ennajd-state.test.ts

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPaymentFullyPaid } from "../lib/ennajd-billing";
import { useEnnajdState } from "./use-ennajd-state";
import type {
  AttendanceRecord,
  Payment,
  PriceEntry,
  Session,
  Student,
} from "../types/ennajd";

// Fixed clock so the "now + 1 month" generation horizon is deterministic.
const NOW = "2026-11-15T12:00:00";
const TODAY_KEY = "2026-11-15";

const STUDENT_ID = "student-1";
const STUDENT: Student = {
  id: STUDENT_ID,
  firstName: "Aicha",
  lastName: "Bennani",
  whatsappPhone: "",
  parentPhone: "",
  level: "T.C",
  track: null,
  enrollments: [
    { subject: "Math", track: null, groupType: "Large", enrolledAt: "2026-09-15T12:00:00.000Z" },
  ],
  createdAt: "2025-01-01T00:00:00.000Z",
  advanceBalance: 0,
};

// Tue + Thu recurring Math slots for T.C Large (8 sessions/month → perSession
// = 350 / 8 = 43.75).
const SESSIONS: Session[] = [
  {
    id: "session-math-tue",
    subject: "Math",
    level: "T.C",
    track: null,
    groupType: "Large",
    dayOfWeek: 2,
    startTime: "16:00",
    endTime: "18:00",
    kind: "recurring",
    date: null,
  },
  {
    id: "session-math-thu",
    subject: "Math",
    level: "T.C",
    track: null,
    groupType: "Large",
    dayOfWeek: 4,
    startTime: "16:00",
    endTime: "18:00",
    kind: "recurring",
    date: null,
  },
];

const PRICES: PriceEntry[] = [
  {
    id: "price-math-tc",
    level: "T.C",
    subject: "Math",
    track: null,
    groupType: "Large",
    price: 350,
  },
];

// Shared mock state — lets a single test flip a doc write to a rejection.
const mockState = vi.hoisted(() => ({
  failNextPaymentBatch: false,
}));

vi.mock("@/lib/dbServices", () => ({
  addStudentDoc: vi.fn().mockResolvedValue(undefined),
  updateStudentDoc: vi.fn().mockResolvedValue(undefined),
  updateStudentAdvanceBalanceDoc: vi.fn().mockResolvedValue(undefined),
  deleteStudentDoc: vi.fn().mockResolvedValue(undefined),
  addSessionDoc: vi.fn().mockResolvedValue(undefined),
  updateSessionDoc: vi.fn().mockResolvedValue(undefined),
  deleteSessionDoc: vi.fn().mockResolvedValue(undefined),
  setPriceDoc: vi.fn().mockResolvedValue(undefined),
  markAttendanceDoc: vi.fn().mockResolvedValue(undefined),
  upsertAttendanceBatchDoc: vi.fn().mockResolvedValue(undefined),
  upsertPaymentDoc: vi.fn().mockResolvedValue(undefined),
  upsertPaymentsBatchDoc: vi.fn().mockImplementation(() =>
    mockState.failNextPaymentBatch
      ? Promise.reject(new Error("simulated offline failure"))
      : Promise.resolve(undefined),
  ),
  updatePaymentsBatchDoc: vi.fn().mockResolvedValue(undefined),
  deletePaymentsBatchDoc: vi.fn().mockResolvedValue(undefined),
  upsertMessageDoc: vi.fn().mockResolvedValue(undefined),
  deleteMessageDoc: vi.fn().mockResolvedValue(undefined),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));

/** Restores the pristine pre-hydration store between tests. */
function resetStore() {
  useEnnajdState.setState({
    students: [],
    sessions: [],
    prices: [],
    attendanceRecords: [],
    payments: [],
    messages: [],
    lastPaymentsSyncDateKey: null,
    hasSyncedPayments: false,
    hasSyncedStudents: false,
    hasSyncedSessions: false,
  });
  mockState.failNextPaymentBatch = false;
  toast.success.mockClear();
  toast.warning.mockClear();
  toast.error.mockClear();
}

/**
 * Seeds a hydrated Rule A ledger: student + timetable + price, and the
 * installments a pre-mark sync would have built off the ENROLLMENT anchor
 * (Sept = 219 for the 15/09 joiner). `hasSyncedPayments` is on and the daily
 * sync key is already today — so a recalc that moves the ledger proves it
 * bypassed the daily throttle.
 */
function seedRuleALedger(payments: Payment[]) {
  resetStore();
  useEnnajdState.setState({
    students: [STUDENT],
    sessions: SESSIONS,
    prices: PRICES,
    payments,
    hasSyncedPayments: true,
    lastPaymentsSyncDateKey: TODAY_KEY,
  });
}

function payment(
  id: string,
  dueDate: string,
  amountDue: number,
  rule: Payment["rule"] = "A",
  amountPaid = 0,
): Payment {
  return {
    id,
    studentId: STUDENT_ID,
    subject: "Math",
    dueDate,
    month: dueDate.slice(0, 7),
    isPaid: amountPaid >= amountDue,
    amountDue,
    amountPaid,
    isHalfMonth: false,
    rule,
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
}

/** The recalc is queued on a microtask and awaits internal work (the forced
 *  sync + its own batch writes), so let the microtask queue drain plenty of
 *  turns before asserting. */
async function flushReactive() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

/** One row per (month), latest state wins — robust to id churn from the
 *  dueDate-reanchoring dedupe. */
function ledgerByMonth(): Map<string, Payment> {
  return new Map(useEnnajdState.getState().payments.map((p) => [p.month, p]));
}

/** Every payment id handed to `deletePaymentsBatchDoc` so far in this test. */
async function deletePaymentsBatchDocIds(): Promise<string[]> {
  const db = await import("@/lib/dbServices");
  const calls = vi.mocked(db.deletePaymentsBatchDoc).mock.calls as unknown as string[][];
  return calls.flat();
}

describe("reactive ledger — markAttendance trigger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetStore();
  });

  it("re-bills Sept from a pre-registration attendance mark", async () => {
    // No attendance yet → ledger sits on the 15/09 enrollment anchor: Sept
    // 219 (5 × 43.75), Oct/Nov full 350.
    seedRuleALedger([
      payment("sept", "2026-09-15", 219),
      payment("oct", "2026-10-01", 350),
      payment("nov", "2026-11-01", 350),
    ]);

    const ok = await useEnnajdState
      .getState()
      .markAttendance(STUDENT_ID, "session-math-thu", "2026-09-10", "present");
    expect(ok).toBe(true);
    await flushReactive();

    // The 10/09 mark predates registration but is INCLUSIVE — Sept re-bills
    // to 6 × 43.75 = 263 and is re-dated onto the anchor.
    const ledger = ledgerByMonth();
    expect(ledger.get("2026-09")!.amountDue).toBe(263);
    expect(ledger.get("2026-09")!.dueDate).toBe("2026-09-10");
    expect(ledger.get("2026-10")!.amountDue).toBe(350);
  });

  it("keeps exactly one installment per month after re-anchoring", async () => {
    seedRuleALedger([
      payment("sept", "2026-09-15", 219),
      payment("oct", "2026-10-01", 350),
    ]);

    await useEnnajdState
      .getState()
      .markAttendance(STUDENT_ID, "session-math-thu", "2026-09-10", "present");
    await flushReactive();

    const months = useEnnajdState.getState().payments.map((p) => p.month);
    const counts = new Map<string, number>();
    for (const m of months) counts.set(m, (counts.get(m) ?? 0) + 1);
    for (const [month, count] of counts) expect(count).toBe(1);
    expect(counts.get("2026-09")).toBe(1);
  });

  it("cascades a settled installment's surplus into the following months", async () => {
    // Sept over-charged 350 and settled on the enrollment anchor; a 17/09
    // attendance mark drops Sept to 175 → the 175 surplus rolls onto Oct.
    seedRuleALedger([
      payment("sept", "2026-09-15", 350, "A", 350),
      payment("oct", "2026-10-01", 350),
    ]);

    await useEnnajdState
      .getState()
      .markAttendance(STUDENT_ID, "session-math-thu", "2026-09-17", "present");
    await flushReactive();

    const ledger = ledgerByMonth();
    expect(ledger.get("2026-09")!.amountDue).toBe(175);
    expect(ledger.get("2026-09")!.amountPaid).toBe(175);
    expect(ledger.get("2026-10")!.amountPaid).toBe(175); // surplus forwarded
  });

  it("confirms the recalc with a toast naming the student", async () => {
    // Over-charged settled Sept: the forced sync re-anchors Sept to 175 and
    // leaves the 175 surplus on the row, and the recalc then cascades that
    // surplus onto Oct — real ledger work the toast confirms.
    seedRuleALedger([
      payment("sept", "2026-09-15", 350, "A", 350),
      payment("oct", "2026-10-01", 350),
    ]);

    await useEnnajdState
      .getState()
      .markAttendance(STUDENT_ID, "session-math-thu", "2026-09-17", "present");
    await flushReactive();

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("Aicha"),
    );
  });

  it("is idempotent — a second mark of the same date moves nothing", async () => {
    seedRuleALedger([payment("sept", "2026-09-15", 219)]);

    const store = useEnnajdState.getState();
    await store.markAttendance(STUDENT_ID, "session-math-thu", "2026-09-10", "present");
    await flushReactive();
    const afterFirst = ledgerByMonth().get("2026-09")!.amountDue;
    expect(afterFirst).toBe(263);

    toast.success.mockClear();
    // Same student+session+date → the existing record is replaced, the anchor
    // is unchanged, so the ledger must not move again.
    await useEnnajdState
      .getState()
      .markAttendance(STUDENT_ID, "session-math-thu", "2026-09-10", "present", {
        isManualOverride: true,
      });
    await flushReactive();

    expect(ledgerByMonth().get("2026-09")!.amountDue).toBe(263);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("deletes stale rows BEFORE upserting rebuilt ones (unique-constraint safe)", async () => {
    // Two rows share the Sept month; the 10/09 mark re-anchors Sept onto a
    // new dueDate. The collapse must delete the surplus row BEFORE the
    // re-dated survivor is upserted, or the unique(student, subject,
    // due_date) index would reject the whole batch.
    seedRuleALedger([
      payment("sept", "2026-09-15", 219),
      payment("sept-dup", "2026-09-17", 100),
      payment("oct", "2026-10-01", 350),
      payment("nov", "2026-11-01", 350),
    ]);

    // The db mocks accumulate calls across this file's tests — clear so
    // every order number below belongs to THIS mark's write path.
    vi.clearAllMocks();

    await useEnnajdState
      .getState()
      .markAttendance(STUDENT_ID, "session-math-thu", "2026-09-10", "present");
    await flushReactive();

    const db = await import("@/lib/dbServices");
    const deleteOrders = vi.mocked(db.deletePaymentsBatchDoc).mock.invocationCallOrder;
    const upsertOrders = vi.mocked(db.upsertPaymentsBatchDoc).mock.invocationCallOrder;
    expect(deleteOrders.length).toBeGreaterThan(0);
    expect(upsertOrders.length).toBeGreaterThan(0);
    // EVERY delete lands before EVERY upsert (the collapse in the forced
    // sync, and the reactive recalc's own rebuild, both write in this order).
    const lastDelete = Math.max(...deleteOrders);
    const firstUpsert = Math.min(...upsertOrders);
    expect(lastDelete).toBeLessThan(firstUpsert);

    // The surplus Sept row is gone...
    expect(await deletePaymentsBatchDocIds()).toContain("sept-dup");
    // ...and exactly one row per month survived.
    const months = useEnnajdState.getState().payments.map((p) => p.month);
    const counts = new Map<string, number>();
    for (const m of months) counts.set(m, (counts.get(m) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBe(1);
  });

  it("never blocks on a persistence failure (warning toast, kept attendance)", async () => {
    seedRuleALedger([payment("sept", "2026-09-15", 219)]);
    mockState.failNextPaymentBatch = true;

    const ok = await useEnnajdState
      .getState()
      .markAttendance(STUDENT_ID, "session-math-thu", "2026-09-10", "present");
    await flushReactive();

    // The attendance write itself landed and stays recorded...
    expect(ok).toBe(true);
    const records: AttendanceRecord[] =
      useEnnajdState.getState().attendanceRecords;
    expect(records).toHaveLength(1);
    expect(records[0].date).toBe("2026-09-10");
    // ...and the recalc failure surfaced as a warning, never an error throw.
    expect(toast.warning).toHaveBeenCalled();
  });

  it("leaves a Rule B (2Bac s.x Small) ledger on its fixed schedule", async () => {
    resetStore();
    useEnnajdState.setState({
      students: [
        {
          ...STUDENT,
          id: STUDENT_ID,
          level: "2Bac",
          track: "s.x",
          enrollments: [
            {
              subject: "Math",
              track: "s.x",
              groupType: "Small",
              enrolledAt: "2026-09-15T12:00:00.000Z",
            },
          ],
        },
      ],
      sessions: [
        {
          id: "session-math-2bac",
          subject: "Math",
          level: "2Bac",
          track: "s.x",
          groupType: "Small",
          dayOfWeek: 2,
          startTime: "16:00",
          endTime: "18:00",
          kind: "recurring",
          date: null,
        },
      ],
      prices: [
        {
          id: "price-math-2bac",
          level: "2Bac",
          subject: "Math",
          track: "s.x",
          groupType: "Small",
          price: 500,
        },
      ],
      // The full Rule B rolling cycle through the generation horizon
      // (now + 1 month) already exists, so generation is a no-op and the
      // only thing that could move the ledger is the recalc.
      payments: [
        payment("b-sept", "2026-09-15", 500, "B"),
        payment("b-oct", "2026-10-15", 500, "B"),
        payment("b-nov", "2026-11-15", 500, "B"),
        payment("b-dec", "2026-12-15", 500, "B"),
      ],
      hasSyncedPayments: true,
      lastPaymentsSyncDateKey: TODAY_KEY,
    });

    await useEnnajdState
      .getState()
      .markAttendance(STUDENT_ID, "session-math-2bac", "2026-09-01", "present");
    await flushReactive();

    const payments = useEnnajdState.getState().payments;
    expect(payments).toHaveLength(4);
    expect(payments.every((p) => p.rule === "B")).toBe(true);
    expect(payments.map((p) => p.amountDue)).toEqual([500, 500, 500, 500]);
    expect(payments.map((p) => p.dueDate)).toEqual([
      "2026-09-15",
      "2026-10-15",
      "2026-11-15",
      "2026-12-15",
    ]);
    // Nothing moved, so no confirmation toast.
    expect(toast.success).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------//
// regeneratePaymentLedger — the manual "recalculate installments" button.
// ---------------------------------------------------------------------------//

describe("regeneratePaymentLedger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetStore();
    // The db mocks accumulate calls across this file's tests — clear them so
    // this block can assert exact call counts and call ORDER.
    vi.clearAllMocks();
  });

  it("rebuilds Rule A, keeps Rule B, and deletes before inserting", async () => {
    seedRuleALedger([
      payment("sept", "2026-09-15", 219),
      payment("oct", "2026-10-01", 350),
      payment("ruleB", "2026-10-15", 500, "B"),
    ]);

    const ok = await useEnnajdState.getState().regeneratePaymentLedger();
    expect(ok).toBe(true);

    const db = await import("@/lib/dbServices");
    const deleteCalls = vi.mocked(db.deletePaymentsBatchDoc).mock.calls;
    const upsertCalls = vi.mocked(db.upsertPaymentsBatchDoc).mock.calls;

    // Every Rule A row is deleted before the rebuild is inserted.
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toEqual(["sept", "oct"]);
    expect(upsertCalls).toHaveLength(1);
    expect(
      vi.mocked(db.deletePaymentsBatchDoc).mock.invocationCallOrder[0]!,
    ).toBeLessThan(
      vi.mocked(db.upsertPaymentsBatchDoc).mock.invocationCallOrder[0]!,
    );

    // DB constraints guarded on the shipped rows: one row per natural key,
    // and every amountDue strictly positive (check (amount_due > 0)).
    const keys = new Set<string>();
    for (const p of upsertCalls[0][0]) {
      expect(p.amountDue).toBeGreaterThan(0);
      const key = `${p.studentId}__${p.subject}__${p.dueDate}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }

    // Rule B is never part of the rebuild nor deleted.
    expect(upsertCalls[0][0].find((p) => p.id === "ruleB")).toBeUndefined();
    expect(useEnnajdState.getState().payments.filter((p) => p.rule === "B"))
      .toHaveLength(1);
  });

  it("rolls back and surfaces the real DB error when the write fails", async () => {
    seedRuleALedger([payment("sept", "2026-09-15", 219)]);
    mockState.failNextPaymentBatch = true;

    const ok = await useEnnajdState.getState().regeneratePaymentLedger();
    expect(ok).toBe(false);

    // The toast carries the actual failure reason, not a generic message.
    expect(toast.error).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        description: expect.stringContaining("simulated offline failure"),
      }),
    );
    // The local ledger is rolled back to its pre-rebuild state.
    expect(useEnnajdState.getState().payments.map((p) => p.id)).toEqual([
      "sept",
    ]);
  });
});

// ---------------------------------------------------------------------------//
// recordPartialPayment — the wallet waterfall lands surplus on the NEXT month's
// gap, not on a duplicate of the same month.
// ---------------------------------------------------------------------------//

describe("recordPartialPayment — waterfall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetStore();
    vi.clearAllMocks();
  });

  it("absorbs a 350 payment as Sept 175 + Oct 175, one row per month", async () => {
    // The September amount is 175 (a 17/09 joiner, 4 sessions × 43.75). A
    // 350 payment fills Sept entirely and lands the 175 surplus on October's
    // gap — never on a second September row.
    seedRuleALedger([
      payment("sept", "2026-09-17", 175),
      payment("oct", "2026-10-01", 350),
      payment("nov", "2026-11-01", 350),
    ]);

    await useEnnajdState
      .getState()
      .recordPartialPayment(STUDENT_ID, "Math", 350, new Date("2026-10-15T12:00:00"));

    const ledger = ledgerByMonth();
    expect(ledger.get("2026-09")!.amountPaid).toBe(175);
    expect(isPaymentFullyPaid(ledger.get("2026-09")!)).toBe(true);
    expect(ledger.get("2026-10")!.amountPaid).toBe(175);
    expect(ledger.get("2026-10")!.amountDue).toBe(350);
    expect(ledger.get("2026-10")!.isPaid).toBe(false);
    // November untouched — the waterfall stops when the credit runs out.
    expect(ledger.get("2026-11")!.amountPaid).toBe(0);

    // Exactly one row per month — the waterfall never mints a duplicate.
    const months = useEnnajdState.getState().payments.map((p) => p.month);
    const counts = new Map<string, number>();
    for (const m of months) counts.set(m, (counts.get(m) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBe(1);

    // The surplus was absorbed, so nothing was parked in advanceBalance.
    expect(
      useEnnajdState.getState().students.find((s) => s.id === STUDENT_ID)!
        .advanceBalance ?? 0,
    ).toBe(0);
  });
});

