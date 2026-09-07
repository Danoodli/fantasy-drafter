import { describe, it, expect } from "vitest";
import { planFpBudget } from "../lib/etl/fantasypros";

describe("planFpBudget — spend the free tier's ~10 daily calls by value", () => {
  it("nine calls: news + PPR consensus for the top 60, no projections", () =>
    expect(planFpBudget(9)).toEqual({ news: true, ecrChunks: 6, projChunks: 0 }));
  it("tiny budgets still take news first", () => {
    expect(planFpBudget(1)).toEqual({ news: true, ecrChunks: 0, projChunks: 0 });
    expect(planFpBudget(3)).toEqual({ news: true, ecrChunks: 2, projChunks: 0 });
    expect(planFpBudget(0)).toEqual({ news: false, ecrChunks: 0, projChunks: 0 });
  });
  it("a paid budget adds projections only once 50 players fit, capped at 150", () => {
    expect(planFpBudget(11).projChunks).toBe(0);
    expect(planFpBudget(12)).toEqual({ news: true, ecrChunks: 6, projChunks: 5 });
    expect(planFpBudget(40).projChunks).toBe(15);
  });
});
