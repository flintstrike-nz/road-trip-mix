import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import Image from "next/image";
import Link from "next/link";
import LoginButton from "../login-button";

export default async function Header() {
  const session = await getServerSession(authOptions);

  return (
    <header
      className="flex flex-col gap-3 px-4 py-3 border-b sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4"
      style={{ borderColor: "var(--background-tinted-base)" }}
    >
      <Link href="/" className="shrink-0">
        <h1
          className="text-xl sm:text-2xl font-bold tracking-tight hover:opacity-80 transition-opacity"
          style={{ color: "var(--text-base)" }}
        >
          Road Trip Mix
        </h1>
      </Link>
      {session?.user ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link
            href="/collab"
            className="text-sm hover:opacity-80 transition-opacity"
            style={{ color: "var(--text-subdued)" }}
          >
            Collaborative Mix
          </Link>
          <Link
            href="/jam"
            className="text-sm hover:opacity-80 transition-opacity"
            style={{ color: "var(--text-subdued)" }}
          >
            Jam
          </Link>
          <Link
            href="/history"
            className="text-sm hover:opacity-80 transition-opacity"
            style={{ color: "var(--text-subdued)" }}
          >
            History
          </Link>
          <Link
            href="/settings"
            className="text-sm hover:opacity-80 transition-opacity"
            style={{ color: "var(--text-subdued)" }}
          >
            Settings
          </Link>
          <div className="flex items-center gap-2 ml-auto sm:ml-0">
            {session.user.image && (
              <Image
                src={session.user.image}
                alt={session.user.name ?? "Profile"}
                width={32}
                height={32}
                className="rounded-full shrink-0"
              />
            )}
            <span
              className="hidden sm:inline min-w-0 text-sm max-w-[10rem] truncate"
              style={{ color: "var(--text-subdued)" }}
            >
              {session.user.name}
            </span>
            <LoginButton signedIn />
          </div>
        </div>
      ) : (
        <LoginButton />
      )}
    </header>
  );
}
