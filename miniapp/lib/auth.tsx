"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ApiError, resume, signIn, type Me } from "./api";
import { isInsideTelegram, notify } from "./telegram";

type Status = "booting" | "ready" | "outside" | "failed";

interface AuthState {
  status: Status;
  user: Me | null;
  error: string | null;
  retry: () => void;
  updateUser: (user: Me) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("booting");
  const [user, setUser] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const boot = useCallback(async () => {
    setStatus("booting");
    setError(null);

    if (!isInsideTelegram()) {
      setStatus("outside");
      return;
    }

    try {
      // Reload path first: reusing initData would trip the server's
      // replay guard, so try the refresh token before the launch payload.
      const restored = await resume();
      setUser(restored ?? (await signIn()));
      setStatus("ready");
    } catch (err) {
      notify("error");
      setError(
        err instanceof ApiError ? err.message : "Could not reach the server.",
      );
      setStatus("failed");
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void boot();

    /**
     * Warm the wallet stack while the user is still on the home screen.
     *
     * `ensureWalletKit()` initialises a WalletConnect UniversalProvider, which
     * performs a relay handshake and pulls the wallet registry. Left until the
     * Wallet screen mounts, that cost lands squarely between the user tapping a
     * wallet and their extension appearing — a pause with no explanation, which
     * reads as the click not having registered.
     *
     * Starting it here moves the same work into time the user is already
     * spending reading the home screen. It is idempotent and deliberately not
     * awaited: nothing about signing in depends on it, and a failure is already
     * captured and surfaced by the Wallet screen's diagnostics.
     */
    void import("./wallet-kit").then((m) => m.ensureWalletKit());
  }, [boot]);

  return (
    <AuthContext.Provider value={{ status, user, error, retry: boot, updateUser: setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
