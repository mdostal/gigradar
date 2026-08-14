"use server";

import { revalidatePath } from "next/cache";
import { actionErr, actionOk } from "@/lib/actions/result";
import { resolveIssue } from "@/lib/notify/issues";
import type { ActionResult } from "@/lib/actions/result";

/**
 * Marks an issue resolved. Revalidates BOTH `/issues` (the list itself)
 * AND `/` (layout.tsx's nav badge reads `listIssues()` on every render,
 * but Next's Full Route Cache needs the explicit invalidation to actually
 * re-run that read — same convention `saveConfigAction` already
 * established for `/config`). Every route shares the same root layout, so
 * `/` is enough to cover the badge everywhere, not just the dashboard.
 */
export async function resolveIssueAction(id: string): Promise<ActionResult<null>> {
  try {
    resolveIssue(id);
  } catch (e) {
    return actionErr(e);
  }
  revalidatePath("/issues");
  revalidatePath("/");
  return actionOk(null);
}
