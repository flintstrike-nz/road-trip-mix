import Header from "../components/Header";
import Footer from "../components/Footer";
import BackgroundRecorder from "../components/Jam/BackgroundRecorder";

export default function PagesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col" style={{ backgroundColor: "var(--background-base)" }}>
      <Header />
      <BackgroundRecorder />
      <div className="flex-1">
        {children}
      </div>
      <Footer />
    </div>
  );
}
