import { X_POST_READ_MICRO_USD, X_PRICE_EXPIRES_AT, X_USAGE_LIMITS } from "../config/xSources.js";
import type { XReservationResult, XStore } from "./xStore.js";

export async function reserveXRequest(
  store: XStore,
  authorId: string,
  now: Date,
  cycleRequestsAlreadyReserved: number,
): Promise<XReservationResult> {
  if (Number.isNaN(now.getTime())) return { allowed: false, reason: "state_unavailable" };
  if (now.getTime() >= new Date(X_PRICE_EXPIRES_AT).getTime()) return { allowed: false, reason: "budget" };
  try {
    return await store.reserveRequest(authorId, now, {
      cycleRequestsAlreadyReserved,
      requestsPerCycle: X_USAGE_LIMITS.requestsPerCycle,
      requestsPerDay: X_USAGE_LIMITS.requestsPerDay,
      requestsPerIsoWeek: X_USAGE_LIMITS.requestsPerIsoWeek,
      requestsPerMonth: X_USAGE_LIMITS.requestsPerMonth,
      reservedPostsPerRequest: X_USAGE_LIMITS.reservedPostsPerRequest,
      reservedPostsPerMonth: X_USAGE_LIMITS.reservedPostsPerMonth,
      reservedMicroUsdPerMonth: X_USAGE_LIMITS.reservedMicroUsdPerMonth,
      reservedMicroUsdPerRequest: X_USAGE_LIMITS.reservedPostsPerRequest * X_POST_READ_MICRO_USD,
    });
  } catch {
    return { allowed: false, reason: "state_unavailable" };
  }
}
