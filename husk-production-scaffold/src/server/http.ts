/**
 * Airgapped HTTP server for the Husk. Node builtins only — no express,
 * no framework, nothing to pull from a registry at deploy time.
 *
 * Binds loopback by default. Endpoints:
 *   GET  /health          → readiness + calibration status
 *   POST /query           → { question, mode? } → HuskEnvelope
 *
 * Deliberately minimal. This is a scaffold: auth, rate limiting, and
 * TLS are NOT here and are called out in README-PROD.md as required
 * before any multi-user exposure.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HuskService } from "./service.js";
import { config } from "../config/index.js";

const service = new HuskService(config);

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX = 1024 * 64; // 64KB cap — questions aren't documents
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: service.isReady(),
        calibrated: config.thresholdCalibration.calibrated,
        thresholdUsed: config.queryThreshold,
        mode: config.mode,
      });
    }

    if (req.method === "POST" && req.url === "/query") {
      if (!service.isReady()) {
        return json(res, 503, { error: "service not ready" });
      }
      const body = (await readBody(req)) as { question?: string; mode?: string };
      if (!body.question || typeof body.question !== "string") {
        return json(res, 400, { error: "missing 'question' string" });
      }
      const envelope = await service.handle({
        question: body.question,
        mode: body.mode === "rag" ? "rag" : "retrieve",
      });
      return json(res, 200, envelope);
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, {
      error: err instanceof Error ? err.message : "internal error",
    });
  }
});

async function start(): Promise<void> {
  await service.init();
  server.listen(config.server.port, config.server.host, () => {
    console.log(
      `🔋 [HUSK] listening on http://${config.server.host}:${config.server.port} ` +
        `(mode=${config.mode}, calibrated=${config.thresholdCalibration.calibrated})`
    );
  });
}

start().catch((e) => {
  console.error("[HUSK] failed to start:", e);
  process.exit(1);
});
