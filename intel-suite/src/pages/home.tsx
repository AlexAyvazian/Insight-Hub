import { motion } from "framer-motion";
import { Link } from "wouter";
import {
  ArrowRight,
  CalendarRange,
  Building2,
  ExternalLink,
  FileText,
  Network,
  Newspaper,
  RefreshCcw,
  Search,
  TrendingUp,
  Users,
} from "lucide-react";
import outreachGalaxyButton from "@/assets/portal-buttons/outreach-galaxy.png";
import relationshipPlanetButton from "@/assets/portal-buttons/relationship-planet.png";
import hiringCompassButton from "@/assets/portal-buttons/hiring-compass.png";
import occuMedLogoSrc from "@/assets/occu-med-logo.png";

type PortalLinkKey = "outreach" | "relationship" | "hiringTrends";
type PortalLinks = Record<PortalLinkKey, string>;

const SOURCE_VAULT_FALLBACK_URL = "https://source-vault.onrender.com";
const ULTRA_SEARCH_URL = "https://ultra-search-browser.onrender.com";

function normalizeExternalPortalUrl(rawUrl: string | undefined) {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return SOURCE_VAULT_FALLBACK_URL;

  if (
    trimmed.startsWith("/") ||
    trimmed.includes("/portal/prospects") ||
    trimmed.includes("/portal/clients")
  ) {
    return SOURCE_VAULT_FALLBACK_URL;
  }

  try {
    const url = new URL(trimmed);
    if (
      url.pathname.startsWith("/portal/prospects") ||
      url.pathname.startsWith("/portal/clients")
    ) {
      return SOURCE_VAULT_FALLBACK_URL;
    }
    return url.toString();
  } catch {
    return SOURCE_VAULT_FALLBACK_URL;
  }
}

const SOURCE_VAULT_URL = normalizeExternalPortalUrl(
  import.meta.env.VITE_FILE_SHARING_PORTAL_URL,
);

const SHARED_PORTAL_LINKS: PortalLinks = {
  outreach: import.meta.env.VITE_OUTREACH_PORTAL_URL ?? "",
  relationship: import.meta.env.VITE_RELATIONSHIP_PORTAL_URL ?? "",
  hiringTrends: import.meta.env.VITE_HIRING_TRENDS_PORTAL_URL ?? "",
};

function OccuMedHeroLogo() {
  return (
    <div className="mb-[-18px] flex justify-center" aria-label="Occu-Med">
      <img
        src={occuMedLogoSrc}
        alt="Occu-Med"
        decoding="async"
        className="h-auto w-[430px] max-w-full drop-shadow-[0_0_38px_rgba(255,255,255,0.28)]"
      />
    </div>
  );
}

export default function Home() {
  const extraCards = [
    {
      key: "outreach",
      imgUrl: outreachGalaxyButton,
      alt: "Outreach Intelligence",
      icon: <Network className="w-5 h-5 text-primary-foreground" />,
      title: "Outreach Intelligence",
      desc: "Look up employee contacts, org charts, and decision-makers across client and prospect organizations to power targeted outreach.",
      delay: 0.7,
      link: SHARED_PORTAL_LINKS.outreach,
    },
    {
      key: "relationship",
      imgUrl: relationshipPlanetButton,
      alt: "Relationship Intelligence",
      icon: <Users className="w-5 h-5 text-primary-foreground" />,
      title: "Relationship Intelligence",
      desc: "Unified view of clients and prospects — relationship status, tiers, branches, contacts, and opportunity signals in one place.",
      delay: 0.8,
      link: SHARED_PORTAL_LINKS.relationship,
    },
    {
      key: "hiringTrends",
      imgUrl: hiringCompassButton,
      alt: "Hiring Trend Intelligence",
      icon: <TrendingUp className="w-5 h-5 text-primary-foreground" />,
      title: "Hiring Trend Intelligence",
      desc: "Track hiring velocity, open roles, and workforce expansion signals across client and prospect organizations to identify needs early.",
      delay: 0.9,
      link: SHARED_PORTAL_LINKS.hiringTrends,
    },
  ];

  return (
    <div className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-x-hidden bg-background p-4">
      <style>{`
        @keyframes home-orb1 {
          0%   { transform: translate(0px, 0px) scale(1); }
          25%  { transform: translate(160px, 170px) scale(1.16); }
          50%  { transform: translate(60px, 300px) scale(0.88); }
          75%  { transform: translate(-120px, 150px) scale(1.10); }
          100% { transform: translate(0px, 0px) scale(1); }
        }
        @keyframes home-orb2 {
          0%   { transform: translate(0px, 0px) scale(1); }
          25%  { transform: translate(-200px, -150px) scale(1.20); }
          50%  { transform: translate(-90px, -280px) scale(0.85); }
          75%  { transform: translate(140px, -120px) scale(1.12); }
          100% { transform: translate(0px, 0px) scale(1); }
        }
        @keyframes home-orb3 {
          0%   { transform: translate(0px, 0px) scale(1); }
          33%  { transform: translate(240px, -180px) scale(1.25); }
          66%  { transform: translate(-160px, 150px) scale(0.82); }
          100% { transform: translate(0px, 0px) scale(1); }
        }
        @keyframes home-pulse {
          0%, 100% { opacity: 0.70; transform: scale(1); }
          50%       { opacity: 1; transform: scale(1.22); }
        }
        @media (prefers-reduced-motion: reduce) {
          .home-orb { animation: none !important; }
        }
      `}</style>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
      >
        <div className="absolute inset-0 bg-background" />
        <div
          className="home-orb"
          style={{
            position: "absolute",
            top: "-12%",
            left: "-8%",
            width: "650px",
            height: "650px",
            borderRadius: "50%",
            background:
              "radial-gradient(circle at center, rgba(56,182,255,0.80) 0%, rgba(56,182,255,0.40) 35%, transparent 70%)",
            filter: "blur(36px)",
            animation: "home-orb1 18s ease-in-out infinite",
          }}
        />
        <div
          className="home-orb"
          style={{
            position: "absolute",
            bottom: "-10%",
            right: "-6%",
            width: "750px",
            height: "750px",
            borderRadius: "50%",
            background:
              "radial-gradient(circle at center, rgba(30,140,255,0.82) 0%, rgba(80,200,255,0.42) 35%, transparent 70%)",
            filter: "blur(40px)",
            animation: "home-orb2 22s ease-in-out infinite",
            animationDelay: "-11s",
          }}
        />
        <div
          className="home-orb"
          style={{
            position: "absolute",
            top: "28%",
            right: "12%",
            width: "480px",
            height: "480px",
            borderRadius: "50%",
            background:
              "radial-gradient(circle at center, rgba(0,200,220,0.68) 0%, rgba(56,182,255,0.32) 40%, transparent 70%)",
            filter: "blur(32px)",
            animation: "home-orb3 14s ease-in-out infinite",
            animationDelay: "-6s",
          }}
        />
        <div
          className="home-orb"
          style={{
            position: "absolute",
            top: "5%",
            right: "8%",
            width: "320px",
            height: "320px",
            borderRadius: "50%",
            background:
              "radial-gradient(circle at center, rgba(100,220,255,0.90) 0%, rgba(56,182,255,0.45) 40%, transparent 70%)",
            filter: "blur(22px)",
            animation: "home-pulse 9s ease-in-out infinite",
            animationDelay: "-3s",
          }}
        />
        <div
          className="home-orb"
          style={{
            position: "absolute",
            bottom: "12%",
            left: "6%",
            width: "400px",
            height: "400px",
            borderRadius: "50%",
            background:
              "radial-gradient(circle at center, rgba(30,100,255,0.72) 0%, rgba(56,182,255,0.34) 40%, transparent 70%)",
            filter: "blur(26px)",
            animation: "home-pulse 13s ease-in-out infinite",
            animationDelay: "-8s",
          }}
        />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-6xl min-w-0 flex-col items-center py-6 sm:py-8">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="mb-16 text-center"
        >
          <OccuMedHeroLogo />
          <h1 className="mb-6 text-5xl font-display font-bold tracking-tight text-white md:text-7xl">
            Insight <span className="text-gradient">Hub</span>
          </h1>
          <p className="mx-auto max-w-2xl text-lg font-light leading-relaxed text-muted-foreground md:text-xl">
            The strategic intelligence command center for Occu-Med — surfacing contracting opportunities, tracking entity relationships, and mapping the competitive landscape.
          </p>
        </motion.div>

        <div className="grid w-full min-w-0 grid-cols-1 gap-6 md:grid-cols-3">
          {[
            {
              href: "/portal/opportunities",
              imgUrl:
                "https://media.base44.com/images/public/69dcaa5f2cdb34ef76b60740/0217324d6_e6551bb4-354c-4267-bcc8-3a654f7d911a.png",
              alt: "Opportunity Intelligence",
              icon: <Search className="w-5 h-5 text-primary-foreground" />,
              title: "Opportunity Intelligence",
              desc: "Discover, track, and analyze contracting opportunities from SAM.gov, web intelligence sources, and configured procurement networks.",
              delay: 0.1,
            },
            {
              href: ULTRA_SEARCH_URL,
              imgUrl:
                "https://media.base44.com/images/public/69dcaa5f2cdb34ef76b60740/3c37bc98d_ebb08cf5-f915-465a-9abe-6a5fd91d249b.png",
              alt: "Search Bar",
              icon: <Search className="w-5 h-5 text-primary-foreground" />,
              title: "Search Bar",
              desc: "Open the Ultra Search Browser for fast multi-engine research, source discovery, and targeted web searches.",
              delay: 0.2,
              external: true,
            },
            {
              href: "/portal/forecasts",
              imgUrl:
                "https://media.base44.com/images/public/69dcaa5f2cdb34ef76b60740/4c56e7c63_725370ea-8900-4051-a09b-baf05e5d806b.png",
              alt: "Forecasts",
              icon: <CalendarRange className="w-5 h-5 text-primary-foreground" />,
              title: "Forecasts",
              desc: "See federal procurement forecasts before solicitations are posted, including expected timing, values, set-asides, and contacts.",
              delay: 0.3,
            },
            {
              href: SOURCE_VAULT_URL,
              imgUrl:
                "https://media.base44.com/images/public/69dcaa5f2cdb34ef76b60740/cd3786710_2af8b45c-7f6e-4598-a2bd-564566d4892f.png",
              alt: "File Sharing",
              icon: <FileText className="w-5 h-5 text-primary-foreground" />,
              title: "File Sharing",
              desc: "Access shared files, forms, packets, supporting documents, and organized reference materials.",
              delay: 0.4,
              external: true,
            },
            {
              href: "/portal/recompete-watch",
              imgUrl:
                "https://media.base44.com/images/public/69dcaa5f2cdb34ef76b60740/e2e3572a9_5ad3d8f9-d805-4fc2-8cb7-a8614edc9c0fcopy.png",
              alt: "Recompete Watch",
              icon: <RefreshCcw className="w-5 h-5 text-primary-foreground" />,
              title: "Recompete Watch",
              desc: "Track forecasted recompetes, incumbents, contract values, expiration dates, and likely displacement opportunities.",
              delay: 0.5,
            },
            {
              href: "/portal/relevant-news",
              imgUrl:
                "https://media.base44.com/images/public/69dcaa5f2cdb34ef76b60740/02588225c_783f5460-1289-4bbd-a0ac-a9316906a45e.png",
              alt: "Relevant News",
              icon: <Newspaper className="w-5 h-5 text-primary-foreground" />,
              title: "Relevant News",
              desc: "Follow current federal contractor awards, acquisitions, procurement activity, solicitations, and recompete developments.",
              delay: 0.6,
            },
            {
              href: "/portal/company-watch",
              imgUrl: "",
              alt: "Company Watch",
              icon: <Building2 className="w-5 h-5 text-primary-foreground" />,
              title: "Company Watch",
              desc: "Monitor companies and their awards in a separate workspace.",
              delay: 0.7,
            },
          ].map((card) => {
            const cardBody = (
              <div className="glass-card group relative h-full overflow-hidden rounded-3xl p-1">
                <div className="absolute inset-0 bg-gradient-to-b from-primary/10 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
                <div className="relative mb-4 overflow-hidden rounded-2xl border border-white/10">
                  {card.imgUrl ? <img
                    src={card.imgUrl}
                    alt={card.alt}
                    loading="lazy"
                    decoding="async"
                    className="h-auto w-full object-contain transition-transform duration-700 group-hover:scale-105"
                  /> : <div role="img" aria-label={card.alt} className="flex h-40 items-center justify-center bg-gradient-to-br from-blue-950 via-sky-900/40 to-slate-950"><Building2 className="h-16 w-16 text-sky-300/70" /></div>}
                  <div className="absolute inset-0 bg-gradient-to-t from-[hsl(207,72%,10%)]/40 to-transparent" />
                  <div className="glass-panel absolute left-4 top-4 rounded-full p-2">
                    {card.icon}
                  </div>
                </div>
                <div className="px-5 pb-6">
                  <h2 className="mb-2 flex items-center justify-between text-xl font-display font-semibold text-white">
                    {card.title}
                    {card.external ? (
                      <ExternalLink className="w-5 h-5 -translate-x-4 text-primary opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
                    ) : (
                      <ArrowRight className="w-5 h-5 -translate-x-4 text-primary opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
                    )}
                  </h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {card.desc}
                  </p>
                </div>
              </div>
            );

            return (
              <motion.div
                key={card.href}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: card.delay }}
              >
                {card.external ? (
                  <a
                    href={card.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block h-full rounded-3xl"
                  >
                    {cardBody}
                  </a>
                ) : (
                  <Link href={card.href} className="block h-full rounded-3xl">
                    {cardBody}
                  </Link>
                )}
              </motion.div>
            );
          })}

          {extraCards.map((card) => (
            <motion.div
              key={card.key}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: card.delay }}
            >
              {card.link ? (
                <a
                  href={card.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block h-full rounded-3xl"
                >
                  <div className="glass-card group relative h-full overflow-hidden rounded-3xl p-1">
                    <div className="absolute inset-0 bg-gradient-to-b from-primary/10 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
                    <div className="relative mb-4 overflow-hidden rounded-2xl border border-white/10">
                      <img
                        src={card.imgUrl}
                        alt={card.alt}
                        loading="lazy"
                        decoding="async"
                        className="h-auto w-full object-contain transition-transform duration-700 group-hover:scale-105"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[hsl(207,72%,10%)]/40 to-transparent" />
                      <div className="glass-panel absolute left-4 top-4 rounded-full p-2">
                        {card.icon}
                      </div>
                    </div>
                    <div className="px-5 pb-6">
                      <h2 className="mb-2 flex items-center justify-between text-xl font-display font-semibold text-white">
                        {card.title}
                        <ExternalLink className="w-5 h-5 -translate-x-4 text-primary opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
                      </h2>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {card.desc}
                      </p>
                    </div>
                  </div>
                </a>
              ) : (
                <div
                  aria-disabled="true"
                  className="block h-full cursor-not-allowed rounded-3xl opacity-60"
                >
                  <div className="glass-card relative h-full overflow-hidden rounded-3xl p-1">
                    <div className="relative mb-4 overflow-hidden rounded-2xl border border-white/10">
                      <img
                        src={card.imgUrl}
                        alt={card.alt}
                        loading="lazy"
                        decoding="async"
                        className="h-auto w-full object-contain"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[hsl(207,72%,10%)]/50 to-transparent" />
                      <div className="glass-panel absolute left-4 top-4 rounded-full p-2">
                        {card.icon}
                      </div>
                    </div>
                    <div className="px-5 pb-6">
                      <h2 className="mb-2 flex items-center justify-between text-xl font-display font-semibold text-white">
                        {card.title}
                      </h2>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        Configure the linked Render URL in environment variables to enable this portal shortcut.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
