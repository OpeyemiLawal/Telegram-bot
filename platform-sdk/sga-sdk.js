/**
 * Solana Games SDK for Godot web exports.
 *
 * It supports two launch modes without changing game code:
 *
 * 1. Direct Telegram mode: the game is opened from a bot Web App button,
 *    verifies Telegram initData with the SGA backend, and receives a restricted
 *    game session plus the player's linked public wallet address.
 *
 * 2. Legacy shell mode: an older platform page embeds the game and answers the
 *    same API through postMessage.
 *
 * The SDK never exposes Telegram initData or either mode's access token to
 * Godot. Games receive only displayName and walletAddress.
 */

(function () {
  "use strict";

  var VERSION = 1;
  var config = window.SGA_CONFIG || {};
  var telegram = window.Telegram && window.Telegram.WebApp;
  var apiBase = String(config.apiUrl || "").replace(/\/+$/, "");
  var gameSlug = String(config.gameSlug || "");
  var directMode = Boolean(telegram && telegram.initData && apiBase && gameSlug);

  var shellOrigin = (function () {
    if (directMode) return null;
    try {
      var fromQuery = new URLSearchParams(window.location.search).get("sgaOrigin");
      if (fromQuery) return new URL(fromQuery).origin;
      if (document.referrer) return new URL(document.referrer).origin;
    } catch (error) {
      /* no trusted shell origin */
    }
    return null;
  })();

  var bridgeMode = Boolean(
    !directMode &&
      shellOrigin &&
      window.parent &&
      window.parent !== window,
  );

  var pending = {};
  var counter = 0;

  function wrap(callback) {
    if (!callback) return null;
    return function (result) {
      callback(result.ok ? result.data || {} : { error: result.error });
    };
  }

  function bridgeSend(type, payload, onResult) {
    if (!bridgeMode) {
      if (onResult) onResult({ ok: false, error: "Platform connection unavailable" });
      return;
    }

    counter += 1;
    var id = "g" + counter + "-" + Date.now().toString(36);

    if (onResult) {
      pending[id] = onResult;
      setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        onResult({ ok: false, error: "Timed out" });
      }, 10000);
    }

    window.parent.postMessage(
      { sga: VERSION, id: id, type: type, payload: payload },
      shellOrigin,
    );
  }

  window.addEventListener("message", function (event) {
    if (!bridgeMode || event.origin !== shellOrigin) return;

    var data = event.data;
    if (!data || data.sga !== VERSION || typeof data.id !== "string") return;

    var handler = pending[data.id];
    if (!handler) return;
    delete pending[data.id];

    handler({ ok: data.ok === true, data: data.data, error: data.error });
  });

  function storageKey() {
    return "sga.game.session." + gameSlug;
  }

  function readStoredToken() {
    try {
      return window.sessionStorage.getItem(storageKey());
    } catch (error) {
      return null;
    }
  }

  function storeToken(token) {
    try {
      if (token) window.sessionStorage.setItem(storageKey(), token);
      else window.sessionStorage.removeItem(storageKey());
    } catch (error) {
      /* Session restoration is optional. */
    }
  }

  function readResponse(response) {
    return response.text().then(function (text) {
      var body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch (error) {
        body = {};
      }

      if (!response.ok) {
        var message =
          typeof body.detail === "string" ? body.detail : "Game authentication failed.";
        throw new Error(message);
      }
      return body;
    });
  }

  function apiRequest(path, options) {
    return window
      .fetch(apiBase + "/api/game" + path, options || {})
      .then(readResponse);
  }

  var playerCache = null;
  var authInFlight = null;
  var gameToken = null;
  var rewardQueue = Promise.resolve();

  function playerResult(body) {
    var player = body && body.player;
    if (!player) throw new Error("Backend returned no player.");
    return {
      displayName: String(player.display_name || "player"),
      walletAddress: player.wallet_address || null,
    };
  }

  function loginDirect() {
    return apiRequest("/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        init_data: telegram.initData,
        game_slug: gameSlug,
      }),
    }).then(function (body) {
      gameToken = body.access_token || null;
      storeToken(gameToken);
      return playerResult(body);
    });
  }

  function restoreDirect(token) {
    gameToken = token;
    return apiRequest("/session", {
      headers: { Authorization: "Bearer " + token },
    })
      .then(playerResult)
      .catch(function () {
        gameToken = null;
        storeToken(null);
        return loginDirect();
      });
  }

  function getDirectPlayer(onResult) {
    if (playerCache) {
      onResult({ ok: true, data: playerCache });
      return;
    }

    if (!authInFlight) {
      var stored = readStoredToken();
      authInFlight = (stored ? restoreDirect(stored) : loginDirect()).then(
        function (player) {
          playerCache = player;
          authInFlight = null;
          return player;
        },
        function (error) {
          authInFlight = null;
          throw error;
        },
      );
    }

    authInFlight
      .then(function (player) {
        onResult({ ok: true, data: player });
      })
      .catch(function (error) {
        onResult({
          ok: false,
          error: error && error.message ? error.message : "Could not authenticate game.",
        });
      });
  }

  function ensureDirectAuth() {
    return new Promise(function (resolve, reject) {
      getDirectPlayer(function (result) {
        if (result.ok && gameToken) resolve();
        else reject(new Error(result.error || "Could not authenticate game."));
      });
    });
  }

  function directAuthorizedRequest(path, options) {
    return ensureDirectAuth().then(function () {
      var requestOptions = options || {};
      requestOptions.headers = Object.assign(
        {},
        requestOptions.headers || {},
        { Authorization: "Bearer " + gameToken },
      );
      return apiRequest(path, requestOptions);
    });
  }

  function finishDirect(promise, onResult) {
    promise.then(
      function (data) {
        onResult({ ok: true, data: data });
      },
      function (error) {
        onResult({
          ok: false,
          error: error && error.message ? error.message : "Reward request failed.",
        });
      },
    );
  }

  function roundResult(body) {
    return {
      roundId: body.round_id,
      availableAmount: body.available_amount,
      tokenSymbol: body.token_symbol,
      rules: {
        tapsPerReward: body.rules.taps_per_reward,
        tokensPerReward: body.rules.tokens_per_reward,
        roundSeconds: body.rules.round_seconds,
        dailyCap: body.rules.daily_cap,
      },
    };
  }

  function tapResult(body) {
    return {
      acceptedTaps: body.accepted_taps,
      tapProgress: body.tap_progress,
      earnedNow: body.earned_now,
      availableAmount: body.available_amount,
      dailyRemaining: body.daily_remaining,
      tokenSymbol: body.token_symbol,
    };
  }

  function rewardSummaryResult(body) {
    return {
      availableAmount: body.available_amount,
      pendingAmount: body.pending_amount,
      lifetimeEarned: body.lifetime_earned,
      lifetimeClaimed: body.lifetime_claimed,
      tokenSymbol: body.token_symbol,
      walletAddress: body.wallet_address || null,
      claimsEnabled: Boolean(body.claims_enabled),
      minimumClaim: body.minimum_claim,
      canClaim: Boolean(body.can_claim),
    };
  }

  function claimResult(body) {
    return {
      claimId: body.claim_id,
      amount: body.amount,
      tokenSymbol: body.token_symbol,
      walletAddress: body.wallet_address,
      status: body.status,
      signature: body.signature || null,
      explorerUrl: body.explorer_url || null,
      message: body.message,
    };
  }

  function telegramSurface() {
    var platform = telegram && telegram.platform ? telegram.platform : "unknown";
    if (platform === "android" || platform === "ios") return "mobile";
    if (platform.indexOf("web") === 0) return "web";
    return "desktop";
  }

  function directHandshake(onResult) {
    telegram.ready();
    telegram.expand();
    onResult({
      ok: true,
      data: {
        version: VERSION,
        gameSlug: gameSlug,
        surface: telegramSurface(),
      },
    });
  }

  function directHaptic(style) {
    var feedback = telegram && telegram.HapticFeedback;
    if (!feedback) return;
    if (
      style === "success" ||
      style === "error" ||
      style === "warning"
    ) {
      feedback.notificationOccurred(style);
    } else {
      feedback.impactOccurred(style || "light");
    }
  }

  window.SGA = {
    version: VERSION,

    isAvailable: function () {
      return directMode || bridgeMode;
    },

    handshake: function (callback) {
      var done = wrap(callback);
      if (directMode) {
        directHandshake(done || function () {});
        return;
      }
      bridgeSend("handshake", undefined, done);
    },

    getPlayer: function (callback) {
      var done = wrap(callback);
      if (directMode) {
        if (done) getDirectPlayer(done);
        return;
      }
      bridgeSend("getPlayer", undefined, done);
    },

    startRewardRound: function (callback) {
      var done = wrap(callback);
      if (!done) return;
      if (!directMode) {
        done({ ok: false, error: "Rewards require a direct Telegram launch." });
        return;
      }
      finishDirect(
        directAuthorizedRequest("/rewards/rounds", { method: "POST" }).then(roundResult),
        done,
      );
    },

    recordTap: function (roundId, sequence, elapsedMs, callback) {
      var done = wrap(callback);
      if (!done) return;
      if (!directMode) {
        done({ ok: false, error: "Rewards require a direct Telegram launch." });
        return;
      }

      rewardQueue = rewardQueue
        .catch(function () {
          /* A rejected tap must not strand the next queued tap. */
        })
        .then(function () {
          return directAuthorizedRequest(
            "/rewards/rounds/" + encodeURIComponent(String(roundId)) + "/taps",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sequence: Number(sequence),
                elapsed_ms: Number(elapsedMs),
              }),
            },
          ).then(tapResult);
        });
      finishDirect(rewardQueue, done);
    },

    getRewardSummary: function (callback) {
      var done = wrap(callback);
      if (!done) return;
      if (!directMode) {
        done({ ok: false, error: "Rewards require a direct Telegram launch." });
        return;
      }
      finishDirect(
        directAuthorizedRequest("/rewards", { method: "GET" }).then(
          rewardSummaryResult,
        ),
        done,
      );
    },

    claimRewards: function (callback) {
      var done = wrap(callback);
      if (!done) return;
      if (!directMode) {
        done({ ok: false, error: "Claims require a direct Telegram launch." });
        return;
      }
      finishDirect(
        directAuthorizedRequest("/rewards/claim", { method: "POST" }).then(
          claimResult,
        ),
        done,
      );
    },

    haptic: function (style) {
      if (directMode) {
        directHaptic(style || "light");
        return;
      }
      bridgeSend("haptic", { style: style || "light" }, null);
    },

    exit: function () {
      if (directMode) {
        telegram.close();
        return;
      }
      bridgeSend("exit", undefined, null);
    },
  };
})();
