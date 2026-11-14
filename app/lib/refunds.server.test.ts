import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

const testDb = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("~/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        const target = testDb.current as object;
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }
  ),
}));

const { checkRefundablePurchase, REFUND_WINDOW_DAYS } = await import(
  "./refunds.server"
);

type Db = ReturnType<typeof createTestDb>;

function daysAgo(n: number) {
  const when = new Date();
  when.setDate(when.getDate() - n);
  return when.toISOString();
}

describe("checkRefundablePurchase", () => {
  let db: Db;
  let base: ReturnType<typeof seedBaseData>;
  let lessonIds: number[];

  beforeEach(() => {
    db = createTestDb();
    testDb.current = db;
    base = seedBaseData(db);

    const mod = db
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Module", position: 1 })
      .returning()
      .get();

    lessonIds = [1, 2, 3, 4].map(
      (position) =>
        db
          .insert(schema.lessons)
          .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
          .returning()
          .get().id
    );
  });

  function buy(amountPaid: number, createdAt = daysAgo(1)) {
    return db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid,
        country: null,
        createdAt,
      })
      .returning()
      .get();
  }

  function complete(count: number) {
    for (const lessonId of lessonIds.slice(0, count)) {
      db.insert(schema.lessonProgress)
        .values({
          userId: base.user.id,
          lessonId,
          status: schema.LessonProgressStatus.Completed,
        })
        .run();
    }
  }

  it("returns null when the Student has not bought the course", () => {
    expect(checkRefundablePurchase(base.user.id, base.course.id)).toBeNull();
  });

  it("offers the full amount paid, not the course's list price", () => {
    // Without a purchasing-power discount the old code refunded course.price,
    // which is wrong after a price change or for a purchase of several Seats.
    db.update(schema.courses).set({ price: 9900 }).run();
    buy(4900);

    const result = checkRefundablePurchase(base.user.id, base.course.id);

    expect(result).toMatchObject({ refundable: true, amount: 4900 });
  });

  it("refuses once half the lessons are completed", () => {
    buy(4900);
    complete(2);

    expect(checkRefundablePurchase(base.user.id, base.course.id)).toEqual({
      refundable: false,
      reason: "You have completed too much of this course to get a refund.",
      status: 403,
    });
  });

  it("still allows a refund just under half the lessons", () => {
    buy(4900);
    complete(1);

    expect(checkRefundablePurchase(base.user.id, base.course.id)).toMatchObject(
      { refundable: true }
    );
  });

  it("refuses after two hours watched", () => {
    buy(4900);
    db.insert(schema.videoWatchEvents)
      .values({
        userId: base.user.id,
        lessonId: lessonIds[0],
        eventType: "progress",
        positionSeconds: 2 * 60 * 60,
      })
      .run();

    expect(checkRefundablePurchase(base.user.id, base.course.id)).toMatchObject(
      { refundable: false, status: 403 }
    );
  });

  it("allows the whole of the last day of the Refund Window, then closes", () => {
    buy(4900, daysAgo(REFUND_WINDOW_DAYS));
    expect(checkRefundablePurchase(base.user.id, base.course.id)).toMatchObject(
      { refundable: true }
    );

    db.delete(schema.purchases).run();
    buy(4900, daysAgo(REFUND_WINDOW_DAYS + 1));
    expect(checkRefundablePurchase(base.user.id, base.course.id)).toMatchObject(
      {
        refundable: false,
        reason: `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
      }
    );
  });

  it("allows at most one Pending Refund Request per purchase", () => {
    const purchase = buy(4900);
    db.insert(schema.refunds)
      .values({ purchaseId: purchase.id, reason: "Not what I expected" })
      .run();

    expect(checkRefundablePurchase(base.user.id, base.course.id)).toMatchObject(
      { refundable: false, status: 409 }
    );
  });

  it("refuses the whole purchase of Seats once any Seat is claimed", () => {
    const purchase = buy(4 * 4900);
    const team = db.insert(schema.teams).values({}).returning().get();
    for (const code of ["a", "b", "c", "d"]) {
      db.insert(schema.seats)
        .values({
          teamId: team.id,
          courseId: base.course.id,
          purchaseId: purchase.id,
          code,
        })
        .run();
    }

    expect(checkRefundablePurchase(base.user.id, base.course.id)).toMatchObject(
      { refundable: true, amount: 4 * 4900 }
    );

    db.update(schema.seats)
      .set({ claimedByUserId: base.instructor.id, claimedAt: daysAgo(0) })
      .where(eq(schema.seats.code, "a"))
      .run();

    expect(checkRefundablePurchase(base.user.id, base.course.id)).toMatchObject(
      { refundable: false, status: 403 }
    );
  });
});
