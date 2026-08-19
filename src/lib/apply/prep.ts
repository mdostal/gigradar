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
import { loadResume } from "../documents/resume-store.js";
import { buildResumeContentBlock } from "../profile-ingestion/extract.js";
import type { ApplyProfileConfig, Gig, Profile } from "../types.js";
import { createAiSdkModel, generateHarnessObject, toHarnessContentBlocks } from "../config/llm-client.js";
import type { LlmCredential } from "../config/env-store.js";
import { buildApplicantDataBlock, buildGigDataBlock } from "./draft.js";

const PREP_TOOL_NAME = "report_prep_packet";

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
  /** career-documents epic: empty when no resume is on file (applyProfile.resumePath unset) -- never fabricated, only ever populated when a real resume file was actually read. */
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
}

/**
 * Generates one gig's prep packet via a single Claude Messages API call
 * using the Vercel AI SDK's forced structured output — mirrors
 * `generateDraft()`'s shape exactly. `credential` is used to construct the
 * model client HERE, inside this function call, and nowhere else — callers
 * resolve it themselves via `resolveLlmCredential()`, however is
 * appropriate for their own calling context.
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
): Promise<PrepPacketContent> {
  // career-documents epic, real-parseability-check story: loadResume()
  // returns undefined gracefully (missing/never-uploaded/deleted file),
  // never throws for that case -- this call degrades to the keyword-overlap-
  // only behavior ats-navigator already shipped, exactly as before this
  // story existed.
  const resumeFile = applyProfile?.resumePath ? loadResume(applyProfile.resumePath) : undefined;
  const resumeBlock = resumeFile
    ? buildResumeContentBlock(
        resumeFile.mediaType === "application/pdf"
          ? { resumeFile: { data: resumeFile.data, mediaType: "application/pdf" } }
          : { resumeText: resumeFile.data.toString("utf8") },
      )
    : undefined;

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
        (resumeBlock
          ? "A real resume file is attached below -- ALSO report parseabilityIssues: specific, observable ATS " +
            "parsing problems in its ACTUAL format (multi-column layout, tables, text embedded in images, contact " +
            "info in a header/footer, non-standard section headings). Only report what you can genuinely observe " +
            "in the attached file, never a generic list."
          : "No resume file is attached to this request -- parseabilityIssues MUST be an empty array; never " +
            "guess or fabricate a format issue for a resume you cannot see.") +
        " CRITICAL: never invent, embellish, or assume experience, skills, requirements, or figures that are not " +
        "explicitly present in the data below. A gap, question, or keyword claim must be grounded in what's " +
        "actually stated, not an assumption about what a listing like this usually asks.",
    },
    { type: "text", text: buildApplicantDataBlock(profile, applyProfile ?? { email: "" }) },
    { type: "text", text: buildGigDataBlock(gig) },
    ...(resumeBlock ? [{ type: "text" as const, text: "The applicant's real, current resume file follows:" }, resumeBlock] : []),
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
      parseabilityIssues: resumeBlock ? parsed.parseabilityIssues : [],
      resumeChecked: resumeBlock !== undefined,
    },
  };
}
