import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import LoginButton from "@/app/components/login-button";
import HistoryView from "@/app/components/Jam/HistoryView";

export default async function HistoryPage() {
  const session = await getServerSession(authOptions);

  return (
    <div className="max-w-4xl w-full mx-auto px-6 py-10">
      {session?.user ? (
        <HistoryView />
      ) : (
        <div className="flex flex-col items-center justify-center py-32 gap-4">
          <p style={{ color: "var(--text-subdued)" }}>Login to see your play history</p>
          <LoginButton />
        </div>
      )}
    </div>
  );
}
