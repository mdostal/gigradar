"use client";

// gigradar-command-center epic, interview-workspace-page story. Once a
// gig's status is "interview", the prep packet + a real, grounded
// Materials view get a full page instead of a table row's <details> tag
// (dashboard-client.tsx's renderPrepSection(), still what /today and the
// dashboard's own row use for every OTHER status). "Fire off a full prep
// packet" is this page's primary action, per the story's own acceptance
// criteria.
//
// The Materials section is read-only, grounded ONLY in the real
// Profile/ApplyProfileConfig this app already has saved -- zero
// generation, zero fabrication. It deliberately does NOT invent its own
// approval/staging mechanism: the one real "staged until a human reviews
// it" gate in this codebase is application_drafts.status (draft ->
// approved/rejected -> submitted, reviewed on /drafts, never
// auto-submitted from here) -- this page surfaces that SAME status rather
// than a second, parallel one, per this story's own acceptance criteria
// ("reuses [the approval posture] rather than inventing a second one").
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { StoredDraft, StoredGig } from "@/lib/store";
import type { PrepPacketContent } from "@/lib/apply/prep";
import type { ApplyProfileConfig, Profile } from "@/lib/types";
import { generateDraftAction, generatePrepPacketAction } from "../../../actions";
import { canGenerateDraft, draftButtonLabel } from "../../../dashboard-draft";
import { formatDate, formatRate, OUTCOME_LABEL, STATUS_LABEL, TIER_BADGE_FALLBACK_STYLE, TIER_BADGE_STYLE } from "../../../dashboard-client";

const DRAFT_STATUS_LABEL: Record<StoredDraft["status"], string> = {
  draft: "Drafted — not yet reviewed",
  approved: "Approved",
  rejected: "Rejected",
  submitted: "Submitted",
  submitting: "Submitting…",
};

function Field({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs font-medium text-theme-text-dim">{label}</dt>
      <dd className="text-sm text-theme-text">{value}</dd>
    </div>
  );
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-theme-text">{title}</h3>
      <ul className="mt-1 ml-4 list-disc text-sm text-theme-text">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function InterviewWorkspaceClient({
  gig,
  prep: initialPrep,
  draft,
  profile,
  applyProfile,
}: {
  gig: StoredGig;
  prep: PrepPacketContent | undefined;
  draft: StoredDraft | undefined;
  profile: Profile | undefined;
  applyProfile: ApplyProfileConfig | undefined;
}) {
  const router = useRouter();
  const [prep, setPrep] = useState(initialPrep);
  const [prepError, setPrepError] = useState<string | undefined>();
  const [draftError, setDraftError] = useState<string | undefined>();
  const [isGeneratingPrep, startPrepTransition] = useTransition();
  const [isGeneratingDraft, startDraftTransition] = useTransition();

  const tierStyle = gig.tier ? TIER_BADGE_STYLE[gig.tier] : TIER_BADGE_FALLBACK_STYLE;

  function handleGeneratePrep() {
    setPrepError(undefined);
    startPrepTransition(async () => {
      const result = await generatePrepPacketAction(gig.key);
      if (!result.ok) {
        setPrepError(result.error);
        return;
      }
      setPrep(result.data);
    });
  }

  function handleGenerateDraft() {
    setDraftError(undefined);
    startDraftTransition(async () => {
      const result = await generateDraftAction(gig.key);
      if (!result.ok) {
        setDraftError(result.error);
        return;
      }
      router.push("/drafts");
    });
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <Link href="/" className="text-sm font-medium text-theme-text-dim hover:underline">
        ← Dashboard
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-current/30" style={tierStyle}>
              {gig.tier ?? "unrated"}
            </span>
            <span className="text-xs text-theme-text-dim">{gig.sourceId}</span>
            <span className="text-xs text-theme-text-dim">·</span>
            <span className="text-xs text-theme-text-dim">{STATUS_LABEL[gig.status]}</span>
          </div>
          <h1 className="mt-1 font-theme-heading text-2xl font-bold tracking-tight text-theme-text">{gig.title}</h1>
          {gig.company && <p className="text-sm text-theme-text-dim">{gig.company}</p>}
          <p className="mt-1 font-theme-mono text-sm text-theme-text-dim">
            {formatRate(gig.rate)} · First seen {formatDate(gig.firstSeen)}
          </p>
        </div>
        <a
          href={gig.url}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised"
        >
          Open original listing ↗
        </a>
      </div>
      {gig.outcomeReason && (
        <p className="mt-1 text-xs text-theme-text-dim">
          {OUTCOME_LABEL[gig.outcomeReason]}
          {gig.outcomeNote && <> — {gig.outcomeNote}</>}
        </p>
      )}

      {/* Prep packet -- this page's primary action, per the story's own acceptance criteria. */}
      <section className="mt-6 rounded-lg border border-theme-surface-border bg-theme-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-theme-heading text-lg font-semibold text-theme-text">Prep packet</h2>
          <button
            type="button"
            disabled={isGeneratingPrep}
            onClick={handleGeneratePrep}
            className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised disabled:opacity-50"
          >
            {isGeneratingPrep ? "Generating…" : prep ? "Regenerate prep packet" : "Generate prep packet"}
          </button>
        </div>
        {prepError && <p className="mt-2 text-sm text-red-600">{prepError}</p>}

        {prep ? (
          <div className="mt-4 flex flex-col gap-4">
            <div>
              <p className="text-sm font-semibold text-theme-text">
                Fit score: {prep.score}/100 — {prep.recommendation}
              </p>
              <p className="mt-1 text-sm text-theme-text">{prep.rationale}</p>
            </div>
            <ListSection title="Top strengths" items={prep.topStrengths} />
            <ListSection title="Key gaps" items={prep.keyGaps} />
            <ListSection title="Predicted interview questions" items={prep.predictedQuestions} />
            <ListSection title="STARLA story prompts" items={prep.starlaStories} />

            <div className="border-t border-theme-surface-border pt-3">
              <h3 className="text-sm font-semibold text-theme-text">
                ATS keyword match: {prep.atsScore.keywordOverlapScore}/100
              </h3>
              <ListSection title="Matched keywords" items={prep.atsScore.matchedKeywords} />
              <ListSection title="Missing keywords" items={prep.atsScore.missingKeywords} />
              <ListSection title="Tweaks to close the gap" items={prep.atsScore.resumeTweaks} />
              {prep.atsScore.resumeChecked ? (
                prep.atsScore.parseabilityIssues.length > 0 ? (
                  <ListSection title="Resume format issues (from your saved resume)" items={prep.atsScore.parseabilityIssues} />
                ) : (
                  <p className="mt-2 text-sm text-green-700">No resume format issues found.</p>
                )
              ) : (
                <p className="mt-2 text-sm text-theme-text-dim">No resume format check — save a resume on /config to get a real ATS-parseability read.</p>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-theme-text-dim">No prep packet generated yet for this gig.</p>
        )}
      </section>

      {/* Materials -- grounded ONLY in real, saved Profile/ApplyProfileConfig data. Never generated, never fabricated. */}
      <section className="mt-6 rounded-lg border border-theme-surface-border bg-theme-surface p-4">
        <h2 className="font-theme-heading text-lg font-semibold text-theme-text">Materials</h2>
        <p className="mt-1 text-xs text-theme-text-dim">
          Everything below is read directly from your saved Profile and Application Profile on /config — nothing here is generated or
          guessed. Review it yourself before reusing any of it in an application.
        </p>

        {profile || applyProfile ? (
          <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
            <Field label="Name" value={profile?.name} />
            <Field label="Headline" value={applyProfile?.headline} />
            <Field label="Roles" value={profile?.roles.join("; ")} />
            <Field label="Skills" value={profile?.skills.join("; ")} />
            <Field label="Timezone" value={profile?.timezone} />
            <Field label="Email" value={applyProfile?.email} />
            <Field label="Phone" value={applyProfile?.phone} />
            <Field label="LinkedIn" value={applyProfile?.linkedInUrl} />
            <Field label="Rate anchor" value={applyProfile?.rateAnchor != null ? `$${applyProfile.rateAnchor}` : undefined} />
            <Field label="Links" value={applyProfile?.links?.join("; ")} />
            <Field label="Resume on file" value={applyProfile?.resumePath ? "Yes — see /config" : "No resume uploaded"} />
            {applyProfile?.bio && (
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-theme-text-dim">Bio</dt>
                <dd className="whitespace-pre-wrap text-sm text-theme-text">{applyProfile.bio}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-theme-text-dim">No Profile saved yet — fill it in on /config first.</p>
        )}
      </section>

      {/* Application draft -- the ONE real staged-for-review gate in this codebase (application_drafts.status). Reused here, not reinvented. */}
      <section className="mt-6 rounded-lg border border-theme-surface-border bg-theme-surface p-4">
        <h2 className="font-theme-heading text-lg font-semibold text-theme-text">Application draft</h2>
        {draftError && <p className="mt-2 text-sm text-red-600">{draftError}</p>}

        {draft ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-theme-text">
              Status: <span className="font-medium">{DRAFT_STATUS_LABEL[draft.status]}</span>
              {draft.approvedAt && ` · Approved ${formatDate(draft.approvedAt)}`}
              {draft.submittedAt && ` · Submitted ${formatDate(draft.submittedAt)}`}
            </p>
            <Link
              href="/drafts"
              className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised"
            >
              Review on /drafts
            </Link>
          </div>
        ) : canGenerateDraft(gig.tier) ? (
          <div className="mt-2">
            <button
              type="button"
              disabled={isGeneratingDraft}
              onClick={handleGenerateDraft}
              className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised disabled:opacity-50"
            >
              {isGeneratingDraft ? "Generating…" : draftButtonLabel(false)}
            </button>
            <p className="mt-1 text-xs text-theme-text-dim">Generates a real draft, staged for your review on /drafts — never auto-submitted.</p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-theme-text-dim">This gig is tier "red" — no draft can be generated for it.</p>
        )}
      </section>
    </main>
  );
}
