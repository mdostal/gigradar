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
import { endChatSession, resolveApproval, sendMessage, startChatSession, type ChatLoopEvent } from "@/lib/chat/agent-chat-loop";
import { resolveLlmCredential } from "@/lib/config/env-store";
import { readRawConfig } from "@/lib/config/save";
import { ConfigSchema } from "@/lib/config/schema";

const MISSING_API_KEY_ERROR =
  'gigradar chat: no Anthropic credential is set. Configure one in the "Anthropic credential" field on /config, then try again.';

/** Starts a fresh chat session and returns its id -- the client threads this through every subsequent sendChatMessageAction() call. */
export async function startChatSessionAction(): Promise<ActionResult<{ sessionId: string }>> {
  const sessionId = crypto.randomUUID();
  startChatSession(sessionId);
  return actionOk({ sessionId });
}

/** Ends a chat session, discarding its history. Idempotent. */
export async function endChatSessionAction(sessionId: string): Promise<ActionResult<null>> {
  endChatSession(sessionId);
  return actionOk(null);
}

export async function sendChatMessageAction(sessionId: string, message: string): Promise<ActionResult<ChatLoopEvent>> {
  const credential = resolveLlmCredential();
  if (!credential) {
    return actionErr(new Error(MISSING_API_KEY_ERROR));
  }

  try {
    const event = await sendMessage(sessionId, credential, message);
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
