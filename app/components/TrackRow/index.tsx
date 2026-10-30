import Image from "next/image";
import type { EnrichedTrack } from "../../(pages)/playlist/[id]/types";
import "../../(pages)/playlist/[id]/style.css";

function formatDuration(ms: number) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, "0");
  return `${m}:${s}`;
}


type Props = {
  track: EnrichedTrack;
  index: number;
};

export default function TrackRow({ track, index }: Props) {
  return (
    <div className="track-grid-row track-grid gap-3 px-4 py-2 rounded transition-colors hover:bg-white/5">
      <span className="track-number text-sm text-center">{index + 1}</span>

      <div className="flex items-center gap-3 min-w-0">
        {track.album.images?.[0] && (
          <Image
            src={track.album.images[0].url}
            alt={track.album.name}
            width={40}
            height={40}
            className="flex-shrink-0 rounded"
          />
        )}
        <div className="min-w-0">
          <p className="track-name text-sm font-medium truncate">{track.name}</p>
          <p className="track-artist text-xs truncate">
            {track.artists.map((a) => a.name).join(", ")}
          </p>
        </div>
      </div>

      <p className="track-album track-meta truncate">{track.album.name}</p>

      <p className="track-meta truncate">
        {track.genres.length > 0 ? track.genres.join(", ") : "—"}
      </p>

      <span className="track-meta">{track.audioFeatures ? track.audioFeatures.tempo : "—"}</span>
      <span className="track-meta">{track.audioFeatures?.key_of ?? "—"}</span>
      <span className="track-meta">{track.audioFeatures?.open_key ?? "—"}</span>
      <span className="track-meta">{track.audioFeatures?.time_sig ?? "—"}</span>
      <span className="track-meta">{track.audioFeatures ? track.audioFeatures.danceability : "—"}</span>
      <span className="track-meta">{track.audioFeatures ? track.audioFeatures.acousticness : "—"}</span>

      <span className="track-duration track-meta">{formatDuration(track.duration_ms)}</span>
    </div>
  );
}
