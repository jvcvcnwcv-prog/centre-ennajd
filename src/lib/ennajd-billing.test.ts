// Unit tests for the advance-credit waterfall.
// Run with: npx vitest run src/lib/ennajd-billing.test.ts

import { describe, it, expect } from "vitest";
import { applyCreditWaterfall, isPaymentFullyPaid } from "./ennajd-billing";
import type { Payment, Subject } from "../types/ennajd";

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
