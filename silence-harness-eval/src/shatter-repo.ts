import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync, existsSync } from "node:fs";
import * as path from "node:path";

/**
 * Self-ingest shatter — mirrors scripts/ingest_husk.py chunking exactly
 * (120-line chunks, 50% overlap, same shard-ID scheme) but writes local
 * JSON shard files for the landmark orchestrator instead of embedding
 * to Qdrant. Shard filename === shard id, which retrieve() relies on
 * for disk fetch.
 *
 * Usage: npx tsx src/shatter-repo.ts <repoRoot> <outDir>
 */

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".py", ".go", ".rs", ".lua", ".sol",
  ".java", ".kt", ".cs",
  ".cpp", ".cc", ".c", ".h", ".hpp",
  ".rb", ".swift", ".sh", ".bash",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".next", "dist", "build",
  "coverage", ".turbo", ".cache", "vendor", "venv", ".venv",
  "target", "shards",
]);

const CHUNK_SIZE = 120;
const STEP = CHUNK_SIZE / 2;

interface Shard {
  id: string;
  title: string;
  source: string;
  content: string;
  line_start: number;
  line_end: number;
}

function chunkFile(filePath: string, repoRoot: string): Shard[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  if (!text.trim()) return [];

  const lines = text.split(/\r?\n/);
  const relPath = path.relative(repoRoot, filePath).split(path.sep).join("/");
  const shards: Shard[] = [];

  for (let i = 0; i < Math.max(1, lines.length); i += STEP) {
    const chunkLines = lines.slice(i, i + CHUNK_SIZE);
    const chunkText = chunkLines.join("\n");
    if (chunkText.trim()) {
      const chunkIdx = Math.floor(i / STEP);
      shards.push({
        id: `${relPath.replace(/\//g, "_").replace(/\./g, "_")}__chunk_${String(chunkIdx).padStart(4, "0")}`,
        title: `${relPath} (lines ${i + 1}–${i + chunkLines.length})`,
        source: relPath,
        content: chunkText,
        line_start: i + 1,
        line_end: i + chunkLines.length,
      });
    }
    if (i + CHUNK_SIZE >= lines.length) break;
  }
  return shards;
}

function walk(dir: string, repoRoot: string, shards: Shard[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(full, repoRoot, shards);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      shards.push(...chunkFile(full, repoRoot));
    }
  }
}

function main(): void {
  const repoRoot = path.resolve(process.argv[2] ?? "../");
  const outDir = path.resolve(process.argv[3] ?? "./shards");
  if (!statSync(repoRoot).isDirectory()) throw new Error(`Not a directory: ${repoRoot}`);

  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const shards: Shard[] = [];
  walk(repoRoot, repoRoot, shards);

  const sources = new Set(shards.map((s) => s.source));
  for (const shard of shards) {
    writeFileSync(path.join(outDir, `${shard.id}.json`), JSON.stringify(shard, null, 2));
  }
  console.log(`Shattered ${sources.size} source files into ${shards.length} shards at ${outDir}`);
}

main();
