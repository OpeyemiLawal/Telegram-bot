/**
 * Thin typed wrapper over `window.Telegram.WebApp`.
 *
 * Rule enforced here: nothing outside this file reads `initDataUnsafe`.
 * It is unsigned and trivially forged. It is fine for painting a name on
 * screen before the server answers, and for nothing else.
 */

type HapticStyle = "light" | "medium" | "heavy" | "rigid" | "soft";

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: {
    user?: {
      id: number;
      first_name?: string;
      username?: string;
      photo_url?: string;
    };
  };
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  isExpanded: boolean;

  /**
   * Opens an http(s) URL outside the WebView. This is the only way to reach a
   * wallet app from inside Telegram — `window.open` is blocked on mobile and a
   * plain navigation destroys the WebApp JS context along with the pending
   * WalletConnect session.
   */
  openLink?(
    url: string,
    options?: { try_instant_view?: boolean; try_browser?: string },
  ): void;

  /** For `tg://` and `https://t.me/...` only. Stays inside Telegram. */
  openTelegramLink?(url: string): void;

  /**
   * Bot API 8.0. Optional because older Telegram clients do not have it, and a
   * game must still be playable there — the CSS overlay already fills the
   * WebView, so this only reclaims Telegram's own header.
   */
  requestFullscreen?(): void;
  exitFullscreen?(): void;
  isFullscreen?: boolean;

  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  disableVerticalSwipes?(): void;
  enableClosingConfirmation?(): void;
  HapticFeedback?: {
    impactOccurred(style: HapticStyle): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
  };
  BackButton: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function webApp(): TelegramWebApp | null {
  if (typeof window === "undefined") return null;
  return window.Telegram?.WebApp ?? null;
}

export function isInsideTelegram(): boolean {
  const app = webApp();
  return Boolean(app && app.initData);
}

/** The signed blob. Only ever send this to our own API over HTTPS. */
export function getInitData(): string {
  return webApp()?.initData ?? "";
}

/**
 * Which of the three environments we are in, because each connects a wallet a
 * different way and nothing else about them matters here.
 *
 *   mobile   Telegram's iOS/Android app. A wallet app is installed on the same
 *            device, so deep links work and a QR would ask the user to scan
 *            their own screen.
 *
 *   desktop  The installed Telegram Desktop client. Its webview has no
 *            extensions and no wallet app to hand off to. QR is the only route.
 *
 *   web      Telegram in a browser tab. Extensions may be present, so the
 *            injected-wallet path is worth trying before falling back to QR.
 *
 * `unknown` is grouped with desktop deliberately: QR is the option that works
 * everywhere, so an unrecognised client should land there rather than on a
 * deep link that may silently do nothing.
 */
export type TelegramSurface = "mobile" | "desktop" | "web";

export function telegramSurface(): TelegramSurface {
  const platform = webApp()?.platform ?? "unknown";

  if (platform === "android" || platform === "ios") return "mobile";
  // Telegram ships several web clients: "web" (K), "weba" (A), "webk".
  if (platform.startsWith("web")) return "web";
  return "desktop";
}

export function isMobileTelegram(): boolean {
  return telegramSurface() === "mobile";
}

/**
 * Whether a browser-extension wallet has injected itself.
 *
 * A hint, not a guarantee — Telegram's web clients frame the Mini App on a
 * different origin, and whether a given extension injects into that frame is up
 * to the extension. So this only decides which option is offered first; the QR
 * path stays reachable regardless.
 */
export function hasInjectedSolanaWallet(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.solana ?? w.solflare ?? w.backpack ?? w.phantom);
}

/** Unverified. Cosmetic use only — never for authorization. */
export function optimisticProfile() {
  const user = webApp()?.initDataUnsafe?.user;
  if (!user) return null;
  return {
    displayName: user.username || user.first_name || "player",
    photoUrl: user.photo_url ?? null,
  };
}

/** Call once on mount. Claims the viewport and uses Telegram's active theme. */
export function primeViewport(): void {
  const app = webApp();
  if (!app) return;

  const theme = window.getComputedStyle(document.documentElement);
  const background =
    theme.getPropertyValue("--tg-theme-bg-color").trim() || "#ffffff";
  const header =
    theme.getPropertyValue("--tg-theme-header-bg-color").trim() || background;

  app.ready();
  app.expand();
  app.setBackgroundColor(background);
  app.setHeaderColor(header);
  // Stops a downward swipe during gameplay from dismissing the app.
  app.disableVerticalSwipes?.();
}

export function tap(style: HapticStyle = "light"): void {
  webApp()?.HapticFeedback?.impactOccurred(style);
}

export function notify(type: "error" | "success" | "warning"): void {
  webApp()?.HapticFeedback?.notificationOccurred(type);
}

/**
 * Open an external page outside the WebView.
 *
 * A plain link does not reliably work here. Telegram blocks `window.open` on
 * mobile, and letting an anchor navigate the WebView would replace the Mini App
 * itself — taking the session, the wallet connection and the way back with it.
 * `openLink` is the sanctioned route and leaves the app running behind it.
 *
 * Falls back to a normal navigation outside Telegram, so the same code works in
 * a browser during development.
 */
export function openExternal(url: string): void {
  const app = webApp();

  if (app && typeof app.openLink === "function") {
    app.openLink(url, { try_instant_view: false });
    return;
  }

  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Ask Telegram for its own chrome back, for the duration of a game.
 *
 * Returns a cleanup function that restores the normal view. Both calls are
 * optional at runtime: `requestFullscreen` arrived in Bot API 8.0, and a client
 * older than that must still be able to play. The CSS overlay already fills the
 * WebView on its own — this only reclaims the header Telegram draws above it.
 */
export function enterFullscreen(): () => void {
  const app = webApp();
  if (!app || typeof app.requestFullscreen !== "function") return () => {};

  try {
    app.requestFullscreen();
  } catch {
    // Some clients advertise the method and reject the request, typically on a
    // surface where fullscreen makes no sense. Not worth surfacing to a player.
    return () => {};
  }

  return () => {
    try {
      app.exitFullscreen?.();
    } catch {
      /* leaving the game matters more than restoring chrome cleanly */
    }
  };
}

/** Wire Telegram's native back button to a handler. Returns a cleanup fn. */
export function bindBackButton(handler: () => void): () => void {
  const app = webApp();
  if (!app) return () => {};
  app.BackButton.onClick(handler);
  app.BackButton.show();
  return () => {
    app.BackButton.offClick(handler);
    app.BackButton.hide();
  };
}
