"""
mitmproxy addon: capture responses from the hosts we care about (Greenhouse embed,
Datadog careers, Typesense, Gmail) and write each body to debug/captures/ as its own
file so we can grep/read them offline. Also appends a one-line summary to index.log.

Run via:  mitmweb -s debug/mitm-capture.py  (already wired into debug/launch.sh)
"""

from __future__ import annotations

import os
import re
import time
from typing import Optional

from mitmproxy import http

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAP_DIR = os.path.join(ROOT, "debug", "captures")
os.makedirs(CAP_DIR, exist_ok=True)

# Only capture bodies from these hosts — everything else passes through untouched.
HOST_ALLOW = re.compile(
    r"(job-boards\.greenhouse\.io"
    r"|boards\.greenhouse\.io"
    r"|careers\.datadoghq\.com"
    r"|\.a1\.typesense\.net"
    r"|mail\.google\.com/mail/u/0/(\?ik|feed))"
)

# Skip noisy asset types even for allowed hosts.
CT_SKIP = re.compile(r"^(image/|font/|application/octet-stream|video/|audio/)")


def _safe(s: str, max_len: int = 60) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", s).strip("_")[:max_len] or "root"


def _ext_from_ct(ct: str) -> str:
    ct = ct.lower()
    if "html" in ct:
        return "html"
    if "json" in ct:
        return "json"
    if "javascript" in ct or "ecmascript" in ct:
        return "js"
    if "css" in ct:
        return "css"
    if "xml" in ct:
        return "xml"
    return "txt"


def response(flow: http.HTTPFlow) -> None:
    if flow.response is None:
        return
    host = flow.request.pretty_host
    if not HOST_ALLOW.search(host):
        return
    ct = flow.response.headers.get("content-type", "")
    if CT_SKIP.match(ct):
        return

    ts = time.strftime("%H%M%S")
    path = flow.request.path.split("?", 1)[0]
    fname = f"{ts}-{_safe(host)}-{_safe(path)}.{_ext_from_ct(ct)}"
    dest = os.path.join(CAP_DIR, fname)

    body: Optional[str]
    try:
        body = flow.response.get_text(strict=False)
    except Exception as e:
        body = None
        err = f"body-decode-failed: {e}"
    else:
        err = None

    try:
        with open(dest, "w", encoding="utf-8") as f:
            f.write(body or "")
    except OSError as e:
        print(f"[capture] write failed {fname}: {e}")
        return

    size = len(body or "")
    line = (
        f"{ts} {flow.request.method:4} {flow.response.status_code} "
        f"{host}{flow.request.path[:120]:120} {size:>8}B -> {fname}"
    )
    if err:
        line += f"  ({err})"
    print(f"[capture] {line}")
    with open(os.path.join(CAP_DIR, "index.log"), "a", encoding="utf-8") as f:
        f.write(line + "\n")
