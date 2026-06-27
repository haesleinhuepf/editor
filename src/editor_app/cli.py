from __future__ import annotations

import argparse
import threading
import webbrowser

import uvicorn

from editor_app.server import create_app


def main() -> int:
    parser = argparse.ArgumentParser(prog="editor", description="Section-based markdown editor (browser)")
    parser.add_argument("filename", nargs="?", help="Optional markdown file to open")
    parser.add_argument("--host", default="127.0.0.1", help="Host for local web server")
    parser.add_argument("--port", type=int, default=8765, help="Port for local web server")
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open browser")
    args = parser.parse_args()

    app = create_app(initial_path=args.filename)
    base_url = f"http://{args.host}:{args.port}/"

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(base_url)).start()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
