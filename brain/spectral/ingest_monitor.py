"""
ingest_monitor.py — LawLibra Ingest Watchdog
=============================================
Watches the Pi ingest log and fires Telegram alerts when:
  - No progress for STALL_SECONDS (stall / crash)
  - Error rate exceeds ERROR_THRESHOLD in last WINDOW lines
  - Ingest completes

Config via environment variables:
    TELEGRAM_BOT_TOKEN   — required
    TELEGRAM_CHAT_ID     — required
    INGEST_LOG_PATH      — optional, defaults to ~/whiteglove/vault/temporal_ingest.log

Run on Pi:
    export TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
    python3 ~/whiteglove/brain/spectral/ingest_monitor.py &

PID file written to: /tmp/ingest_monitor.pid
Kill cleanly: kill $(cat /tmp/ingest_monitor.pid)
"""

import json
import logging
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [monitor] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(Path.home() / "whiteglove/vault/monitor.log"),
    ],
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

def require_env(key: str) -> str:
    val = os.environ.get(key, "").strip()
    if not val:
        log.error(f"Missing required env var: {key}")
        sys.exit(1)
    return val

BOT_TOKEN  = require_env("TELEGRAM_BOT_TOKEN")
CHAT_ID    = require_env("TELEGRAM_CHAT_ID")
LOG_PATH   = Path(os.environ.get(
    "INGEST_LOG_PATH",
    str(Path.home() / "whiteglove/vault/temporal_ingest.log")
))

POLL_INTERVAL   = 60     # seconds between checks
STALL_SECONDS   = 300    # alert if no new shard in 5 minutes
ERROR_THRESHOLD = 0.20   # alert if >20% of last WINDOW lines are errors
WINDOW          = 50     # lines to check for error rate
PID_FILE        = Path("/tmp/ingest_monitor.pid")

# ── Graceful shutdown ─────────────────────────────────────────────────────────

_running = True

def _handle_signal(sig, frame):
    global _running
    log.info(f"Received signal {sig}, shutting down.")
    _running = False

signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT, _handle_signal)

# ── Telegram ──────────────────────────────────────────────────────────────────

def send_alert(msg: str) -> bool:
    # Telegram hard limit is 4096 chars
    if len(msg) > 4000:
        msg = msg[:3990] + "… *(truncated)*"
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = json.dumps({
        "chat_id": CHAT_ID,
        "text": msg,
        "parse_mode": "Markdown",
    }).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            result = json.loads(r.read())
            if not result.get("ok"):
                log.warning(f"Telegram API error: {result}")
                return False
            return True
    except urllib.error.URLError as e:
        log.warning(f"Telegram send failed: {e}")
        return False

# ── Log parsing ───────────────────────────────────────────────────────────────

SHARD_RE = re.compile(r'\[\s*(\d+)\s*/\s*(\d+)\]')
ERROR_RE  = re.compile(r'embed failed|HTTP Error \d+|⚠')

def parse_log(path: Path):
    """Returns (current_shard, total_shards, last_lines)"""
    if not path.exists():
        return None, None, []
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError as e:
        log.warning(f"Could not read log: {e}")
        return None, None, []

    current, total = None, None
    for line in reversed(lines):
        m = SHARD_RE.search(line)
        if m:
            current, total = int(m.group(1)), int(m.group(2))
            break
    return current, total, lines[-WINDOW:]

# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    PID_FILE.write_text(str(os.getpid()))
    log.info(f"LawLibra ingest watchdog started (PID {os.getpid()})")
    log.info(f"Watching: {LOG_PATH}")
    send_alert(" *LawLibra Monitor* started — watching Pi ingest log.")

    last_shard    = None
    last_progress = time.time()
    stall_alerted = False
    error_alerted = False
    done_alerted  = False

    while _running:
        current, total, last_lines = parse_log(LOG_PATH)
        now = time.time()

        # ── Progress tracking ─────────────────────────────────────────────────
        if current is not None:
            if current != last_shard:
                log.info(f"Progress: {current}/{total}")
                last_shard    = current
                last_progress = now
                stall_alerted = False

            elapsed = now - last_progress

            # ── Completion ────────────────────────────────────────────────────
            if total and current >= total and not done_alerted:
                send_alert(
                    f"✅ *LawLibra ingest COMPLETE*\n"
                    f"Shards: {current}/{total}\n"
                    f"Pi ingest finished. Ready to merge into main Qdrant."
                )
                done_alerted = True

            # ── Stall ─────────────────────────────────────────────────────────
            elif elapsed > STALL_SECONDS and not stall_alerted:
                send_alert(
                    f" *LawLibra ingest STALLED*\n"
                    f"Last shard: {current}/{total}\n"
                    f"No progress in {int(elapsed // 60)} min.\n"
                    f"`tail -20 ~/whiteglove/vault/temporal_ingest.log`"
                )
                stall_alerted = True

        else:
            # No shard pattern found at all
            elapsed = now - last_progress
            if elapsed > STALL_SECONDS and not stall_alerted:
                send_alert(
                    f" *LawLibra monitor* — no shard progress detected.\n"
                    f"Log at `{LOG_PATH}` shows no `[N/M]` pattern.\n"
                    f"Process may be dead or not started yet."
                )
                stall_alerted = True

        # ── Error rate ────────────────────────────────────────────────────────
        if last_lines:
            error_count = sum(1 for l in last_lines if ERROR_RE.search(l))
            rate = error_count / len(last_lines)
            if rate > ERROR_THRESHOLD and not error_alerted:
                log.warning(f"High error rate: {rate:.0%} ({error_count}/{len(last_lines)})")
                send_alert(
                    f"⚠️ *LawLibra — high embed error rate*\n"
                    f"Shard: {current}/{total}\n"
                    f"Errors: {error_count}/{len(last_lines)} lines ({rate:.0%})\n"
                    f"Likely Ollama overload (HTTP 500)."
                )
                error_alerted = True
            elif rate <= ERROR_THRESHOLD and error_alerted:
                log.info("Error rate cleared.")
                error_alerted = False

        time.sleep(POLL_INTERVAL)

    log.info("Monitor shut down cleanly.")
    PID_FILE.unlink(missing_ok=True)

if __name__ == "__main__":
    main()
