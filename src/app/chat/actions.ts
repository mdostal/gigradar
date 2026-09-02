"use server";

// agent-chat epic, chat-loop-core story. Thin Server Action wrappers over
// agent-chat-loop.ts, same {ok,error} convention every action in this
// repo uses. The LLM credential is resolved fresh, inside
// sendChatMessageAction() itself, via resolveLlmCredential() -- never
// process.env, never module-scope -- same non-negotiable discipline every
// other LLM-calling action in this repo follows (see src/app/actions.ts's
// generateDraftAction()/generatePrepPacketAction() for the identical
// pattern; llm-credential-modes epic for why this is a credential, not a
// bare apiKey string).
import crypto from "node:crypto";
import { actionErr, actionOk } from "@/lib/actions/result";
import type { ActionResult } from "@/lib/actions/result";
import {
  buildContextSeedBlock,
  endChatSession,
  resolveApproval,
  resumeChatSession,
  sendMessage,
  startChatSession,
  type ChatLoopEvent,
} from "@/lib/chat/agent-chat-loop";
import { resolveLlmCredential } from "@/lib/config/env-store";
import { readRawConfig } from "@/lib/config/save";
import { ConfigSchema } from "@/lib/config/schema";
import { getDraft, getGig } from "@/lib/store";

/** The 3 contextual hover-chat entry points (chat-copilot-self-tuning epic, Slice 2) -- Dashboard rows, Drafts cards, Config source rows. */
export type ContextualChatKind = "gig" | "draft" | "source";

const MISSING_API_KEY_ERROR =
  'gigradar chat: no Anthropic credential is set. Configure one in the "Anthropic credential" field on /config, then try again.';

/** Starts a fresh chat session and returns its id -- the client threads this through every subsequent sendChatMessageAction() call. */
export async function startChatSessionAction(): Promise<ActionResult<{ sessionId: string }>> {
  const sessionId = crypto.randomUUID();
  startChatSession(sessionId);
  return actionOk({ sessionId });
}

/**
 * chat-copilot-self-tuning epic, Slice 2. Starts a fresh chat session
 * pre-seeded with `itemKey`'s real data (server-resolved, never trusting
 * a client-supplied blob) -- the same underlying agent-chat-loop.ts
 * session mechanism as startChatSessionAction() above, just with history
 * pre-loaded via buildContextSeedBlock(). `contextLabel` is returned so
 * the panel's header can say what it's chatting about without the caller
 * having to already know (a table row only has the key/id handy in some
 * cases, e.g. a source has no separate human label).
 */
export async function startContextualChatSessionAction(
  kind: ContextualChatKind,
  itemKey: string,
): Promise<ActionResult<{ sessionId: string; contextLabel: string }>> {
  let seedData: unknown;
  let contextLabel: string;

  if (kind === "gig") {
    const gig = getGig(itemKey);
    if (!gig) return actionErr(new Error(`gigradar chat: no gig found with key "${itemKey}".`));
    seedData = gig;
    contextLabel = gig.title;
  } else if (kind === "draft") {
    const draft = getDraft(itemKey);
    if (!draft) return actionErr(new Error(`gigradar chat: no draft found for gig key "${itemKey}".`));
    const gig = getGig(itemKey);
    seedData = { draft, gig };
    contextLabel = gig?.title ?? itemKey;
  } else {
    const rawConfig = readRawConfig();
    const rawSources = Array.isArray(rawConfig.sources) ? rawConfig.sources : [];
    const found = rawSources.find((s) => typeof s === "object" && s !== null && (s as Record<string, unknown>).id === itemKey) as
      | Record<string, unknown>
      | undefined;
    if (!found) return actionErr(new Error(`gigradar chat: no source found with id "${itemKey}".`));
    // `settings` is deliberately omitted -- opaque per SourceConfigSchema's own doc comment, and not
    // needed for the kind of "why isn't this source finding anything" questions this entry point is for.
    seedData = { id: found.id, enabled: found.enabled, kind: found.kind, groupIds: found.groupIds };
    contextLabel = itemKey;
  }

  const sessionId = crypto.randomUUID();
  startChatSession(sessionId, buildContextSeedBlock(kind, contextLabel, seedData));
  return actionOk({ sessionId, contextLabel });
}

/** Ends a chat session, discarding its history (including persisted memory). Idempotent. */
export async function endChatSessionAction(sessionId: string): Promise<ActionResult<null>> {
  endChatSession(sessionId);
  return actionOk(null);
}

/**
 * chat-copilot-self-tuning epic. Tries to rehydrate `sessionId` from
 * persisted memory (survives a server restart within the same browser
 * tab's remembered session id -- see chat-client.tsx's localStorage
 * wiring). `resumed: false` means the caller should fall back to
 * startChatSessionAction() for a fresh id instead.
 */
export async function resumeChatSessionAction(sessionId: string): Promise<ActionResult<{ resumed: boolean }>> {
  const resumed = resumeChatSession(sessionId);
  return actionOk({ resumed });
}

export async function sendChatMessageAction(sessionId: string, message: string): Promise<ActionResult<ChatLoopEvent>> {
  const credential = resolveLlmCredential();
  if (!credential) {
    return actionErr(new Error(MISSING_API_KEY_ERROR));
  }

  const parsedConfig = ConfigSchema.safeParse(readRawConfig());
  if (!parsedConfig.success) {
    return actionErr(
      new Error("gigradar config: your saved configuration is incomplete or invalid — check /config before chatting."),
    );
  }

  try {
    const event = await sendMessage(sessionId, credential, message, parsedConfig.data);
    return actionOk(event);
  } catch (e) {
    return actionErr(e);
  }
}

/**
 * Resolves a pending write-tool proposal -- `approve: false` (Reject)
 * never executes anything, `approve: true` runs the real underlying
 * action. Config resolved the SAME non-resolving way
 * generateDraftAction()/generatePrepPacketAction() (src/app/actions.ts)
 * already do -- readRawConfig() + ConfigSchema.safeParse(), never
 * loadConfig() (see those actions' own doc comments for why).
 */
export async function resolveChatApprovalAction(sessionId: string, approve: boolean): Promise<ActionResult<ChatLoopEvent>> {
  const credential = resolveLlmCredential();
  if (!credential) {
    return actionErr(new Error(MISSING_API_KEY_ERROR));
  }

  const parsedConfig = ConfigSchema.safeParse(readRawConfig());
  if (!parsedConfig.success) {
    return actionErr(
      new Error("gigradar config: your saved configuration is incomplete or invalid — check /config before approving this action."),
    );
  }

  try {
    const event = await resolveApproval(sessionId, credential, approve, parsedConfig.data);
    return actionOk(event);
  } catch (e) {
    return actionErr(e);
  }
}
