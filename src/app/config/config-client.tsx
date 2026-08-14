"use client";

import { type ChangeEvent, type FormEvent, useState, useTransition } from "react";
import { ROLE_TEMPLATES } from "@/lib/config/role-templates";
import type { ConfigEdits } from "@/lib/config/save";
import { mergeDedupe } from "@/lib/profile-ingestion/merge";
import { KNOWN_SOURCES, SOURCE_ORIGINS } from "@/lib/sources/origins";
import type { Config, EngagementType, RoleAreaConfig, SourceConfig, Tier } from "@/lib/types";
import {
  cancelCaptureAction,
  extractProfileFromResumeAction,
  finishCaptureAction,
  getAutoFireApprovedCountAction,
  saveConfigAction,
  setAnthropicApiKeyAction,
  startCaptureAction,
} from "./actions";

// ---------------------------------------------------------------------------
// Draft (form) state — a UI-friendly shape distinct from `Config` itself:
// number fields are strings (controlled <input type="number"> values), and
// the optional `homeBase`/`roleArea`/`schedule` sections each carry their own
// "enabled" flag so the form can represent the tri-state "never touched this
// section" vs "explicitly configured, possibly with empty lists" distinction
// `RoleAreaConfig`/`schedule` document (see src/lib/types.ts and this
// story's acceptance criteria). `draftToEdits()` below is the only place
// that converts back to the real `Config`-shaped `ConfigEdits`.
// ---------------------------------------------------------------------------

interface SettingPair {
  key: string;
  value: string;
}

interface DraftSource {
  id: string;
  enabled: boolean;
  settings: SettingPair[];
}

interface DraftProfile {
  name: string;
  roles: string[];
  skills: string[];
  timezone: string;
  homeBaseEnabled: boolean;
  homeBaseCity: string;
  homeBaseLat: string;
  homeBaseLng: string;
}

/** Mirrors `EngagementProfile` in src/lib/types.ts — numeric fields are controlled-input strings, same convention as DraftNeeds' old flat fields. */
interface DraftEngagementProfile {
  id: string;
  label: string;
  types: EngagementType[];
  minRate: string;
  highRate: string;
  maxHours: string;
  maxHoursAtHighRate: string;
  rateUnit: "hour" | "year";
}

interface DraftNeeds {
  engagementProfiles: DraftEngagementProfile[];
  freshStageOnly: boolean;
  remoteOnly: boolean;
}

const ALL_ENGAGEMENT_TYPES: EngagementType[] = ["contract", "fractional", "contract-to-hire", "full-time"];

const ENGAGEMENT_TYPE_LABEL: Record<EngagementType, string> = {
  contract: "Contract",
  fractional: "Fractional",
  "contract-to-hire": "Contract-to-hire",
  "full-time": "Full-time (salaried, benefits)",
};

/** Generates a stable-enough profile id from its label + a random suffix — collisions are harmless (ids only need to be unique WITHIN one user's profile list, never compared across configs). */
function makeProfileId(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
  return `${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultEngagementProfile(): DraftEngagementProfile {
  return {
    id: makeProfileId("new-profile"),
    label: "",
    types: ["contract", "fractional"],
    minRate: "",
    highRate: "",
    maxHours: "",
    maxHoursAtHighRate: "",
    rateUnit: "hour",
  };
}

interface DraftRoleArea {
  enabled: boolean;
  coreTitles: string[];
  keywords: string[];
  redKeywords: string[];
}

/**
 * Mirrors `DraftRoleArea`'s enabled-flag tri-state pattern exactly
 * (`draft-generation-foundation` story): `enabled` distinguishes "never
 * configured" from "configured, possibly with blank optional fields" —
 * `rateAnchor` is a controlled number-input string like `DraftNeeds`'
 * numeric fields, converted via `draftNumber()` in `draftToEdits()` below.
 */
interface DraftApplyProfile {
  enabled: boolean;
  email: string;
  phone: string;
  linkedInUrl: string;
  headline: string;
  bio: string;
  rateAnchor: string;
}

/** Mirrors `AutoFireRuleConfig` in src/lib/types.ts — numeric fields are controlled-input strings, same convention as DraftEngagementProfile. */
interface DraftAutoFireRule {
  sourceId: string;
  tier: Tier;
  enabled: boolean;
  minApprovals: string;
  dailyCap: string;
}

/**
 * Mirrors `Config["autoFire"]` — like `autoDraftOnScan`/`notifyOnGreenMatch`
 * above, no enabled-flag tri-state needed: an empty `rules` list plus
 * `killSwitch: false` is functionally identical to the section being
 * omitted entirely (see that field's own doc comment in types.ts), so this
 * is always sent as-is, never wrapped in a separate "configure this
 * section" checkbox the way roleArea/applyProfile are.
 */
interface DraftAutoFire {
  killSwitch: boolean;
  rules: DraftAutoFireRule[];
}

function defaultAutoFireRule(): DraftAutoFireRule {
  return { sourceId: "", tier: "green", enabled: true, minApprovals: "3", dailyCap: "3" };
}

interface DraftConfig {
  profile: DraftProfile;
  needs: DraftNeeds;
  sources: DraftSource[];
  roleArea: DraftRoleArea;
  schedule: string;
  applyProfile: DraftApplyProfile;
  /**
   * Unlike roleArea/schedule, `autoDraftOnScan`/`notifyOnGreenMatch`
   * omitted vs explicitly `false` are functionally IDENTICAL in the
   * scheduler's own code (both mean "don't do the behavior") — no
   * enabled-flag tri-state needed here, always sent as a plain boolean.
   */
  autoDraftOnScan: boolean;
  notifyOnGreenMatch: boolean;
  autoFire: DraftAutoFire;
}

// -- Config -> Draft -----------------------------------------------------

/**
 * `settings` values are shown/edited as literal strings (the "PAIRS EDITOR"
 * this story specifies) — a non-string value (rare; `settings` is opaque
 * `Record<string, unknown>`) is stringified for display only. Crucially, a
 * string value — including any `"env:VAR_NAME"` reference — passes through
 * completely UNCHANGED: this function never inspects, resolves, or looks up
 * `process.env` for anything.
 */
function settingsToPairs(settings: Record<string, unknown> | undefined): SettingPair[] {
  if (!settings) return [];
  return Object.entries(settings).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

function sourceToDraft(source: SourceConfig): DraftSource {
  return { id: source.id, enabled: source.enabled, settings: settingsToPairs(source.settings) };
}

function configToDraft(config: Config): DraftConfig {
  return {
    profile: {
      name: config.profile.name,
      roles: config.profile.roles,
      skills: config.profile.skills,
      timezone: config.profile.timezone,
      homeBaseEnabled: config.profile.homeBase != null,
      homeBaseCity: config.profile.homeBase?.city ?? "",
      homeBaseLat: config.profile.homeBase ? String(config.profile.homeBase.lat) : "",
      homeBaseLng: config.profile.homeBase ? String(config.profile.homeBase.lng) : "",
    },
    needs: {
      engagementProfiles: config.needs.engagementProfiles.map((p) => ({
        id: p.id,
        label: p.label,
        types: p.types,
        minRate: String(p.minRate),
        highRate: String(p.highRate),
        maxHours: String(p.maxHours),
        maxHoursAtHighRate: String(p.maxHoursAtHighRate),
        rateUnit: p.rateUnit,
      })),
      freshStageOnly: config.needs.freshStageOnly,
      remoteOnly: config.needs.remoteOnly,
    },
    sources: config.sources.map(sourceToDraft),
    roleArea: {
      enabled: config.roleArea != null,
      coreTitles: config.roleArea?.coreTitles ?? [],
      keywords: config.roleArea?.keywords ?? [],
      redKeywords: config.roleArea?.redKeywords ?? [],
    },
    schedule: config.schedule ?? "",
    autoDraftOnScan: config.autoDraftOnScan ?? false,
    notifyOnGreenMatch: config.notifyOnGreenMatch ?? false,
    autoFire: {
      killSwitch: config.autoFire?.killSwitch ?? false,
      rules: (config.autoFire?.rules ?? []).map((r) => ({
        sourceId: r.sourceId,
        tier: r.tier,
        enabled: r.enabled,
        minApprovals: String(r.minApprovals),
        dailyCap: String(r.dailyCap),
      })),
    },
    applyProfile: {
      enabled: config.applyProfile != null,
      email: config.applyProfile?.email ?? "",
      phone: config.applyProfile?.phone ?? "",
      linkedInUrl: config.applyProfile?.linkedInUrl ?? "",
      headline: config.applyProfile?.headline ?? "",
      bio: config.applyProfile?.bio ?? "",
      rateAnchor: config.applyProfile?.rateAnchor !== undefined ? String(config.applyProfile.rateAnchor) : "",
    },
  };
}

// -- Draft -> ConfigEdits --------------------------------------------------

/** Drops blank rows (an add-row the user never filled in) — never sent to the server as an empty string entry. */
function nonBlank(values: string[]): string[] {
  return values.filter((v) => v.trim() !== "");
}

/**
 * Converts a numeric-field draft string to a real `number` for the edits
 * payload — UNLESS it's blank or not a valid number, in which case the
 * ORIGINAL STRING is passed through unchanged instead. This is deliberate,
 * not an oversight: `Number("")` is `0` (a perfectly valid `ConfigSchema`
 * value), so silently coercing a cleared required field to `0` would defeat
 * this story's "a required Needs field cleared" validation-failure
 * acceptance criterion — the save would just succeed with a wrong-but-valid
 * `0`. Leaving a blank/invalid field as a string instead means
 * `ConfigSchema`'s `z.number()` check on the server rejects it with a
 * specific `needs.<field>: Expected number, received string` error, which
 * `saveConfigAction` surfaces verbatim in the form.
 */
function draftNumber(value: string): number | string {
  const n = Number(value);
  return value.trim() !== "" && !Number.isNaN(n) ? n : value;
}

function pairsToSettings(pairs: SettingPair[]): Record<string, unknown> | undefined {
  const nonBlankPairs = pairs.filter((p) => p.key.trim() !== "");
  if (nonBlankPairs.length === 0) return undefined;
  const settings: Record<string, unknown> = {};
  for (const p of nonBlankPairs) settings[p.key] = p.value; // literal string — never resolved
  return settings;
}

function draftToSource(draft: DraftSource): SourceConfig {
  const settings = pairsToSettings(draft.settings);
  return settings ? { id: draft.id, enabled: draft.enabled, settings } : { id: draft.id, enabled: draft.enabled };
}

/**
 * Builds the `ConfigEdits` object the Server Action sends to `saveConfig()`.
 * `profile`/`needs`/`sources` are always included (this form always submits
 * the complete current state of those three sections). `roleArea`/
 * `schedule` are included explicitly as `undefined` when their section is
 * disabled/empty — `saveConfig()`'s shallow top-level merge
 * (`{...currentRaw, ...edits}`) combined with `JSON.stringify` dropping
 * `undefined`-valued keys means an explicit `undefined` here correctly
 * un-sets a previously-saved section, while first-run (nothing on disk yet)
 * simply stays absent — either way, the written document never gets a
 * defaulted `roleArea: {}` or `schedule: ""` per this story's acceptance
 * criteria.
 */
function draftToEdits(draft: DraftConfig): ConfigEdits {
  // NOT typed as `Profile`/`Needs` here on purpose: draftNumber() can return
  // the original (invalid) string for a blank/non-numeric field, which is
  // exactly what should reach ConfigSchema.safeParse() server-side to
  // produce a specific `needs.<field>: Expected number...` error — typing
  // these as the strict domain interfaces would force a `number`-only shape
  // and mask that deliberately-invalid passthrough at compile time.
  const profile = {
    name: draft.profile.name,
    roles: nonBlank(draft.profile.roles),
    skills: nonBlank(draft.profile.skills),
    timezone: draft.profile.timezone,
    ...(draft.profile.homeBaseEnabled
      ? {
          homeBase: {
            city: draft.profile.homeBaseCity,
            lat: draftNumber(draft.profile.homeBaseLat),
            lng: draftNumber(draft.profile.homeBaseLng),
          },
        }
      : {}),
  };

  const needs = {
    engagementProfiles: draft.needs.engagementProfiles.map((p) => ({
      id: p.id,
      label: p.label,
      types: p.types,
      minRate: draftNumber(p.minRate),
      highRate: draftNumber(p.highRate),
      rateUnit: p.rateUnit,
      // maxHours/maxHoursAtHighRate are omitted entirely for a "year"
      // (salaried) profile — EngagementProfileSchema only requires them
      // when rateUnit is "hour" (see that schema's .refine()).
      ...(p.rateUnit === "hour"
        ? { maxHours: draftNumber(p.maxHours), maxHoursAtHighRate: draftNumber(p.maxHoursAtHighRate) }
        : {}),
    })),
    freshStageOnly: draft.needs.freshStageOnly,
    remoteOnly: draft.needs.remoteOnly,
  };

  const sources: SourceConfig[] = draft.sources.map(draftToSource);

  const edits: ConfigEdits = { profile, needs, sources };

  if (draft.roleArea.enabled) {
    const roleArea: RoleAreaConfig = {
      coreTitles: nonBlank(draft.roleArea.coreTitles),
      keywords: nonBlank(draft.roleArea.keywords),
      redKeywords: nonBlank(draft.roleArea.redKeywords),
    };
    edits.roleArea = roleArea;
  } else {
    edits.roleArea = undefined;
  }

  const schedule = draft.schedule.trim();
  edits.schedule = schedule === "" ? undefined : schedule;

  // Always sent as plain booleans -- see DraftConfig's own comment on why
  // these two don't need roleArea/schedule's enabled-flag tri-state.
  edits.autoDraftOnScan = draft.autoDraftOnScan;
  edits.notifyOnGreenMatch = draft.notifyOnGreenMatch;

  // NOT typed as AutoFireRuleConfig[] here on purpose -- same draftNumber()
  // invalid-passthrough reasoning as `needs` above.
  edits.autoFire = {
    killSwitch: draft.autoFire.killSwitch,
    rules: draft.autoFire.rules.map((r) => ({
      sourceId: r.sourceId,
      tier: r.tier,
      enabled: r.enabled,
      minApprovals: draftNumber(r.minApprovals),
      dailyCap: draftNumber(r.dailyCap),
    })),
  };

  // NOT typed as `ApplyProfileConfig` here on purpose — same reasoning as
  // `needs` above: `draftNumber(rateAnchor)` can return the original
  // (invalid) string for a non-numeric value, which must reach
  // `ConfigSchema.safeParse()` server-side to produce a specific
  // `applyProfile.rateAnchor: Expected number...` error rather than being
  // masked by a `number`-only type at compile time.
  if (draft.applyProfile.enabled) {
    const applyProfile: Record<string, unknown> = { email: draft.applyProfile.email };
    if (draft.applyProfile.phone.trim() !== "") applyProfile.phone = draft.applyProfile.phone;
    if (draft.applyProfile.linkedInUrl.trim() !== "") applyProfile.linkedInUrl = draft.applyProfile.linkedInUrl;
    if (draft.applyProfile.headline.trim() !== "") applyProfile.headline = draft.applyProfile.headline;
    if (draft.applyProfile.bio.trim() !== "") applyProfile.bio = draft.applyProfile.bio;
    if (draft.applyProfile.rateAnchor.trim() !== "") {
      applyProfile.rateAnchor = draftNumber(draft.applyProfile.rateAnchor);
    }
    edits.applyProfile = applyProfile;
  } else {
    edits.applyProfile = undefined;
  }

  return edits;
}

// ---------------------------------------------------------------------------
// Session capture (`session-capture-ui` story) — a "Capture login" button
// per `SourceConfig` row whose id is registered in `SOURCE_ORIGINS`
// (`src/lib/sources/origins.ts`). Purely user-driven per the design's
// decided no-polling approach: no `setInterval`/`setTimeout`/auto-refresh
// anywhere in this file — the only state transitions are the three explicit
// clicks below (Capture login / I'm done / Cancel), each firing exactly one
// Server Action call.
// ---------------------------------------------------------------------------

/**
 * One source row's capture UI state, keyed by row index in `captureState`
 * below (same "rows have no identity beyond position" convention the rest
 * of this file already uses for `draft.sources`). `waiting` is the state
 * while the real headed Chromium window is open and the human is logging
 * in at their own pace — `finishing`/`cancelling` are the same underlying
 * "waiting" screen with its two buttons momentarily disabled mid-click, not
 * a different screen, so a captureId is never lost between "I'm done" being
 * clicked and its Server Action resolving.
 */
type CaptureUIState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "waiting"; captureId: string; sourceId: string }
  | { status: "finishing"; captureId: string; sourceId: string }
  | { status: "cancelling"; captureId: string; sourceId: string }
  | { status: "success"; path: string }
  | { status: "error"; message: string };

/**
 * Adds/overwrites a single key in a `SettingPair[]` list, used to fold a
 * just-captured `sessionStatePath` into a source row's Settings pairs
 * editor immediately on success — see `handleFinishCapture()` below for why
 * this needs to happen in `draft` too, not just on disk.
 */
function upsertSettingPair(pairs: SettingPair[], key: string, value: string): SettingPair[] {
  const idx = pairs.findIndex((p) => p.key === key);
  if (idx < 0) return [...pairs, { key, value }];
  const next = [...pairs];
  next[idx] = { key, value };
  return next;
}

const captureButtonClass =
  "rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50";

/**
 * Renders one source row's capture control: the "Capture login" button in
 * its idle/success/error states, or the "browser window opened" waiting
 * screen (with "I'm done" + Cancel) once a capture is in flight. `sourceId`
 * is only used for the human-readable "log in to <source>" copy — never
 * re-derived from `state`, since `state.status === "idle"` carries no id at
 * all.
 */
function CaptureLoginControl({
  sourceId,
  state,
  onStart,
  onFinish,
  onCancel,
}: {
  sourceId: string;
  state: CaptureUIState;
  onStart: () => void;
  onFinish: () => void;
  onCancel: () => void;
}) {
  if (state.status === "waiting" || state.status === "finishing" || state.status === "cancelling") {
    const busy = state.status !== "waiting";
    return (
      <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p>
          A browser window opened — log in to {sourceId}, then click &ldquo;I&rsquo;m done&rdquo;.
        </p>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={onFinish} disabled={busy} className={captureButtonClass}>
            {state.status === "finishing" ? "Finishing…" : "I'm done"}
          </button>
          <button type="button" onClick={onCancel} disabled={busy} className={captureButtonClass}>
            {state.status === "cancelling" ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onStart}
        disabled={state.status === "starting"}
        className={captureButtonClass}
      >
        {state.status === "starting" ? "Opening browser…" : "Capture login"}
      </button>
      {state.status === "success" && (
        <p role="status" className="mt-1 text-xs text-green-700">
          Captured — saved to {state.path} and written to this source&rsquo;s settings.
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {state.message}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resume/link ingestion (`resume-link-ui` story) — the "Anthropic API key"
// field (writes to .env immediately, its own independent action) and the
// "Extract from resume/link" control (populates DRAFT state only; nothing
// persists until the form's own, separate, existing Save button). Both are
// plain async handlers with hand-rolled status state, matching this file's
// existing `CaptureUIState` convention above rather than `useTransition` —
// consistent with every other non-Save action already in this file.
// ---------------------------------------------------------------------------

type ApiKeyUIState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "success" }
  | { status: "error"; message: string };

type ExtractUIState =
  | { status: "idle" }
  | { status: "extracting" }
  | { status: "success"; warnings: string[] }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Small reusable pieces
// ---------------------------------------------------------------------------

const inputClass =
  "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none";
const labelClass = "block text-sm font-medium text-slate-700";
const sectionClass = "rounded-lg border border-slate-200 bg-white p-4";

function StringListEditor({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <span className={labelClass}>{label}</span>
      <div className="mt-1 flex flex-col gap-1.5">
        {values.map((v, i) => (
          // Index keys are acceptable here: rows have no identity of their
          // own beyond position, and this list is small/rarely reordered.
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="flex gap-2">
            <input
              type="text"
              value={v}
              placeholder={placeholder}
              onChange={(e) => {
                const next = [...values];
                next[i] = e.target.value;
                onChange(next);
              }}
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => onChange(values.filter((_, idx) => idx !== i))}
              className="shrink-0 text-xs text-red-600 hover:underline"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...values, ""])}
          className="self-start text-xs font-medium text-slate-600 hover:underline"
        >
          + Add
        </button>
      </div>
    </div>
  );
}

/**
 * Per-`auth` type Settings guidance — deliberately NOT a single generic
 * "e.g. env:API_KEY" hint for every source. That used to show for
 * `auth:"none"` sources like Braintrust, which need no credentials at all
 * (their settings, when present, are optional listing filters like
 * `roleIds`/`category`) — misleading, since it implied a key was expected.
 * Keyed by `Source.auth` (see KNOWN_SOURCES in src/lib/sources/origins.ts,
 * which mirrors each adapter's real `auth` field).
 */
const SETTINGS_HINT_BY_AUTH: Record<"none" | "api-key" | "browser-session", { placeholder: string; note?: string }> = {
  none: {
    placeholder: "value (optional listing filter — this source needs no credentials)",
  },
  "api-key": {
    placeholder: "value — e.g. env:YOUR_API_KEY",
    note: "This source needs an API key. Store the real value in a local .env file and reference it as env:VAR_NAME — never paste the raw key here.",
  },
  "browser-session": {
    placeholder: "value — e.g. a sessionStatePath, or env:VAR_NAME",
    note: "This source authenticates via a captured browser session (see \"Capture login\" below), not an API key. settings.sessionStatePath points at the saved session file.",
  },
};

/** SourceConfig.settings key/value PAIRS editor — deliberately not a raw JSON textarea (see this story's spec). */
function SettingsEditor({
  pairs,
  onChange,
  auth,
}: {
  pairs: SettingPair[];
  onChange: (next: SettingPair[]) => void;
  /** The selected source's auth type, if known — drives the value hint below. Undefined (e.g. no source selected yet) falls back to a generic hint. */
  auth?: "none" | "api-key" | "browser-session";
}) {
  const hint = auth ? SETTINGS_HINT_BY_AUTH[auth] : undefined;
  const valuePlaceholder = hint?.placeholder ?? "value";
  return (
    <div>
      <span className={labelClass}>Settings</span>
      {hint?.note && <p className="mt-0.5 text-xs text-slate-500">{hint.note}</p>}
      <div className="mt-1 flex flex-col gap-1.5">
        {pairs.map((pair, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="flex gap-2">
            <input
              type="text"
              value={pair.key}
              placeholder="key (e.g. apiKey)"
              onChange={(e) => {
                const key = e.target.value;
                onChange(pairs.map((p, idx) => (idx === i ? { ...p, key } : p)));
              }}
              className={`${inputClass} max-w-[10rem]`}
            />
            <input
              type="text"
              value={pair.value}
              placeholder={valuePlaceholder}
              onChange={(e) => {
                const value = e.target.value;
                onChange(pairs.map((p, idx) => (idx === i ? { ...p, value } : p)));
              }}
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => onChange(pairs.filter((_, idx) => idx !== i))}
              className="shrink-0 text-xs text-red-600 hover:underline"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...pairs, { key: "", value: "" }])}
          className="self-start text-xs font-medium text-slate-600 hover:underline"
        >
          + Add setting
        </button>
      </div>
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300"
      />
      {label}
    </label>
  );
}

/**
 * `Needs.engagementProfiles` editor — a repeatable list, same "+ Add" /
 * "Remove" pattern as SettingsEditor above. Each profile is its own
 * engagement-type checklist + rate/hours threshold — see EngagementProfile
 * in src/lib/types.ts for the full semantics (a gig can clear more than one
 * profile at once; matching/gate.ts checks every applicable one, not just
 * the first).
 */
function EngagementProfilesEditor({
  profiles,
  onChange,
}: {
  profiles: DraftEngagementProfile[];
  onChange: (next: DraftEngagementProfile[]) => void;
}) {
  return (
    <div className="mt-3 flex flex-col gap-3">
      {profiles.map((p, i) => (
        <div key={p.id} className="rounded-md border border-slate-200 p-3">
          <div className="flex items-end gap-3">
            <label className="flex-1">
              <span className={labelClass}>Profile label</span>
              <input
                type="text"
                value={p.label}
                placeholder="e.g. Fractional/contract"
                onChange={(e) =>
                  onChange(profiles.map((pp, idx) => (idx === i ? { ...pp, label: e.target.value } : pp)))
                }
                className={inputClass}
              />
            </label>
            <label>
              <span className={labelClass}>Rate unit</span>
              <select
                value={p.rateUnit}
                onChange={(e) =>
                  onChange(
                    profiles.map((pp, idx) =>
                      idx === i ? { ...pp, rateUnit: e.target.value as "hour" | "year" } : pp,
                    ),
                  )
                }
                className={inputClass}
              >
                <option value="hour">$/hour</option>
                <option value="year">$/year (total comp)</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => onChange(profiles.filter((_, idx) => idx !== i))}
              className="shrink-0 text-xs text-red-600 hover:underline"
            >
              Remove profile
            </button>
          </div>

          <div className="mt-2 flex flex-wrap gap-3">
            {ALL_ENGAGEMENT_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={p.types.includes(t)}
                  onChange={(e) => {
                    const types = e.target.checked ? [...p.types, t] : p.types.filter((x) => x !== t);
                    onChange(profiles.map((pp, idx) => (idx === i ? { ...pp, types } : pp)));
                  }}
                  className="h-4 w-4 rounded border-slate-300"
                />
                {ENGAGEMENT_TYPE_LABEL[t]}
              </label>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label>
              <span className={labelClass}>Minimum rate ({p.rateUnit === "hour" ? "$/hr" : "$/yr"})</span>
              <input
                type="number"
                value={p.minRate}
                onChange={(e) =>
                  onChange(profiles.map((pp, idx) => (idx === i ? { ...pp, minRate: e.target.value } : pp)))
                }
                className={inputClass}
              />
            </label>
            <label>
              <span className={labelClass}>High rate ({p.rateUnit === "hour" ? "$/hr" : "$/yr"})</span>
              <input
                type="number"
                value={p.highRate}
                onChange={(e) =>
                  onChange(profiles.map((pp, idx) => (idx === i ? { ...pp, highRate: e.target.value } : pp)))
                }
                className={inputClass}
              />
            </label>
            {p.rateUnit === "hour" && (
              <>
                <label>
                  <span className={labelClass}>Max weekly hours</span>
                  <input
                    type="number"
                    value={p.maxHours}
                    onChange={(e) =>
                      onChange(profiles.map((pp, idx) => (idx === i ? { ...pp, maxHours: e.target.value } : pp)))
                    }
                    className={inputClass}
                  />
                </label>
                <label>
                  <span className={labelClass}>Max weekly hours at high rate</span>
                  <input
                    type="number"
                    value={p.maxHoursAtHighRate}
                    onChange={(e) =>
                      onChange(
                        profiles.map((pp, idx) => (idx === i ? { ...pp, maxHoursAtHighRate: e.target.value } : pp)),
                      )
                    }
                    className={inputClass}
                  />
                </label>
              </>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...profiles, defaultEngagementProfile()])}
        className="self-start text-xs font-medium text-slate-600 hover:underline"
      >
        + Add profile
      </button>
    </div>
  );
}

const TIER_OPTIONS: Tier[] = ["green", "yellow", "red"];

/** One rule row's live "N/minApprovals approved" trust status -- fetched on demand only (no polling/auto-refresh, same discipline session-capture-ui already established in this file). */
type TrustStatus = { status: "idle" } | { status: "loading" } | { status: "loaded"; approvedCount: number } | { status: "error"; message: string };

/**
 * `Config.autoFire.rules` editor — the graduated-auto-fire-trust epic's
 * per-`(sourceId, tier)` rule list, same repeatable-list "+ Add" / "Remove"
 * pattern as `EngagementProfilesEditor` above. Each row's "Check status"
 * button calls `getAutoFireApprovedCountAction()` (read-only) and shows a
 * real "N/minApprovals approved" + graduated/not-graduated badge computed
 * against the row's CURRENT (possibly unsaved) minApprovals value.
 */
function AutoFireRulesEditor({
  rules,
  onChange,
}: {
  rules: DraftAutoFireRule[];
  onChange: (next: DraftAutoFireRule[]) => void;
}) {
  const [statusByIndex, setStatusByIndex] = useState<Record<number, TrustStatus>>({});

  async function checkStatus(i: number, rule: DraftAutoFireRule) {
    if (rule.sourceId.trim() === "") return;
    setStatusByIndex((prev) => ({ ...prev, [i]: { status: "loading" } }));
    const result = await getAutoFireApprovedCountAction(rule.sourceId, rule.tier);
    setStatusByIndex((prev) => ({
      ...prev,
      [i]: result.ok ? { status: "loaded", approvedCount: result.data } : { status: "error", message: result.error },
    }));
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {rules.map((r, i) => {
        const minApprovals = Number(r.minApprovals);
        const s = statusByIndex[i] ?? { status: "idle" };
        return (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="rounded-md border border-slate-200 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <label>
                <span className={labelClass}>Source</span>
                <select
                  value={r.sourceId}
                  onChange={(e) => onChange(rules.map((rr, idx) => (idx === i ? { ...rr, sourceId: e.target.value } : rr)))}
                  className={inputClass}
                >
                  <option value="" disabled>
                    Select a source…
                  </option>
                  {KNOWN_SOURCES.map((s2) => (
                    <option key={s2.id} value={s2.id}>
                      {s2.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelClass}>Tier</span>
                <select
                  value={r.tier}
                  onChange={(e) => onChange(rules.map((rr, idx) => (idx === i ? { ...rr, tier: e.target.value as Tier } : rr)))}
                  className={inputClass}
                >
                  {TIER_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelClass}>Min approvals to graduate</span>
                <input
                  type="number"
                  value={r.minApprovals}
                  onChange={(e) => onChange(rules.map((rr, idx) => (idx === i ? { ...rr, minApprovals: e.target.value } : rr)))}
                  className={inputClass}
                />
              </label>
              <label>
                <span className={labelClass}>Daily fire cap</span>
                <input
                  type="number"
                  value={r.dailyCap}
                  onChange={(e) => onChange(rules.map((rr, idx) => (idx === i ? { ...rr, dailyCap: e.target.value } : rr)))}
                  className={inputClass}
                />
              </label>
              <CheckboxField
                label="Enabled"
                checked={r.enabled}
                onChange={(enabled) => onChange(rules.map((rr, idx) => (idx === i ? { ...rr, enabled } : rr)))}
              />
              <button
                type="button"
                onClick={() => onChange(rules.filter((_, idx) => idx !== i))}
                className="shrink-0 text-xs text-red-600 hover:underline"
              >
                Remove rule
              </button>
            </div>

            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => checkStatus(i, r)}
                disabled={r.sourceId.trim() === "" || s.status === "loading"}
                className="text-xs font-medium text-slate-600 hover:underline disabled:opacity-50"
              >
                {s.status === "loading" ? "Checking…" : "Check status"}
              </button>
              {s.status === "loaded" && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    s.approvedCount >= minApprovals
                      ? "bg-green-100 text-green-800"
                      : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {s.approvedCount}/{r.minApprovals || 0} approved —{" "}
                  {s.approvedCount >= minApprovals ? "graduated" : "not yet graduated"}
                </span>
              )}
              {s.status === "error" && <span className="text-xs text-red-700">{s.message}</span>}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...rules, defaultAutoFireRule()])}
        className="self-start text-xs font-medium text-slate-600 hover:underline"
      >
        + Add rule
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * The config-editing form (`config-editing-ui` story). Receives the already
 * pre-populated (or blank, for first-run) `Config` from the Server Component
 * parent (src/app/config/page.tsx) and owns all editing state client-side,
 * submitting the whole document via `saveConfigAction` (src/app/config/actions.ts)
 * on Save — the same `{ok,error}` Server Action convention
 * `updateGigStatusAction` established (src/app/actions.ts).
 */
export function ConfigClient({ initial }: { initial: Config }) {
  const [draft, setDraft] = useState<DraftConfig>(() => configToDraft(initial));
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // "Start from a template" (role-templates story) — pure client-side draft
  // state, no Server Action involved. Applying OVERWRITES whatever's
  // currently in coreTitles/keywords/redKeywords with no confirmation
  // dialog: decided v1 behavior (see ROLE_TEMPLATES's design discussion),
  // trivially re-editable before Save.
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(ROLE_TEMPLATES[0]?.id ?? "");

  function handleApplyTemplate() {
    const template = ROLE_TEMPLATES.find((t) => t.id === selectedTemplateId);
    if (!template) return;
    setDraft((prev) => ({
      ...prev,
      roleArea: {
        enabled: true,
        coreTitles: [...template.config.coreTitles],
        keywords: [...template.config.keywords],
        redKeywords: [...template.config.redKeywords],
      },
    }));
  }

  // Session-capture state, keyed by source row index — deliberately separate
  // from `draft`/`isPending` above: capture actions are independent,
  // per-row, user-driven flows that don't submit the whole form. See the
  // "Session capture" section above for `CaptureUIState`.
  const [captureState, setCaptureState] = useState<Record<number, CaptureUIState>>({});

  function setRowCapture(i: number, next: CaptureUIState) {
    setCaptureState((prev) => ({ ...prev, [i]: next }));
  }

  async function handleStartCapture(i: number, sourceId: string) {
    setRowCapture(i, { status: "starting" });
    const result = await startCaptureAction(sourceId);
    if (!result.ok) {
      setRowCapture(i, { status: "error", message: result.error });
      return;
    }
    setRowCapture(i, { status: "waiting", captureId: result.data.captureId, sourceId });
  }

  async function handleFinishCapture(i: number, captureId: string, sourceId: string) {
    setRowCapture(i, { status: "finishing", captureId, sourceId });
    const result = await finishCaptureAction(captureId, sourceId);
    if (!result.ok) {
      // Show the SPECIFIC error finishCaptureAction/finishCapture() returned
      // (e.g. the zero-cookies sanity check message) — never a generic
      // "capture failed" string.
      setRowCapture(i, { status: "error", message: result.error });
      return;
    }
    // Fold the captured path into this row's draft settings too, not just
    // on disk — otherwise a later "Save config" click (which resubmits the
    // WHOLE `sources` section) would silently overwrite the just-auto-written
    // sessionStatePath with whatever the in-memory draft still had, undoing
    // this action's own write.
    setDraft((prev) => ({
      ...prev,
      sources: prev.sources.map((s, idx) =>
        idx === i ? { ...s, settings: upsertSettingPair(s.settings, "sessionStatePath", result.data.path) } : s,
      ),
    }));
    setRowCapture(i, { status: "success", path: result.data.path });
  }

  async function handleCancelCapture(i: number, captureId: string, sourceId: string) {
    setRowCapture(i, { status: "cancelling", captureId, sourceId });
    const result = await cancelCaptureAction(captureId);
    if (!result.ok) {
      setRowCapture(i, { status: "error", message: result.error });
      return;
    }
    setRowCapture(i, { status: "idle" });
  }

  // -- Anthropic API key ("resume-link-ui" story) --------------------------
  // Writes straight to .env via setAnthropicApiKeyAction, independent of
  // draft/Save — see design_decisions in
  // .pHive/epics/profile-overview-ingestion/stories/resume-link-ui.yaml.
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [apiKeyState, setApiKeyState] = useState<ApiKeyUIState>({ status: "idle" });

  async function handleSetApiKey() {
    setApiKeyState({ status: "saving" });
    const formData = new FormData();
    formData.set("apiKey", apiKeyValue);
    const result = await setAnthropicApiKeyAction(formData);
    if (!result.ok) {
      setApiKeyState({ status: "error", message: result.error });
      return;
    }
    setApiKeyState({ status: "success" });
  }

  // -- Extract from resume/link ("resume-link-ui" story) -------------------
  // Populates DRAFT profile.roles/skills only, MERGED (not replaced) via
  // mergeDedupe() — never auto-applied, never persisted until the user's
  // own Save click below.
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [linksText, setLinksText] = useState("");
  const [extractState, setExtractState] = useState<ExtractUIState>({ status: "idle" });

  function handleResumeFileChange(e: ChangeEvent<HTMLInputElement>) {
    setResumeFile(e.target.files?.[0] ?? null);
  }

  async function handleExtract() {
    setExtractState({ status: "extracting" });
    const formData = new FormData();
    if (resumeFile) formData.set("resumeFile", resumeFile);
    formData.set("links", linksText);

    const result = await extractProfileFromResumeAction(formData);
    if (!result.ok) {
      setExtractState({ status: "error", message: result.error });
      return;
    }

    // Merge, never replace — extracted roles/skills are additive enrichment
    // of whatever's already in the draft (which may itself hold unsaved
    // hand-edits), deliberately unlike role-templates' overwrite-on-apply.
    setDraft((prev) => ({
      ...prev,
      profile: {
        ...prev.profile,
        roles: mergeDedupe(prev.profile.roles, result.data.roles),
        skills: mergeDedupe(prev.profile.skills, result.data.skills),
      },
    }));
    setExtractState({ status: "success", warnings: result.data.warnings });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSavedAt(null);
    const edits = draftToEdits(draft);
    startTransition(async () => {
      const result = await saveConfigAction(edits);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Resync the form with the server's validated, written document —
      // e.g. a source added with a blank id/settings row got dropped.
      setDraft(configToDraft(result.data));
      setSavedAt(Date.now());
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="whitespace-pre-wrap rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}
      {savedAt && !error && (
        <div role="status" className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          Saved.
        </div>
      )}

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold text-slate-900">Profile</h2>
        <div className="mt-3 flex flex-col gap-3">
          <label>
            <span className={labelClass}>Name</span>
            <input
              type="text"
              value={draft.profile.name}
              onChange={(e) => setDraft({ ...draft, profile: { ...draft.profile, name: e.target.value } })}
              className={inputClass}
            />
          </label>
          <StringListEditor
            label="Roles"
            values={draft.profile.roles}
            onChange={(roles) => setDraft({ ...draft, profile: { ...draft.profile, roles } })}
            placeholder="e.g. Fractional CTO"
          />
          <StringListEditor
            label="Skills"
            values={draft.profile.skills}
            onChange={(skills) => setDraft({ ...draft, profile: { ...draft.profile, skills } })}
            placeholder="e.g. TypeScript"
          />
          <label>
            <span className={labelClass}>Timezone</span>
            <input
              type="text"
              value={draft.profile.timezone}
              onChange={(e) => setDraft({ ...draft, profile: { ...draft.profile, timezone: e.target.value } })}
              placeholder="e.g. America/Chicago"
              className={inputClass}
            />
          </label>

          <CheckboxField
            label="Set a home base (optional)"
            checked={draft.profile.homeBaseEnabled}
            onChange={(homeBaseEnabled) => setDraft({ ...draft, profile: { ...draft.profile, homeBaseEnabled } })}
          />
          {draft.profile.homeBaseEnabled && (
            <div className="grid grid-cols-3 gap-2 pl-5">
              <label>
                <span className={labelClass}>City</span>
                <input
                  type="text"
                  value={draft.profile.homeBaseCity}
                  onChange={(e) =>
                    setDraft({ ...draft, profile: { ...draft.profile, homeBaseCity: e.target.value } })
                  }
                  className={inputClass}
                />
              </label>
              <label>
                <span className={labelClass}>Latitude</span>
                <input
                  type="number"
                  step="any"
                  value={draft.profile.homeBaseLat}
                  onChange={(e) =>
                    setDraft({ ...draft, profile: { ...draft.profile, homeBaseLat: e.target.value } })
                  }
                  className={inputClass}
                />
              </label>
              <label>
                <span className={labelClass}>Longitude</span>
                <input
                  type="number"
                  step="any"
                  value={draft.profile.homeBaseLng}
                  onChange={(e) =>
                    setDraft({ ...draft, profile: { ...draft.profile, homeBaseLng: e.target.value } })
                  }
                  className={inputClass}
                />
              </label>
            </div>
          )}

          <div className="mt-2 border-t border-slate-200 pt-3">
            <span className={labelClass}>Anthropic API key</span>
            <p className="text-xs text-slate-500">
              Writes directly to <code>.env</code> (encrypted at rest) — not <code>config.json</code> — and
              saves immediately, separately from this form&rsquo;s Save button below.
            </p>
            <div className="mt-1 flex gap-2">
              <input
                type="password"
                value={apiKeyValue}
                onChange={(e) => setApiKeyValue(e.target.value)}
                placeholder="sk-ant-..."
                autoComplete="off"
                className={inputClass}
              />
              <button
                type="button"
                onClick={handleSetApiKey}
                disabled={apiKeyState.status === "saving" || apiKeyValue.trim() === ""}
                className={`shrink-0 ${captureButtonClass}`}
              >
                {apiKeyState.status === "saving" ? "Saving…" : "Save key"}
              </button>
            </div>
            {apiKeyState.status === "success" && (
              <p role="status" className="mt-1 text-xs text-green-700">
                Anthropic API key saved to .env.
              </p>
            )}
            {apiKeyState.status === "error" && (
              <p role="alert" className="mt-1 text-xs text-red-700">
                {apiKeyState.message}
              </p>
            )}
          </div>

          <div className="border-t border-slate-200 pt-3">
            <span className={labelClass}>Extract from resume/link</span>
            <p className="text-xs text-slate-500">
              Sends the resume and/or link content to Anthropic&rsquo;s API using the key above. Extracted
              roles/skills are MERGED into the Roles/Skills fields above (existing entries are kept, never
              overwritten) — review and edit as needed, nothing is saved until you click &ldquo;Save
              config&rdquo; below. GitHub profiles and personal portfolio/blog links work well; LinkedIn
              links are not reliably supported (bot-walled against unauthenticated fetches).
            </p>
            <div className="mt-2 flex flex-col gap-2">
              <label>
                <span className={labelClass}>Resume (PDF or plain text)</span>
                <input
                  type="file"
                  accept=".pdf,application/pdf,.txt,text/plain"
                  onChange={handleResumeFileChange}
                  className={inputClass}
                />
              </label>
              <label>
                <span className={labelClass}>Links (one per line)</span>
                <textarea
                  value={linksText}
                  onChange={(e) => setLinksText(e.target.value)}
                  placeholder={"https://github.com/yourhandle\nhttps://yourportfolio.dev"}
                  rows={3}
                  className={inputClass}
                />
              </label>
              <button
                type="button"
                onClick={handleExtract}
                disabled={extractState.status === "extracting" || (!resumeFile && linksText.trim() === "")}
                className={`self-start ${captureButtonClass}`}
              >
                {extractState.status === "extracting" ? "Extracting…" : "Extract from resume/link"}
              </button>
            </div>
            {extractState.status === "success" && (
              <div className="mt-2">
                <p role="status" className="text-xs text-green-700">
                  Extracted roles/skills merged into the fields above — review, edit, then Save.
                </p>
                {extractState.warnings.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {extractState.warnings.map((w, i) => (
                      // Index keys are acceptable here: this is a fresh,
                      // append-only list rendered once per successful
                      // extraction, never reordered/edited in place.
                      // eslint-disable-next-line react/no-array-index-key
                      <li key={i} role="alert" className="text-xs text-amber-700">
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {extractState.status === "error" && (
              <p role="alert" className="mt-1 text-xs text-red-700">
                {extractState.message}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold text-slate-900">Needs</h2>
        <p className="text-xs text-slate-500">
          At least one engagement profile is required — this is the gate's hard constraint set. A gig is checked
          against every profile whose engagement type it matches (a listing can clear more than one); each profile
          has its own rate floor, so e.g. a low-ball full-time salary can be excluded even while a good hourly
          contract rate passes.
        </p>
        <EngagementProfilesEditor
          profiles={draft.needs.engagementProfiles}
          onChange={(engagementProfiles) => setDraft({ ...draft, needs: { ...draft.needs, engagementProfiles } })}
        />
        <div className="mt-3 flex flex-wrap gap-4">
          <CheckboxField
            label="Fresh-stage listings only"
            checked={draft.needs.freshStageOnly}
            onChange={(v) => setDraft({ ...draft, needs: { ...draft.needs, freshStageOnly: v } })}
          />
          <CheckboxField
            label="Remote only"
            checked={draft.needs.remoteOnly}
            onChange={(v) => setDraft({ ...draft, needs: { ...draft.needs, remoteOnly: v } })}
          />
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold text-slate-900">Sources</h2>
        <div className="mt-3 flex flex-col gap-4">
          {draft.sources.map((source, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="rounded-md border border-slate-200 p-3">
              <div className="flex items-end gap-3">
                <label className="flex-1">
                  <span className={labelClass}>Source</span>
                  <select
                    value={source.id}
                    onChange={(e) => {
                      const id = e.target.value;
                      setDraft({
                        ...draft,
                        sources: draft.sources.map((s, idx) => (idx === i ? { ...s, id } : s)),
                      });
                    }}
                    className={inputClass}
                  >
                    <option value="" disabled>
                      Select a source…
                    </option>
                    {KNOWN_SOURCES.map((known) => (
                      <option key={known.id} value={known.id}>
                        {known.label}
                      </option>
                    ))}
                  </select>
                </label>
                <CheckboxField
                  label="Enabled"
                  checked={source.enabled}
                  onChange={(enabled) => {
                    setDraft({
                      ...draft,
                      sources: draft.sources.map((s, idx) => (idx === i ? { ...s, enabled } : s)),
                    });
                  }}
                />
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, sources: draft.sources.filter((_, idx) => idx !== i) })}
                  className="shrink-0 text-xs text-red-600 hover:underline"
                >
                  Remove source
                </button>
              </div>
              <div className="mt-2">
                <SettingsEditor
                  pairs={source.settings}
                  auth={KNOWN_SOURCES.find((known) => known.id === source.id)?.auth}
                  onChange={(settings) => {
                    setDraft({
                      ...draft,
                      sources: draft.sources.map((s, idx) => (idx === i ? { ...s, settings } : s)),
                    });
                  }}
                />
              </div>
              {source.id in SOURCE_ORIGINS && (
                <CaptureLoginControl
                  sourceId={source.id}
                  state={captureState[i] ?? { status: "idle" }}
                  onStart={() => handleStartCapture(i, source.id)}
                  onFinish={() => {
                    const rowState = captureState[i];
                    if (rowState?.status === "waiting") handleFinishCapture(i, rowState.captureId, rowState.sourceId);
                  }}
                  onCancel={() => {
                    const rowState = captureState[i];
                    if (rowState?.status === "waiting") handleCancelCapture(i, rowState.captureId, rowState.sourceId);
                  }}
                />
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setDraft({ ...draft, sources: [...draft.sources, { id: "", enabled: true, settings: [] }] })
            }
            className="self-start text-sm font-medium text-slate-600 hover:underline"
          >
            + Add source
          </button>
        </div>
      </section>

      <section className={sectionClass}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Role area (optional)</h2>
          <CheckboxField
            label="Configure role-area filtering"
            checked={draft.roleArea.enabled}
            onChange={(enabled) => setDraft({ ...draft, roleArea: { ...draft.roleArea, enabled } })}
          />
        </div>
        <p className="text-xs text-slate-500">
          Left off, every gig tiers &quot;yellow&quot; — the do-nothing default, not an error.
        </p>
        <div className="mt-3 flex items-end gap-2">
          <label className="flex-1">
            <span className={labelClass}>Start from a template</span>
            <select
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              className={inputClass}
            >
              {ROLE_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={handleApplyTemplate} className={captureButtonClass}>
            Apply
          </button>
        </div>
        {draft.roleArea.enabled && (
          <div className="mt-3 flex flex-col gap-3">
            <StringListEditor
              label="Core titles (unambiguous title matches — always GREEN)"
              values={draft.roleArea.coreTitles}
              onChange={(coreTitles) => setDraft({ ...draft, roleArea: { ...draft.roleArea, coreTitles } })}
            />
            <StringListEditor
              label="Keywords (broader green signals)"
              values={draft.roleArea.keywords}
              onChange={(keywords) => setDraft({ ...draft, roleArea: { ...draft.roleArea, keywords } })}
            />
            <StringListEditor
              label="Red keywords (title-only hard stop, unless a core title also matches)"
              values={draft.roleArea.redKeywords}
              onChange={(redKeywords) => setDraft({ ...draft, roleArea: { ...draft.roleArea, redKeywords } })}
            />
          </div>
        )}
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold text-slate-900">Schedule (optional)</h2>
        <label>
          <span className={labelClass}>Cron expression</span>
          <input
            type="text"
            value={draft.schedule}
            placeholder="e.g. 0 9 * * * (leave blank for no scheduled runs)"
            onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}
            className={inputClass}
          />
        </label>
        <p className="mt-3 text-xs text-slate-500">
          Only take effect while the scheduler (<code>npm run scheduler</code>) is running.
        </p>
        <div className="mt-2 flex flex-col gap-2">
          <CheckboxField
            label="Auto-draft new green-tier matches each scan"
            checked={draft.autoDraftOnScan}
            onChange={(v) => setDraft({ ...draft, autoDraftOnScan: v })}
          />
          <CheckboxField
            label="Notify (desktop) on new green-tier matches each scan"
            checked={draft.notifyOnGreenMatch}
            onChange={(v) => setDraft({ ...draft, notifyOnGreenMatch: v })}
          />
        </div>
      </section>

      <section className={sectionClass}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Apply profile (optional)</h2>
          <CheckboxField
            label="Configure apply profile"
            checked={draft.applyProfile.enabled}
            onChange={(enabled) => setDraft({ ...draft, applyProfile: { ...draft.applyProfile, enabled } })}
          />
        </div>
        <p className="text-xs text-slate-500">
          The apply-specific fields a real application form needs (beyond Profile above) — email, phone,
          LinkedIn, a short headline/bio, and a rate to anchor. Left off, drafting an application throws until
          this is configured. Encrypted at rest like every other field in <code>config.json</code>.
        </p>
        {draft.applyProfile.enabled && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label>
              <span className={labelClass}>Email</span>
              <input
                type="email"
                value={draft.applyProfile.email}
                onChange={(e) =>
                  setDraft({ ...draft, applyProfile: { ...draft.applyProfile, email: e.target.value } })
                }
                className={inputClass}
              />
            </label>
            <label>
              <span className={labelClass}>Phone</span>
              <input
                type="text"
                value={draft.applyProfile.phone}
                onChange={(e) =>
                  setDraft({ ...draft, applyProfile: { ...draft.applyProfile, phone: e.target.value } })
                }
                className={inputClass}
              />
            </label>
            <label>
              <span className={labelClass}>LinkedIn URL</span>
              <input
                type="text"
                value={draft.applyProfile.linkedInUrl}
                onChange={(e) =>
                  setDraft({ ...draft, applyProfile: { ...draft.applyProfile, linkedInUrl: e.target.value } })
                }
                placeholder="https://linkedin.com/in/..."
                className={inputClass}
              />
            </label>
            <label>
              <span className={labelClass}>Rate anchor ($/hr)</span>
              <input
                type="number"
                value={draft.applyProfile.rateAnchor}
                onChange={(e) =>
                  setDraft({ ...draft, applyProfile: { ...draft.applyProfile, rateAnchor: e.target.value } })
                }
                className={inputClass}
              />
            </label>
            <label className="col-span-2">
              <span className={labelClass}>Headline</span>
              <input
                type="text"
                value={draft.applyProfile.headline}
                onChange={(e) =>
                  setDraft({ ...draft, applyProfile: { ...draft.applyProfile, headline: e.target.value } })
                }
                className={inputClass}
              />
            </label>
            <label className="col-span-2">
              <span className={labelClass}>Bio</span>
              <textarea
                value={draft.applyProfile.bio}
                onChange={(e) =>
                  setDraft({ ...draft, applyProfile: { ...draft.applyProfile, bio: e.target.value } })
                }
                rows={3}
                className={inputClass}
              />
            </label>
          </div>
        )}
      </section>

      <section className={sectionClass}>
        <h2 className="text-lg font-semibold text-slate-900">Auto-fire (optional)</h2>
        <p className="text-xs text-slate-500">
          Real, automatic application submission — off by default, and gated: a rule only ever fires once
          you&apos;ve manually approved at least its own <code>minApprovals</code> drafts for that exact
          source/tier pair. See docs/ARCHITECTURE.md for the full trust/decision-tree contract.
        </p>

        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3">
          <CheckboxField
            label="Kill switch — force-disable ALL auto-fire, regardless of the rules below"
            checked={draft.autoFire.killSwitch}
            onChange={(killSwitch) => setDraft({ ...draft, autoFire: { ...draft.autoFire, killSwitch } })}
          />
        </div>

        <AutoFireRulesEditor
          rules={draft.autoFire.rules}
          onChange={(rules) => setDraft({ ...draft, autoFire: { ...draft.autoFire, rules } })}
        />
      </section>

      <div>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md border border-slate-900 bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save config"}
        </button>
      </div>
    </form>
  );
}
