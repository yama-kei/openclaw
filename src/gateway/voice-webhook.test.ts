import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createVoiceWebhookHandler } from "./voice-webhook.js";

function createMockRequest(opts: {
  method?: string;
  url?: string;
  body?: string;
}): IncomingMessage {
  const req = {
    method: opts.method ?? "POST",
    url: opts.url ?? "/webhooks/voice",
    headers: {
      "content-type": "application/json",
    },
    on: vi.fn((event: string, cb: (data?: Buffer) => void) => {
      if (event === "data" && opts.body) {
        cb(Buffer.from(opts.body, "utf-8"));
      }
      if (event === "end") {
        cb();
      }
    }),
    destroy: vi.fn(),
  } as unknown as IncomingMessage;
  return req;
}

function createMockResponse(): ServerResponse & {
  getBody: () => unknown;
  getStatusCode: () => number;
} {
  let statusCode = 200;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    end: vi.fn((data?: string) => {
      body = data ?? "";
    }),
    getBody: () => (body ? JSON.parse(body) : null),
    getStatusCode: () => statusCode,
  } as unknown as ServerResponse & { getBody: () => unknown; getStatusCode: () => number };
  Object.defineProperty(res, "statusCode", {
    get: () => statusCode,
    set: (v: number) => {
      statusCode = v;
    },
  });
  return res;
}

describe("voice-webhook", () => {
  describe("createVoiceWebhookHandler", () => {
    it("returns false for non-matching paths", async () => {
      const handler = createVoiceWebhookHandler();
      const req = createMockRequest({ url: "/other/path" });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(false);
    });

    it("rejects non-POST methods", async () => {
      const handler = createVoiceWebhookHandler();
      const req = createMockRequest({ method: "GET" });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.getStatusCode()).toBe(405);
    });

    it("rejects missing session_id", async () => {
      const handler = createVoiceWebhookHandler();
      const req = createMockRequest({
        body: JSON.stringify({ audio_base64: "dGVzdA==" }),
      });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toEqual({ error: "session_id must be a string" });
    });

    it("rejects empty session_id", async () => {
      const handler = createVoiceWebhookHandler();
      const req = createMockRequest({
        body: JSON.stringify({ session_id: "  ", audio_base64: "dGVzdA==" }),
      });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toEqual({ error: "session_id is required" });
    });

    it("rejects missing audio_base64", async () => {
      const handler = createVoiceWebhookHandler();
      const req = createMockRequest({
        body: JSON.stringify({ session_id: "test-session" }),
      });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toEqual({ error: "audio_base64 must be a string" });
    });

    it("rejects empty audio_base64", async () => {
      const handler = createVoiceWebhookHandler();
      const req = createMockRequest({
        body: JSON.stringify({ session_id: "test-session", audio_base64: "" }),
      });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toEqual({ error: "audio_base64 is required" });
    });

    it("returns stub response for valid payload", async () => {
      const handler = createVoiceWebhookHandler();
      const req = createMockRequest({
        body: JSON.stringify({
          session_id: "test-session",
          audio_base64: "dGVzdA==",
        }),
      });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody()).toEqual({
        text: "Voice webhook received",
        speak: true,
        tts_audio_base64: null,
      });
    });

    it("allows custom basePath", async () => {
      const handler = createVoiceWebhookHandler({ basePath: "/api/voice" });
      const req = createMockRequest({
        url: "/api/voice",
        body: JSON.stringify({
          session_id: "test-session",
          audio_base64: "dGVzdA==",
        }),
      });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.getStatusCode()).toBe(200);
    });

    it("rejects invalid JSON", async () => {
      const handler = createVoiceWebhookHandler();
      const req = createMockRequest({
        body: "not valid json",
      });
      const res = createMockResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.getStatusCode()).toBe(400);
    });
  });
});
