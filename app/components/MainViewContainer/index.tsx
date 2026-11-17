"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import PlaylistBox, { type Playlist } from "../PlaylistBox";
import PlaylistListItem from "../PlaylistListItem";
import GroupedPlaylistCard from "../GroupedPlaylistCard";
import {
  loadGroupedPlaylists,
  saveGroupedPlaylists,
  type GroupedPlaylist,
} from "@/lib/grouped-playlists";
import { getAllPlaylists } from "@/lib/spotify";
import "./style.css";

type Group = { id: string; name: string; playlistIds: string[] };
type View = "grid" | "list";

const GROUPS_KEY = "road-trip-mix:groups";
const VIEW_KEY = "road-trip-mix:view";

// ── Group header with inline rename ──────────────────────────────────────────

function GroupHeader({
  group,
  onRename,
  onDelete,
  onAddGroupedPlaylist,
}: {
  group: Group;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onAddGroupedPlaylist: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);

  const save = () => {
    const trimmed = draft.trim();
    if (trimmed) onRename(group.id, trimmed);
    else setDraft(group.name);
    setEditing(false);
  };

  return (
    <div className="group-header">
      {editing ? (
        <input
          autoFocus
          className="group-header__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") { setDraft(group.name); setEditing(false); }
          }}
        />
      ) : (
        <h3 className="group-header__name" onDoubleClick={() => setEditing(true)}>
          {group.name}
        </h3>
      )}
      <span className="group-header__count">{group.playlistIds.length}</span>
      <button className="group-header__btn group-header__btn--add" title="New grouped playlist" onClick={onAddGroupedPlaylist}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
          <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/>
        </svg>
      </button>
      <button className="group-header__btn" title="Rename" onClick={() => setEditing(true)}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
          <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z"/>
        </svg>
      </button>
      <button className="group-header__btn group-header__btn--delete" title="Delete group" onClick={() => onDelete(group.id)}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
          <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
          <path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
        </svg>
      </button>
    </div>
  );
}

// ── Per-playlist group assignment button + popover ────────────────────────────

function GroupButton({
  playlist,
  groups,
  onAssign,
  onRemove,
  onCreate,
}: {
  playlist: Playlist;
  groups: Group[];
  onAssign: (playlistId: string, groupId: string) => void;
  onRemove: (playlistId: string) => void;
  onCreate: (name: string, playlistId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setName("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const currentGroup = groups.find((g) => g.playlistIds.includes(playlist.id));

  return (
    <div className="group-btn-wrapper" ref={ref}>
      <button
        className="group-btn"
        title="Assign to group"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
          setCreating(false);
          setName("");
        }}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M9.828 3h3.982a2 2 0 0 1 1.992 2.181l-.637 7A2 2 0 0 1 13.174 14H2.825a2 2 0 0 1-1.991-1.819l-.637-7a1.99 1.99 0 0 1 .342-1.31L.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3zm-8.322.12C1.72 3.042 1.95 3 2.19 3h5.396l-.707-.707A1 1 0 0 0 6.172 2H2.5a1 1 0 0 0-1 .981l.006.139z"/>
        </svg>
      </button>
      {open && (
        <div className="group-popover">
          {currentGroup && (
            <button
              className="group-popover__item group-popover__item--remove"
              onClick={() => onRemove(playlist.id)}
            >
              Remove from &ldquo;{currentGroup.name}&rdquo;
            </button>
          )}
          {groups
            .filter((g) => g.id !== currentGroup?.id)
            .map((g) => (
              <button
                key={g.id}
                className="group-popover__item"
                onClick={() => onAssign(playlist.id, g.id)}
              >
                {currentGroup ? "Move to" : "Add to"} &ldquo;{g.name}&rdquo;
              </button>
            ))}
          {groups.length > 0 && <div className="group-popover__divider" />}
          {!creating ? (
            <button
              className="group-popover__item group-popover__item--new"
              onClick={() => setCreating(true)}
            >
              + New group
            </button>
          ) : (
            <form
              className="group-popover__form"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) onCreate(name.trim(), playlist.id);
              }}
            >
              <input
                autoFocus
                className="group-popover__input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Group name"
                onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
              />
              <button
                type="submit"
                className="group-popover__confirm"
                disabled={!name.trim()}
              >
                Create
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main container ────────────────────────────────────────────────────────────

export default function MainViewContainer() {
  const { data: session } = useSession();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [playlistError, setPlaylistError] = useState<string | null>(null);
  const [view, setView] = useState<View>("grid");
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupedPlaylists, setGroupedPlaylists] = useState<GroupedPlaylist[]>([]);
  const [creatingGroupedIn, setCreatingGroupedIn] = useState<string | null>(null);
  const [newGpName, setNewGpName] = useState("");

  // Track which token we last fetched for to prevent React StrictMode double-fire
  const fetchedTokenRef = useRef<string | null>(null);
  const [retryIn, setRetryIn] = useState<number | null>(null);

  const fetchPlaylists = async (token: string) => {
    setLoadingPlaylists(true);
    setPlaylistError(null);
    setRetryIn(null);
    try {
      const result = await getAllPlaylists(token);
      setPlaylists(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load playlists.";
      setPlaylistError(msg);
      // Start auto-retry countdown: parse seconds from message or default 30
      if (msg.includes("rate limit")) {
        const match = msg.match(/(\d+)s/);
        setRetryIn(match ? parseInt(match[1]) : 30);
      }
    } finally {
      setLoadingPlaylists(false);
    }
  };

  // Countdown tick
  useEffect(() => {
    if (retryIn === null || retryIn <= 0) return;
    const t = setTimeout(() => setRetryIn((n) => (n !== null ? n - 1 : null)), 1000);
    return () => clearTimeout(t);
  }, [retryIn]);

  // Auto-retry when countdown reaches 0
  useEffect(() => {
    if (retryIn !== 0 || !session?.accessToken) return;
    fetchedTokenRef.current = null;
    fetchPlaylists(session.accessToken);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryIn]);

  useEffect(() => {
    if (!session?.accessToken) return;
    // Skip if we already fetched for this token (prevents React StrictMode double-fire)
    if (fetchedTokenRef.current === session.accessToken) return;
    fetchedTokenRef.current = session.accessToken;
    fetchPlaylists(session.accessToken);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.accessToken]);

  useEffect(() => {
    try {
      const g = localStorage.getItem(GROUPS_KEY);
      if (g) setGroups(JSON.parse(g));
      const v = localStorage.getItem(VIEW_KEY) as View | null;
      if (v === "grid" || v === "list") setView(v);
      setGroupedPlaylists(loadGroupedPlaylists());
    } catch {}
  }, []);

  const saveGp = (next: GroupedPlaylist[]) => {
    setGroupedPlaylists(next);
    saveGroupedPlaylists(next);
  };

  const createGroupedPlaylist = (name: string, groupId: string) => {
    saveGp([
      ...groupedPlaylists,
      { id: "local_" + crypto.randomUUID(), name, groupId, rules: [], createdAt: new Date().toISOString() },
    ]);
    setCreatingGroupedIn(null);
    setNewGpName("");
  };

  const saveGroups = (next: Group[]) => {
    setGroups(next);
    localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
  };

  const saveView = (v: View) => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  };

  const assignToGroup = (playlistId: string, groupId: string) => {
    saveGroups(
      groups.map((g) => ({
        ...g,
        playlistIds:
          g.id === groupId
            ? Array.from(new Set([...g.playlistIds, playlistId]))
            : g.playlistIds.filter((id) => id !== playlistId),
      }))
    );
  };

  const removeFromGroup = (playlistId: string) => {
    saveGroups(
      groups.map((g) => ({
        ...g,
        playlistIds: g.playlistIds.filter((id) => id !== playlistId),
      }))
    );
  };

  const createGroup = (name: string, playlistId?: string) => {
    saveGroups([
      ...groups,
      {
        id: crypto.randomUUID(),
        name,
        playlistIds: playlistId ? [playlistId] : [],
      },
    ]);
  };

  const renameGroup = (id: string, name: string) => {
    saveGroups(groups.map((g) => (g.id === id ? { ...g, name } : g)));
  };

  const deleteGroup = (id: string) => {
    saveGroups(groups.filter((g) => g.id !== id));
  };

  const assignedIds = groups.flatMap((g) => g.playlistIds);
  const ungrouped = playlists.filter((p) => !assignedIds.includes(p.id));
  const groupSections = groups.map((g) => ({
    ...g,
    items: g.playlistIds
      .map((id) => playlists.find((p) => p.id === id))
      .filter((p): p is Playlist => !!p),
  }));

  const gridClass =
    "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4";

  const renderItem = (playlist: Playlist) => {
    const group = groups.find((g) => g.playlistIds.includes(playlist.id));
    return (
      <div
        key={playlist.id}
        className={`playlist-item-wrapper playlist-item-wrapper--${view}`}
      >
        {view === "grid" ? (
          <PlaylistBox playlist={playlist} />
        ) : (
          <PlaylistListItem playlist={playlist} groupName={group?.name} />
        )}
        <GroupButton
          playlist={playlist}
          groups={groups}
          onAssign={assignToGroup}
          onRemove={removeFromGroup}
          onCreate={createGroup}
        />
      </div>
    );
  };

  return (
    <section className="main-view-container">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold" style={{ color: "var(--text-base)" }}>
          {loadingPlaylists ? "Loading playlists…" : "Your Playlists"}
        </h2>
        <div className="flex items-center gap-1">
          <button
            className={`view-toggle-btn ${view === "grid" ? "view-toggle-btn--active" : ""}`}
            onClick={() => saveView("grid")}
            title="Grid view"
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor">
              <path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v3A1.5 1.5 0 0 1 5.5 7h-3A1.5 1.5 0 0 1 1 5.5v-3zm8 0A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7h-3A1.5 1.5 0 0 1 9 5.5v-3zm-8 8A1.5 1.5 0 0 1 2.5 9h3A1.5 1.5 0 0 1 7 10.5v3A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5v-3zm8 0A1.5 1.5 0 0 1 10.5 9h3A1.5 1.5 0 0 1 15 10.5v3A1.5 1.5 0 0 1 13.5 15h-3A1.5 1.5 0 0 1 9 13.5v-3z"/>
            </svg>
          </button>
          <button
            className={`view-toggle-btn ${view === "list" ? "view-toggle-btn--active" : ""}`}
            onClick={() => saveView("list")}
            title="List view"
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor">
              <path fillRule="evenodd" d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Shown until the first group exists: grouping is how playlists get merged */}
      {groups.length === 0 && playlists.length > 1 && (
        <p className="group-hint">
          Merge playlists: use the group button on a playlist to start a group, then create a grouped playlist
          from it. Pick round-robin, shuffle or sort rules and push the result to Spotify.
        </p>
      )}

      {/* Creation modal */}
      {creatingGroupedIn && (
        <div className="create-gp-overlay" onClick={() => { setCreatingGroupedIn(null); setNewGpName(""); }}>
          <div className="create-gp-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="create-gp-modal__title">New Grouped Playlist</h3>
            <p className="create-gp-modal__sub">
              in &ldquo;{groups.find((g) => g.id === creatingGroupedIn)?.name}&rdquo;
            </p>
            <form onSubmit={(e) => { e.preventDefault(); if (newGpName.trim()) createGroupedPlaylist(newGpName.trim(), creatingGroupedIn); }}>
              <input
                autoFocus
                className="create-gp-modal__input"
                value={newGpName}
                onChange={(e) => setNewGpName(e.target.value)}
                placeholder="Playlist name"
                onKeyDown={(e) => e.key === "Escape" && (setCreatingGroupedIn(null), setNewGpName(""))}
              />
              <div className="create-gp-modal__actions">
                <button type="button" className="create-gp-modal__cancel" onClick={() => { setCreatingGroupedIn(null); setNewGpName(""); }}>Cancel</button>
                <button type="submit" className="create-gp-modal__confirm" disabled={!newGpName.trim()}>Create</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Error / retry */}
      {playlistError && (
        <div className="mb-6" style={{ color: "var(--text-subdued)", fontSize: "0.875rem" }}>
          <span style={{ color: "#e25f5f" }}>{playlistError}</span>
          {session?.accessToken && (
            retryIn !== null && retryIn > 0 ? (
              <span className="ml-3">Retrying in {retryIn}s…</span>
            ) : (
              <button
                onClick={() => {
                  fetchedTokenRef.current = null;
                  fetchPlaylists(session.accessToken!);
                }}
                className="ml-3 underline"
                style={{ color: "var(--text-base)" }}
              >
                Retry
              </button>
            )
          )}
        </div>
      )}

      {/* Group sections */}
      {groupSections.map((group) => {
        const gps = groupedPlaylists.filter((gp) => gp.groupId === group.id);
        if (group.items.length === 0 && gps.length === 0) return null;
        return (
          <div key={group.id} className="playlist-group">
            <GroupHeader
              group={group}
              onRename={renameGroup}
              onDelete={deleteGroup}
              onAddGroupedPlaylist={() => setCreatingGroupedIn(group.id)}
            />
            <div className={view === "grid" ? gridClass : "flex flex-col"}>
              {gps.map((gp) => (
                <GroupedPlaylistCard key={gp.id} playlist={gp} view={view} />
              ))}
              {group.items.map(renderItem)}
            </div>
          </div>
        );
      })}

      {/* Ungrouped */}
      {ungrouped.length > 0 && (
        <div>
          {groups.length > 0 && (
            <p
              className="text-xs font-semibold uppercase tracking-wider mb-3"
              style={{ color: "var(--text-subdued)" }}
            >
              Other Playlists
            </p>
          )}
          <div className={view === "grid" ? gridClass : "flex flex-col"}>
            {ungrouped.map(renderItem)}
          </div>
        </div>
      )}
    </section>
  );
}
