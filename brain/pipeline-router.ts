/**
 * PIPELINE ROUTER
 *
 * Reads manifests/pipeline.json and provides typed routing for the TGIL
 * domain → processor → collection → receptacle contract.
 *
 * NOTE: manifests/pipeline.json is GENERATED from
 * spectral-config/config/domains.config.ts (`npm run generate:v2` there).
 * Do not hand-edit the JSON — edit the v3 manifest and regenerate.
 *
 * Usage:
 *   import { routeByDomain, listDomains, getCollection } from "./brain/pipeline-router";
 *
 *   const route = routeByDomain("legal-corpus");
 *   // { processor: "laplacian-768", collection: "legal-heatmap", receptacle: "legal_retrieve", ... }
 *
 *   listDomains();
 *   // ["legal-corpus", "medical-corpus", "repo-husk", "roblox-luau", "finance-crypto", "property-data"]
 */

import * as fs from "fs";
import * as path from "path";

export interface DomainRoute {
  processor:    string;
  collection:   string;
  qdrant?:      string;
  embed_model?: string;
  dims?:        number;
  receptacle:   string;
  role?:        string;
  note?:        string;
  ingest_script?: string;
  tools?:       string[];
  /** For repo-husk: resolves {repo_name} template */
  resolvedCollection?: string;
}

interface PipelineManifest {
  version:     string;
  description: string;
  domains:     Record<string, DomainRoute>;
}

const MANIFEST_PATH = path.resolve(__dirname, "../manifests/pipeline.json");

let _manifest: PipelineManifest | null = null;

function loadManifest(): PipelineManifest {
  if (_manifest) return _manifest;
  const raw = fs.readFileSync(MANIFEST_PATH, "utf-8");
  _manifest = JSON.parse(raw) as PipelineManifest;
  return _manifest;
}

/**
 * Route a domain key to its full pipeline config.
 * For repo-husk domains, pass repoName to resolve the {repo_name} template.
 * Returns null if domain not found.
 */
export function routeByDomain(domain: string, repoName?: string): DomainRoute | null {
  const manifest = loadManifest();
  const route = manifest.domains[domain];
  if (!route) return null;

  // Clone to avoid mutating the cached manifest
  const resolved: DomainRoute = { ...route };

  // Resolve {repo_name} template for repo-husk collections
  if (repoName && resolved.collection.includes("{repo_name}")) {
    resolved.resolvedCollection = resolved.collection.replace("{repo_name}", repoName);
  }

  return resolved;
}

/**
 * List all registered domain keys.
 */
export function listDomains(): string[] {
  return Object.keys(loadManifest().domains);
}

/**
 * Get just the collection name for a domain.
 * For repo-husk, pass repoName to resolve the template.
 */
export function getCollection(domain: string, repoName?: string): string | null {
  const route = routeByDomain(domain, repoName);
  if (!route) return null;
  return route.resolvedCollection ?? route.collection;
}

/**
 * Get the Qdrant URL for a domain. Endpoints come from the manifest (set
 * QDRANT_PI_URL when generating) or the same env var at runtime — no
 * literal endpoint lives in this public repo.
 */
export function getQdrantUrl(domain: string): string {
  const route = routeByDomain(domain);
  return route?.qdrant ?? process.env.QDRANT_PI_URL ?? "";
}

/**
 * Get the receptacle tool name for a domain.
 */
export function getReceptacle(domain: string): string | null {
  return routeByDomain(domain)?.receptacle ?? null;
}

/**
 * Find which domain a collection belongs to.
 * Useful for reverse-routing from collection name → domain config.
 */
export function domainForCollection(collection: string): string | null {
  const manifest = loadManifest();
  for (const [domain, route] of Object.entries(manifest.domains)) {
    if (route.collection === collection || route.collection.replace("{repo_name}", "") === collection.replace(/husk-.*/, "husk-")) {
      return domain;
    }
  }
  return null;
}

/**
 * Reload the manifest from disk (useful after adding new domains).
 */
export function reloadManifest(): void {
  _manifest = null;
}
