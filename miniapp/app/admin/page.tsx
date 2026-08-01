"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Screen } from "@/components/Screen";
import {
  ApiError,
  adminCreateGame,
  adminDeleteGame,
  adminListGames,
  adminUpdateGame,
  type AdminGame,
} from "@/lib/api";
import { notify, tap } from "@/lib/telegram";

/**
 * The catalogue editor.
 *
 * This screen is the whole point of moving games out of code: publishing becomes
 * filling in a form instead of a commit, a review, a backend deploy and a
 * frontend rebuild. At two hundred games that is the difference between a
 * platform and a repository.
 *
 * There is no client-side authorisation here, and that is not an oversight.
 * Every admin endpoint is gated on the server against a list of Telegram ids in
 * configuration; this page simply calls them and shows what comes back. Hiding
 * the route from non-admins in JavaScript would protect nothing — the endpoints
 * are what matter, and anyone can call those directly.
 */

const BLANK: AdminGame = {
  slug: "",
  title: "",
  tagline: "",
  embed_url: "https://",
  accent: "#C89B3C",
  status: "soon",
  sort_order: 100,
};

export default function AdminPage() {
  const router = useRouter();

  const [games, setGames] = useState<AdminGame[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AdminGame | null>(null);
  // The slug the draft is editing, captured when editing began. Kept separate
  // because the form allows changing the slug, and the server needs the old one
  // to know which row to update.
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setGames(await adminListGames());
    } catch (err) {
      // 404 means either "not an admin" or "no such endpoint", and the server
      // will not distinguish them on purpose. Both mean the same thing here.
      if (err instanceof ApiError && err.status === 404) setDenied(true);
      else setError(err instanceof Error ? err.message : "Could not load games.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      if (editingSlug) await adminUpdateGame(editingSlug, draft);
      else await adminCreateGame(draft);
      notify("success");
      setDraft(null);
      setEditingSlug(null);
      await load();
    } catch (err) {
      notify("error");
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(game: AdminGame, status: AdminGame["status"]) {
    setBusy(true);
    setError(null);
    try {
      await adminUpdateGame(game.slug, { ...game, status });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(game: AdminGame) {
    // Deleting is the only irreversible action on this screen, and "hidden"
    // covers almost every reason someone reaches for it.
    if (!window.confirm(`Delete ${game.title}? Hiding it is usually what you want.`)) {
      return;
    }
    setBusy(true);
    try {
      await adminDeleteGame(game.slug);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen onBack={() => router.push("/")}>
      {() => {
        if (denied) {
          return (
            <div className="state">
              <h1 className="heading">Not found</h1>
              <p className="body">This screen is not available on your account.</p>
            </div>
          );
        }

        return (
          <>
            <header className="page-header">
              <span className="eyebrow">Admin</span>
              <h1 className="display">Catalogue</h1>
              <p className="body">
                Manage published games and their trusted origins.
              </p>
            </header>

            {error && <p className="wallet-panel__error">{error}</p>}

            {draft ? (
              <GameForm
                draft={draft}
                busy={busy}
                isNew={!editingSlug}
                onChange={setDraft}
                onCancel={() => {
                  setDraft(null);
                  setEditingSlug(null);
                }}
                onSave={() => void save()}
              />
            ) : (
              <button
                className="button"
                onClick={() => {
                  tap();
                  setDraft({ ...BLANK });
                  setEditingSlug(null);
                }}
              >
                Add a game
              </button>
            )}

            {!games && !error && (
              <div className="stack" style={{ marginTop: 20 }}>
                <div className="skeleton" style={{ height: 74 }} />
                <div className="skeleton" style={{ height: 74 }} />
              </div>
            )}

            {games && (
              <div className="stack" style={{ marginTop: 20 }}>
                {games.map((game) => (
                  <GameRow
                    key={game.slug}
                    game={game}
                    busy={busy}
                    onEdit={() => {
                      tap();
                      setDraft({ ...game });
                      setEditingSlug(game.slug);
                    }}
                    onToggle={() =>
                      void setStatus(
                        game,
                        game.status === "hidden" ? "live" : "hidden",
                      )
                    }
                    onDelete={() => void remove(game)}
                  />
                ))}
              </div>
            )}
          </>
        );
      }}
    </Screen>
  );
}

function GameRow({
  game,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  game: AdminGame;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="tile" style={{ alignItems: "flex-start" }}>
      <span
        className="tile__pip"
        style={{ background: game.accent, opacity: game.status === "hidden" ? 0.3 : 1 }}
        aria-hidden
      />
      <span className="tile__body">
        <span className="heading">
          {game.title}{" "}
          <span className="eyebrow" style={{ opacity: 0.7 }}>
            {game.status}
          </span>
        </span>
        <p className="body" style={{ wordBreak: "break-all" }}>
          {game.slug} · {game.embed_url}
        </p>

        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button className="button button--quiet" disabled={busy} onClick={onEdit}>
            Edit
          </button>
          <button className="button button--quiet" disabled={busy} onClick={onToggle}>
            {game.status === "hidden" ? "Show" : "Hide"}
          </button>
          <button className="button button--danger" disabled={busy} onClick={onDelete}>
            Delete
          </button>
        </div>
      </span>
    </div>
  );
}

function GameForm({
  draft,
  busy,
  isNew,
  onChange,
  onCancel,
  onSave,
}: {
  draft: AdminGame;
  busy: boolean;
  isNew: boolean;
  onChange: (game: AdminGame) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof AdminGame>(key: K, value: AdminGame[K]) =>
    onChange({ ...draft, [key]: value });

  return (
    <div className="wallet-panel">
      <span className="eyebrow">{isNew ? "New game" : `Editing ${draft.slug}`}</span>

      <Field
        label="Slug"
        hint="Lowercase, hyphens. Used in the URL — changing it breaks shared links."
      >
        <input
          className="admin-input"
          value={draft.slug}
          onChange={(e) => set("slug", e.target.value)}
          placeholder="tap-rush"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </Field>

      <Field label="Title">
        <input
          className="admin-input"
          value={draft.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="Tap Rush"
        />
      </Field>

      <Field label="Tagline">
        <input
          className="admin-input"
          value={draft.tagline}
          onChange={(e) => set("tagline", e.target.value)}
          placeholder="One line describing the game"
        />
      </Field>

      <Field
        label="Origin"
        hint="https:// and a host only, no path. One game per origin, never two."
      >
        <input
          className="admin-input"
          value={draft.embed_url}
          onChange={(e) => set("embed_url", e.target.value)}
          placeholder="https://my-game.vercel.app"
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="url"
        />
      </Field>

      <Field label="Accent">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="color"
            value={draft.accent}
            onChange={(e) => set("accent", e.target.value.toUpperCase())}
            style={{ width: 44, height: 38, border: 0, background: "none" }}
          />
          <input
            className="admin-input"
            value={draft.accent}
            onChange={(e) => set("accent", e.target.value)}
          />
        </div>
      </Field>

      <Field label="Status" hint="Hidden takes it out of the catalogue instantly.">
        <select
          className="admin-input"
          value={draft.status}
          onChange={(e) => set("status", e.target.value as AdminGame["status"])}
        >
          <option value="live">live</option>
          <option value="soon">soon</option>
          <option value="hidden">hidden</option>
        </select>
      </Field>

      <Field label="Sort order" hint="Lower appears first.">
        <input
          className="admin-input"
          type="number"
          value={draft.sort_order}
          onChange={(e) => set("sort_order", Number(e.target.value) || 0)}
        />
      </Field>

      <div className="wallet-panel__actions">
        <button className="button" disabled={busy} onClick={onSave}>
          {busy ? "Saving…" : isNew ? "Create" : "Save"}
        </button>
        <button className="button button--quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginTop: 14 }}>
      <span className="eyebrow" style={{ display: "block", marginBottom: 6 }}>
        {label}
      </span>
      {children}
      {hint && (
        <span className="body" style={{ display: "block", marginTop: 4, opacity: 0.7 }}>
          {hint}
        </span>
      )}
    </label>
  );
}
