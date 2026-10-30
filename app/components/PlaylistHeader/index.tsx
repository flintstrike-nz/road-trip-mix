import Image from "next/image";
import Link from "next/link";
import type { PlaylistMeta } from "../../(pages)/playlist/[id]/types";
import "../../(pages)/playlist/[id]/style.css";

type Props = {
  playlist: PlaylistMeta;
  trackCount: number;
};

export default function PlaylistHeader({ playlist, trackCount }: Props) {
  return (
    <div className="playlist-header px-8 pt-8 pb-6">
      <Link href="/" className="back-link text-sm mb-6 inline-block transition-colors hover:text-white">
        ← Back
      </Link>

      <div className="flex gap-6 items-end mt-4">
        {playlist.images?.[0] ? (
          <Image
            src={playlist.images[0].url}
            alt={playlist.name}
            width={232}
            height={232}
            className="flex-shrink-0 shadow-2xl playlist-cover"
          />
        ) : (
          <div className="playlist-cover-placeholder w-[232px] h-[232px] flex-shrink-0 rounded" />
        )}
        <div className="pb-2">
          <p className="playlist-label text-xs font-bold uppercase tracking-widest mb-2">
            Playlist
          </p>
          <h1 className="playlist-title font-black mb-4">
            {playlist.name}
          </h1>
          {playlist.description && (
            <p
              className="playlist-description text-sm mb-2"
              dangerouslySetInnerHTML={{ __html: playlist.description }}
            />
          )}
          <p className="playlist-owner text-sm font-semibold">
            {playlist.owner?.display_name ?? "Unknown"}
            <span className="playlist-owner-sub font-normal">
              {" "}· {playlist.tracks?.total ?? trackCount} songs
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}
