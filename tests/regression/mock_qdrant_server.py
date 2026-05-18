#!/usr/bin/env python3
"""Tiny Qdrant-compatible mock for regression tests."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse


class Handler(BaseHTTPRequestHandler):
    points_count = 0

    def _write_json(self, code: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/collections":
            self._write_json(
                200,
                {
                    "status": "ok",
                    "result": {"collections": [{"name": "legal-heatmap"}]},
                },
            )
            return

        if path.startswith("/collections/"):
            self._write_json(
                200,
                {
                    "status": "ok",
                    "result": {
                        "status": "green",
                        "points_count": Handler.points_count,
                    },
                },
            )
            return

        self._write_json(404, {"status": "error", "result": None})

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        size = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(size) if size > 0 else b"{}"
        data = json.loads(raw or b"{}")

        if path.startswith("/collections/") and path.endswith("/points"):
            points = data.get("points", [])
            Handler.points_count += len(points)
            self._write_json(200, {"status": "ok", "result": {"operation_id": 1}})
            return

        if path.startswith("/collections/"):
            self._write_json(200, {"status": "ok", "result": True})
            return

        self._write_json(404, {"status": "error", "result": None})

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=17634)
    parser.add_argument("--points", type=int, default=0)
    args = parser.parse_args()

    Handler.points_count = args.points
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
