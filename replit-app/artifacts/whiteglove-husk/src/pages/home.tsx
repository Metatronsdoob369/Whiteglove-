import { useState } from "react";
import { Github, Play, ShieldCheck, WifiOff, VolumeX, Dna } from "lucide-react";
import { useHuskQuery } from "@workspace/api-client-react";

const DEFAULT_RESPONSE = {
  text: "No shards met the calibrated Hamming threshold (0.45).",
  citations: "HUSK remained silent. This is working as intended.",
};

const GUARANTEES = [
  {
    icon: WifiOff,
    title: "Airgapped First",
    body: "Runs entirely from a portable ARCHIVE drive. Zero network calls. Ever.",
  },
  {
    icon: VolumeX,
    title: "Silence First",
    body: "The absence of an answer is a deliberate, trustworthy response.",
  },
  {
    icon: Dna,
    title: "Contract Driven",
    body: "EmbeddingContract enforces ℓ₂-normalization. All vectors live on the unit sphere.",
  },
  {
    icon: ShieldCheck,
    title: "Hallucination Proof",
    body: "No generation without verified source shards. The model only speaks from truth.",
  },
];

const ARCHITECTURE_STEPS = [
  {
    n: "1",
    title: "Query arrives",
    body: "SimHash-128 fingerprint generated",
  },
  {
    n: "2",
    title: "Hamming Distance Ranking",
    body: "Hot Ring Buffer returns top candidates in O(1)",
  },
];

const REPO_URL = "https://github.com/Metatronsdoob369/Whiteglove-";

export default function Home() {
  const [query, setQuery] = useState("");
  const husk = useHuskQuery();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    husk.mutate({ data: { query } });
  };

  const submitted = husk.data ?? null;
  const isLoading = husk.isPending;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="fixed top-0 w-full border-b border-border bg-background/80 backdrop-blur-lg z-50">
        <div className="max-w-screen-2xl mx-auto px-6 md:px-8 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
              WG
            </div>
            <span className="text-xl md:text-2xl font-semibold tracking-tighter text-foreground">
              WhiteGlove
            </span>
            <span className="text-primary text-sm font-mono tracking-widest pt-1 hidden sm:inline">
              HUSK
            </span>
          </div>
          <div className="flex items-center gap-6 md:gap-10 text-sm">
            <a
              href="#philosophy"
              className="hidden md:inline hover:text-primary transition-colors"
            >
              Philosophy
            </a>
            <a
              href="#architecture"
              className="hidden md:inline hover:text-primary transition-colors"
            >
              Architecture
            </a>
            <a
              href="#demo"
              className="hidden md:inline hover:text-primary transition-colors"
            >
              Live Demo
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 px-4 md:px-5 py-2.5 border border-primary rounded-xl hover:bg-primary/10 transition-colors"
              data-testid="link-github-nav"
            >
              <Github className="w-4 h-4" />
              <span>GitHub</span>
            </a>
          </div>
        </div>
      </nav>
      <section
        className="relative min-h-screen flex items-center pt-28 pb-20 overflow-hidden"
        style={{
          background:
            "radial-gradient(circle at 50% 30%, hsl(158 100% 45% / 0.08), transparent 70%)",
        }}
      >
        <div className="max-w-screen-2xl mx-auto px-6 md:px-8 grid md:grid-cols-2 gap-16 items-center">
          <div className="space-y-8">
            <div className="inline-flex items-center gap-2 px-4 py-2 border border-primary/30 rounded-2xl text-primary text-xs md:text-sm font-mono tracking-widest">
              AIRGAPPED • HALLUCINATION PROOF
            </div>

            <h1 className="text-5xl sm:text-6xl md:text-8xl font-bold tracking-tighter leading-[0.95] text-foreground">
              Silence is
              <br />
              the protocol.
            </h1>

            <p className="text-xl md:text-2xl text-muted-foreground max-w-lg">
              The <span className="font-semibold text-foreground">WhiteGlove: <span className="text-primary">Agent</span> Hush<span className="ml-px align-super text-sm text-primary">+</span></span> never
              fabricates. It either retrieves verified knowledge or remains completely silent.
            </p>

            <div className="flex flex-wrap items-center gap-4">
              <a
                href="#demo"
                className="px-6 md:px-8 py-4 border border-primary bg-transparent text-primary hover:bg-primary/15 font-semibold rounded-2xl transition-colors flex items-center gap-3"
                data-testid="link-try-agent"
              >
                <Play className="w-4 h-4" />
                Try the Agent
              </a>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="px-6 md:px-8 py-4 border border-border hover:border-muted-foreground rounded-2xl transition-colors"
                data-testid="link-view-repo"
              >
                View Repository
              </a>
            </div>

            <div className="flex flex-wrap items-center gap-4 md:gap-8 text-xs md:text-sm pt-6">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
                <span className="text-primary">Offline-First</span>
              </div>
              <div className="text-muted-foreground">SimHash-128 • Hamming Distance</div>
              <div className="text-muted-foreground">Raspberry Pi 5 Optimized</div>
            </div>
          </div>

          <div className="relative">
            <div className="bg-card p-6 md:p-8 rounded-3xl border border-primary/20 shadow-2xl">
              <div className="text-primary text-xs mb-6 flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-destructive" />
                <div className="w-3 h-3 rounded-full bg-yellow-500" />
                <div className="w-3 h-3 rounded-full bg-primary" />
                <span className="ml-4 font-mono">HUSK v0.9.4 — ARCHIVE MODE</span>
              </div>

              <div className="space-y-6 font-mono text-sm">
                <div className="text-muted-foreground">
                  → What are the signs of diabetic ketoacidosis?
                </div>
                <div className="pl-6 border-l border-primary/30 text-primary/90">
                  Kussmaul breathing, fruity breath odor, nausea, vomiting, abdominal pain,
                  confusion, and rapid fatigue.
                </div>
                <div className="text-[10px] text-muted-foreground">
                  3 shards retrieved • max hamming 0.387 • confidence: VERIFIED
                </div>

                <div className="pt-6 text-muted-foreground text-xs border-t border-border">
                  Query fingerprinted with SimHash-128 • 15,580 medical shards indexed
                </div>
              </div>
            </div>

            <div className="absolute -bottom-6 -right-6 bg-card border border-border rounded-2xl p-5 text-xs font-mono max-w-[220px]">
              <div className="flex items-center gap-2 text-primary">
                <ShieldCheck className="w-4 h-4" />
                <span>Faith-Less Retrieval Active</span>
              </div>
              <div className="text-muted-foreground mt-1">
                Zero hallucinations since last DREAM cycle
              </div>
            </div>
          </div>
        </div>
      </section>
      <section id="philosophy" className="py-24 md:py-32 bg-black">
        <div className="max-w-screen-2xl mx-auto px-6 md:px-8">
          <div className="grid md:grid-cols-12 gap-12 md:gap-16 items-center">
            <div className="md:col-span-5">
              <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground mb-8">
                Most agents lie
                <br />
                by speaking.
                <br />
                <span className="text-primary">This one lies by staying silent.</span>
              </h2>
            </div>
            <div className="md:col-span-7 text-base md:text-lg text-muted-foreground leading-relaxed space-y-6">
              <p className="text-lg md:text-xl">
                Standard RAG systems prioritize sounding confident.{" "}
                <span className="text-foreground font-medium">The Husk inverts this.</span>
              </p>
              <p>
                It uses SimHash-128 fingerprinting and calibrated Hamming distance to determine
                whether a query has sufficient grounding in the knowledge vault.
              </p>
              <p className="text-primary font-medium">
                If no shard meets the threshold — it returns nothing.
              </p>
              <p className="text-muted-foreground/80">
                This is not a limitation. In medicine, defense, and high-stakes operations, a
                confident hallucination is far more dangerous than silence.
              </p>
            </div>
          </div>
        </div>
      </section>
      <section className="py-20 md:py-24 border-t border-b border-border">
        <div className="max-w-screen-2xl mx-auto px-6 md:px-8">
          <h3 className="text-center text-primary font-mono tracking-widest text-sm mb-12">
            GUARANTEES BY DESIGN
          </h3>

          <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-6">
            {GUARANTEES.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="bg-card border border-border p-8 rounded-3xl hover:border-primary/50 transition-colors"
              >
                <Icon className="w-8 h-8 mb-6 text-primary" strokeWidth={1.5} />
                <h4 className="text-xl font-semibold mb-3">{title}</h4>
                <p className="text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section id="architecture" className="py-24 md:py-32 bg-black">
        <div className="max-w-screen-2xl mx-auto px-6 md:px-8">
          <h2 className="text-3xl md:text-5xl font-bold text-center mb-16">
            Faith-Less Retrieval Engine
          </h2>

          <div className="max-w-4xl mx-auto font-mono text-sm bg-card border border-border rounded-3xl p-8 md:p-12">
            <div className="space-y-10">
              {ARCHITECTURE_STEPS.map((step) => (
                <div className="flex gap-6 md:gap-8 items-start" key={step.n}>
                  <div className="w-8 h-8 shrink-0 rounded-2xl bg-primary/10 text-primary flex items-center justify-center font-bold">
                    {step.n}
                  </div>
                  <div>
                    <div className="text-primary">{step.title}</div>
                    <div className="text-muted-foreground">{step.body}</div>
                  </div>
                </div>
              ))}
              <div className="flex gap-6 md:gap-8 items-start border-l-2 border-primary pl-6 md:pl-8">
                <div>
                  <div className="text-primary">Threshold Gate (0.45)</div>
                  <div className="text-muted-foreground">
                    If no shard is close enough →{" "}
                    <span className="text-destructive font-bold">SILENCE</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-6 md:gap-8 items-start">
                <div className="w-8 h-8 shrink-0 rounded-2xl bg-primary/10 text-primary flex items-center justify-center font-bold">
                  3
                </div>
                <div className="text-primary">
                  Return verified source text only — or pass to local Ollama (RAG mode)
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section id="demo" className="py-24 md:py-32 bg-muted/40">
        <div className="max-w-3xl mx-auto px-6 md:px-8">
          <h3 className="text-center text-primary font-mono text-sm tracking-widest mb-4">
            INTERACTIVE DEMO
          </h3>
          <h2 className="text-3xl md:text-4xl font-bold text-center mb-12">Ask the Husk</h2>

          <form
            onSubmit={handleSubmit}
            className="bg-card rounded-3xl p-6 md:p-8 border border-primary"
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              type="text"
              placeholder="Ask a medical emergency question..."
              className="w-full bg-transparent outline-none text-foreground placeholder-muted-foreground font-mono text-base md:text-lg"
              data-testid="input-query"
            />

            <div className="mt-10 min-h-[180px] text-sm leading-relaxed">
              {isLoading && (
                <div className="flex items-center gap-3 text-muted-foreground font-mono text-xs">
                  <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
                  Scanning shard vault…
                </div>
              )}
              {!isLoading && submitted && (
                <div>
                  <div className="text-primary mb-2">→ {submitted.query}</div>
                  <div className="text-[10px] text-muted-foreground/70 font-mono mb-4">
                    fingerprint {(submitted.fingerprint ?? "").slice(0, 12)}… •{" "}
                    {submitted.turns ?? 0} turn{(submitted.turns ?? 0) === 1 ? "" : "s"}
                  </div>
                  {submitted.silenced ? (
                    <>
                      <div className="text-destructive/80">
                        No shard cleared the calibrated Hamming threshold (
                        {submitted.threshold}).
                        {submitted.distance != null && (
                          <span className="text-destructive/60">
                            {" "}
                            Closest measured distance: {submitted.distance.toFixed(3)}.
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-4">
                        {submitted.gateVeto
                          ? submitted.gateVeto === "overlap"
                            ? "HUSK remained silent — the gate vetoed the model's answer: the query shares no meaningful vocabulary with any vault shard. Rejected by the gate, not the model."
                            : "HUSK remained silent — rejected by the threshold gate, not by the model. This is working as intended."
                          : "HUSK remained silent — the agent judged this outside the vault's scope. Deliberate silence, as intended."}
                      </div>
                    </>
                  ) : (
                    <>
                      {submitted.concept && (
                        <div className="text-[10px] text-primary/50 font-mono mb-2 uppercase tracking-widest">
                          {submitted.concept}
                        </div>
                      )}
                      <div className="text-primary/90">{submitted.text}</div>
                      <div className="text-[10px] text-primary/70 mt-6">{submitted.citations}</div>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => { husk.reset(); setQuery(""); }}
                    className="mt-8 px-5 py-2.5 text-xs font-mono border border-border rounded-xl hover:border-primary/60 hover:text-primary transition-colors text-muted-foreground"
                  >
                    ↩ Clear &amp; ask again
                  </button>
                </div>
              )}
              {!isLoading && husk.isError && (
                <div className="text-destructive/80 text-xs font-mono">
                  Shard vault unreachable. Check API connection.
                </div>
              )}
            </div>
          </form>

          <p className="text-center text-muted-foreground text-xs mt-6 font-mono">
            Powered by real SimHash-128 logic • Medical knowledge vault
          </p>
        </div>
      </section>
      <footer className="border-t border-border py-16">
        <div className="max-w-screen-2xl mx-auto px-6 md:px-8 text-center">
          <p className="text-muted-foreground text-sm">
            Built for realities where wrong answers are not an option.
          </p>
          <p className="text-muted-foreground/70 text-xs mt-8 font-mono">
            WhiteGlove Agent Husk • Offline • Airgapped • Silence-First
          </p>
        </div>
      </footer>
    </div>
  );
}
