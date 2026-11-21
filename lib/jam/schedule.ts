import { SongSet } from "../dedupe";
import { playedKeys } from "./rules";
import type { BaseEntry, JamState, PlayedEntry, ScheduledItem } from "./types";

// Derives the upcoming play order from the per-member queues.
//
// Each member's i-th queued song is assigned to round `firstRound(member) + i`,
// and songs are then ordered by (round, position in the rotation). That gives
// "one song per member per round" with these properties:
//  - a member with an empty queue is simply skipped for that round;
//  - a member who adds a song joins the *next turn they haven't had yet*: the
//    current round if their position is still ahead of the cursor, otherwise
//    the next round;
//  - reordering or removing songs in a member's own queue changes which song
//    lands in which round, but never lets them take two turns in one round.
//
// The song at `state.cursor` is already playing and is not part of the result.
export function firstRound(state: JamState, memberId: string): number {
  const pos = state.memberOrder.indexOf(memberId);
  const cursor = state.cursor;
  const last = (state.lastRound[memberId] ?? -1) + 1; // can't go before the round after their last locked song
  if (!cursor) return Math.max(0, last);
  const eligible = pos > cursor.turn ? cursor.round : cursor.round + 1;
  return Math.max(eligible, last);
}

// The play log only grows by replacement (a new array each time), so its normalised keys are
// computed once per version of the log rather than on every schedule rebuild.
// Match keys are stored on each play when it's logged, so this is just collecting strings.
function collectPlayedKeys(played: PlayedEntry[]): Set<string> {
  const keys = new Set<string>();
  played.forEach((p) => playedKeys(p).forEach((k) => keys.add(k)));
  return keys;
}

export function buildUpcoming(state: JamState): ScheduledItem[] {
  const slots: { round: number; pos: number; item: ScheduledItem }[] = [];
  state.memberOrder.forEach((memberId, pos) => {
    const queue = state.queues[memberId] ?? [];
    const start = firstRound(state, memberId);
    queue.forEach((entry, i) => {
      slots.push({
        round: start + i,
        pos,
        item: { entryId: entry.id, track: entry.track, memberId, round: start + i },
      });
    });
  });
  slots.sort((a, b) => a.round - b.round || a.pos - b.pos);
  const jam = slots.map((s) => s.item);
  // A song never appears twice in the playlist: filler is skipped if the same song is already
  // queued, playing, played this session, or listed earlier in the filler.
  const seen = new SongSet(collectPlayedKeys(state.played));
  if (state.nowPlaying) seen.add(state.nowPlaying.track);
  jam.forEach((i) => seen.add(i.track));
  const filler: ScheduledItem[] = state.base
    .filter((b: BaseEntry) => seen.add(b.track))
    .map((b: BaseEntry) => ({
      entryId: b.id,
      track: b.track,
      memberId: null,
      round: null,
    }));
  return [...jam, ...filler];
}

// Which entry plays next (head of the schedule), if any.
export function peekNext(state: JamState): ScheduledItem | null {
  return buildUpcoming(state)[0] ?? null;
}

// True for something that played from outside the jam playlist (see JamHost.trackStarted).
export const isExternalItem = (item: ScheduledItem): boolean => item.external === true;
