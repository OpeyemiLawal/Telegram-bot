"use client";

/**
 * The shell's side of the game bridge.
 *
 * The shell holds the wallet; games run on their own origins inside an iframe
 * and can only ask for things through here. That asymmetry is the whole point:
 * a game never has the session, never has the wallet, and cannot acquire either
 * by asking nicely.
 *
 * Three checks gate every message, and each one is load-bearing:
 *
 *   1. `event.origin` equals the game's origin exactly. `postMessage` is
 *      broadcast to a window, not addressed to a listener, so anything with a
 *      handle on this window can post to it — another iframe, an extension, a
 *      popup it opened. The origin is the only part of the sender the browser
 *      vouches for.
 *
 *   2. `event.source` is the iframe's own contentWindow. Origin alone is not
 *      enough: a second frame on the same origin as the game would pass check
 *      one. This pins the sender to the specific frame we embedded.
 *
 *   3. The message parses as a known request. Anything else is ignored in
 *      silence, because the page legitimately receives messages that are none
 *      of our business.
 *
 * Replies are addressed to the game's exact origin. Never `"*"` — that would
 * post the response to whatever document currently occupies the frame, which,
 * if the game has navigated away, is not the game.
 */

import {
  type BridgeRequest,
  type HandshakeInfo,
  type PlayerInfo,
  fail,
  ok,
  originOf,
  parseRequest,
} from "./bridge-protocol";
import { notify, tap, telegramSurface } from "./telegram";

export interface BridgeContext {
  gameSlug: string;
  embedUrl: string;
  /** Read at message time, not captured, so a wallet linked mid-game is seen. */
  player: () => PlayerInfo;
  onExit: () => void;
}

/**
 * Attach the bridge to the window. Returns a cleanup function.
 *
 * `frame` is the iframe element. It is required rather than optional because
 * check 2 above cannot be performed without it, and a bridge that silently
 * skips a security check when an argument is missing is worse than one that
 * refuses to start.
 */
export function attachGameBridge(
  frame: HTMLIFrameElement,
  context: BridgeContext,
): () => void {
  const expectedOrigin = originOf(context.embedUrl);

  if (!expectedOrigin) {
    // A catalogue entry we cannot derive an origin from is not a game we can
    // safely talk to. Fail closed and say why — silence here would look like a
    // game that simply never sends anything.
    console.error(
      `[bridge] ${context.gameSlug} has an unparseable embed URL; bridge not attached`,
    );
    return () => {};
  }

  function reply(response: unknown) {
    frame.contentWindow?.postMessage(response, expectedOrigin as string);
  }

  function handle(request: BridgeRequest) {
    switch (request.type) {
      case "handshake": {
        const info: HandshakeInfo = {
          version: 1,
          gameSlug: context.gameSlug,
          surface: telegramSurface(),
        };
        reply(ok(request.id, info));
        return;
      }

      case "getPlayer": {
        // Public facts only. The access token, the refresh token and initData
        // are not representable in PlayerInfo, which is deliberate — the type
        // is the enforcement, not a comment asking future code to behave.
        reply(ok(request.id, context.player()));
        return;
      }

      case "haptic": {
        const style = (request.payload as { style?: string } | undefined)?.style;
        if (style === "error" || style === "success" || style === "warning") {
          notify(style);
        } else {
          tap();
        }
        reply(ok(request.id));
        return;
      }

      case "exit": {
        reply(ok(request.id));
        context.onExit();
        return;
      }

      default: {
        // Unreachable while `parseRequest` and `RequestType` agree. Kept so that
        // adding a type to the union without adding a case here fails loudly at
        // runtime instead of dropping the request.
        reply(fail(request.id, "Unsupported request"));
      }
    }
  }

  function onMessage(event: MessageEvent) {
    if (event.origin !== expectedOrigin) return;
    if (event.source !== frame.contentWindow) return;

    const request = parseRequest(event.data);
    if (!request) return;

    handle(request);
  }

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
