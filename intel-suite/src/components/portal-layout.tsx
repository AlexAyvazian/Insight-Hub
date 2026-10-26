import { ReactNode } from "react";
import { ArrowLeft, Settings } from "lucide-react";
import { Link, useLocation } from "wouter";

const GlowBackground = () => (
  <>
    <style>{`
      @keyframes orb1 {
        0%   { transform: translate(0px, 0px) scale(1); }
        25%  { transform: translate(160px, 180px) scale(1.18); }
        50%  { transform: translate(60px, 300px) scale(0.85); }
        75%  { transform: translate(-120px, 140px) scale(1.1); }
        100% { transform: translate(0px, 0px) scale(1); }
      }
      @keyframes orb2 {
        0%   { transform: translate(0px, 0px) scale(1); }
        25%  { transform: translate(-200px, -150px) scale(1.22); }
        50%  { transform: translate(-80px, -280px) scale(0.82); }
        75%  { transform: translate(140px, -120px) scale(1.12); }
        100% { transform: translate(0px, 0px) scale(1); }
      }
      @keyframes orb3 {
        0%   { transform: translate(0px, 0px) scale(1); }
        33%  { transform: translate(240px, -200px) scale(1.28); }
        66%  { transform: translate(-160px, 160px) scale(0.8); }
        100% { transform: translate(0px, 0px) scale(1); }
      }
      @keyframes orb-pulse {
        0%, 100% { opacity: 0.55; transform: scale(1); }
        50%       { opacity: 0.85; transform: scale(1.15); }
      }
      @media (prefers-reduced-motion: reduce) {
        .portal-orb { animation: none !important; }
      }
      @media (max-width: 640px) {
        .portal-orb-low-priority { display: none; }
      }
    `}</style>

    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        overflow: "hidden",
        contain: "strict",
      }}
    >
      <div
        className="portal-orb"
        style={{
          position: "absolute",
          top: "-10%",
          left: "-5%",
          width: "600px",
          height: "600px",
          borderRadius: "50%",
          background:
            "radial-gradient(circle at center, rgba(56,182,255,0.55) 0%, rgba(56,182,255,0.25) 35%, transparent 70%)",
          filter: "blur(40px)",
          animation: "orb1 18s ease-in-out infinite",
        }}
      />
      <div
        className="portal-orb"
        style={{
          position: "absolute",
          bottom: "-8%",
          right: "-5%",
          width: "700px",
          height: "700px",
          borderRadius: "50%",
          background:
            "radial-gradient(circle at center, rgba(30,140,255,0.60) 0%, rgba(80,200,255,0.28) 35%, transparent 70%)",
          filter: "blur(45px)",
          animation: "orb2 22s ease-in-out infinite",
          animationDelay: "-10s",
        }}
      />
      <div
        className="portal-orb portal-orb-low-priority"
        style={{
          position: "absolute",
          top: "30%",
          left: "35%",
          width: "450px",
          height: "450px",
          borderRadius: "50%",
          background:
            "radial-gradient(circle at center, rgba(0,200,220,0.45) 0%, rgba(56,182,255,0.20) 40%, transparent 70%)",
          filter: "blur(35px)",
          animation: "orb3 14s ease-in-out infinite",
          animationDelay: "-6s",
        }}
      />
      <div
        className="portal-orb portal-orb-low-priority"
        style={{
          position: "absolute",
          top: "5%",
          right: "10%",
          width: "280px",
          height: "280px",
          borderRadius: "50%",
          background:
            "radial-gradient(circle at center, rgba(100,210,255,0.70) 0%, rgba(56,182,255,0.30) 40%, transparent 70%)",
          filter: "blur(25px)",
          animation: "orb-pulse 8s ease-in-out infinite",
          animationDelay: "-3s",
        }}
      />
      <div
        className="portal-orb portal-orb-low-priority"
        style={{
          position: "absolute",
          bottom: "10%",
          left: "8%",
          width: "350px",
          height: "350px",
          borderRadius: "50%",
          background:
            "radial-gradient(circle at center, rgba(30,100,255,0.50) 0%, rgba(56,182,255,0.22) 40%, transparent 70%)",
          filter: "blur(30px)",
          animation: "orb-pulse 13s ease-in-out infinite",
          animationDelay: "-7s",
        }}
      />
    </div>
  </>
);

export function PortalLayout({ children }: { children: ReactNode }) {
  const [pathname] = useLocation();

  return (
    <div
      className="relative flex min-h-dvh w-full min-w-0 bg-background"
      style={{ isolation: "isolate" }}
    >
      <a
        href="#portal-main-content"
        className="fixed left-4 top-3 z-[100] -translate-y-24 rounded-lg border border-primary/40 bg-background px-4 py-2 text-sm font-semibold text-white shadow-xl transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>

      <GlowBackground />

      <div
        className="relative z-10 flex min-h-dvh min-w-0 w-full flex-col"
      >
        <div className="sticky top-0 z-40 border-b border-white/5 bg-background/70 backdrop-blur-xl">
          <header className="flex h-16 min-w-0 items-center px-3 sm:px-4 md:px-8">
            <Link
              href="/"
              className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70 transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden xs:inline sm:inline">Insight Hub</span>
            </Link>

            <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
              {(pathname === "/portal/opportunities" || pathname === "/portal/settings") && <Link
                href="/portal/settings"
                aria-current={pathname === "/portal/settings" ? "page" : undefined}
                className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${
                  pathname === "/portal/settings"
                    ? "border-primary/40 bg-primary/15 text-white"
                    : "border-white/10 bg-white/5 text-white/65 hover:border-primary/40 hover:bg-primary/10 hover:text-white"
                }`}
              >
                <Settings className="h-4 w-4" />
                <span className="hidden lg:inline">Procurement Operations</span>
              </Link>}
              <div
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-gradient-to-tr from-primary/40 to-primary/20"
              >
                <span className="text-xs font-bold text-white">IS</span>
              </div>
            </div>
          </header>

        </div>

        <main
          id="portal-main-content"
          tabIndex={-1}
          className="ui-page-shell ui-scrollbar-stable ui-safe-bottom flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6 lg:p-8"
        >
          <div className="mx-auto min-w-0 w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
