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
  colorScheme: "light" | "dark";
  isExpanded: boolean;
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

/** Unverified. Cosmetic use only — never for authorization. */
export function optimisticProfile() {
  const user = webApp()?.initDataUnsafe?.user;
  if (!user) return null;
  return {
    displayName: user.username || user.first_name || "player",
    photoUrl: user.photo_url ?? null,
  };
}

/** Call once on mount. Claims the viewport and paints our own chrome. */
export function primeViewport(background: string, header: string): void {
  const app = webApp();
  if (!app) return;
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
