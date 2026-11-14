import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  seats,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
} from "~/db/schema";

// The vocabulary here follows GLOSSARY.md (Refund Window, Refundable Purchase,
// Pending Refund Request, Claimed Seat).

export const REFUND_WINDOW_DAYS = 14;
const WATCH_LIMIT_SECONDS = 2 * 60 * 60;
const COMPLETION_LIMIT = 0.5;

type Purchase = typeof purchases.$inferSelect;

export type RefundEligibility =
  | {
      refundable: true;
      purchase: Purchase;
      // A Refund is always the full amount paid. There are no partial Refunds.
      amount: number;
      lastDayOfRefundWindow: string;
    }
  | { refundable: false; reason: string; status: 403 | 409 };

export function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

export function getPendingRefundRequest(purchaseId: number) {
  return db
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, purchaseId),
        eq(refunds.status, RefundStatus.Pending)
      )
    )
    .get();
}

// The Refund Window is counted in whole days, not hours — someone who buys at
// 23:00 still gets the whole of their fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function hasClaimedSeat(purchaseId: number) {
  return !!db
    .select({ id: seats.id })
    .from(seats)
    .where(and(eq(seats.purchaseId, purchaseId), isNotNull(seats.claimedAt)))
    .get();
}

/**
 * Whether the Student's latest purchase of this course is a Refundable
 * Purchase. The course page and the refund route both ask this, so the rules
 * live in one place.
 */
export function checkRefundablePurchase(
  userId: number,
  courseId: number
): RefundEligibility | null {
  const purchase = getLatestPurchase(userId, courseId);

  if (!purchase) return null;

  if (getPendingRefundRequest(purchase.id)) {
    return {
      refundable: false,
      reason: "You already have a pending refund request for this purchase.",
      status: 409,
    };
  }

  // A purchase of Seats is refunded only as a whole, so a single Claimed Seat
  // makes all of it non-refundable.
  if (hasClaimedSeat(purchase.id)) {
    return {
      refundable: false,
      reason: "A seat on this purchase has been claimed, so it cannot be refunded.",
      status: 403,
    };
  }

  const purchasedDay = calendarDay(new Date(purchase.createdAt));
  const lastDay = lastDayOfRefundWindow(purchase.createdAt);
  const today = calendarDay(new Date());

  if (today < purchasedDay || today > lastDay) {
    return {
      refundable: false,
      reason: `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
      status: 403,
    };
  }

  const lessonIds = getLessonIdsForCourse(courseId);

  if (getSecondsWatched(userId, lessonIds) >= WATCH_LIMIT_SECONDS) {
    return {
      refundable: false,
      reason: "You have watched too much of this course to get a refund.",
      status: 403,
    };
  }

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      COMPLETION_LIMIT
  ) {
    return {
      refundable: false,
      reason: "You have completed too much of this course to get a refund.",
      status: 403,
    };
  }

  return {
    refundable: true,
    purchase,
    amount: purchase.amountPaid,
    lastDayOfRefundWindow: lastDay,
  };
}
