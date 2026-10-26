import { useState, useMemo, useEffect } from "react";
import { CompanyLogo } from "@/components/company-logo";
import { motion, AnimatePresence } from "framer-motion";
import {
  Building2, Search, Globe, MapPin, RefreshCw, Sparkles, Plus,
  ChevronDown, ChevronUp, ExternalLink, X, Factory,
  FlaskConical, Warehouse, Truck, GraduationCap, Landmark,
  Briefcase, Server, TrendingUp, TrendingDown, Minus,
  ArrowLeft, Calendar, Loader2, DollarSign, Scale, ShieldAlert,
  AlertTriangle, CheckCircle, Lock, Crown, Users, Package,
  MessageSquare, Target, Trash2, Filter, Clock,
  BarChart3,
} from "lucide-react";
import { FaLinkedinIn as Linkedin } from "react-icons/fa";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useListClients,
  useGetClient,
  useResearchBranches,
  useRefreshBranchHiring,
} from "@workspace/api-client-react";
import type { Client, ClientBranch, BranchHiringPost } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";
import type {
  FecResponse, OshaResponse, LitigationResponse,
} from "./clients-types";
import ClientDossierPanel from "@/components/portal/ClientDossierPanel";
import { getDossier } from "@/data/client-dossiers";

// ── Config ────────────────────────────────────────────────────────────────────

const BRANCH_TYPE_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  headquarters:     { label: "Headquarters",  icon: Landmark,      color: "text-sky-300", bg: "bg-sky-500/12" },
  manufacturing:    { label: "Manufacturing",  icon: Factory,       color: "text-sky-300", bg: "bg-sky-500/12" },
  office:           { label: "Office",         icon: Building2,     color: "text-sky-300", bg: "bg-sky-500/12" },
  research:         { label: "R&D",            icon: FlaskConical,  color: "text-sky-300", bg: "bg-sky-500/12" },
  depot:            { label: "Depot",          icon: Warehouse,     color: "text-sky-300", bg: "bg-sky-500/12" },
  field_operations: { label: "Field Ops",      icon: Briefcase,     color: "text-sky-300", bg: "bg-sky-500/12" },
  training:         { label: "Training",       icon: GraduationCap, color: "text-sky-300", bg: "bg-sky-500/12" },
  distribution:     { label: "Distribution",   icon: Truck,         color: "text-sky-300", bg: "bg-sky-500/12" },
  data_center:      { label: "Data Center",    icon: Server,        color: "text-sky-300", bg: "bg-sky-500/12" },
  other:            { label: "Other",          icon: Building2,     color: "text-sky-300", bg: "bg-sky-500/10" },
};

const TREND_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; bg: string; border: string; ring: string }> = {
  growing:     { label: "Growing",      icon: TrendingUp,   color: "text-emerald-400",      bg: "bg-emerald-500/15", border: "border-emerald-500/30", ring: "#10b981" },
  stable:      { label: "Stable",       icon: Minus,        color: "text-amber-400",        bg: "bg-amber-500/15",   border: "border-amber-500/30",   ring: "#f59e0b" },
  contracting: { label: "Contracting",  icon: TrendingDown, color: "text-rose-400",         bg: "bg-rose-500/15",    border: "border-rose-500/30",    ring: "#f43f5e" },
  unknown:     { label: "Not Assessed", icon: Minus,        color: "text-muted-foreground", bg: "bg-muted/15",       border: "border-white/10",       ring: "#6b7280" },
};

const PARTY_COLORS: Record<string, string> = {
  Republican: "#ef4444",
  Democrat: "#3b82f6",
  "Other / Bipartisan": "#8b5cf6",
};

function fmtDollars(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ── Contact types & config ─────────────────────────────────────────────────────

type ClientContact = {
  id: string;
  clientId: string;
  name: string;
  category: string;
  title?: string | null;
  department?: string | null;
  isEhsContact: boolean;
  isKeyContact: boolean;
  linkedinUrl?: string | null;
  email?: string | null;
  notes?: string | null;
};

const CONTACT_CATEGORY_CONFIG: Record<string, {
  label: string; icon: React.ElementType; color: string; bg: string; border: string; order: number;
}> = {
  ehs_safety:               { label: "EHS / Safety",                  icon: ShieldAlert,   color: "text-rose-400",    bg: "bg-rose-500/12",    border: "border-rose-500/22",  order: 1 },
  quality:                  { label: "Quality",                        icon: CheckCircle,   color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 2 },
  ceo_leadership:           { label: "Executive Leadership",           icon: Crown,         color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 3 },
  human_resources:          { label: "Human Resources",                icon: Users,         color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 4 },
  finance:                  { label: "Finance",                        icon: DollarSign,    color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 5 },
  legal_compliance:         { label: "Legal & Compliance",             icon: Scale,         color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 6 },
  operations:               { label: "Operations",                     icon: Briefcase,     color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 7 },
  technology:               { label: "Technology & IT",                icon: Server,        color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 8 },
  procurement_supply_chain: { label: "Procurement & Supply Chain",     icon: Package,       color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 9 },
  board_governance:         { label: "Board & Governance",             icon: Landmark,      color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 10 },
  communications:           { label: "Communications & External Affairs", icon: MessageSquare, color: "text-sky-300",  bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 11 },
  strategy:                 { label: "Strategy & Planning",            icon: Target,        color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 12 },
  business_unit:            { label: "Business Unit",                  icon: Building2,     color: "text-sky-300",     bg: "bg-sky-500/12",     border: "border-sky-500/22",   order: 13 },
  other:                    { label: "Other",                          icon: Users,         color: "text-sky-300",     bg: "bg-sky-500/10",     border: "border-white/10",     order: 14 },
};

// ── Org Structure Panel ────────────────────────────────────────────────────────

function OrgStructurePanel({ clientId }: { clientId: string }) {
  const [contacts, setContacts] = useState<ClientContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState<string>("all");
  const { toast } = useToast();

  useEffect(() => {
    setLoading(true);
    fetch(`/api/clients/${clientId}/contacts`)
      .then((r) => r.json())
      .then((d: { contacts: ClientContact[] }) => { setContacts(d.contacts || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [clientId]);

  async function handleDelete(id: string) {
    try {
      await fetch(`/api/clients/${clientId}/contacts/${id}`, { method: "DELETE" });
      setContacts((prev) => prev.filter((c) => c.id !== id));
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  }

  const filtered = useMemo(() => {
    let list = contacts;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q) || (c.title || "").toLowerCase().includes(q));
    }
    if (catFilter !== "all") list = list.filter((c) => c.category === catFilter);
    return list;
  }, [contacts, search, catFilter]);

  const ehsContacts = filtered.filter((c) => c.isEhsContact);
  const grouped = useMemo(() => {
    const map: Record<string, ClientContact[]> = {};
    filtered.filter((c) => !c.isEhsContact).forEach((c) => {
      if (!map[c.category]) map[c.category] = [];
      map[c.category].push(c);
    });
    return map;
  }, [filtered]);

  const categories = Object.keys(grouped).sort((a, b) => {
    const aOrder = CONTACT_CATEGORY_CONFIG[a]?.order ?? 99;
    const bOrder = CONTACT_CATEGORY_CONFIG[b]?.order ?? 99;
    return aOrder - bOrder;
  });

  const presentCats = [...new Set(contacts.map((c) => c.category))];

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  if (contacts.length === 0) {
    return (
      <div className="glass-panel rounded-2xl p-14 text-center border border-white/5 flex flex-col items-center gap-4">
        <Users className="w-12 h-12 text-primary/30" />
        <div>
          <p className="text-white font-semibold mb-1">No contacts on file</p>
          <p className="text-sm text-muted-foreground max-w-sm">
            Contact data will appear here once imported via the bulk upload endpoint.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="glass-panel rounded-xl p-4 border border-white/5">
          <p className="text-xs text-muted-foreground mb-1">Total Contacts</p>
          <p className="text-2xl font-bold text-white">{contacts.length}</p>
        </div>
        <div className="glass-panel rounded-xl p-4 border border-white/5">
          <p className="text-xs text-muted-foreground mb-1">EHS Contacts</p>
          <p className="text-2xl font-bold text-rose-400">{contacts.filter((c) => c.isEhsContact).length}</p>
        </div>
        <div className="glass-panel rounded-xl p-4 border border-white/5">
          <p className="text-xs text-muted-foreground mb-1">Key Contacts</p>
          <p className="text-2xl font-bold text-amber-400">{contacts.filter((c) => c.isKeyContact).length}</p>
        </div>
      </div>

      {/* Search & category filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Search by name or title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
          {search && <button className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white" onClick={() => setSearch("")}><X className="w-3 h-3" /></button>}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <button
            onClick={() => setCatFilter("all")}
            className={`text-[11px] px-2.5 py-1 rounded-lg border transition-all whitespace-nowrap ${catFilter === "all" ? "bg-primary/20 border-primary/40 text-primary" : "bg-white/5 border-white/10 text-muted-foreground hover:text-white"}`}
          >
            All
          </button>
          {presentCats.map((cat) => {
            const cfg = CONTACT_CATEGORY_CONFIG[cat] || CONTACT_CATEGORY_CONFIG.other;
            const CatIcon = cfg.icon;
            return (
              <button
                key={cat}
                onClick={() => setCatFilter(cat === catFilter ? "all" : cat)}
                className={`text-[11px] px-2.5 py-1 rounded-lg border transition-all whitespace-nowrap flex items-center gap-1 ${catFilter === cat ? "bg-primary/20 border-primary/40 text-primary" : "bg-white/5 border-white/10 text-muted-foreground hover:text-white"}`}
              >
                <CatIcon className="w-3 h-3" />{cfg.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* EHS priority section */}
      {ehsContacts.length > 0 && (
        <div className="glass-panel rounded-xl border border-rose-500/20 p-4">
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert className="w-4 h-4 text-rose-400" />
            <p className="text-sm font-semibold text-rose-300">EHS & Safety Contacts — Primary Buyers</p>
            <span className="text-xs bg-rose-500/20 text-rose-300 px-2 py-0.5 rounded-full ml-auto">{ehsContacts.length}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {ehsContacts.map((contact) => (
              <ContactCard key={contact.id} contact={contact} onDelete={handleDelete} highlight />
            ))}
          </div>
        </div>
      )}

      {/* Grouped by category */}
      {categories.map((category) => {
        const group = grouped[category];
        if (!group?.length) return null;
        const cfg = CONTACT_CATEGORY_CONFIG[category] || CONTACT_CATEGORY_CONFIG.other;
        const CatIcon = cfg.icon;
        return (
          <div key={category} className="space-y-2">
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-6 h-6 rounded-md ${cfg.bg} flex items-center justify-center`}>
                <CatIcon className={`w-3.5 h-3.5 ${cfg.color}`} />
              </div>
              <p className="text-sm font-semibold text-white">{cfg.label}</p>
              <span className="text-xs text-muted-foreground">({group.length})</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {group.map((contact) => (
                <ContactCard key={contact.id} contact={contact} onDelete={handleDelete} />
              ))}
            </div>
          </div>
        );
      })}

      <p className="text-[10px] text-muted-foreground/50 text-center pt-2">
        Contact data sourced from public org charts, LinkedIn, and verified corporate directories.
      </p>
    </div>
  );
}

// ── Contact Card ───────────────────────────────────────────────────────────────

function ContactCard({
  contact,
  onDelete,
  highlight = false,
}: {
  contact: ClientContact;
  onDelete: (id: string) => void;
  highlight?: boolean;
}) {
  const initials = contact.name.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  return (
    <div className={`glass-card rounded-xl p-3 border flex items-start gap-3 group ${highlight ? "border-rose-500/20" : "border-white/5"}`}>
      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${highlight ? "bg-rose-500/20 text-rose-300" : "bg-primary/15 text-primary"}`}>
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className="text-sm font-semibold text-white leading-tight">{contact.name}</p>
          {contact.isEhsContact && !highlight && <ShieldAlert className="w-3 h-3 text-rose-400 flex-shrink-0" />}
        </div>
        {contact.title && <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{contact.title}</p>}
        {contact.department && <p className="text-[11px] text-muted-foreground/60 mt-0.5">{contact.department}</p>}
        <div className="flex items-center gap-2 mt-1.5">
          {contact.linkedinUrl && (
            <a href={contact.linkedinUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-sky-400 transition-colors">
              <Linkedin className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>
      <button
        onClick={() => onDelete(contact.id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-rose-400 flex-shrink-0"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── Branch Card ───────────────────────────────────────────────────────────────

function BranchCard({ branch, clientId, onRefreshDone }: { branch: ClientBranch; clientId: string; onRefreshDone: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [posts, setPosts] = useState<BranchHiringPost[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const { toast } = useToast();
  const refreshMutation = useRefreshBranchHiring();
  const typeConfig = BRANCH_TYPE_CONFIG[branch.branchType] || BRANCH_TYPE_CONFIG.other;
  const trendConfig = TREND_CONFIG[branch.hiringTrendDirection || "unknown"] || TREND_CONFIG.unknown;
  const TypeIcon = typeConfig.icon;
  const TrendIcon = trendConfig.icon;
  const locationStr = [branch.city, branch.state, branch.country].filter(Boolean).join(", ");

  async function handleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && posts.length === 0 && Number(branch.postingCount || 0) > 0) {
      setLoadingPosts(true);
      try {
        const res = await fetch(`/api/clients/${clientId}/branches/${branch.id}/hiring`);
        if (res.ok) { const data = await res.json() as { posts: BranchHiringPost[] }; setPosts(data.posts || []); }
      } catch { /* noop */ } finally { setLoadingPosts(false); }
    }
  }

  function handleRefresh() {
    refreshMutation.mutate({ id: clientId, branchId: branch.id }, {
      onSuccess: (data) => {
        setPosts(data.posts || []);
        toast({ title: "Hiring data refreshed", description: data.branch.hiringTrendSummary || "" });
        onRefreshDone();
      },
      onError: () => toast({ title: "Refresh failed", description: "Could not pull hiring data.", variant: "destructive" }),
    });
  }

  return (
    <motion.div layout className="glass-card rounded-xl overflow-hidden border border-white/5">
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className={`w-8 h-8 rounded-lg ${typeConfig.bg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
            <TypeIcon className={`w-4 h-4 ${typeConfig.color}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${typeConfig.bg} ${typeConfig.color}`}>{typeConfig.label}</span>
              {branch.hiringTrendDirection && branch.hiringTrendDirection !== "unknown" && (
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${trendConfig.bg} ${trendConfig.color} ${trendConfig.border}`}>
                  <TrendIcon className="inline w-2.5 h-2.5 mr-0.5 -mt-0.5" />{trendConfig.label}
                </span>
              )}
              {Number(branch.postingCount || 0) > 0 && (
                <span className="text-[10px] text-muted-foreground">{branch.postingCount} posting{Number(branch.postingCount) !== 1 ? "s" : ""}</span>
              )}
            </div>
            <p className="text-sm font-medium text-white truncate">{branch.name || locationStr}</p>
            <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
              <MapPin className="w-3 h-3" /><span>{locationStr || "Location unknown"}</span>
            </div>
            {branch.hiringTrendSummary && <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{branch.hiringTrendSummary}</p>}
            {branch.lastResearched && (
              <p className="text-[10px] text-muted-foreground/60 mt-1">Last updated {new Date(branch.lastResearched).toLocaleDateString()}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleRefresh} disabled={refreshMutation.isPending}>
              {refreshMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
              Refresh Hiring
            </Button>
            {Number(branch.postingCount || 0) > 0 && (
              <button className="text-muted-foreground hover:text-white transition-colors" onClick={handleExpand}>
                {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            )}
          </div>
        </div>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="border-t border-white/5 px-4 pb-4 pt-3 space-y-2">
              {loadingPosts ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 className="w-4 h-4 animate-spin" />Loading posts...</div>
              ) : posts.length === 0 ? (
                <p className="text-xs text-muted-foreground">No job postings loaded yet.</p>
              ) : (
                posts.map((post) => (
                  <div key={post.id} className="flex items-start justify-between gap-3 py-2 border-b border-white/5 last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium truncate">{post.title}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {post.department && <span className="text-[10px] bg-white/5 rounded px-1.5 py-0.5 text-muted-foreground">{post.department}</span>}
                        {post.source && <span className="text-[10px] text-muted-foreground">{post.source}</span>}
                        {post.postedDate && <span className="text-[10px] text-muted-foreground flex items-center gap-0.5"><Calendar className="w-2.5 h-2.5" />{post.postedDate}</span>}
                      </div>
                    </div>
                    {post.url && <a href={post.url} target="_blank" rel="noreferrer" className="flex-shrink-0 text-primary hover:text-primary/70 transition-colors mt-0.5"><ExternalLink className="w-3.5 h-3.5" /></a>}
                  </div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Connect prompt helper ─────────────────────────────────────────────────────

function ConnectPrompt({ icon, title, message, steps, settingName }: { icon: React.ReactNode; title: string; message: string; steps: { text: string; href?: string; linkText?: string }[]; settingName: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center gap-4">
      <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
        <Lock className="w-6 h-6 text-muted-foreground" />
      </div>
      <div>
        <p className="text-white font-semibold mb-1">{title}</p>
        <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">{message}</p>
      </div>
      <div className="glass-panel rounded-xl p-4 border border-white/5 max-w-sm w-full text-left">
        <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wider">How to connect</p>
        <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal list-inside">
          {steps.map((s, i) => (
            <li key={i}>
              {s.href ? <><span>{s.text} </span><a href={s.href} target="_blank" rel="noreferrer" className="text-primary hover:underline">{s.linkText}</a></> : s.text}
            </li>
          ))}
          <li>Add your <strong className="text-white">{settingName}</strong> in <strong className="text-white">Integrations</strong></li>
        </ol>
      </div>
      {icon}
    </div>
  );
}

// ── FEC Panel ─────────────────────────────────────────────────────────────────

type FetchStatus = "loading" | "ok" | "source-error" | "network-error";

function FecPanel({ clientId }: { clientId: string }) {
  const [data, setData] = useState<FecResponse | null>(null);
  const [status, setStatus] = useState<FetchStatus>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setStatus("loading");
    setErrorMsg(null);
    fetch(`/api/clients/${clientId}/intelligence/fec`)
      .then(async (r) => {
        if (!r.ok) { setStatus("source-error"); setErrorMsg(`FEC.gov responded with ${r.status}`); return; }
        setData(await r.json() as FecResponse);
        setStatus("ok");
      })
      .catch((e: Error) => { setStatus("network-error"); setErrorMsg(e.message); });
  }, [clientId]);

  if (status === "loading") {
    return <div className="flex items-center gap-3 py-12 justify-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Querying FEC.gov…</span></div>;
  }

  if (status === "source-error" || status === "network-error") {
    return (
      <div className="py-8 text-center">
        <AlertTriangle className="w-8 h-8 text-rose-400 mx-auto mb-3 opacity-70" />
        <p className="text-sm text-rose-400 font-medium">{status === "source-error" ? "FEC.gov Source Unavailable" : "Network Error"}</p>
        <p className="text-xs text-muted-foreground mt-1">{errorMsg}</p>
      </div>
    );
  }

  if (!data?.committee) {
    return (
      <div className="py-12 text-center">
        <DollarSign className="w-8 h-8 text-muted-foreground mx-auto mb-3 opacity-40" />
        <p className="text-sm text-muted-foreground">No FEC committee found for this company.</p>
        <p className="text-xs text-muted-foreground/60 mt-1">This company may not have a registered PAC on file with the FEC.</p>
      </div>
    );
  }

  const { committee, cycles, partySplit, recentDisbursements, totalReceipts, totalDisbursements, allCommittees } = data;

  const cycleChartData = [...(cycles || [])].reverse().map((c) => ({
    cycle: String(c.cycle),
    Receipts: Math.round(c.receipts),
    Disbursements: Math.round(c.disbursements),
  }));

  return (
    <div className="space-y-6">
      {/* Committee summary */}
      <div className="glass-panel rounded-xl p-5 border border-white/5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Primary PAC Committee</p>
            <h3 className="text-base font-semibold text-white leading-tight">{committee.name}</h3>
            <div className="flex items-center gap-3 mt-1.5 flex-wrap text-xs text-muted-foreground">
              <span className="flex items-center gap-1"><Building2 className="w-3 h-3" />{committee.type}</span>
              {committee.state && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{committee.state}</span>}
              {committee.firstFileDate && <span>Active since {new Date(committee.firstFileDate).getFullYear()}</span>}
            </div>
          </div>
          <div className="flex gap-4">
            <div className="text-right">
              <p className="text-xs text-muted-foreground mb-0.5">Total Raised (4 cycles)</p>
              <p className="text-lg font-bold text-emerald-400">{fmtDollars(totalReceipts)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground mb-0.5">Total Spent</p>
              <p className="text-lg font-bold text-rose-400">{fmtDollars(totalDisbursements)}</p>
            </div>
          </div>
        </div>
        {committee.treasurer && <p className="text-xs text-muted-foreground/60 mt-3">Treasurer: {committee.treasurer}</p>}
        <a href={`https://www.fec.gov/data/committee/${committee.id}/`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/70 transition-colors mt-2">
          <ExternalLink className="w-3 h-3" />View on FEC.gov
        </a>
      </div>

      {/* Cycle totals bar chart */}
      {cycleChartData.length > 0 && (
        <div className="glass-panel rounded-xl p-5 border border-white/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-4">PAC Financials by Election Cycle</p>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={cycleChartData} barGap={4}>
                <XAxis dataKey="cycle" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmtDollars(v)} width={52} />
                <Tooltip contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "#fff", fontWeight: 600, marginBottom: 4 }} formatter={(v: number, name: string) => [fmtDollars(v), name]} />
                <Bar dataKey="Receipts" fill="#10b981" radius={[3, 3, 0, 0]} />
                <Bar dataKey="Disbursements" fill="#f43f5e" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 justify-center">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" />Receipts</span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-rose-500 inline-block" />Disbursements</span>
          </div>
        </div>
      )}

      {/* Party split donut */}
      {partySplit && partySplit.length > 0 && (
        <div className="glass-panel rounded-xl p-5 border border-white/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-4">2024 Cycle Disbursements — Party Affiliation</p>
          <div className="flex items-center gap-6">
            <div className="h-40 w-40 flex-shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={partySplit} dataKey="amount" nameKey="party" cx="50%" cy="50%" outerRadius={65} innerRadius={35} paddingAngle={2}>
                    {partySplit.map((entry) => <Cell key={entry.party} fill={PARTY_COLORS[entry.party] || "#6b7280"} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }} formatter={(v: number, name: string) => [fmtDollars(v), name]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 space-y-2.5">
              {partySplit.map((p) => (
                <div key={p.party}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="flex items-center gap-1.5 text-xs text-white font-medium">
                      <span className="w-2 h-2 rounded-full inline-block" style={{ background: PARTY_COLORS[p.party] || "#6b7280" }} />
                      {p.party}
                    </span>
                    <span className="text-xs text-muted-foreground">{p.pct}% · {fmtDollars(p.amount)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${p.pct}%`, background: PARTY_COLORS[p.party] || "#6b7280" }} />
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-muted-foreground/50 pt-1">Based on recipient name matching from Schedule B disbursements. Recipients not matching known party patterns are classified as Other/Bipartisan.</p>
            </div>
          </div>
        </div>
      )}

      {/* Recent disbursements table */}
      {recentDisbursements && recentDisbursements.length > 0 && (
        <div className="glass-panel rounded-xl p-5 border border-white/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Recent Disbursements (2024 Cycle)</p>
          <div className="space-y-0 divide-y divide-white/5">
            {recentDisbursements.map((d, i) => (
              <div key={i} className="py-2.5 flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{d.recipient || "—"}</p>
                  {d.description && <p className="text-xs text-muted-foreground truncate">{d.description}</p>}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-medium text-rose-400">{d.amount != null ? fmtDollars(d.amount) : "—"}</p>
                  {d.date && <p className="text-[10px] text-muted-foreground">{d.date}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Other committees */}
      {allCommittees && allCommittees.length > 1 && (
        <div className="glass-panel rounded-xl p-5 border border-white/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">All Committees on File ({allCommittees.length})</p>
          <div className="space-y-2">
            {allCommittees.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 py-1">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white truncate">{c.name}</p>
                  <p className="text-[10px] text-muted-foreground">{c.type}</p>
                </div>
                <a href={`https://www.fec.gov/data/committee/${c.id}/`} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary transition-colors flex-shrink-0"><ExternalLink className="w-3 h-3" /></a>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground/50 text-center">Data sourced from FEC.gov Open Data API · Updated as of latest FEC filing</p>
    </div>
  );
}

// ── OSHA / Regulatory Panel ───────────────────────────────────────────────────

function OshaPanel({ clientId }: { clientId: string }) {
  const [data, setData] = useState<OshaResponse | null>(null);
  const [status, setStatus] = useState<FetchStatus>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setStatus("loading");
    fetch(`/api/clients/${clientId}/intelligence/osha`)
      .then(async (r) => {
        const json = await r.json() as OshaResponse;
        if (!r.ok) { setStatus("source-error"); setErrorMsg(`DOL API responded with ${r.status}`); return; }
        setData(json);
        setStatus("ok");
      })
      .catch((e: Error) => { setStatus("network-error"); setErrorMsg(e.message); });
  }, [clientId]);

  if (status === "loading") {
    return <div className="flex items-center gap-3 py-12 justify-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Checking OSHA records…</span></div>;
  }

  if (status === "source-error" || status === "network-error") {
    return (
      <div className="glass-panel rounded-xl p-8 text-center border border-white/5">
        <Clock className="w-7 h-7 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground font-medium">OSHA search temporarily unavailable</p>
        <p className="text-xs text-muted-foreground/60 mt-1">Unable to reach the search service. Try again shortly.</p>
      </div>
    );
  }

  if (!data?.configured) {
    return (
      <ConnectPrompt
        icon={<ShieldAlert className="w-5 h-5 text-amber-400/40" />}
        title="OSHA Search Not Configured"
        message={data?.message || "Add a Serper API key to enable OSHA enforcement record searches."}
        steps={[
          { text: "Get a free key at", href: "https://serper.dev", linkText: "serper.dev" },
        ]}
        settingName="Serper API Key"
      />
    );
  }

  const inspections = (data as { configured: true; inspections: import("./clients-types").OshaInspection[]; total: number }).inspections;
  const total = (data as { configured: true; inspections: import("./clients-types").OshaInspection[]; total: number }).total;

  if (!inspections?.length) {
    return (
      <div className="py-12 text-center">
        <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-3 opacity-70" />
        <p className="text-sm text-white font-medium">No OSHA Records Found</p>
        <p className="text-xs text-muted-foreground mt-1">No OSHA enforcement records found for this company.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass-panel rounded-xl p-4 border border-amber-500/20 bg-amber-500/5">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <p className="text-sm font-semibold text-amber-400">{total} OSHA Enforcement Record{total !== 1 ? "s" : ""} Found</p>
        </div>
        <p className="text-xs text-muted-foreground">Search results from OSHA enforcement database and public records</p>
      </div>

      <div className="space-y-3">
        {inspections.map((insp) => (
          <div key={insp.id} className="glass-card rounded-xl p-4 border border-white/5 hover:border-amber-500/20 transition-colors">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  {insp.isOshaGov && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
                      <ShieldAlert className="w-2.5 h-2.5" />osha.gov
                    </span>
                  )}
                  <p className="text-sm font-medium text-white leading-snug line-clamp-1">{insp.title || insp.establishment}</p>
                </div>
                {insp.snippet && <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{insp.snippet}</p>}
                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground flex-wrap">
                  {insp.openDate && <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{insp.openDate}</span>}
                  {insp.violations != null && <span className="text-amber-400/80">{insp.violations} violation{insp.violations !== 1 ? "s" : ""}</span>}
                  {insp.sourceUrl && (
                    <a href={insp.sourceUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sky-400/70 hover:text-sky-400 transition-colors ml-auto">
                      View record <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
              {insp.totalPenalty && (
                <div className="text-right flex-shrink-0 pl-2">
                  <p className="text-[10px] text-muted-foreground">Penalty</p>
                  <p className="text-sm font-bold text-rose-400">{fmtDollars(parseFloat(insp.totalPenalty))}</p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground/50 text-center">Search results via OSHA enforcement database and public records</p>
    </div>
  );
}

// ── Litigation Panel ──────────────────────────────────────────────────────────

function LitigationPanel({ clientId }: { clientId: string }) {
  const [data, setData] = useState<LitigationResponse | null>(null);
  const [status, setStatus] = useState<FetchStatus>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setStatus("loading");
    fetch(`/api/clients/${clientId}/intelligence/litigation`)
      .then(async (r) => {
        const json = await r.json() as LitigationResponse;
        if (!r.ok) { setStatus("source-error"); setErrorMsg(`${r.status}`); return; }
        setData(json);
        setStatus("ok");
      })
      .catch((e: Error) => { setStatus("network-error"); setErrorMsg(e.message); });
  }, [clientId]);

  if (status === "loading") {
    return <div className="flex items-center gap-3 py-12 justify-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /><span className="text-sm">Searching court records…</span></div>;
  }

  if (status === "source-error" || status === "network-error") {
    return (
      <div className="glass-panel rounded-xl p-8 text-center border border-white/5">
        <Clock className="w-7 h-7 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground font-medium">Litigation data temporarily unavailable</p>
        <p className="text-xs text-muted-foreground/60 mt-1">CourtListener is not responding right now. Try again shortly.</p>
      </div>
    );
  }

  if (data && (data as { unavailable?: boolean }).unavailable) {
    return (
      <div className="glass-panel rounded-xl p-8 text-center border border-white/5">
        <Clock className="w-7 h-7 text-muted-foreground/40 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground font-medium">Litigation data temporarily unavailable</p>
        <p className="text-xs text-muted-foreground/60 mt-1">CourtListener is not responding right now. Try again shortly.</p>
      </div>
    );
  }

  if (!data?.configured) {
    return (
      <ConnectPrompt
        icon={<Scale className="w-5 h-5 text-violet-400/40" />}
        title="Litigation Data Source Not Connected"
        message={data?.message || "Connect a CourtListener API token to enable federal litigation search for this company."}
        steps={[
          { text: "Create a free account at", href: "https://www.courtlistener.com/sign-in/", linkText: "courtlistener.com" },
          { text: "Go to your profile → API token and copy it." },
        ]}
        settingName="CourtListener Token"
      />
    );
  }

  const cases = (data as { configured: true; cases: import("./clients-types").LitigationCase[]; total: number }).cases;
  const totalCount = (data as { configured: true; cases: import("./clients-types").LitigationCase[]; total: number }).total;

  if (!cases?.length) {
    return (
      <div className="py-12 text-center">
        <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-3 opacity-70" />
        <p className="text-sm text-white font-medium">No Federal Cases Found</p>
        <p className="text-xs text-muted-foreground mt-1">No matching federal court cases found for this company.</p>
      </div>
    );
  }

  const activeCases = cases.filter((c) => c.status === "Active");
  const closedCases = cases.filter((c) => c.status === "Closed");

  // Litigation timeline — cases filed by year
  const byYear: Record<string, { active: number; closed: number }> = {};
  for (const c of cases) {
    const yr = c.dateFiled ? c.dateFiled.slice(0, 4) : "Unknown";
    if (!byYear[yr]) byYear[yr] = { active: 0, closed: 0 };
    if (c.status === "Active") byYear[yr].active++;
    else byYear[yr].closed++;
  }
  const timelineData = Object.entries(byYear)
    .filter(([yr]) => yr !== "Unknown")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, counts]) => ({ year, ...counts }));

  return (
    <div className="space-y-4">
      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="glass-panel rounded-xl p-3 border border-white/5 text-center">
          <p className="text-xl font-bold text-white">{totalCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Total Cases</p>
        </div>
        <div className="glass-panel rounded-xl p-3 border border-rose-500/20 bg-rose-500/5 text-center">
          <p className="text-xl font-bold text-rose-400">{activeCases.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Active</p>
        </div>
        <div className="glass-panel rounded-xl p-3 border border-white/5 text-center">
          <p className="text-xl font-bold text-muted-foreground">{closedCases.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Closed</p>
        </div>
      </div>

      {/* Litigation timeline bar chart */}
      {timelineData.length > 0 && (
        <div className="glass-panel rounded-xl p-5 border border-white/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-4">Cases Filed by Year</p>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={timelineData} barGap={2}>
                <XAxis dataKey="year" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#9ca3af", fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} width={24} />
                <Tooltip contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "#fff", fontWeight: 600, marginBottom: 4 }} />
                <Bar dataKey="active" name="Active" fill="#f43f5e" stackId="a" radius={[0, 0, 0, 0]} />
                <Bar dataKey="closed" name="Closed" fill="#6b7280" stackId="a" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="flex items-center gap-4 mt-2 justify-center">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-rose-500 inline-block" />Active</span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="w-2.5 h-2.5 rounded-sm bg-slate-500 inline-block" />Closed</span>
          </div>
        </div>
      )}

      {/* Cases list */}
      <div className="space-y-2">
        {cases.map((c) => (
          <div key={c.id} className={`glass-card rounded-xl p-4 border ${c.status === "Active" ? "border-rose-500/20" : "border-white/5"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${c.status === "Active" ? "bg-rose-500/15 text-rose-400" : "bg-white/5 text-muted-foreground"}`}>{c.status}</span>
                  {c.jurisdictionType && <span className="text-[10px] text-muted-foreground bg-white/5 px-1.5 py-0.5 rounded">{c.jurisdictionType}</span>}
                </div>
                <p className="text-sm font-medium text-white leading-snug">{c.caseName || "—"}</p>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                  {c.court && <span className="uppercase tracking-wide">{c.court}</span>}
                  {c.docketNumber && <span>#{c.docketNumber}</span>}
                  {c.dateFiled && <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />Filed {c.dateFiled}</span>}
                  {c.dateTerminated && <span>Closed {c.dateTerminated}</span>}
                </div>
                {c.cause && <p className="text-xs text-muted-foreground/70 mt-1 italic">{c.cause}</p>}
              </div>
              <div className="flex flex-col items-end gap-2 flex-shrink-0">
                {c.amountAtStake != null && (
                  <div className="text-right">
                    <p className="text-[10px] text-muted-foreground">At Stake</p>
                    <p className="text-sm font-bold text-amber-400">{fmtDollars(c.amountAtStake)}</p>
                  </div>
                )}
                {c.url && (
                  <a href={c.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground/50 text-center">Data sourced from CourtListener / RECAP federal court archive · Amount-at-stake data requires PACER document access and is not available from the docket listing API</p>
    </div>
  );
}


// ── Occu-Med Exam Relevance Engine ────────────────────────────────────────────
const ROLE_CATEGORIES: Array<{
  label: string;
  keywords: string[];
  relevance: "very_high" | "high" | "medium" | "low";
  examTypes: string[];
  color: string;
  bg: string;
}> = [
  {
    label: "Deployment / Overseas",
    keywords: ["deploy", "overseas", "logcap", "oconus", "expeditionary", "forward", "contingency"],
    relevance: "very_high",
    examTypes: ["Deployment Physical", "Dental", "Labs", "Vaccines", "Vision"],
    color: "text-rose-400", bg: "bg-rose-500/12",
  },
  {
    label: "Base Operations / Logistics",
    keywords: ["base ops", "logistics", "base operation", "operations specialist", "life support", "supply chain"],
    relevance: "very_high",
    examTypes: ["Physical", "Labs", "Vaccines"],
    color: "text-rose-400", bg: "bg-rose-500/12",
  },
  {
    label: "Aviation / Aircraft",
    keywords: ["aircraft", "aviation", "mechanic", "airframe", "powerplant", "avionics", "flight", "pilot"],
    relevance: "high",
    examTypes: ["Physical", "Vision", "Audiogram", "PFT"],
    color: "text-amber-400", bg: "bg-amber-500/12",
  },
  {
    label: "Security / Protective",
    keywords: ["security", "guard", "protective", "armed", "law enforcement", "police"],
    relevance: "high",
    examTypes: ["Physical", "Vision", "Fitness Standard"],
    color: "text-amber-400", bg: "bg-amber-500/12",
  },
  {
    label: "Transportation / CDL",
    keywords: ["driver", "cdl", "truck", "transport", "freight", "logistics driver", "hazmat driver"],
    relevance: "high",
    examTypes: ["DOT Physical", "Drug Screen", "FMCSA"],
    color: "text-amber-400", bg: "bg-amber-500/12",
  },
  {
    label: "Construction / Field Labor",
    keywords: ["construction", "laborer", "ironwork", "carpenter", "electrician", "field", "site worker", "welder"],
    relevance: "high",
    examTypes: ["Physical", "Respirator/PFT", "Audiogram"],
    color: "text-amber-400", bg: "bg-amber-500/12",
  },
  {
    label: "Environmental / Hazmat",
    keywords: ["environmental", "hazmat", "remediation", "ehs", "safety", "industrial hygiene", "toxicology"],
    relevance: "high",
    examTypes: ["Physical", "Respirator/PFT", "Hazmat Surveillance"],
    color: "text-amber-400", bg: "bg-amber-500/12",
  },
  {
    label: "EMS / Medical Transport",
    keywords: ["paramedic", "emt", "ambulance", "medic", "first responder", "medical transport"],
    relevance: "high",
    examTypes: ["Physical", "Vaccines", "Drug Screen"],
    color: "text-amber-400", bg: "bg-amber-500/12",
  },
  {
    label: "Engineering / Technical",
    keywords: ["engineer", "technician", "technical", "program manager", "systems"],
    relevance: "medium",
    examTypes: ["Physical (if field)"],
    color: "text-sky-400", bg: "bg-sky-500/12",
  },
  {
    label: "Corporate / Admin",
    keywords: ["analyst", "coordinator", "admin", "hr ", "human resources", "finance", "accounting"],
    relevance: "low",
    examTypes: [],
    color: "text-muted-foreground", bg: "bg-white/5",
  },
];

function classifyPost(title: string): typeof ROLE_CATEGORIES[0] | null {
  const lower = title.toLowerCase();
  for (const cat of ROLE_CATEGORIES) {
    if (cat.keywords.some((kw) => lower.includes(kw))) return cat;
  }
  return null;
}

// ── HiringIntelPanel ─────────────────────────────────────────────────────────
function HiringIntelPanel({ clientId, branches }: { clientId: string; branches: ClientBranch[] }) {
  const [allPosts, setAllPosts] = useState<(BranchHiringPost & { _branchName: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterRelevance, setFilterRelevance] = useState<string>("all");

  useEffect(() => {
    async function loadAllPosts() {
      setLoading(true);
      const results: (BranchHiringPost & { _branchName: string })[] = [];
      for (const branch of branches.filter(b => Number(b.postingCount || 0) > 0)) {
        try {
          const res = await fetch(`/api/clients/${clientId}/branches/${branch.id}/hiring`);
          if (res.ok) {
            const data = await res.json() as { posts: BranchHiringPost[] };
            results.push(...(data.posts || []).map(p => ({ ...p, _branchName: `${branch.city || ""}${branch.state ? ", " + branch.state : ""}${branch.country && branch.country !== "United States" ? ", " + branch.country : ""}`.trim() || branch.name || "Unknown" })));
          }
        } catch { /* skip */ }
      }
      setAllPosts(results);
      setLoading(false);
    }
    loadAllPosts();
  }, [clientId, branches]);

  const classified = useMemo(() => {
    return allPosts.map(p => ({ ...p, _cat: classifyPost(p.title) }));
  }, [allPosts]);

  const filtered = useMemo(() => {
    return classified.filter(p => {
      const matchSearch = !searchTerm || p.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        ((p as any)._branchName as string || "").toLowerCase().includes(searchTerm.toLowerCase());
      const matchRel = filterRelevance === "all" || p._cat?.relevance === filterRelevance || (!p._cat && filterRelevance === "low");
      return matchSearch && matchRel;
    });
  }, [classified, searchTerm, filterRelevance]);

  // Aggregations
  const relevanceCounts = useMemo(() => {
    const counts: Record<string, number> = { very_high: 0, high: 0, medium: 0, low: 0, unclassified: 0 };
    classified.forEach(p => {
      const r = p._cat?.relevance;
      if (r) counts[r] = (counts[r] || 0) + 1;
      else counts.unclassified++;
    });
    return counts;
  }, [classified]);

  const categoryBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    classified.forEach(p => {
      const label = p._cat?.label || "Unclassified";
      counts[label] = (counts[label] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [classified]);

  const topLocations = useMemo(() => {
    const counts: Record<string, number> = {};
    allPosts.forEach(p => {
      const loc = (p as any)._branchName || "Unknown";
      counts[loc] = (counts[loc] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [allPosts]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 gap-3">
        <Loader2 className="w-5 h-5 animate-spin text-primary" />
        <span className="text-sm text-muted-foreground">Loading hiring intelligence across all branches…</span>
      </div>
    );
  }

  if (allPosts.length === 0) {
    return (
      <div className="glass-panel rounded-2xl p-12 text-center border border-white/5">
        <TrendingUp className="w-10 h-10 text-primary/30 mx-auto mb-4" />
        <p className="text-white font-semibold mb-2">No hiring data yet</p>
        <p className="text-sm text-muted-foreground">Use "Refresh Hiring" on individual branches to pull job postings. Once loaded, Hiring Intel aggregates everything here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Postings", value: allPosts.length, color: "text-white", sub: "across all branches" },
          { label: "Critical Relevance", value: relevanceCounts.very_high, color: "text-rose-400", sub: "Deployment / LOGCAP" },
          { label: "High Relevance", value: relevanceCounts.high, color: "text-amber-400", sub: "Aviation, CDL, Security" },
          { label: "Locations Active", value: new Set(allPosts.map(p => (p as any)._branchName)).size, color: "text-emerald-400", sub: "with open postings" },
        ].map(({ label, value, color, sub }) => (
          <div key={label} className="glass-panel rounded-xl p-4 border border-white/5">
            <p className="text-xs text-muted-foreground mb-1">{label}</p>
            <p className={`text-2xl font-display font-bold ${color}`}>{value}</p>
            <p className="text-[10px] text-muted-foreground/60 mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      {/* Role breakdown + top locations */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="glass-panel rounded-2xl p-5 border border-white/5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5" />Role Categories
          </h3>
          <div className="space-y-2">
            {categoryBreakdown.map(([label, count]) => {
              const cat = ROLE_CATEGORIES.find(c => c.label === label);
              const pct = Math.round((count / allPosts.length) * 100);
              return (
                <div key={label} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-xs font-medium ${cat?.color || "text-muted-foreground"}`}>{label}</span>
                      <span className="text-xs text-muted-foreground">{count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/5">
                      <div className="h-full rounded-full bg-primary/60" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="glass-panel rounded-2xl p-5 border border-white/5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-4 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5" />Top Hiring Locations
          </h3>
          <div className="space-y-2">
            {topLocations.map(([loc, count]) => (
              <div key={loc} className="flex items-center justify-between">
                <span className="text-sm text-white/80 truncate flex-1 mr-4">{loc || "Unknown"}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <div className="h-1.5 w-16 rounded-full bg-white/5">
                    <div className="h-full rounded-full bg-emerald-500/60" style={{ width: `${Math.round((count / (topLocations[0]?.[1] || 1)) * 100)}%` }} />
                  </div>
                  <span className="text-xs text-muted-foreground w-5 text-right">{count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Exam demand callout */}
      {(relevanceCounts.very_high + relevanceCounts.high) > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <div className="flex items-start gap-3">
            <Sparkles className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-300 mb-1">Exam Demand Prediction</p>
              <p className="text-xs text-amber-200/70 leading-relaxed">
                {relevanceCounts.very_high > 0 && `${relevanceCounts.very_high} deployment/LOGCAP postings suggest high demand for deployment physicals, dental, labs, and vaccines. `}
                {relevanceCounts.high > 0 && (() => {
                  const cats = classified.filter(p => p._cat?.relevance === "high");
                  const examSet = new Set(cats.flatMap(p => p._cat?.examTypes || []));
                  const exams = Array.from(examSet).slice(0, 5).join(", ");
                  return `${relevanceCounts.high} high-relevance postings (${exams}) indicate active occupational health exam needs.`;
                })()}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Job list with search/filter */}
      <div>
        <div className="flex gap-3 mb-4 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search job titles or locations…" className="pl-8 bg-white/5 border-white/10 text-sm h-9" />
          </div>
          <select value={filterRelevance} onChange={e => setFilterRelevance(e.target.value)}
            className="h-9 px-3 rounded-lg bg-white/5 border border-white/10 text-sm text-white">
            <option value="all">All Relevance</option>
            <option value="very_high">Critical (Deployment)</option>
            <option value="high">High (Aviation, CDL, Security)</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div className="space-y-1.5">
          {filtered.slice(0, 80).map((post) => {
            const cat = post._cat;
            return (
              <div key={post.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${cat?.relevance === "very_high" ? "border-rose-500/20 bg-rose-500/5" : cat?.relevance === "high" ? "border-amber-500/15 bg-amber-500/4" : "border-white/5 bg-white/[0.02]"}`}>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${cat?.relevance === "very_high" ? "bg-rose-400" : cat?.relevance === "high" ? "bg-amber-400" : cat?.relevance === "medium" ? "bg-sky-400" : "bg-white/20"}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-white truncate">{post.title}</span>
                    {cat && (
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${cat.bg} ${cat.color} flex-shrink-0`}>{cat.label}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1"><MapPin className="w-2.5 h-2.5" />{(post as any)._branchName || "Unknown"}</span>
                    {cat?.examTypes && cat.examTypes.length > 0 && (
                      <span className="text-[10px] text-primary/70">→ {cat.examTypes.slice(0,3).join(", ")}</span>
                    )}
                    {post.postedDate && <span className="text-[10px] text-muted-foreground/60">{post.postedDate}</span>}
                  </div>
                </div>
                {post.url && <a href={post.url} target="_blank" rel="noreferrer" className="flex-shrink-0 text-muted-foreground hover:text-primary transition-colors"><ExternalLink className="w-3.5 h-3.5" /></a>}
              </div>
            );
          })}
          {filtered.length > 80 && (
            <p className="text-xs text-muted-foreground text-center pt-2">Showing 80 of {filtered.length} — use search to narrow results</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Client Detail View ─────────────────────────────────────────────────────────

type IntelTab = "contacts" | "branches" | "hiring" | "fec" | "osha" | "litigation" | "dossier";

function ClientDetail({ clientId, onBack }: { clientId: string; onBack: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, refetch } = useGetClient(clientId);
  const researchMutation = useResearchBranches();
  const [activeTab, setActiveTab] = useState<IntelTab>("contacts");

  const client = data?.client;
  const branches = data?.branches ?? [];

  const trendConfig = TREND_CONFIG[client?.overallHiringTrend || "unknown"] || TREND_CONFIG.unknown;
  const TrendIcon = trendConfig.icon;

  function handleResearch() {
    researchMutation.mutate({ id: clientId }, {
      onSuccess: (result) => {
        toast({ title: "Branch research complete", description: `Discovered ${result.added} new branch${result.added !== 1 ? "es" : ""} (${result.total} total).` });
        refetch();
      },
      onError: () => toast({ title: "Research failed", description: "Could not complete branch discovery.", variant: "destructive" }),
    });
  }

  function handleRefreshDone() {
    refetch();
    queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
  }

  if (isLoading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  if (!client) {
    return <div className="text-center py-16 text-muted-foreground">Client not found.</div>;
  }

  const dossier = getDossier(clientId);

  const tabs: { id: IntelTab; label: string; icon: React.ElementType }[] = [
    { id: "contacts",   label: "Org Structure",     icon: Users       },
    { id: "hiring",     label: "Hiring Intel",      icon: TrendingUp  },
    { id: "branches",   label: "Branches",          icon: Building2   },
    { id: "dossier",    label: "Data Profile",      icon: BarChart3   },
    { id: "fec",        label: "FEC / Political",   icon: DollarSign  },
    { id: "osha",       label: "Regulatory",        icon: ShieldAlert },
    { id: "litigation", label: "Litigation",        icon: Scale       },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="flex-shrink-0 mt-1">
          <ArrowLeft className="w-4 h-4 mr-1" />Back
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-2xl font-display font-bold text-white">{client.name}</h2>
            <span className={`text-xs font-semibold px-2 py-1 rounded-full border ${trendConfig.bg} ${trendConfig.color} ${trendConfig.border} flex items-center gap-1`}>
              <TrendIcon className="w-3 h-3" />{trendConfig.label}
            </span>
          </div>
          <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground flex-wrap">
            {client.industry && <span>{client.industry}</span>}
            {client.headquarters && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{client.headquarters}</span>}
            {client.website && (
              <a href={client.website} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-primary transition-colors">
                <Globe className="w-3.5 h-3.5" />{client.website.replace(/https?:\/\/(www\.)?/, "")}
              </a>
            )}
          </div>
        </div>
        {activeTab === "branches" && (
          <Button onClick={handleResearch} disabled={researchMutation.isPending} className="flex-shrink-0">
            {researchMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            Research Branches
          </Button>
        )}
      </div>

      {/* Intelligence tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {tabs.map((tab) => {
          const TabIcon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all whitespace-nowrap ${
                activeTab === tab.id
                  ? "bg-primary/20 border-primary/40 text-primary"
                  : "bg-white/5 border-white/10 text-muted-foreground hover:text-white hover:border-white/20"
              }`}
            >
              <TabIcon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div key={activeTab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }}>
          {activeTab === "contacts"   && <OrgStructurePanel clientId={clientId} />}
          {activeTab === "hiring"     && <HiringIntelPanel clientId={clientId} branches={branches} />}
          {activeTab === "dossier"    && dossier ? <ClientDossierPanel dossier={dossier} /> : (
            <div className="glass-panel rounded-2xl p-12 text-center border border-white/10">
              <BarChart3 className="w-10 h-10 text-primary/30 mx-auto mb-4" />
              <p className="text-white font-semibold mb-2">No dossier data yet</p>
              <p className="text-muted-foreground text-sm max-w-md mx-auto">
                Upload a client intelligence pack (CSV or JSON) to generate rich visual profiles with safety trends, benchmarks, and geographic breakdowns.
              </p>
            </div>
          )}
          {activeTab === "fec"        && <FecPanel clientId={clientId} />}
          {activeTab === "osha"       && <OshaPanel clientId={clientId} />}
          {activeTab === "litigation" && <LitigationPanel clientId={clientId} />}
          {activeTab === "branches"   && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="glass-panel rounded-xl p-4 border border-white/5">
                  <p className="text-xs text-muted-foreground mb-1">Total Branches</p>
                  <p className="text-2xl font-bold text-white">{branches.length}</p>
                </div>
                <div className="glass-panel rounded-xl p-4 border border-white/5">
                  <p className="text-xs text-muted-foreground mb-1">Active Hiring</p>
                  <p className="text-2xl font-bold text-emerald-400">{branches.filter((b) => b.hiringTrendDirection === "growing").length}</p>
                </div>
                <div className="glass-panel rounded-xl p-4 border border-white/5">
                  <p className="text-xs text-muted-foreground mb-1">Total Postings</p>
                  <p className="text-2xl font-bold text-white">{branches.reduce((acc, b) => acc + Number(b.postingCount || 0), 0)}</p>
                </div>
              </div>
              {branches.length === 0 ? (
                <div className="glass-panel rounded-2xl p-12 text-center border border-white/5">
                  <Sparkles className="w-8 h-8 text-primary mx-auto mb-3" />
                  <p className="text-white font-medium mb-1">No branches discovered yet</p>
                  <p className="text-sm text-muted-foreground">Click "Research Branches" to discover worldwide locations using AI.</p>
                </div>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">{branches.length} branch{branches.length !== 1 ? "es" : ""} discovered</p>
                  {branches.map((branch) => <BranchCard key={branch.id} branch={branch} clientId={clientId} onRefreshDone={handleRefreshDone} />)}
                </>
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// ── Client Card ────────────────────────────────────────────────────────────────

function ClientCard({ client, onClick }: { client: Client; onClick: () => void }) {
  const trendConfig = TREND_CONFIG[client.overallHiringTrend || "unknown"] || TREND_CONFIG.unknown;
  const TrendIcon = trendConfig.icon;
  const hasDossier = !!getDossier(client.id);

  return (
    <motion.div layout whileHover={{ y: -2 }} className="glass-card rounded-xl p-4 cursor-pointer border border-white/5 hover:border-white/15 transition-all" onClick={onClick}>
      <div className="flex items-start gap-3">
        <CompanyLogo name={client.name} website={client.website} size={40} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate mb-0.5">{client.name}</p>
          {client.industry && <p className="text-xs text-muted-foreground mb-0.5">{client.industry}</p>}
          {client.headquarters && <p className="text-xs text-muted-foreground flex items-center gap-1"><MapPin className="w-3 h-3" />{client.headquarters}</p>}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${trendConfig.bg} ${trendConfig.color} ${trendConfig.border} flex items-center gap-1`}>
              <TrendIcon className="w-2.5 h-2.5" />{trendConfig.label}
            </span>
            {(client.branchCount ?? 0) > 0 && <span className="text-[10px] text-muted-foreground">{client.branchCount} branch{client.branchCount !== 1 ? "es" : ""}</span>}
            {hasDossier && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-primary/15 text-primary border-primary/30 flex items-center gap-1">
                <BarChart3 className="w-2.5 h-2.5" />Data Profile
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function ClientsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch]         = useState("");
  const [trendFilter, setTrendFilter] = useState<string>("all");
  const [isAddOpen, setIsAddOpen]   = useState(false);
  const [addName, setAddName]       = useState("");
  const [addWebsite, setAddWebsite] = useState("");
  const [addIndustry, setAddIndustry] = useState("");
  const [addHQ, setAddHQ]           = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const { data, isLoading, refetch } = useListClients();
  const clients = data?.clients ?? [];
  const { toast } = useToast();

  const handleAddClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addName.trim()) return;
    setAddLoading(true);
    try {
      const resp = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: addName.trim(),
          website: addWebsite.trim() || undefined,
          industry: addIndustry.trim() || undefined,
          headquarters: addHQ.trim() || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to create client");
      setIsAddOpen(false);
      setAddName(""); setAddWebsite(""); setAddIndustry(""); setAddHQ("");
      refetch();
      toast({ title: "Client added", description: `${addName} added to your client list.` });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Failed to add client", description: err.message });
    } finally {
      setAddLoading(false);
    }
  };

  const filtered = useMemo(() => {
    let list = clients;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        (c.industry || "").toLowerCase().includes(q) ||
        (c.headquarters || "").toLowerCase().includes(q)
      );
    }
    if (trendFilter !== "all") {
      list = list.filter((c) => (c.overallHiringTrend || "unknown") === trendFilter);
    }
    return list;
  }, [clients, search, trendFilter]);

  if (selectedId) {
    return (
      <div className="flex flex-col gap-8 h-full">
        <div>
          <h1 className="text-3xl font-display font-bold text-white tracking-tight">Client Intelligence</h1>
          <p className="text-muted-foreground mt-1 text-lg">FEC filings, regulatory records, litigation, and branch intelligence.</p>
        </div>
        <ClientDetail clientId={selectedId} onBack={() => setSelectedId(null)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 h-full">
      <div>
        <h1 className="text-3xl font-display font-bold text-white tracking-tight">Client Intelligence</h1>
        <p className="text-muted-foreground mt-1 text-lg">
          FEC political contributions, regulatory records, litigation, and hiring intelligence across all clients.
        </p>
      </div>

      {/* Add Client Dialog */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="glass-panel border border-white/10 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white">Add New Client</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAddClient} className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label className="text-white/80 text-xs uppercase tracking-wider">Company Name *</Label>
              <Input
                value={addName} onChange={e => setAddName(e.target.value)}
                placeholder="e.g. Amazon, Boeing, CACI International"
                required autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-white/80 text-xs uppercase tracking-wider">Website</Label>
              <Input value={addWebsite} onChange={e => setAddWebsite(e.target.value)} placeholder="https://..." />
            </div>
            <div className="space-y-1.5">
              <Label className="text-white/80 text-xs uppercase tracking-wider">Industry</Label>
              <Input value={addIndustry} onChange={e => setAddIndustry(e.target.value)} placeholder="e.g. Defense & Government Services" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-white/80 text-xs uppercase tracking-wider">Headquarters</Label>
              <Input value={addHQ} onChange={e => setAddHQ(e.target.value)} placeholder="e.g. Arlington, VA" />
            </div>
            <DialogFooter className="pt-2">
              <Button type="button" variant="ghost" onClick={() => setIsAddOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={addLoading || !addName.trim()}>
                {addLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Plus className="w-4 h-4 mr-2" />}
                Add Client
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Search & Filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search clients..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          {search && <button className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white" onClick={() => setSearch("")}><X className="w-3.5 h-3.5" /></button>}
        </div>
        <Button onClick={() => setIsAddOpen(true)} className="flex items-center gap-2 shrink-0">
          <Plus className="w-4 h-4" />
          Add Client
        </Button>
        <div className="flex gap-2">
          {[
            { value: "all",         label: "All"          },
            { value: "growing",     label: "Growing"      },
            { value: "stable",      label: "Stable"       },
            { value: "contracting", label: "Contracting"  },
            { value: "unknown",     label: "Not Assessed" },
          ].map((opt) => (
            <button
              key={opt.value}
              onClick={() => setTrendFilter(opt.value)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                trendFilter === opt.value
                  ? "bg-primary/20 border-primary/40 text-primary"
                  : "bg-white/5 border-white/10 text-muted-foreground hover:text-white hover:border-white/20"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Count */}
      {!isLoading && <p className="text-sm text-muted-foreground -mt-4">Showing {filtered.length} of {clients.length} clients</p>}

      {/* Client grid */}
      {isLoading ? (
        <div className="flex items-center justify-center h-40"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
      ) : clients.length === 0 ? (
        <div className="glass-panel rounded-3xl border border-white/10 flex flex-col items-center justify-center p-12 text-center flex-1 min-h-[300px]">
          <Building2 className="w-10 h-10 text-primary mb-4" />
          <p className="text-white font-semibold mb-2">No clients yet</p>
          <p className="text-muted-foreground text-sm">Add your first client to get started.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="glass-panel rounded-2xl p-10 text-center border border-white/5">
          <Search className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-white font-medium">No clients match your filter</p>
          <button className="text-sm text-primary mt-2 hover:underline" onClick={() => { setSearch(""); setTrendFilter("all"); }}>Clear filters</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <AnimatePresence mode="popLayout">
            {filtered.map((client) => (
              <motion.div key={client.id} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} layout>
                <ClientCard client={client} onClick={() => setSelectedId(client.id)} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
