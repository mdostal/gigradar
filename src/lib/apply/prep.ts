// career-crm epic, prep-packet-mechanism story. A per-gig "judgment" tool
// -- fit/gap analysis + interview prep, grounded strictly in gigradar's
// own structured Profile/ApplyProfileConfig/Gig data. Follows draft.ts's
// REAL shape exactly (one LLM call, forced structured output via the
// Vercel AI SDK -- see llm-provider-harness epic's design-discussion.md
// §2.5 -- `credential` a required parameter resolved by the caller, never
// module-scope) and REUSES draft.ts's
// buildApplicantDataBlock()/buildGigDataBlock() directly rather than a
// second, duplicated implementation that could drift out of sync (the
// same reason profile-suggest.ts already reuses buildApplicantDataBlock()).
//
// Ports personal-site's match-score/interview-prep PROMPT CONTENT (see
// .pHive/epics/career-crm/docs/design-discussion.md §1, §5) onto this
// mechanism -- never that source's raw-JSON.parse() mechanism (NOT the
// same thing as this codebase's own, later, DELIBERATE Vercel AI SDK
// adoption above -- that source's version bypassed forced structured
// output entirely via a hand-rolled JSON.parse() of free text), and never
// its hardcoded-profile-string "resume match" input (this repo's own
// structured Profile replaces that).
//
// ONE combined call, not personal-site's two separate ones (match-score +
// interview-prep chat mode) -- cheaper, and predicted questions naturally
// cohere with the same gaps the fit analysis surfaces when generated
// together. See design-discussion.md §5.
//
// keyGaps/predictedQuestions are LLM SYNTHESIS, not verbatim extraction --
// the no-fabricated-data rule here means "never invent a FACT about the
// gig/profile" (a skill, a rate, a requirement that isn't actually
// present), not "never reason." Reasoning about the real facts is the
// entire point of a judgment tool. See design-discussion.md's
// design_decisions in the story YAML.
import { type FilePart, NoOutputGeneratedError, Output, type TextPart, generateText } from "ai";
import { z } from "zod";
import { loadResume, pickResume } from "../documents/resume-store.js";
import { buildResumeContentBlock } from "../profile-ingestion/extract.js";
import type { ApplyProfileConfig, Gig, Profile } from "../types.js";
import { createAiSdkModel, generateHarnessObject, toHarnessContentBlocks } from "../config/llm-client.js";
import type { LlmCredential } from "../config/env-store.js";
import { buildApplicantDataBlock, buildGigDataBlock } from "./draft.js";

const PREP_TOOL_NAME = "report_prep_packet";

/** Only attach a per-resume ranking request when this many (or more) resumes are actually on file -- "which fits best" is meaningless with zero or one. */
const MIN_RESUMES_FOR_RANKING = 2;

const PrepResultSchema = z.object({
  score: z.number().describe("Overall fit score, 1-100."),
  rationale: z.string().describe("A short explanation of the score, grounded in the real applicant/gig data."),
  topStrengths: z.array(z.string()).describe("The strongest real alignments between the applicant's actual profile and this gig."),
  keyGaps: z.array(z.string()).describe("Real gaps between the applicant's actual profile and this gig's stated requirements -- never invented requirements the listing doesn't state."),
  recommendation: z.string().describe("A short, actionable recommendation: pursue, pursue with caveats, or pass, and why."),
  predictedQuestions: z.array(z.string()).describe("Interview questions this specific gig's listing and the identified gaps make likely."),
  starlaStories: z.array(z.string()).describe("STARLA-format (Situation/Task/Action/Result/Learning/Application) story prompts drawn from the applicant's real profile that address this gig's likely questions/gaps."),
  keywordOverlapScore: z.number().describe("1-100: how well the applicant's tracked skills/roles overlap with this specific listing's own stated keywords -- an ATS-keyword-matching lens, distinct from the holistic fit score above."),
  matchedKeywords: z.array(z.string()).describe("Skills/role terms from the applicant's real profile that are ALSO explicitly present in this listing's text."),
  missingKeywords: z.array(z.string()).describe("Keywords this listing's text explicitly emphasizes that are NOT present anywhere in the applicant's tracked skills/roles."),
  resumeTweaks: z.array(z.string()).describe("Concrete, ATS-mechanical actions to close the keyword gap -- each MUST name a specific missingKeywords entry and where/how many times it appears in the listing. Never generic advice."),
  parseabilityIssues: z
    .array(z.string())
    .describe(
      "ONLY when a real resume file/document was actually attached to this request: specific, observable format/structure problems that would trip up an automated ATS parser (multi-column layout, tables, text embedded in images, contact info in a header/footer, non-standard section headings) -- each naming the SPECIFIC problem, never vague. If NO resume file was attached, this MUST be an empty array -- never guess or fabricate issues about a resume you cannot see.",
    ),
  // resume-store-multi-resume-and-tailoring story: extends this SAME
  // fit-scoring call (never a second, parallel LLM call) to also compare
  // every stored resume against this gig, when 2+ are on file -- see
  // this file's header comment for why that reuse matters.
  resumeRankings: z
    .array(
      z.object({
        resumeId: z.string().describe("The exact resumeId this ranking is for, copied verbatim from that resume option's own labeled block below."),
        fitScore: z.number().describe("1-100: how well THIS SPECIFIC resume (not the applicant's profile in general) presents a fit for this gig, grounded in what's actually in that resume file."),
        reasoning: z.string().describe("One or two sentences of real, specific reasoning for this resume's fitScore -- what in THIS resume helps or hurts for THIS gig."),
      }),
    )
    .describe(
      `ONLY when 2 or more resume options were actually attached to this request (each in its own labeled block below): one entry per attached resume, covering EVERY attached resumeId exactly once. If fewer than 2 resume options were attached, this MUST be an empty array.`,
    ),
});

/**
 * ats-navigator epic, ats-resume-score story. Bidirectional ATS
 * keyword-matching: a forward score (keywordOverlapScore/matchedKeywords/
 * missingKeywords) plus a reverse, concrete action list (resumeTweaks) --
 * generated by the SAME call as the rest of the packet, not a second LLM
 * call.
 *
 * career-documents epic, real-parseability-check story: `parseabilityIssues`
 * is the forward-direction format/structure check ats-navigator's own
 * ats-resume-score story deliberately deferred (no persisted resume
 * existed then). Now that career-documents persists one, this is grounded
 * in the ACTUAL resume file (embedded natively via buildResumeContentBlock(),
 * the SAME mechanism extract.ts's own extraction call already uses) --
 * never fabricated. Empty/omitted gracefully when no resume is on file,
 * so a user without one still gets the keyword-overlap half unaffected.
 */
export interface AtsScore {
  keywordOverlapScore: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  resumeTweaks: string[];
  /** career-documents epic: empty when no resume is on file (applyProfile.resumes empty/unset) -- never fabricated, only ever populated when a real resume file was actually read. */
  parseabilityIssues: string[];
  /**
   * True only when a real resume file was actually read and embedded in
   * this call. Distinguishes "no resume on file" from "resume checked,
   * genuinely zero issues found" -- both leave `parseabilityIssues` empty,
   * so the UI needs this to avoid claiming "no check happened" for a
   * clean resume.
   */
  resumeChecked: boolean;
}

export interface PrepPacketContent {
  score: number;
  rationale: string;
  topStrengths: string[];
  keyGaps: string[];
  recommendation: string;
  predictedQuestions: string[];
  starlaStories: string[];
  atsScore: AtsScore;
  /**
   * resume-store-multi-resume-and-tailoring story. Real, LLM-produced
   * per-resume fit comparison -- present ONLY when `applyProfile.resumes`
   * held 2+ entries at generation time (undefined otherwise, never an
   * empty/placeholder object). `bestResumeId` is picked HERE in code (the
   * highest `fitScore` among `rankings`), never asked of the model
   * directly -- deterministic given the model's own real per-resume
   * scores, rather than a second judgment call that could disagree with
   * them.
   */
  resumeSuggestion?: {
    rankings: Array<{ resumeId: string; label: string; fitScore: number; reasoning: string }>;
    bestResumeId: string;
  };
}

/**
 * Generates one gig's prep packet via a single Claude Messages API call
 * using the Vercel AI SDK's forced structured output — mirrors
 * `generateDraft()`'s shape exactly. `credential` is used to construct the
 * model client HERE, inside this function call, and nowhere else — callers
 * resolve it themselves via `resolveLlmCredential()`, however is
 * appropriate for their own calling context.
 *
 * resume-store-multi-resume-and-tailoring story: `selectedResumeId`
 * chooses WHICH stored resume `parseabilityIssues` checks (via
 * `documents/resume-store.ts`'s `pickResume()` -- omitted falls back to
 * the first stored resume, byte-identical to the old single-resume
 * behavior). Independently of that selection, when `applyProfile.resumes`
 * holds 2+ entries, EVERY one of them is attached (each its own labeled
 * content block) and this SAME call also asks the model to rank each
 * against this gig -- see `PrepResultSchema.resumeRankings` and
 * `PrepPacketContent.resumeSuggestion` above. This reuses the existing
 * fit-scoring call/schema/data-block builders rather than a second,
 * parallel matching mechanism -- see this file's header comment and the
 * story's own design_decisions.
 *
 * Throws a specific error if the model's response doesn't include the
 * expected structured output, or if the underlying API call itself fails —
 * never silently returns a partial/placeholder packet.
 */
export async function generatePrepPacket(
  gig: Gig,
  profile: Profile,
  applyProfile: ApplyProfileConfig | undefined,
  credential: LlmCredential,
  selectedResumeId?: string,
): Promise<PrepPacketContent> {
  // career-documents epic, real-parseability-check story: loadResume()
  // returns undefined gracefully (missing/never-uploaded/deleted file),
  // never throws for that case -- this call degrades to the keyword-overlap-
  // only behavior ats-navigator already shipped, exactly as before this
  // story existed.
  const allResumes = applyProfile?.resumes ?? [];
  const selectedResume = pickResume(allResumes, selectedResumeId);
  // resume-store-multi-resume-and-tailoring story: when 2+ resumes are on
  // file, EVERY one is attached below as its own labeled "resume option"
  // block (including the selected one) so the model can genuinely compare
  // them -- so the single generic resumeBlock below is only built for the
  // 0-or-1-resume case, never a redundant SECOND copy of the same file the
  // selected resume's own option block already carries.
  const hasMultipleResumes = allResumes.length >= MIN_RESUMES_FOR_RANKING;
  const resumeFile = !hasMultipleResumes && selectedResume ? loadResume(selectedResume.path) : undefined;
  const resumeBlock = resumeFile
    ? buildResumeContentBlock(
        resumeFile.mediaType === "application/pdf"
          ? { resumeFile: { data: resumeFile.data, mediaType: "application/pdf" } }
          : { resumeText: resumeFile.data.toString("utf8") },
      )
    : undefined;

  const loadedResumeIds = new Set<string>();
  const resumeOptionBlocks: Array<TextPart | FilePart> = !hasMultipleResumes
    ? []
    : allResumes.flatMap((record) => {
        const file = loadResume(record.path);
        if (!file) return [];
        loadedResumeIds.add(record.id);
        const block = buildResumeContentBlock(
          file.mediaType === "application/pdf" ? { resumeFile: { data: file.data, mediaType: "application/pdf" } } : { resumeText: file.data.toString("utf8") },
        );
        // block is never actually undefined here -- the ternary above always passes resumeFile or resumeText.
        return [{ type: "text" as const, text: `Resume option -- resumeId="${record.id}", label="${record.label}":` }, block as TextPart | FilePart];
      });
  // The primary resume's own file (if it loaded successfully) drives
  // parseabilityIssues in the multi-resume case -- named explicitly so the
  // model knows which OPTION block that check applies to, since there's no
  // separate single resumeBlock to point at here. Reuses whether that
  // resume's id made it into `loadedResumeIds` above rather than a second,
  // redundant loadResume()/decrypt() of the same file.
  const hasParseabilityTarget = hasMultipleResumes ? selectedResume !== undefined && loadedResumeIds.has(selectedResume.id) : resumeBlock !== undefined;

  const contentBlocks: Array<TextPart | FilePart> = [
    {
      type: "text",
      text:
        "Analyze this person's real fit for this specific gig, grounded STRICTLY in the real applicant and gig " +
        "data provided below. Report a 1-100 fit score with rationale, the strongest real alignments (topStrengths), " +
        "real gaps between the applicant's actual profile and this gig's stated requirements (keyGaps), a short " +
        "actionable recommendation, likely interview questions given this specific gig and the identified gaps, " +
        "and STARLA-format story prompts drawn from the applicant's real profile that address those questions/gaps. " +
        "ALSO report a SEPARATE, narrower ATS-keyword-matching lens: keywordOverlapScore (1-100, how well the " +
        "applicant's tracked skills/roles overlap with keywords this specific listing's text explicitly uses), " +
        "matchedKeywords (skills/role terms present in BOTH), missingKeywords (keywords this listing explicitly " +
        "emphasizes that the applicant's tracked skills/roles do not mention), and resumeTweaks -- concrete, " +
        "mechanical actions to close that gap (e.g. \"add 'Kubernetes' to your skills -- it appears 3 times in " +
        "this listing\"), each one naming a specific missingKeywords entry, never generic advice. " +
        (hasParseabilityTarget
          ? "A real resume file is attached below" +
            (hasMultipleResumes ? ` (the resume option with resumeId="${selectedResume?.id}")` : "") +
            " -- ALSO report parseabilityIssues: specific, observable ATS " +
            "parsing problems in its ACTUAL format (multi-column layout, tables, text embedded in images, contact " +
            "info in a header/footer, non-standard section headings). Only report what you can genuinely observe " +
            "in that attached file, never a generic list."
          : "No resume file is attached to this request -- parseabilityIssues MUST be an empty array; never " +
            "guess or fabricate a format issue for a resume you cannot see.") +
        (resumeOptionBlocks.length > 0
          ? " Several resume OPTIONS are ALSO attached below, each in its own \"Resume option\" block naming its " +
            "resumeId/label -- ALSO report resumeRankings: one entry per attached resumeId (copied verbatim), each " +
            "with its own fitScore (1-100) and short reasoning grounded in what's ACTUALLY in that specific resume " +
            "file, so the applicant can see which one best fits this gig."
          : " No resume options are attached for a multi-resume comparison this time -- resumeRankings MUST be an " +
            "empty array.") +
        " CRITICAL: never invent, embellish, or assume experience, skills, requirements, or figures that are not " +
        "explicitly present in the data below. A gap, question, or keyword claim must be grounded in what's " +
        "actually stated, not an assumption about what a listing like this usually asks.",
    },
    { type: "text", text: buildApplicantDataBlock(profile, applyProfile ?? { email: "" }) },
    { type: "text", text: buildGigDataBlock(gig) },
    ...(resumeBlock ? [{ type: "text" as const, text: "The applicant's real, current resume file follows:" }, resumeBlock] : []),
    ...resumeOptionBlocks,
    { type: "text", text: `Now report the complete result via the ${PREP_TOOL_NAME} structured output.` },
  ];

  let parsed: z.infer<typeof PrepResultSchema>;

  if (credential.kind === "claude-code-harness") {
    parsed = await generateHarnessObject(PrepResultSchema, toHarnessContentBlocks(contentBlocks));
  } else {
    const model = createAiSdkModel(credential);

    const result = await generateText({
      model,
      messages: [{ role: "user", content: contentBlocks }],
      output: Output.object({ schema: PrepResultSchema, name: PREP_TOOL_NAME }),
    });

    try {
      parsed = result.output;
    } catch (e) {
      if (e instanceof NoOutputGeneratedError) {
        throw new Error("gigradar career-crm: the model's response did not include the expected structured prep-packet result.");
      }
      throw e;
    }
  }

  return {
    score: parsed.score,
    rationale: parsed.rationale,
    topStrengths: parsed.topStrengths,
    keyGaps: parsed.keyGaps,
    recommendation: parsed.recommendation,
    predictedQuestions: parsed.predictedQuestions,
    starlaStories: parsed.starlaStories,
    atsScore: {
      keywordOverlapScore: parsed.keywordOverlapScore,
      matchedKeywords: parsed.matchedKeywords,
      missingKeywords: parsed.missingKeywords,
      resumeTweaks: parsed.resumeTweaks,
      // Belt-and-suspenders: even if the model ignores the "empty when no
      // resume attached" instruction, never surface fabricated issues when
      // this call genuinely had no resume block to look at.
      parseabilityIssues: hasParseabilityTarget ? parsed.parseabilityIssues : [],
      resumeChecked: hasParseabilityTarget,
    },
    // resume-store-multi-resume-and-tailoring story: same belt-and-
    // suspenders posture as parseabilityIssues above -- never surface a
    // fabricated ranking (or a stray one referencing an unknown resumeId)
    // when this call genuinely didn't attach 2+ resume options.
    ...(() => {
      if (!hasMultipleResumes) return {};
      const rankings = parsed.resumeRankings
        .filter((r) => allResumes.some((record) => record.id === r.resumeId))
        .map((r) => ({
          resumeId: r.resumeId,
          label: allResumes.find((record) => record.id === r.resumeId)?.label ?? r.resumeId,
          fitScore: r.fitScore,
          reasoning: r.reasoning,
        }));
      if (rankings.length === 0) return {};
      const bestResumeId = rankings.reduce((a, b) => (b.fitScore > a.fitScore ? b : a)).resumeId;
      return { resumeSuggestion: { rankings, bestResumeId } };
    })(),
  };
}
