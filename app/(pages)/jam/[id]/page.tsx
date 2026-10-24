import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import LoginButton from "@/app/components/login-button";
import JamConsole from "@/app/components/Jam/JamConsole";

export default async function JamSessionPage({ params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);

  return (
    <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 py-6">
      {session?.user ? (
        <JamConsole id={params.id} />
      ) : (
        <div className="flex flex-col items-center justify-center py-32 gap-4">
          <p style={{ color: "var(--text-subdued)" }}>Login to host a jam</p>
          <LoginButton />
        </div>
      )}
    </div>
  );
}
