/**
 * Load, validate, and query the domain manifest. This is what an agent
 * or script imports — it never touches the raw config directly, it goes
 * through the validated gate.
 */
import { parseManifest, selectPipeline, type DomainPipeline } from "./manifest.schema.js";
import domains from "../config/domains.config.js";

/** Validate at import time. Throws if the manifest is malformed. */
export const MANIFEST = parseManifest(domains);

/** Resolve a pipeline by id (e.g. "legal-corpus"). */
export function getPipeline(id: string): DomainPipeline {
  return selectPipeline(MANIFEST, id);
}

/** List every known pipeline id + status — for agent orientation. */
export function listPipelines(): Array<{ id: string; status: string; geometry: string }> {
  return MANIFEST.pipelines.map((p) => ({
    id: p.id,
    status: p.status,
    geometry: p.geometry,
  }));
}

/** Pipelines whose threshold is not yet calibrated — the honest to-do list. */
export function uncalibrated(): string[] {
  return MANIFEST.pipelines
    .filter((p) => p.silence.enabled && !p.silence.calibration.calibrated)
    .map((p) => p.id);
}

/** Pipelines carrying a [CONFIRM] ambiguity in notes — needs human verify. */
export function needsConfirmation(): Array<{ id: string; note: string | undefined }> {
  return MANIFEST.pipelines
    .filter((p) => (p.notes ?? "").includes("AMBIGUITY") || (p.silence.calibration.note ?? "").includes("CONFIRM"))
    .map((p) => ({ id: p.id, note: p.notes }));
}

import { auditDimensions } from "./manifest.schema.js";
/** Static pipelines running above the dimension policy cap. */
export function dimensionViolations() {
  return auditDimensions(MANIFEST);
}
