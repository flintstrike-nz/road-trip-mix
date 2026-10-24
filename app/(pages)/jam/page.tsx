import { Suspense } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import LoginButton from "@/app/components/login-button";
import JamHome from "@/app/components/Jam/JamHome";

export default async function JamPage() {
  const session = await getServerSession(authOptions);

  return (
    <div className="max-w-4xl w-full mx-auto px-6 py-10">
      {session?.user ? (
        <Suspense fallback={null}>
          <JamHome />
        </Suspense>
      ) : (
        <div className="flex flex-col items-center justify-center py-32 gap-4">
          <p style={{ color: "var(--text-subdued)" }}>Login to host a jam</p>
          <LoginButton />
        </div>
      )}
    </div>
  );
}
