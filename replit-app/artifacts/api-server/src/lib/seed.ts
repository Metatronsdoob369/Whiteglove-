import { db, shardsTable } from "@workspace/db";
import { simhash128 } from "./simhash";

// Seed corpus: concept + synopsis drive the fingerprint; text is the only
// payload the agent is ever allowed to speak.
export const SEED_SHARDS: Array<{
  concept: string;
  source: string;
  text: string;
  synopsis: string;
}> = [
  {
    concept: "Diabetic Ketoacidosis (DKA)",
    source: "Emergency Medicine Reference",
    text: "Classic signs include Kussmaul respirations, fruity (acetone) breath odor, nausea, vomiting, abdominal pain, dehydration, and altered mental status.",
    synopsis:
      "diabetic ketoacidosis dka signs symptoms kussmaul respirations breathing fruity acetone breath odor nausea vomiting abdominal pain dehydration altered mental status confusion emergency high blood sugar ketones",
  },
  {
    concept: "Type 1 Diabetes Management",
    source: "Endocrinology Handbook",
    text: "Requires exogenous insulin — basal-bolus regimen or continuous insulin pump (CSII). Continuous glucose monitoring (CGM) is standard of care. Carbohydrate counting guides mealtime dosing.",
    synopsis:
      "type 1 diabetes t1d juvenile insulin dependent treatment management basal bolus regimen insulin pump csii continuous glucose monitoring cgm carbohydrate counting mealtime dosing",
  },
  {
    concept: "Type 2 Diabetes Management",
    source: "Endocrinology Handbook",
    text: "First-line: lifestyle modification (diet, exercise, weight loss) plus metformin. Step-up options include GLP-1 agonists (semaglutide), SGLT2 inhibitors (empagliflozin), sulfonylureas, and insulin if glycemic targets are not met.",
    synopsis:
      "type 2 diabetes t2d adult onset treatment management lifestyle diet exercise weight loss metformin glp-1 semaglutide ozempic sglt2 empagliflozin sulfonylurea glycemic targets high blood sugar glucose control",
  },
  {
    concept: "Insulin Therapy",
    source: "Pharmacology Reference",
    text: "Basal insulin (glargine, detemir) provides background coverage. Rapid-acting bolus insulin (lispro, aspart) covers meals. Dosing is individualized based on carbohydrate intake and glucose patterns.",
    synopsis:
      "insulin therapy types basal glargine detemir long acting background bolus lispro aspart rapid acting meals dosing units injection pen syringe carbohydrate glucose patterns",
  },
  {
    concept: "Hypoglycemia",
    source: "Emergency Medicine Reference",
    text: "Symptoms: diaphoresis, tremor, palpitations, confusion, seizure. Mild: 15g fast-acting carbohydrate (glucose tablets, juice). Severe/unconscious: glucagon IM or IV dextrose. Recheck in 15 min.",
    synopsis:
      "hypoglycemia low blood sugar glucose drop crash symptoms diaphoresis sweating tremor shaky palpitations confusion seizure dizzy treatment fast acting carbohydrate glucose tablets juice glucagon dextrose unconscious",
  },
  {
    concept: "Anaphylaxis",
    source: "Emergency Medicine Reference",
    text: "Epinephrine 0.3–0.5 mg IM (anterolateral thigh) is first-line. Call emergency services. Lay supine with legs elevated unless respiratory distress. Repeat epinephrine every 5–15 min if needed.",
    synopsis:
      "anaphylaxis severe allergic reaction allergy epinephrine adrenaline epipen first line hives swelling throat closing bee sting airway respiratory distress emergency",
  },
  {
    concept: "Cardiac Arrest / CPR",
    source: "Resuscitation Guidelines",
    text: "Begin CPR immediately: 30 chest compressions to 2 rescue breaths. Compression rate 100–120/min, depth 5–6 cm. Attach AED as soon as available. Continue until advanced help arrives.",
    synopsis:
      "cardiac arrest heart stopped no pulse cpr chest compressions rescue breaths aed defibrillator resuscitation unresponsive not breathing emergency rate depth",
  },
  {
    concept: "Stroke",
    source: "Neurology Reference",
    text: "Use FAST: Face drooping, Arm weakness, Speech difficulty, Time to call emergency services. Do not give aspirin if hemorrhagic stroke suspected. tPA within 4.5 hours for ischemic stroke if no contraindications.",
    synopsis:
      "stroke fast protocol face drooping facial droop arm weakness speech difficulty slurred time emergency tpa alteplase ischemic hemorrhagic brain bleed clot cva aspirin",
  },
];

export interface VaultShard {
  id: number;
  concept: string;
  source: string;
  text: string;
  searchText: string;
  fingerprint: string;
}

export function seedSearchText(shard: (typeof SEED_SHARDS)[number]): string {
  return `${shard.concept} ${shard.synopsis}`;
}

export function seedFingerprint(shard: (typeof SEED_SHARDS)[number]): string {
  return simhash128(seedSearchText(shard));
}

// Idempotent and concurrency-safe seeding.
//
// - Runs inside a single transaction, so a crash can never leave a partial
//   vault (the old early-return-on-any-row version could get stuck forever
//   with a half-seeded vault).
// - ON CONFLICT (concept) refreshes the retrieval fields (fingerprint +
//   searchText) but leaves verified text alone — existing rows survive
//   tokenizer/fingerprint algorithm upgrades, and row ids are stable.
// - The unique constraint on concept plus ON CONFLICT means two concurrent
//   first requests both succeed instead of one 500ing.
//
// The table and corpus are parameters so tests can exercise this against a
// scratch table — seeding logic must never be tested by wiping the real
// shards table.
export async function seedVault(
  executor: typeof db,
  table: typeof shardsTable,
  seeds: typeof SEED_SHARDS,
  log: (msg: string) => void,
): Promise<void> {
  const existing = await executor
    .select({
      concept: table.concept,
      fingerprint: table.fingerprint,
      searchText: table.searchText,
    })
    .from(table);
  const byConcept = new Map(
    existing.map((r) => [r.concept, { fingerprint: r.fingerprint, searchText: r.searchText }]),
  );
  const upToDate = seeds.every((s) => {
    const row = byConcept.get(s.concept);
    return (
      row != null &&
      row.fingerprint === seedFingerprint(s) &&
      row.searchText === seedSearchText(s)
    );
  });
  if (upToDate) return;
  log("seeding shard vault");
  await executor.transaction(async (tx) => {
    for (const shard of seeds) {
      const fingerprint = seedFingerprint(shard);
      const searchText = seedSearchText(shard);
      await tx
        .insert(table)
        .values({
          concept: shard.concept,
          source: shard.source,
          text: shard.text,
          searchText,
          fingerprint,
        })
        .onConflictDoUpdate({
          target: table.concept,
          // Refresh only retrieval fields: verified text is never clobbered.
          set: { fingerprint, searchText },
        });
    }
  });
}

export async function ensureSeeded(log: (msg: string) => void): Promise<void> {
  return seedVault(db, shardsTable, SEED_SHARDS, log);
}

export async function loadVault(): Promise<VaultShard[]> {
  return db.select().from(shardsTable);
}
