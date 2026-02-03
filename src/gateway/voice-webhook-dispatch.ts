/**
 * Voice Webhook Agent Dispatch Module
 *
 * Internal helpers for dispatching transcribed text to the agent.
 * Separated from voice-webhook.ts for maintainability and smaller diffs.
 */

import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { dispatchInboundMessageWithDispatcher } from "../auto-reply/dispatch.js";

/**
 * Voice channel identifier.
 *
 * This is a "terminal-only" channel:
 * - Inbound only (webhook receives audio, returns response via HTTP)
 * - No outbound delivery (responses don't go to a platform)
 * - Not addressable (can't send messages TO voice-terminal)
 */
export const VOICE_CHANNEL = "voice-terminal";

/**
 * Agent dispatch result type.
 */
export type AgentDispatchResult = { ok: true; text: string } | { ok: false; error: string };

function applyVoiceSystemHint(userText: string): string {
  return [
    "SYSTEM (voice mode):",
    "Respond briefly and conversationally, suitable for being spoken aloud.",
    "Default to 1–2 sentences.",
    "Avoid lists, markdown, or long explanations unless explicitly asked.",
    "Do not ask follow-up questions unless necessary.",
    "",
    userText,
  ].join("\n");
}

/**
 * Dispatches transcribed text to the agent and collects the response.
 *
 * Uses the existing agent dispatch pipeline with:
 * - Block streaming disabled (voice needs complete response for TTS)
 * - Direct chat type (1:1 voice interaction)
 * - Command authorization enabled
 */
export async function dispatchToAgent(params: {
  text: string;
  sessionId: string;
  cfg: OpenClawConfig;
}): Promise<AgentDispatchResult> {
  const { text, sessionId, cfg } = params;

  try {
    // Collect agent response parts
    const responseParts: string[] = [];

    const voicePrompt = applyVoiceSystemHint(text);

    // Build message context
    // Note: Provider/Surface = VOICE_CHANNEL marks this as terminal-only
    const ctx: MsgContext = {
      Body: voicePrompt,
      BodyForAgent: voicePrompt,
      SessionKey: sessionId,
      Provider: VOICE_CHANNEL,
      Surface: VOICE_CHANNEL,
      ChatType: "direct",
      CommandAuthorized: true,
    };

    // Dispatch to agent with streaming disabled
    // (voice responses must be complete before TTS synthesis)
    await dispatchInboundMessageWithDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: "",
        deliver: async (payload) => {
          const part = payload.text?.trim();
          if (part) {
            responseParts.push(part);
          }
        },
      },
      replyOptions: {
        disableBlockStreaming: true,
      },
    });

    const responseText = responseParts.join("\n\n").trim();
    if (!responseText) {
      return { ok: false, error: "Agent returned no response" };
    }

    return { ok: true, text: responseText };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Agent dispatch failed: ${message}` };
  }
}
