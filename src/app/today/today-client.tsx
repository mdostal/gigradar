"use client";

// gigradar-command-center epic, daily-shortlist-page story. The fast
// daily check-in counterpart to Dashboard's full working view (Signal
// Deck) -- ships the verified, bug-free Daily Shortlist concept's IA
// "as is" per the owner's own words, reusing the SAME real data/actions
// dashboard-client.tsx already uses (never a second, parallel data model).
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Fraunces, IBM_Plex_Mono, Libre_Franklin } from "next/font/google";
import type { GigStatus, OutcomeReason, StoredGig } from "@/lib/store";
import type { PrepPacketContent } from "@/lib/apply/prep";
import { generateDraftAction, generatePrepPacketAction, updateGigStatusAction } from "../actions";
import { canGenerateDraft, draftButtonLabel } from "../dashboard-draft";
import { distinctSources, isWithinSeenWindow, SEEN_WINDOW_OPTIONS, shortProfileLabel, type SeenWindow } from "../dashboard-filter";
import { ALL_STATUSES, formatDate, formatRate, OUTCOME_LABEL, STATUS_LABEL } from "../dashboard-client";
import { ContextualChatTrigger } from "../contextual-chat/contextual-chat-trigger";
import styles from "./today.module.css";

type TierFilterValue = "all" | "green" | "yellow" | "red";

const TIER_CHIPS: { value: TierFilterValue; label: string }[] = [
  { value: "all", label: "All" },
  { value: "green", label: "Strong fit" },
  { value: "yellow", label: "Maybe" },
  { value: "red", label: "Pass" },
];

const TIER_STAMP_CLASS: Record<string, string | undefined> = {
  green: styles.stampGreen,
  yellow: styles.stampYellow,
  red: styles.stampRed,
};

function tierWord(tier: string | undefined): string {
  return tier === "green" ? "Strong fit" : tier === "yellow" ? "Maybe" : "Pass";
}

function TierStamp({ tier }: { tier: StoredGig["tier"] }) {
  if (!tier) return null;
  return <span className={`${styles.stamp} ${TIER_STAMP_CLASS[tier] ?? ""}`}>{tierWord(tier)}</span>;
}

function ProfileChips({ ids, profiles }: { ids: string[] | undefined; profiles: { id: string; label: string }[] }) {
  if (!ids || ids.length === 0) return null;
  return (
    <span className={styles.profileChips}>
      {ids.map((id) => {
        const profile = profiles.find((p) => p.id === id);
        return (
          <span key={id} className={styles.profileChip} title={profile?.label ?? id}>
            {profile ? shortProfileLabel(profile.label) : id}
          </span>
        );
      })}
    </span>
  );
}

function CompanyLine({ company, cls }: { company: string | undefined; cls: string | undefined }) {
  return company ? <span className={cls}>{company}</span> : <span className={`${cls} ${styles.unlisted}`}>Company not listed</span>;
}

/**
 * Self-hosted at build time via next/font/google, never a runtime request
 * to Google's CDN -- same reasoning as Signal Deck's own font loading
 * (see layout.tsx's header comment on that). Scoped to just this page's
 * component tree (unlike Signal Deck's, which are loaded app-wide in
 * layout.tsx since they back the default theme) -- these three typefaces
 * only ever render on /today.
 */
const shortlistDisplayFont = Fraunces({ subsets: ["latin"], weight: ["600", "700"], style: ["normal", "italic"], variable: "--font-shortlist-display" });
const shortlistBodyFont = Libre_Franklin({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-shortlist-body" });
const shortlistMonoFont = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-shortlist-mono" });

export function TodayClient({
  gigs,
  draftedGigKeys = new Set(),
  initialPrepByGigKey = {},
  engagementProfiles = [],
}: {
  gigs: StoredGig[];
  draftedGigKeys?: ReadonlySet<string>;
  initialPrepByGigKey?: Readonly<Record<string, PrepPacketContent>>;
  engagementProfiles?: { id: string; label: string }[];
}) {
  const router = useRouter();
  const sources = useMemo(() => distinctSources(gigs), [gigs]);

  const [tier, setTier] = useState<TierFilterValue>("all");
  const [status, setStatus] = useState<GigStatus | "all">("all");
  const [source, setSource] = useState<string | "all">("all");
  const [profile, setProfile] = useState<string>("all");
  const [seenWindow, setSeenWindow] = useState<SeenWindow>("any");
  const [search, setSearch] = useState("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const [statusErrorByKey, setStatusErrorByKey] = useState<Record<string, string>>({});
  const [, startStatusTransition] = useTransition();
  const [flashKey, setFlashKey] = useState<string | null>(null);

  const [, startDraftTransition] = useTransition();
  const [generatingDraftKeys, setGeneratingDraftKeys] = useState<ReadonlySet<string>>(new Set());
  const [draftErrorByKey, setDraftErrorByKey] = useState<Record<string, string>>({});

  const [, startPrepTransition] = useTransition();
  const [generatingPrepKeys, setGeneratingPrepKeys] = useState<ReadonlySet<string>>(new Set());
  const [prepErrorByKey, setPrepErrorByKey] = useState<Record<string, string>>({});
  const [prepByKey, setPrepByKey] = useState<Record<string, PrepPacketContent>>(initialPrepByGigKey);

  function matches(g: StoredGig): boolean {
    if (tier !== "all" && g.tier !== tier) return false;
    if (status !== "all" && g.status !== status) return false;
    if (source !== "all" && g.sourceId !== source) return false;
    if (profile !== "all" && !(g.matchedProfileIds ?? []).includes(profile)) return false;
    if (!isWithinSeenWindow(g.firstSeen, seenWindow, Date.now())) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${g.title} ${g.company ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  const visible = useMemo(() => gigs.filter(matches), [gigs, tier, status, source, profile, seenWindow, search]);

  // "Today's Picks" -- green + new, sorted most-recently-seen first, top 4.
  // Deliberately re-filters the FULL gigs array by the same `matches()`
  // predicate (not `visible` -- picks always apply the active filters too,
  // per the verified concept's own behavior) rather than a second data path.
  const picks = useMemo(
    () =>
      gigs
        .filter((g) => g.tier === "green" && g.status === "new" && matches(g))
        .slice()
        .sort((a, b) => new Date(b.firstSeen).getTime() - new Date(a.firstSeen).getTime())
        .slice(0, 4),
    [gigs, tier, status, source, profile, seenWindow, search],
  );

  const grouped = useMemo(() => {
    const byStatus = new Map<GigStatus, StoredGig[]>();
    for (const s of ALL_STATUSES) byStatus.set(s, []);
    for (const g of visible) byStatus.get(g.status)?.push(g);
    return ALL_STATUSES.map((s) => ({ status: s, gigs: byStatus.get(s) ?? [] })).filter((group) => group.gigs.length > 0);
  }, [visible]);

  function resetFilters() {
    setTier("all");
    setStatus("all");
    setSource("all");
    setProfile("all");
    setSeenWindow("any");
    setSearch("");
  }

  function handleStatusChange(key: string, next: GigStatus) {
    setStatusErrorByKey((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
    setFlashKey(key);
    setTimeout(() => setFlashKey((k) => (k === key ? null : k)), 800);
    startStatusTransition(async () => {
      const result = await updateGigStatusAction(key, next);
      if (!result.ok) setStatusErrorByKey((prev) => ({ ...prev, [key]: result.error }));
    });
  }

  function handleGenerateDraft(key: string) {
    setDraftErrorByKey((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
    setGeneratingDraftKeys((prev) => new Set(prev).add(key));
    startDraftTransition(async () => {
      const result = await generateDraftAction(key);
      setGeneratingDraftKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      if (!result.ok) {
        setDraftErrorByKey((prev) => ({ ...prev, [key]: result.error }));
        return;
      }
      router.push("/drafts");
    });
  }

  function handleGeneratePrep(key: string) {
    setPrepErrorByKey((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
    setGeneratingPrepKeys((prev) => new Set(prev).add(key));
    startPrepTransition(async () => {
      const result = await generatePrepPacketAction(key);
      setGeneratingPrepKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      if (!result.ok) {
        setPrepErrorByKey((prev) => ({ ...prev, [key]: result.error }));
        return;
      }
      setPrepByKey((prev) => ({ ...prev, [key]: result.data }));
    });
  }

  function renderRateInline(gig: StoredGig) {
    if (!gig.rate) return <span className={`${styles.rowRate} ${styles.rowRateUnstated} ${styles.mono}`}>not stated</span>;
    return <span className={`${styles.rowRate} ${styles.mono}`}>{formatRate(gig.rate)}</span>;
  }

  return (
    <div className={`${styles.page} ${shortlistDisplayFont.variable} ${shortlistBodyFont.variable} ${shortlistMonoFont.variable}`}>
      <header className={styles.masthead}>
        <div>
          <div className={styles.wordmark}>The Daily Shortlist</div>
          <div className={styles.mastDate}>{formatDate(new Date().toISOString())} — gigradar briefing</div>
        </div>
        <div className={styles.mastRight}>
          <div className={styles.mastStat}>
            <span className={`${styles.dot} ${styles.dotLive}`} />
            {gigs.length} gig{gigs.length === 1 ? "" : "s"} tracked
          </div>
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className={styles.chipGroup}>
          {TIER_CHIPS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTier(t.value)}
              className={`${styles.chip} ${tier === t.value ? styles.chipActive : ""}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className={styles.toolbarSep} />
        <select value={status} onChange={(e) => setStatus(e.target.value as GigStatus | "all")} className={styles.tbSelect} aria-label="Filter by status">
          <option value="all">Any status</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className={styles.tbSelect} aria-label="Filter by source">
          <option value="all">Any source</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={profile} onChange={(e) => setProfile(e.target.value)} className={styles.tbSelect} aria-label="Filter by matched profile">
          <option value="all">Any profile</option>
          {engagementProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className={styles.toolbarSep} />
        <div className={styles.seenToggle}>
          {SEEN_WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setSeenWindow(opt.value)}
              className={`${styles.seg} ${seenWindow === opt.value ? styles.segActive : ""}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="filter roster…"
          aria-label="Filter roster by title or company"
          className={styles.tbSearch}
        />
        <button type="button" onClick={resetFilters} className={styles.tbReset}>
          Reset
        </button>
      </div>

      {picks.length > 0 && (
        <section className={styles.picks}>
          <h2 className={styles.sectionHead}>
            Today&rsquo;s Picks <span className={styles.sectionSub}>— strong fits, freshly seen</span>
          </h2>
          <div className={styles.picksGrid}>
            {picks.map((gig) => (
              <article key={gig.key} className={styles.pickCard}>
                <div className={styles.pickTop}>
                  <div>
                    <div className={styles.pickTitle}>{gig.title}</div>
                    <CompanyLine company={gig.company} cls={styles.pickCompany} />
                  </div>
                  <TierStamp tier={gig.tier} />
                </div>
                <div className={styles.pickMeta}>
                  <span className={styles.sourceTag}>{gig.sourceId}</span>
                  <span>·</span>
                  <span>seen {formatDate(gig.firstSeen)}</span>
                  <ProfileChips ids={gig.matchedProfileIds} profiles={engagementProfiles} />
                </div>
                {gig.rate ? (
                  <div className={styles.pickRate}>{formatRate(gig.rate)}</div>
                ) : (
                  <div className={styles.pickRateUnstated}>Rate not stated</div>
                )}
                <div className={styles.pickActions}>
                  {canGenerateDraft(gig.tier) && (
                    <button
                      type="button"
                      disabled={generatingDraftKeys.has(gig.key)}
                      onClick={() => handleGenerateDraft(gig.key)}
                      className={`${styles.btn} ${styles.btnPrimary}`}
                    >
                      {generatingDraftKeys.has(gig.key) ? "Generating…" : draftButtonLabel(draftedGigKeys.has(gig.key))}
                    </button>
                  )}
                  <button type="button" disabled={generatingPrepKeys.has(gig.key)} onClick={() => handleGeneratePrep(gig.key)} className={styles.btn}>
                    {generatingPrepKeys.has(gig.key) ? "Analyzing…" : "Analyze"}
                  </button>
                  <ContextualChatTrigger kind="gig" itemKey={gig.key} label={gig.title} />
                </div>
                {draftErrorByKey[gig.key] && <p className={styles.detailError}>{draftErrorByKey[gig.key]}</p>}
                {prepErrorByKey[gig.key] && <p className={styles.detailError}>{prepErrorByKey[gig.key]}</p>}
              </article>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className={styles.sectionHead}>
          Full Roster <span className={`${styles.sectionSub} ${styles.rosterCount}`}>— {visible.length} of {gigs.length}</span>
        </h2>
        <div className={styles.rosterHeadRow}>
          <div>Listing</div>
          <div>Source</div>
          <div>Rate</div>
          <div>Seen</div>
          <div>Status</div>
          <div />
        </div>

        {grouped.length === 0 ? (
          <div className={styles.emptyState}>
            No gigs match these filters.
            <button type="button" onClick={resetFilters} className={styles.btn}>
              Clear filters
            </button>
          </div>
        ) : (
          grouped.map((group) => (
            <div key={group.status} className={styles.group}>
              <div className={styles.groupLabel}>
                {STATUS_LABEL[group.status]} <span className="n">{group.gigs.length}</span>
              </div>
              {group.gigs.map((gig) => {
                const isOpen = expandedKey === gig.key;
                const outcomeLabel = gig.outcomeReason ? OUTCOME_LABEL[gig.outcomeReason as OutcomeReason] : null;
                return (
                  <div key={gig.key}>
                    <div
                      className={`${styles.row} ${isOpen ? styles.rowOpen : ""}`}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("select, button, a, input")) return;
                        setExpandedKey(isOpen ? null : gig.key);
                      }}
                    >
                      <div className={styles.rowListing}>
                        <div className={styles.rowTitleLine}>
                          <TierStamp tier={gig.tier} />
                          <span className={styles.rowTitle}>{gig.title}</span>
                        </div>
                        <div>
                          <CompanyLine company={gig.company} cls={styles.rowCompany} /> <ProfileChips ids={gig.matchedProfileIds} profiles={engagementProfiles} />
                        </div>
                      </div>
                      <div>
                        <span className={styles.sourceTag}>{gig.sourceId}</span>
                      </div>
                      <div>
                        {renderRateInline(gig)}
                        {outcomeLabel && <span className={styles.outcomeNote}>{outcomeLabel}</span>}
                      </div>
                      <div className={`${styles.rowSeen} ${styles.mono}`}>{formatDate(gig.firstSeen)}</div>
                      <div className={`${styles.rowStatus} ${flashKey === gig.key ? styles.flash : ""}`}>
                        <select value={gig.status} onChange={(e) => handleStatusChange(gig.key, e.target.value as GigStatus)} aria-label={`Change status for ${gig.title}`}>
                          {ALL_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {STATUS_LABEL[s]}
                            </option>
                          ))}
                        </select>
                        {statusErrorByKey[gig.key] && <p className={styles.detailError}>{statusErrorByKey[gig.key]}</p>}
                      </div>
                      <div className={styles.rowActions}>
                        <ContextualChatTrigger kind="gig" itemKey={gig.key} label={gig.title} />
                        <button
                          type="button"
                          onClick={() => setExpandedKey(isOpen ? null : gig.key)}
                          aria-label={isOpen ? `Collapse ${gig.title}` : `Expand ${gig.title}`}
                          className={`${styles.iconBtn} ${isOpen ? styles.chevronOpen : ""}`}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {isOpen && (
                      <div className={styles.detail}>
                        {gig.description ? (
                          <p className={styles.detailTeaser}>&ldquo;{gig.description}&rdquo;</p>
                        ) : (
                          <p className={styles.detailTeaser}>No description captured for this listing — see the original.</p>
                        )}
                        <div className={styles.detailMeta}>
                          {gig.weeklyHours != null && (
                            <span>
                              <b>{gig.weeklyHours}</b> hrs/wk
                            </span>
                          )}
                          {gig.employmentType && (
                            <span>
                              <b>{gig.employmentType}</b>
                            </span>
                          )}
                          <span>{gig.remote ? "remote" : "on-site"}</span>
                          <span>
                            posted <b>{formatDate(gig.firstSeen)}</b>
                          </span>
                        </div>
                        {gig.matchedProfileIds && gig.matchedProfileIds.length > 0 ? (
                          <div className={styles.detailProfiles}>
                            <span className={styles.detailProfilesLabel}>Clears</span>
                            {gig.matchedProfileIds.map((id) => {
                              const p = engagementProfiles.find((prof) => prof.id === id);
                              return (
                                <span key={id} className={styles.fullChip}>
                                  {p?.label ?? id}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <div className={styles.detailProfiles}>
                            <span className={styles.detailProfilesLabel}>Clears no configured profile</span>
                          </div>
                        )}
                        <div className={styles.detailActions}>
                          {canGenerateDraft(gig.tier) && (
                            <button
                              type="button"
                              disabled={generatingDraftKeys.has(gig.key)}
                              onClick={() => handleGenerateDraft(gig.key)}
                              className={`${styles.btn} ${styles.btnPrimary}`}
                            >
                              {generatingDraftKeys.has(gig.key) ? "Generating…" : draftButtonLabel(draftedGigKeys.has(gig.key))}
                            </button>
                          )}
                          <button type="button" disabled={generatingPrepKeys.has(gig.key)} onClick={() => handleGeneratePrep(gig.key)} className={styles.btn}>
                            {generatingPrepKeys.has(gig.key) ? "Analyzing…" : "Fit & prep analysis"}
                          </button>
                          <a href={gig.url} target="_blank" rel="noreferrer noopener" className={`${styles.btn} ${styles.btnGhost}`}>
                            View listing ↗
                          </a>
                        </div>
                        {draftErrorByKey[gig.key] && <p className={styles.detailError}>{draftErrorByKey[gig.key]}</p>}
                        {prepErrorByKey[gig.key] && <p className={styles.detailError}>{prepErrorByKey[gig.key]}</p>}
                        {prepByKey[gig.key] && (
                          <p className={styles.detailPrep}>
                            Fit score: {prepByKey[gig.key]!.score}/100 — {prepByKey[gig.key]!.recommendation}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </section>

      <footer className={styles.pagefoot}>
        <span>gigradar · {gigs.length} gigs tracked</span>
        <span>this view refreshes on every scan</span>
      </footer>
    </div>
  );
}
