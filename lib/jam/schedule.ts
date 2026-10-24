import type { BaseEntry, JamState, ScheduledItem } from "./types";

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
  const filler: ScheduledItem[] = state.base.map((b: BaseEntry) => ({
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
