import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { settingsFormSchema as formSchema } from "@/lib/settings-form";
import { 
  ShieldAlert, 
  Save, 
  Building, 
  Hash, 
  CalendarDays, 
  Loader2, 
  CheckCircle2,
  Globe,
  Sparkles,
  Search,
  Package,
  ExternalLink,
  Info,
  Plug,
  Scale,
  DollarSign,
  HardHat,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";

import { 
  useGetSettings, 
  useUpdateSettings, 
  getGetSettingsQueryKey,
  useListProviders,
  useUpdateProvider,
  getListProvidersQueryKey
} from "@workspace/api-client-react";

function ProviderCard({ provider, index }: { provider: any; index: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateMutation = useUpdateProvider({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProvidersQueryKey() });
        toast({
          title: `${provider.displayName} Updated`,
          description: "Integration settings saved successfully.",
        });
        setValues({});
      },
      onError: (err: any) => {
        toast({
          variant: "destructive",
          title: "Update Failed",
          description: err.message || "Could not save settings.",
        });
      }
    }
  });

  const [values, setValues] = useState<Record<string, string>>({});

  const handleSave = () => {
    const payload: Record<string, string> = {};
    let hasChanges = false;
    
    const allFields = [...(provider.requiredFields || []), ...(provider.optionalFields || [])];
    
    allFields.forEach(field => {
       const val = values[field.dbKey];
       if (val !== undefined && val !== "") {
         payload[field.dbKey] = val;
         hasChanges = true;
       }
    });
    
    if (hasChanges) {
      updateMutation.mutate({ name: provider.name, data: payload });
    }
  };

  const getIcon = (name: string) => {
    switch (name.toLowerCase()) {
      case "sam.gov":
      case "samgov": return <Globe className="w-5 h-5 text-blue-400" />;
      case "gemini ai":
      case "gemini": return <Sparkles className="w-5 h-5 text-purple-400" />;
      case "serper": return <Search className="w-5 h-5 text-emerald-400" />;
      case "tango": return <Package className="w-5 h-5 text-orange-400" />;
      case "bidnet": return <Building className="w-5 h-5 text-indigo-400" />;
      default: return <Plug className="w-5 h-5 text-primary" />;
    }
  };

  const status = provider.status;
  const isConfigured = status?.configured;
  const isHealthy = status?.healthy;

  let statusBadge = (
    <div className="flex items-center gap-1.5 bg-amber-500/10 text-amber-400 px-2.5 py-1 rounded-full border border-amber-500/20 text-xs font-medium">
      <ShieldAlert className="w-3.5 h-3.5" />
      Not Configured
    </div>
  );

  if (isConfigured && isHealthy) {
    statusBadge = (
      <div className="flex items-center gap-1.5 bg-emerald-500/10 text-emerald-400 px-2.5 py-1 rounded-full border border-emerald-500/20 text-xs font-medium">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Connected
      </div>
    );
  } else if (isConfigured && !isHealthy) {
    statusBadge = (
      <div className="flex items-center gap-1.5 bg-slate-500/10 text-slate-400 px-2.5 py-1 rounded-full border border-slate-500/20 text-xs font-medium">
        <ShieldAlert className="w-3.5 h-3.5" />
        Partial
      </div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1, duration: 0.4, ease: "easeOut" }}
      className="glass-card rounded-2xl p-6 flex flex-col h-full bg-white/5 backdrop-blur-md border-white/10"
    >
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-background/50 border border-white/10 flex items-center justify-center shadow-inner">
            {getIcon(provider.displayName || provider.name)}
          </div>
          <div>
            <h3 className="font-display text-lg font-semibold text-white">{provider.displayName}</h3>
            <p className="text-xs text-muted-foreground line-clamp-2">{provider.description}</p>
          </div>
        </div>
        <div className="shrink-0 ml-2">
          {statusBadge}
        </div>
      </div>

      {provider.capabilities && provider.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {provider.capabilities.map((cap: string, i: number) => (
            <Badge key={i} variant="secondary" className="bg-white/5 hover:bg-white/10 text-[10px] font-normal text-white/80 border-white/10">
              {cap}
            </Badge>
          ))}
        </div>
      )}

      {provider.useCase && (
        <div className="flex items-center gap-2 mb-5">
          <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Used for:</span>
          {(() => {
            switch(provider.useCase) {
              case 'direct_source': return <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20 text-[10px] py-0">Direct Source</Badge>;
              case 'web_discovery': return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px] py-0">Web Discovery</Badge>;
              case 'research_analysis': return <Badge variant="outline" className="bg-pink-500/10 text-pink-400 border-pink-500/20 text-[10px] py-0">Research & Analysis</Badge>;
              case 'hybrid': return <Badge variant="outline" className="bg-purple-500/10 text-purple-400 border-purple-500/20 text-[10px] py-0">Hybrid (Discovery + AI)</Badge>;
              default: return null;
            }
          })()}
        </div>
      )}

      {provider.notes && (
        <div className="mb-5 p-3 rounded-xl bg-primary/5 border border-primary/10 flex gap-2.5">
          <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          <p className="text-xs text-white/80 leading-relaxed">{provider.notes}</p>
        </div>
      )}

      <div className="flex-1 flex flex-col justify-end space-y-4">
        <div className="space-y-4">
          {provider.requiredFields?.map((field: any) => (
            <div key={field.dbKey} className="space-y-1.5">
              <div className="flex justify-between items-center">
                <Label className="text-xs font-medium text-white/90">{field.label}</Label>
                {field.type === 'secret' && provider.signupUrl && (
                  <a href={provider.signupUrl} target="_blank" rel="noreferrer" className="text-[10px] text-primary hover:text-primary/80 flex items-center gap-1 transition-colors">
                    Get API key <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
              <Input
                type={field.type === 'secret' ? 'password' : 'text'}
                placeholder={field.placeholder}
                value={values[field.dbKey] !== undefined ? values[field.dbKey] : ""}
                onChange={(e) => setValues({...values, [field.dbKey]: e.target.value})}
                className="h-9 text-sm bg-background/40 border-white/10 focus-visible:ring-primary/50 text-white font-mono placeholder:font-sans"
              />
              {field.description && (
                <p className="text-[10px] text-muted-foreground">{field.description}</p>
              )}
            </div>
          ))}
          {provider.optionalFields?.map((field: any) => (
            <div key={field.dbKey} className="space-y-1.5">
              <div className="flex justify-between items-center">
                <Label className="text-xs font-medium text-white/90">
                  {field.label} <span className="text-muted-foreground/70 font-normal">(Optional)</span>
                </Label>
              </div>
              <Input
                type={field.type === 'secret' ? 'password' : 'text'}
                placeholder={field.placeholder}
                value={values[field.dbKey] !== undefined ? values[field.dbKey] : ""}
                onChange={(e) => setValues({...values, [field.dbKey]: e.target.value})}
                className="h-9 text-sm bg-background/40 border-white/10 focus-visible:ring-primary/50 text-white font-mono placeholder:font-sans"
              />
              {field.description && (
                <p className="text-[10px] text-muted-foreground">{field.description}</p>
              )}
            </div>
          ))}
        </div>

        <div className="pt-3 flex justify-end">
          <Button 
            size="sm"
            onClick={handleSave}
            disabled={updateMutation.isPending || Object.values(values).every(v => v === "")}
            className="bg-gradient-to-r from-primary to-accent hover:opacity-90 text-white shadow-lg shadow-primary/20 h-8 px-5 text-xs transition-all"
          >
            {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

function IntelKeyCard({
  icon,
  title,
  description,
  status,
  statusLabel,
  signupUrl,
  fields,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: "connected" | "unconfigured" | "default";
  statusLabel: string;
  signupUrl: string;
  fields: { label: string; key: string; placeholder: string; description: string; masked?: string }[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateMutation = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast({ title: `${title} Updated`, description: "API key saved successfully." });
        setValues({});
      },
      onError: () => toast({ variant: "destructive", title: "Save Failed", description: "Could not save the key." }),
    },
  });
  const [values, setValues] = useState<Record<string, string>>({});

  const statusBadge = status === "connected" ? (
    <div className="flex items-center gap-1.5 bg-emerald-500/10 text-emerald-400 px-2.5 py-1 rounded-full border border-emerald-500/20 text-xs font-medium">
      <CheckCircle2 className="w-3.5 h-3.5" />{statusLabel}
    </div>
  ) : status === "default" ? (
    <div className="flex items-center gap-1.5 bg-primary/10 text-primary px-2.5 py-1 rounded-full border border-primary/20 text-xs font-medium">
      <CheckCircle2 className="w-3.5 h-3.5" />{statusLabel}
    </div>
  ) : (
    <div className="flex items-center gap-1.5 bg-amber-500/10 text-amber-400 px-2.5 py-1 rounded-full border border-amber-500/20 text-xs font-medium">
      <ShieldAlert className="w-3.5 h-3.5" />{statusLabel}
    </div>
  );

  return (
    <div className="glass-card rounded-2xl p-5 border border-white/10 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-background/50 border border-white/10 flex items-center justify-center">{icon}</div>
          <div>
            <h3 className="text-sm font-semibold text-white">{title}</h3>
            <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{description}</p>
          </div>
        </div>
        <div className="flex-shrink-0">{statusBadge}</div>
      </div>

      <div className="space-y-3">
        {fields.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-white/90">{f.label}</Label>
              <a href={signupUrl} target="_blank" rel="noreferrer" className="text-[10px] text-primary hover:text-primary/80 flex items-center gap-0.5 transition-colors">
                Get key <ExternalLink className="w-2.5 h-2.5" />
              </a>
            </div>
            <Input
              type="password"
              placeholder={f.masked ? f.masked : f.placeholder}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
              className="h-9 text-sm bg-background/40 border-white/10 focus-visible:ring-primary/50 text-white font-mono placeholder:font-sans"
            />
            <p className="text-[10px] text-muted-foreground">{f.description}</p>
          </div>
        ))}
      </div>

      <div className="flex justify-end pt-1">
        <Button
          size="sm"
          onClick={() => {
            const payload: Record<string, string> = {};
            for (const f of fields) {
              if (values[f.key]?.trim()) payload[f.key] = values[f.key].trim();
            }
            if (Object.keys(payload).length) updateMutation.mutate({ data: payload });
          }}
          disabled={updateMutation.isPending || fields.every((f) => !values[f.key]?.trim())}
          className="bg-gradient-to-r from-primary to-accent hover:opacity-90 text-white h-8 px-5 text-xs"
        >
          {updateMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
          Save
        </Button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: providersData, isLoading: isLoadingProviders } = useListProviders();
  const { data: settings, isLoading: isLoadingSettings } = useGetSettings();
  
  const updateSettingsMutation = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        toast({
          title: "Defaults Saved",
          description: "Your global configuration has been updated.",
        });
      },
      onError: () => {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to save settings. Please try again.",
        });
      }
    }
  });

  const form = useForm<z.input<typeof formSchema>, unknown, z.output<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      organizationName: "",
      defaultKeywords: "",
      defaultDateRange: 30,
    },
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        organizationName: settings.organizationName || "",
        defaultKeywords: settings.defaultKeywords || "",
        defaultDateRange: settings.defaultDateRange || 30,
      });
    }
  }, [settings, form]);

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    updateSettingsMutation.mutate({ data: values });
  };

  const isLoading = isLoadingProviders || isLoadingSettings;

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const providers = providersData?.providers || [];

  return (
    <div className="max-w-6xl w-full mx-auto flex flex-col gap-10 pb-16">
      
      <div>
        <h1 className="text-3xl font-display font-bold text-white tracking-tight">Integrations & Settings</h1>
        <p className="text-muted-foreground mt-1 text-lg">Manage data sources and global portal configurations.</p>
      </div>

      {/* Section 1: Data Source Integrations */}
      <section className="space-y-6">
        <div>
          <h2 className="text-xl font-display font-semibold text-white flex items-center gap-2">
            <Plug className="w-5 h-5 text-primary" />
            Data Source Integrations
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Connect direct data sources, web intelligence tools, and AI providers that power the Opportunities portal.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {providers.map((provider, idx) => (
            <ProviderCard key={provider.name} provider={provider} index={idx} />
          ))}
        </div>
      </section>

      <Separator className="bg-white/10" />

      {/* Section 2: Client Intelligence Data Sources */}
      <section className="space-y-6">
        <div>
          <h2 className="text-xl font-display font-semibold text-white flex items-center gap-2">
            <Scale className="w-5 h-5 text-violet-400" />
            Client Intelligence Data Sources
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Connect public data APIs to enable FEC political contribution tracking, OSHA regulatory records, and federal litigation search on the Clients page.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* FEC */}
          <IntelKeyCard
            icon={<DollarSign className="w-5 h-5 text-emerald-400" />}
            title="FEC.gov Open Data"
            description="Political action committee filings, PAC contributions, and party donation breakdowns."
            status={settings?.fecApiKeyConfigured ? "connected" : "default"}
            statusLabel={settings?.fecApiKeyConfigured ? "Custom key active" : "DEMO_KEY (active)"}
            signupUrl="https://api.open.fec.gov/developers/"
            fields={[
              { label: "FEC API Key", key: "fecApiKey", placeholder: "Your FEC API key (optional)", description: "Leave blank to use the public DEMO_KEY (30 req/hr). Get your own key for higher rate limits.", masked: settings?.fecApiKeyMasked },
            ]}
          />

          {/* OSHA */}
          <IntelKeyCard
            icon={<HardHat className="w-5 h-5 text-amber-400" />}
            title="DOL / OSHA Enforcement"
            description="OSHA inspection records, violations, and penalty data from the Department of Labor."
            status={settings?.dolApiKeyConfigured ? "connected" : "unconfigured"}
            statusLabel={settings?.dolApiKeyConfigured ? "Connected" : "Not configured"}
            signupUrl="https://data.dol.gov/registration"
            fields={[
              { label: "DOL API Key", key: "dolApiKey", placeholder: "Your DOL API key", description: "Register for free at data.dol.gov/registration", masked: settings?.dolApiKeyMasked },
            ]}
          />

          {/* CourtListener */}
          <IntelKeyCard
            icon={<Scale className="w-5 h-5 text-violet-400" />}
            title="CourtListener / RECAP"
            description="Federal court dockets, civil litigation, and case history from the RECAP archive."
            status={settings?.courtListenerTokenConfigured ? "connected" : "unconfigured"}
            statusLabel={settings?.courtListenerTokenConfigured ? "Connected" : "Not configured"}
            signupUrl="https://www.courtlistener.com/sign-in/"
            fields={[
              { label: "CourtListener API Token", key: "courtListenerToken", placeholder: "Your CourtListener token", description: "Create a free account and copy your API token from your profile.", masked: settings?.courtListenerTokenMasked },
            ]}
          />
        </div>
      </section>

      <Separator className="bg-white/10" />

      {/* Section 3: Defaults */}
      <section className="space-y-6">
        <div>
          <h2 className="text-xl font-display font-semibold text-white flex items-center gap-2">
            <Building className="w-5 h-5 text-accent" />
            Profile & Defaults
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Global parameters used across the portal.
          </p>
        </div>

        <div className="glass-panel rounded-3xl p-6 md:p-8 border border-white/10">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <FormField
                  control={form.control}
                  name="organizationName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-white/90">Organization Name</FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="Acme Corp" 
                          {...field} 
                          className="bg-background/50 border-white/10 focus-visible:ring-primary/50 text-white h-10"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <FormField
                  control={form.control}
                  name="defaultKeywords"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-white/90 flex items-center gap-2">
                        <Hash className="w-4 h-4 text-muted-foreground" />
                        Default Search Keywords
                      </FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="e.g. software, cloud, agile" 
                          {...field} 
                          className="bg-background/50 border-white/10 focus-visible:ring-primary/50 text-white h-10"
                        />
                      </FormControl>
                      <FormDescription>Prefilled in the fetch dialog.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="defaultDateRange"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-white/90 flex items-center gap-2">
                        <CalendarDays className="w-4 h-4 text-muted-foreground" />
                        Default Lookback (Days)
                      </FormLabel>
                      <FormControl>
                        <Input 
                          type="number"
                          {...field} 
                          className="bg-background/50 border-white/10 focus-visible:ring-primary/50 text-white h-10"
                        />
                      </FormControl>
                      <FormDescription>How many days back to fetch by default.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="pt-4 flex justify-end">
                <Button 
                  type="submit" 
                  disabled={updateSettingsMutation.isPending}
                  className="bg-gradient-to-r from-primary to-accent hover:opacity-90 text-white shadow-lg shadow-primary/25 min-w-[140px]"
                >
                  {updateSettingsMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  {updateSettingsMutation.isPending ? "Saving..." : "Save Defaults"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </section>

    </div>
  );
}
