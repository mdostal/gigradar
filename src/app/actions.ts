"use server";

import { revalidatePath } from "next/cache";
import { setStatus } from "@/lib/store";
import type { GigStatus } from "@/lib/store";
import { actionErr, actionOk, type ActionResult } from "@/lib/actions/result";

/**
 * Server Action wrapping `setStatus()` — the status-change control on the
 * dashboard's rows calls this. Establishes the shared Server Action
 * convention this epic's other Server Action (config-save, a later story)
 * reuses: a typed `{ok:true,data}|{ok:false,error}` return (see
 * src/lib/actions/result.ts) instead of letting `setStatus()`'s throw on an
 * unknown key cross the client/server boundary as an unhandled 500, AND an
 * explicit `revalidatePath()` call after every successful mutation.
 *
 * The `revalidatePath()` call is load-bearing, not decorative: without it,
 * Next's App Router can serve "/" from its Full Route Cache after a
 * production build (`next build && next start`), so a status change can
 * silently fail to show after a reload even though `setStatus()` itself
 * succeeded — this exact divergence is why this story required verifying
 * under both `next dev` and `next build && next start`, not just dev's
 * looser caching.
 */
export async function updateGigStatusAction(
  key: string,
  status: GigStatus,
): Promise<ActionResult<{ key: string; status: GigStatus }>> {
  try {
    setStatus(key, status);
  } catch (e) {
    return actionErr(e);
  }
  revalidatePath("/");
  return actionOk({ key, status });
}
