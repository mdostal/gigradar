"use server";

// agent-chat epic, chat-loop-core story. Thin Server Action wrappers over
// agent-chat-loop.ts, same {ok,error} convention every action in this
// repo uses. The BYOK Anthropic key is resolved fresh, inside
// sendChatMessageAction() itself, via readEnvVar() -- never process.env,
// never module-scope -- same non-negotiable discipline every other
// LLM-calling action in this repo follows (see src/app/actions.ts's
// generateDraftAction()/generatePrepPacketAction() for the identical
// pattern).
import crypto from "node:crypto";
import { actionErr, actionOk } from "@/lib/actions/result";
import type { ActionResult } from "@/lib/actions/result";
import { endChatSession, sendMessage, startChatSession, type ChatLoopEvent } from "@/lib/chat/agent-chat-loop";
import { readEnvVar } from "@/lib/config/env-store";

const ANTHROPIC_API_KEY_VAR = "ANTHROPIC_API_KEY";
const MISSING_API_KEY_ERROR =
  'gigradar chat: no Anthropic API key is set. Enter one in the "Anthropic API key" field on /config, then try again.';

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
  const apiKey = readEnvVar(ANTHROPIC_API_KEY_VAR);
  if (!apiKey) {
    return actionErr(new Error(MISSING_API_KEY_ERROR));
  }

  try {
    const event = await sendMessage(sessionId, apiKey, message);
    return actionOk(event);
  } catch (e) {
    return actionErr(e);
  }
}
