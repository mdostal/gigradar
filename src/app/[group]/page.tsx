import { notFound, redirect } from "next/navigation";
import { readRawConfig } from "@/lib/config/save";
import { resolveGroupLabel } from "../dashboard-data";

// dashboard-drafts-data-integrity epic, relocate-giglist-to-all-gigs story.
// Mirrors src/app/page.tsx's own redirect — the giglist UI that used to
// render here moved to /[group]/gigs. Still 404s on an unknown groupId
// (same check the old giglist route made) rather than redirecting to a
// gigs route that would itself 404 one hop later.
export const dynamic = "force-dynamic";

export default async function GroupHomePage({ params }: { params: Promise<{ group: string }> }) {
  const { group: groupId } = await params;
  const rawConfig = readRawConfig();
  const groupLabel = resolveGroupLabel(rawConfig, groupId);
  if (groupLabel === undefined) notFound();

  redirect(`/${groupId}/gigs`);
}
