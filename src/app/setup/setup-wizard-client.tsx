"use client";

// product-review-followups epic, setup-wizard story. A guided, 6-step
// SUBSET of /config's full raw-form editing -- not a replacement for it.
// Reuses the SAME real mechanisms /config already uses (no second
// extraction/save path): extractProfileFromResumeAction() for step 1,
// saveWizardConfigAction() (this route's own, see ./actions.ts's header
// comment for why it's separate from config's saveConfigAction) for the
// final save.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { extractProfileFromResumeAction } from "@/app/config/actions";
import { mergeDedupe } from "@/lib/profile-ingestion/merge";
import { KNOWN_SOURCES } from "@/lib/sources/origins";
import type { Config, EngagementProfile } from "@/lib/types";
import { saveWizardConfigAction } from "./actions";

const STEP_LABELS = ["Your background", "Profile", "Rates you'll accept", "What to look for", "Sources", "Done"] as const;

const inputClass =
  "w-full rounded-md border border-theme-surface-border px-2 py-1.5 text-sm text-theme-text placeholder:text-theme-text-dim focus:border-slate-500 focus:outline-none";
const labelClass = "block text-sm font-medium text-theme-text";
const buttonClass = "rounded-md border border-theme-surface-border px-3 py-1.5 text-xs font-medium text-theme-text transition-colors hover:bg-theme-surface-raised disabled:opacity-50";
const primaryButtonClass =
  "rounded-md border border-brand-accent bg-brand-accent px-4 py-2 text-sm font-medium text-brand-bg transition-colors hover:bg-brand-accent/90 disabled:opacity-50";
const sectionClass = "rounded-lg border border-theme-surface-border bg-theme-surface p-4";

/** Multi-line textarea -> string[], one entry per non-blank line -- the wizard's own simpler stand-in for /config's per-item StringListEditor (a guided flow favors "paste a list, done" over click-to-add-each-row). */
function linesToArray(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function arrayToLines(values: string[]): string {
  return values.join("\n");
}

interface WizardState {
  // Step 1 (profile)
  name: string;
  rolesText: string;
  skillsText: string;
  timezone: string;
  // Step 2 (needs)
  hourlyEnabled: boolean;
  hourlyMinRate: string;
  hourlyHighRate: string;
  hourlyMaxHours: string;
  hourlyMaxHoursAtHighRate: string;
  fullTimeEnabled: boolean;
  fullTimeMinRate: string;
  remoteOnly: boolean;
  // Step 3 (role area)
  coreTitlesText: string;
  keywordsText: string;
  redKeywordsText: string;
  // Step 4 (sources)
  enabledSourceIds: Set<string>;
}

function initialState(existing: Config | null): WizardState {
  // Slice 1 of the multi-group-architecture epic has no group-management UI
  // yet (Slice 2) — the wizard only ever reads/writes the FIRST/primary
  // group, same convention as ./actions.ts's saveWizardConfigAction().
  const group = existing?.groups[0];
  const hourly = group?.needs.engagementProfiles.find((p) => p.rateUnit === "hour");
  const fullTime = group?.needs.engagementProfiles.find((p) => p.rateUnit === "year");
  return {
    name: existing?.profile.name ?? "",
    rolesText: arrayToLines(existing?.profile.roles ?? []),
    skillsText: arrayToLines(existing?.profile.skills ?? []),
    timezone: existing?.profile.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    hourlyEnabled: !!hourly,
    hourlyMinRate: hourly ? String(hourly.minRate) : "",
    hourlyHighRate: hourly ? String(hourly.highRate) : "",
    hourlyMaxHours: hourly?.maxHours != null ? String(hourly.maxHours) : "20",
    hourlyMaxHoursAtHighRate: hourly?.maxHoursAtHighRate != null ? String(hourly.maxHoursAtHighRate) : "40",
    fullTimeEnabled: !!fullTime,
    fullTimeMinRate: fullTime ? String(fullTime.minRate) : "",
    remoteOnly: group?.needs.remoteOnly ?? true,
    coreTitlesText: arrayToLines(group?.roleArea?.coreTitles ?? []),
    keywordsText: arrayToLines(group?.roleArea?.keywords ?? []),
    redKeywordsText: arrayToLines(group?.roleArea?.redKeywords ?? []),
    enabledSourceIds: new Set((existing?.sources ?? []).filter((s) => s.enabled && KNOWN_SOURCES.some((k) => k.id === s.id)).map((s) => s.id)),
  };
}

function buildEngagementProfiles(state: WizardState): EngagementProfile[] {
  const profiles: EngagementProfile[] = [];
  if (state.hourlyEnabled) {
    profiles.push({
      id: "hourly-fractional",
      label: "Hourly/Fractional/Contract",
      types: ["contract", "fractional"],
      minRate: Number(state.hourlyMinRate) || 0,
      highRate: Number(state.hourlyHighRate) || Number(state.hourlyMinRate) || 0,
      maxHours: Number(state.hourlyMaxHours) || 0,
      maxHoursAtHighRate: Number(state.hourlyMaxHoursAtHighRate) || 0,
      rateUnit: "hour",
    });
  }
  if (state.fullTimeEnabled) {
    const minRate = Number(state.fullTimeMinRate) || 0;
    profiles.push({ id: "full-time", label: "Full-time (higher rate)", types: ["full-time"], minRate, highRate: minRate, rateUnit: "year" });
  }
  return profiles;
}

export function SetupWizardClient({ existing }: { existing: Config | null }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(() => initialState(existing));

  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [linksText, setLinksText] = useState("");
  const [extractState, setExtractState] = useState<{ status: "idle" } | { status: "extracting" } | { status: "done"; warnings: string[] } | { status: "error"; message: string }>({
    status: "idle",
  });

  const [saveState, setSaveState] = useState<{ status: "idle" } | { status: "saving" } | { status: "error"; message: string }>({ status: "idle" });

  function set<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleExtract() {
    setExtractState({ status: "extracting" });
    const formData = new FormData();
    if (resumeFile) formData.set("resumeFile", resumeFile);
    if (linksText.trim()) formData.set("links", linksText);
    const result = await extractProfileFromResumeAction(formData);
    if (!result.ok) {
      setExtractState({ status: "error", message: result.error });
      return;
    }
    setState((prev) => ({
      ...prev,
      rolesText: arrayToLines(mergeDedupe(linesToArray(prev.rolesText), result.data.roles)),
      skillsText: arrayToLines(mergeDedupe(linesToArray(prev.skillsText), result.data.skills)),
    }));
    setExtractState({ status: "done", warnings: result.data.warnings });
  }

  async function handleFinish() {
    setSaveState({ status: "saving" });
    const result = await saveWizardConfigAction({
      profile: { name: state.name, roles: linesToArray(state.rolesText), skills: linesToArray(state.skillsText), timezone: state.timezone },
      needs: { engagementProfiles: buildEngagementProfiles(state), freshStageOnly: false, remoteOnly: state.remoteOnly },
      roleArea: { coreTitles: linesToArray(state.coreTitlesText), keywords: linesToArray(state.keywordsText), redKeywords: linesToArray(state.redKeywordsText) },
      enabledSourceIds: [...state.enabledSourceIds],
    });
    if (!result.ok) {
      setSaveState({ status: "error", message: result.error });
      return;
    }
    router.push("/");
  }

  const canFinish = state.name.trim() !== "" && buildEngagementProfiles(state).length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-theme-text">{existing ? "Update your setup" : "Set up gigradar"}</h1>
        <p className="mt-1 text-sm text-theme-text-dim">
          {existing
            ? "Re-run this whenever your preferences change -- it's pre-filled from your current config."
            : "A guided walk-through of the essentials. For anything not covered here (custom sources, per-source settings, auto-fire), use Config directly afterward."}
        </p>
        <ol className="mt-3 flex flex-wrap gap-2 text-xs">
          {STEP_LABELS.map((label, i) => (
            <li
              key={label}
              className={`rounded-full px-2.5 py-1 ${i === step ? "bg-brand-accent/15 text-brand-accent ring-1 ring-inset ring-brand-accent/30" : "text-theme-text-dim"}`}
            >
              {i + 1}. {label}
            </li>
          ))}
        </ol>
      </div>

      {step === 0 && (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold text-theme-text">Your background</h2>
          <p className="mt-1 text-xs text-theme-text-dim">
            Upload a resume (PDF or plain text) and/or paste public links (GitHub, portfolio, LinkedIn -- one per line). gigradar reads these ONCE to
            suggest roles/skills for the next step -- nothing here is saved as-is, and you can skip straight to Profile if you'd rather type it yourself.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            <label>
              <span className={labelClass}>Resume (PDF or text)</span>
              <input
                type="file"
                accept=".pdf,.txt,text/plain,application/pdf"
                onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)}
                className="mt-1 block w-full text-sm text-theme-text"
              />
            </label>
            <label>
              <span className={labelClass}>Public links (one per line)</span>
              <textarea
                value={linksText}
                onChange={(e) => setLinksText(e.target.value)}
                placeholder={"https://github.com/you\nhttps://yoursite.com"}
                rows={3}
                className={inputClass}
              />
            </label>
            <div>
              <button
                type="button"
                onClick={handleExtract}
                disabled={extractState.status === "extracting" || (!resumeFile && linksText.trim() === "")}
                className={buttonClass}
              >
                {extractState.status === "extracting" ? "Reading…" : "Extract roles & skills"}
              </button>
              {extractState.status === "done" && (
                <p role="status" className="mt-2 text-xs text-green-700">
                  Done -- roles/skills below are pre-filled. {extractState.warnings.length > 0 && `(${extractState.warnings.join("; ")})`}
                </p>
              )}
              {extractState.status === "error" && (
                <p role="alert" className="mt-2 text-xs text-red-700">
                  {extractState.message}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold text-theme-text">Profile</h2>
          <div className="mt-3 flex flex-col gap-3">
            <label>
              <span className={labelClass}>Name</span>
              <input type="text" value={state.name} onChange={(e) => set("name", e.target.value)} className={inputClass} />
            </label>
            <label>
              <span className={labelClass}>Roles (one per line, priority order)</span>
              <textarea value={state.rolesText} onChange={(e) => set("rolesText", e.target.value)} rows={4} className={inputClass} placeholder="Fractional CTO" />
            </label>
            <label>
              <span className={labelClass}>Skills (one per line)</span>
              <textarea value={state.skillsText} onChange={(e) => set("skillsText", e.target.value)} rows={4} className={inputClass} placeholder="Distributed Systems" />
            </label>
            <label>
              <span className={labelClass}>Timezone (IANA)</span>
              <input type="text" value={state.timezone} onChange={(e) => set("timezone", e.target.value)} className={inputClass} placeholder="America/Chicago" />
            </label>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold text-theme-text">Rates you&rsquo;ll accept</h2>
          <p className="mt-1 text-xs text-theme-text-dim">
            gigradar only ever rejects a gig on rate/engagement type when NEITHER tier below matches it -- turn on whichever you&rsquo;d actually take.
          </p>
          <div className="mt-3 flex flex-col gap-4">
            <div className="rounded-md border border-theme-surface-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-theme-text">
                <input type="checkbox" checked={state.hourlyEnabled} onChange={(e) => set("hourlyEnabled", e.target.checked)} />
                Hourly / fractional / contract work
              </label>
              {state.hourlyEnabled && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label>
                    <span className={labelClass}>Minimum $/hr</span>
                    <input type="number" value={state.hourlyMinRate} onChange={(e) => set("hourlyMinRate", e.target.value)} className={inputClass} />
                  </label>
                  <label>
                    <span className={labelClass}>Ideal (high) $/hr</span>
                    <input type="number" value={state.hourlyHighRate} onChange={(e) => set("hourlyHighRate", e.target.value)} className={inputClass} />
                  </label>
                  <label>
                    <span className={labelClass}>Max hrs/wk at your minimum</span>
                    <input type="number" value={state.hourlyMaxHours} onChange={(e) => set("hourlyMaxHours", e.target.value)} className={inputClass} />
                  </label>
                  <label>
                    <span className={labelClass}>Max hrs/wk at your ideal rate</span>
                    <input type="number" value={state.hourlyMaxHoursAtHighRate} onChange={(e) => set("hourlyMaxHoursAtHighRate", e.target.value)} className={inputClass} />
                  </label>
                </div>
              )}
            </div>
            <div className="rounded-md border border-theme-surface-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-theme-text">
                <input type="checkbox" checked={state.fullTimeEnabled} onChange={(e) => set("fullTimeEnabled", e.target.checked)} />
                Full-time (W2)
              </label>
              {state.fullTimeEnabled && (
                <label className="mt-2 block max-w-xs">
                  <span className={labelClass}>Minimum $/yr total comp</span>
                  <input type="number" value={state.fullTimeMinRate} onChange={(e) => set("fullTimeMinRate", e.target.value)} className={inputClass} />
                </label>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm text-theme-text">
              <input type="checkbox" checked={state.remoteOnly} onChange={(e) => set("remoteOnly", e.target.checked)} />
              Remote only
            </label>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold text-theme-text">What to look for</h2>
          <p className="mt-1 text-xs text-theme-text-dim">Classifies every gig GREEN/YELLOW/RED -- see Config&rsquo;s own docs link for the full precedence rules.</p>
          <div className="mt-3 flex flex-col gap-3">
            <label>
              <span className={labelClass}>Core titles (one per line -- exact title matches, always GREEN)</span>
              <textarea value={state.coreTitlesText} onChange={(e) => set("coreTitlesText", e.target.value)} rows={3} className={inputClass} placeholder="fractional cto" />
            </label>
            <label>
              <span className={labelClass}>Keywords (one per line -- broader GREEN signals)</span>
              <textarea value={state.keywordsText} onChange={(e) => set("keywordsText", e.target.value)} rows={3} className={inputClass} placeholder="staff engineer" />
            </label>
            <label>
              <span className={labelClass}>Red keywords (one per line -- definitely not this)</span>
              <textarea value={state.redKeywordsText} onChange={(e) => set("redKeywordsText", e.target.value)} rows={3} className={inputClass} placeholder="recruiter" />
            </label>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold text-theme-text">Sources</h2>
          <p className="mt-1 text-xs text-theme-text-dim">Turn on whichever boards to scan. Custom/LLM sources and per-source login aren&rsquo;t covered here -- add those in Config afterward.</p>
          <div className="mt-3 flex flex-col gap-2">
            {KNOWN_SOURCES.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm text-theme-text">
                <input
                  type="checkbox"
                  checked={state.enabledSourceIds.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(state.enabledSourceIds);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    set("enabledSourceIds", next);
                  }}
                />
                {s.label}
                {s.auth === "browser-session" && <span className="text-xs text-theme-text-dim">(needs Capture Login in Config)</span>}
              </label>
            ))}
          </div>
        </section>
      )}

      {step === 5 && (
        <section className={sectionClass}>
          <h2 className="text-lg font-semibold text-theme-text">Review</h2>
          <dl className="mt-3 flex flex-col gap-2 text-sm text-theme-text">
            <div>
              <dt className="font-medium">Profile</dt>
              <dd className="text-theme-text-dim">
                {state.name || "(no name set)"} — {linesToArray(state.rolesText).length} role(s), {linesToArray(state.skillsText).length} skill(s)
              </dd>
            </div>
            <div>
              <dt className="font-medium">Rates</dt>
              <dd className="text-theme-text-dim">
                {buildEngagementProfiles(state)
                  .map((p) => p.label)
                  .join(", ") || "None selected — you won't match anything until you enable at least one tier"}
              </dd>
            </div>
            <div>
              <dt className="font-medium">Sources</dt>
              <dd className="text-theme-text-dim">{state.enabledSourceIds.size} enabled</dd>
            </div>
          </dl>
          <div className="mt-4">
            <button type="button" onClick={handleFinish} disabled={!canFinish || saveState.status === "saving"} className={primaryButtonClass}>
              {saveState.status === "saving" ? "Saving…" : "Finish and go to dashboard"}
            </button>
            {saveState.status === "error" && (
              <p role="alert" className="mt-2 text-xs text-red-700">
                {saveState.message}
              </p>
            )}
            {!canFinish && <p className="mt-2 text-xs text-theme-text-dim">Set a name and enable at least one rate tier before finishing.</p>}
          </div>
        </section>
      )}

      <div className="flex justify-between">
        <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className={buttonClass}>
          Back
        </button>
        {step < STEP_LABELS.length - 1 && (
          <button type="button" onClick={() => setStep((s) => Math.min(STEP_LABELS.length - 1, s + 1))} className={buttonClass}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}
