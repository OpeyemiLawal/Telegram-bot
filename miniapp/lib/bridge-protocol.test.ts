/**
 * Message validation.
 *
 * This is the code that decides whether to act on something an iframe sent, so
 * the negative cases matter more than the positive ones. Each rejection below
 * corresponds to a way a malformed or hostile message could otherwise reach a
 * handler.
 */

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  fail,
  ok,
  originOf,
  parseRequest,
  parseResponse,
} from "./bridge-protocol";

const valid = { sga: PROTOCOL_VERSION, id: "abc", type: "getPlayer" };

describe("parseRequest", () => {
  it("accepts every allowed request type", () => {
    for (const type of ["handshake", "getPlayer", "haptic", "exit"]) {
      expect(parseRequest({ ...valid, type })?.type).toBe(type);
    }
  });

  it("preserves the correlation id and payload", () => {
    const parsed = parseRequest({ ...valid, id: "req-7", payload: { style: "light" } });
    expect(parsed?.id).toBe("req-7");
    expect(parsed?.payload).toEqual({ style: "light" });
  });

  it("rejects an unknown request type", () => {
    // The allowlist is the capability boundary. A game that invents
    // "signTransaction" must get nothing, not a handler that happens not to
    // exist yet.
    expect(parseRequest({ ...valid, type: "signTransaction" })).toBeNull();
    expect(parseRequest({ ...valid, type: "getAccessToken" })).toBeNull();
  });

  it("rejects a mismatched or missing version", () => {
    expect(parseRequest({ ...valid, sga: 2 })).toBeNull();
    expect(parseRequest({ ...valid, sga: "1" })).toBeNull();
    expect(parseRequest({ id: "abc", type: "getPlayer" })).toBeNull();
  });

  it("rejects a missing or unusable id", () => {
    // Without an id the SDK cannot match a response to its request, so a reply
    // would be silently dropped — or worse, matched to the wrong caller.
    expect(parseRequest({ ...valid, id: "" })).toBeNull();
    expect(parseRequest({ ...valid, id: 7 })).toBeNull();
    expect(parseRequest({ ...valid, id: "x".repeat(65) })).toBeNull();
  });

  it("rejects non-objects without throwing", () => {
    // Extensions, devtools and other frames all post to this window. None are
    // errors and none should reach a handler.
    for (const junk of [null, undefined, "hello", 42, [], true]) {
      expect(parseRequest(junk)).toBeNull();
    }
  });
});

describe("parseResponse", () => {
  it("accepts a success and an error response", () => {
    expect(parseResponse(ok("a", { x: 1 }))).toEqual({
      sga: PROTOCOL_VERSION,
      id: "a",
      ok: true,
      data: { x: 1 },
      error: undefined,
    });
    expect(parseResponse(fail("b", "nope"))?.error).toBe("nope");
  });

  it("rejects a response with a non-boolean ok", () => {
    // A truthy string would make a failure look like a success to the SDK.
    expect(parseResponse({ sga: PROTOCOL_VERSION, id: "a", ok: "yes" })).toBeNull();
  });

  it("rejects a mismatched version", () => {
    expect(parseResponse({ sga: 99, id: "a", ok: true })).toBeNull();
  });
});

describe("originOf", () => {
  it("reduces a URL to scheme, host and port", () => {
    expect(originOf("https://orbit-runner.vercel.app")).toBe(
      "https://orbit-runner.vercel.app",
    );
    // A game navigating within itself changes the URL but not the origin, which
    // is the only thing the browser guarantees on a message event.
    expect(originOf("https://orbit-runner.vercel.app/level/2?x=1#y")).toBe(
      "https://orbit-runner.vercel.app",
    );
    expect(originOf("https://example.com:8443/x")).toBe("https://example.com:8443");
  });

  it("returns null for an unparseable URL", () => {
    // Fails closed: no origin means no message from that game is ever accepted,
    // so a malformed catalogue entry disables the game rather than opening it up.
    expect(originOf("not a url")).toBeNull();
    expect(originOf("")).toBeNull();
  });

  it("distinguishes origins that differ only by subdomain or scheme", () => {
    expect(originOf("https://evil.orbit-runner.vercel.app")).not.toBe(
      originOf("https://orbit-runner.vercel.app"),
    );
    expect(originOf("http://orbit-runner.vercel.app")).not.toBe(
      originOf("https://orbit-runner.vercel.app"),
    );
  });
});
