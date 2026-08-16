import { describe, expect, test } from "vitest";
import {
  FileUpdateTokenRequestSchema,
  FileUpdateTokenResponseSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("file update token messages", () => {
  test("parses a file_update_token_request with and without overwrite", () => {
    const request = FileUpdateTokenRequestSchema.parse({
      type: "file_update_token_request",
      cwd: "/workspace",
      path: "uploads/notes.txt",
      requestId: "req-1",
    });
    expect(request.overwrite).toBeUndefined();

    const withOverwrite = FileUpdateTokenRequestSchema.parse({
      type: "file_update_token_request",
      cwd: "/workspace",
      path: "uploads/notes.txt",
      overwrite: true,
      requestId: "req-2",
    });
    expect(withOverwrite.overwrite).toBe(true);
  });

  test("parses a file_update_token_response", () => {
    const response = FileUpdateTokenResponseSchema.parse({
      type: "file_update_token_response",
      payload: {
        cwd: "/workspace",
        path: "uploads/notes.txt",
        token: "abc",
        fileName: "notes.txt",
        mimeType: "text/plain",
        exists: true,
        size: 12,
        error: null,
        requestId: "req-1",
      },
    });
    expect(response.payload.exists).toBe(true);
  });

  test("registers both messages in the session unions", () => {
    const inbound = SessionInboundMessageSchema.safeParse({
      type: "file_update_token_request",
      cwd: "/workspace",
      path: "a.txt",
      requestId: "req-1",
    });
    expect(inbound.success).toBe(true);

    const outbound = SessionOutboundMessageSchema.safeParse({
      type: "file_update_token_response",
      payload: {
        cwd: "/workspace",
        path: "a.txt",
        token: null,
        fileName: null,
        mimeType: null,
        exists: null,
        size: null,
        error: "boom",
        requestId: "req-1",
      },
    });
    expect(outbound.success).toBe(true);
  });
});
