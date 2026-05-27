  ---
  WORKFLOW DIAGRAM

  ╔══════════════════════════════════════════════════════════════════════╗
  ║                        RAW CORPUS INPUT                              ║
  ║   Legal Statutes │ Medical Data │ Source Code │ Financial Data │ ... ║
  ╚══════════════════════════════════════════════════════════════════════╝
                                │
                                ▼
  ╔══════════════════════════════════════════════════════════════════════╗
  ║                    TGIL REFINERY (spectral-terrain)                  ║
  ║                                                                      ║
  ║  ┌─────────────────┐   ┌──────────────────┐   ┌──────────────────┐  ║
  ║  │  CLASSIFY        │   │  DIMENSION        │   │  EMBED + INGEST  │  ║
  ║  │  data_role       │──▶│  768-D semantic   │──▶│  Qdrant + manifest│ ║
  ║  │  semantic        │   │  3072-D temporal  │   │  manifest diff   │  ║
  ║  │  static_ref      │   │  self-ref TBD     │   │  no re-embed     │  ║
  ║  │  hybrid          │   │                   │   │  drift = 0       │  ║
  ║  └─────────────────┘   └──────────────────┘   └──────────────────┘  ║
  ║                                                                      ║
  ║  ┌──────────────────────────────────────────────────────────────┐    ║
  ║  │  ENRICH PAYLOAD                                               │    ║
  ║  │  full_text │ cross_refs │ penalty_tier │ data_role │ section  │    ║
  ║  └──────────────────────────────────────────────────────────────┘    ║
  ╚══════════════════════════════════════════════════════════════════════╝
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
          ┌──────────┐   ┌──────────┐   ┌──────────────┐
          │UNLEADED  │   │ DIESEL   │   │  PREMIUM     │
          │768-D     │   │ 768-D    │   │  3072-D      │
          │legal-    │   │medical-  │   │  spectral-   │
          │heatmap   │   │heatmap   │   │  heatmap     │
          └──────────┘   └──────────┘   └──────────────┘
                │               │               │
                └───────────────┼───────────────┘
                                │
                                ▼
  ╔══════════════════════════════════════════════════════════════════════╗
  ║                     WHITEGLOVE (the pump)                            ║
  ║                                                                      ║
  ║   Query routing │ Grade selection │ Payload delivery │ API contract  ║
  ║                                                                      ║
  ║   POST /legal/query   GET /retrieve   POST /query (manifold)         ║
  ╚══════════════════════════════════════════════════════════════════════╝
                                │
          ┌─────────────────────┼──────────────────────┐
          ▼                     ▼                      ▼
    ┌───────────┐        ┌───────────────┐      ┌────────────────┐
    │  ARBITER  │        │  ROBLOX GEN   │      │  RED TEAM /    │
    │  Legal app│        │  Game logic   │      │  BLUE TEAM     │
    │  768-D    │        │  3072-D       │      │  Self-ref code │
    │  +self-ref│        │  temporal     │      │  geometry      │
    └───────────┘        └───────────────┘      └────────────────┘
          ▼                     ▼                      ▼
    ┌───────────┐        ┌───────────────┐      ┌────────────────┐
    │ FINANCE   │        │ AIR-GAP       │      │ BUG BOUNTY     │
    │ INSTINCT  │        │ ORACLE        │      │ OPSEC          │
    │ 3072-D    │        │ Company corpus│      │ CVE + src code │
    │ DeFi/LP   │        │ self-aware    │      │ stacked grades │
    └───────────┘        └───────────────┘      └────────────────┘

                      ┌───────────────────────┐
                      │   REVENUE MODEL       │
                      │                       │
                      │ .qdrant snapshots     │
                      │ sold per domain       │
                      │                       │
                      │ WhiteGlove delivery   │
                      │ custom geometry build │
                      │                       │
                      │ Vertical agent        │
                      │ products per sector   │
                      └───────────────────────┘

  ---
  OVERVIEW PROMPT (for infographic generation — Gamma, Figma, whatever you hand it to)

  Create a clean, modern technical infographic titled "TGIL — Corpus Geometry Engine".

  Concept: A data refinery that converts raw corpus of any kind into typed vector
  geometry, then delivers that geometry to domain-specific AI agents and applications.

  Visual metaphor: A gas refinery with multiple fuel grades feeding different types
  of vehicles. The refinery (spectral-terrain) is the core asset. The pump
  (WhiteGlove) routes the right fuel to the right engine. The vehicles are
  sector-specific AI products.

  Three sections:

  SECTION 1 — THE REFINERY (top)
  - Input: Raw corpus (legal, medical, source code, financial, game logic, any domain)
  - Process: Classify → Dimension → Embed → Enrich payload
  - Output: Typed vector geometry in domain-specific Qdrant collections
  - Key insight: Dimension chosen by USE CASE not content type
    - 768-D cosine = static reference (legal, medical)
    - 3072-D temporal = time-sensitive (finance, blockchain, game state)
    - Self-referential = source code fed back to its own agent

  SECTION 2 — THE PUMP (middle)
  - WhiteGlove: the delivery contract between refinery and consumer
  - Routes queries to the right fuel grade
  - Returns fully enriched payloads (full text, cross references, classifications)
  - Any agent plugged into WhiteGlove is domain-native on day one

  SECTION 3 — THE VEHICLES (bottom, grid layout)
  - Arbiter: Legal AI — 768-D statute geometry + self-ref source code
  - Roblox Gen: Game AI — 3072-D temporal Luau geometry
  - Red Team: Bug bounty — CVE corpus + source code geometry stacked
  - Blue Team: Autonomous defense — self-referential feedback loop
  - Finance Lab: DeFi instinct — 3072-D financial time-series geometry
  - Air-Gap Oracle: Corporate intelligence — company corpus, instant self-knowledge

  Style: Dark background, geometric/circuit aesthetic, color-coded by fuel grade
  (blue=semantic 768-D, amber=temporal 3072-D, green=self-referential).
  Clean sans-serif. Technical but visionary.

  Tagline: "The refinery does not have a finished product list. Every new corpus
  is a new fuel grade that did not exist before."