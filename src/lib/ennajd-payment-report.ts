// Payments matrix builder for the Report Generator — pivots a resolved
// session's Payment rows into a student × academic-month grid, with a
// Total-paid footer row and a visual "discounted" flag. Reads already-
// frozen `amountDue`/`isHalfMonth` values as-is (never recomputes pricing)
// — Takhfid (custom pricing) is therefore automatically correct.

import { sortStudentsAlphabetically, type AcademicMonth } from "@/lib/ennajd-report-shared";
import type { Payment, Student, Subject } from "@/types/ennajd";

export interface PaymentCell {
  amountDue: number;
  /** MAD actually covered (sum of amountPaid). */
  amountPaid: number;
  /** True only when the whole month is fully paid (no partial remaining). */
  isPaid: boolean;
  /** True when at least one installment is fully or partially counted as paid. */
  isPartiallyPaid: boolean;
  /** MAD still owed for this month (amountDue - amountPaid). */
  remaining: number;
  isHalfMonth: boolean;
  isDiscounted: boolean;
}

export interface PaymentMatrixRow {
  student: Student;
  cellsByMonth: Map<string, PaymentCell | null>;
}

export interface PaymentMatrix {
  months: AcademicMonth[];
  rows: PaymentMatrixRow[];
  totalsByMonth: Map<string, number>;
}

/**
 * Builds the payments matrix for one resolved session's roster.
 * `basePrice` is the level+subject+groupType base price for this exact
 * session (all students in this roster share the same group type, since
 * the roster is pinned to a single Session) — used only to flag
 * custom-discounted (Takhfid) installments, never to recompute amounts.
 */
export function buildPaymentMatrix(
  students: Student[],
  payments: Payment[],
  subject: Subject,
  months: AcademicMonth[],
  basePrice: number | undefined,
): PaymentMatrix {
  const sortedStudents = sortStudentsAlphabetically(students);

  const totalsByMonth = new Map<string, number>();
  for (const month of months) totalsByMonth.set(month.key, 0);

  const rows: PaymentMatrixRow[] = sortedStudents.map((student) => {
    const cellsByMonth = new Map<string, PaymentCell | null>();
    const studentPayments = payments.filter(
      (p) => p.studentId === student.id && p.subject === subject,
    );

    for (const month of months) {
      const monthPayments = studentPayments.filter((p) => p.month === month.key);
      if (monthPayments.length === 0) {
        cellsByMonth.set(month.key, null);
        continue;
      }

      const amountDue = monthPayments.reduce((sum, p) => sum + p.amountDue, 0);
      const amountPaid = monthPayments.reduce((sum, p) => sum + (p.amountPaid ?? 0), 0);
      const remaining = Math.max(0, amountDue - amountPaid);
      // A month is "fully paid" only when every installment is covered —
      // an amountPaid that doesn't reach amountDue keeps it unpaid.
      const isPaid = monthPayments.every(
        (p) => p.isPaid || (p.amountPaid ?? 0) >= p.amountDue,
      );
      const isPartiallyPaid = !isPaid && amountPaid > 0;
      const isHalfMonth = monthPayments.some((p) => p.isHalfMonth);
      const isDiscounted =
        basePrice !== undefined &&
        monthPayments.some((p) => {
          const expected = p.isHalfMonth ? Math.round(basePrice / 2) : basePrice;
          return p.amountDue !== expected;
        });

      cellsByMonth.set(month.key, {
        amountDue,
        amountPaid,
        isPaid,
        isPartiallyPaid,
        remaining,
        isHalfMonth,
        isDiscounted,
      });

      if (isPaid) {
        totalsByMonth.set(month.key, (totalsByMonth.get(month.key) ?? 0) + amountDue);
      } else if (isPartiallyPaid) {
        // Partial months contribute only what was actually covered, never
        // their full amount — keeps the Total-paid footer row truthful.
        totalsByMonth.set(month.key, (totalsByMonth.get(month.key) ?? 0) + amountPaid);
      }
    }

    return { student, cellsByMonth };
  });

  return { months, rows, totalsByMonth };
}