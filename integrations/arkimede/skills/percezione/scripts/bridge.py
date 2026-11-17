#!/usr/bin/env python3
"""Daemon: Percezione's live events and presence into Arkimede.

- Events: `GET <PERCEZIONE_URL>/events` (Server-Sent Events). The last event id is kept in SKILL_STATE_DIR, so after a
  restart the stream resumes where it stopped and nothing is lost (Arkimede drops duplicates by id).
- Presence: `who_is_where` from Percezione's MCP server every PRESENCE_POLL_S seconds, and at once on an arrival or a
  departure.
What each event becomes is in mapping.py.
"""
import json
import logging
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mapping import plan, presence_reports  # noqa: E402
from percezione import mcp_tool  # noqa: E402
from plugin_api import call, service  # noqa: E402

logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="[percezione] %(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("percezione")

# a model turn, possibly with tools: longer than a service call
AGENT_TIMEOUT_S = 180

stopping = threading.Event()
poll_now = threading.Event()


def _stop(sig, _frame):
    log.info("signal %s: stopping", sig)
    stopping.set()
    poll_now.set()


signal.signal(signal.SIGTERM, _stop)
signal.signal(signal.SIGINT, _stop)


class LastId:
    """The id of the last event handled, on disk."""

    def __init__(self, directory):
        self.path = os.path.join(directory, "last_event_id") if directory else None
        self.value = None
        if self.path and os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as f:
                self.value = f.read().strip() or None

    def save(self, value):
        self.value = value
        if self.path:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(value)
            os.replace(tmp, self.path)


def ask_agent(cfg, body):
    """A notification or an announcement for the agent: it decides whom to reach and how, in which language. Slow
    (a model turn), so off the event thread. When the agent cannot be asked, the plan's fallback call is made."""
    try:
        res = service(cfg, "agent.ask", body["ask"], timeout=AGENT_TIMEOUT_S)
        log.info("agent: %s", (res.get("reply") or "").replace("\n", " ")[:300])
    except Exception as e:
        detail = e.read()[:200].decode("utf-8", "replace") if isinstance(e, urllib.error.HTTPError) else ""
        kind, fallback = body["fallback"]
        log.warning("agent.ask: %s %s; falling back to %s", e, detail, kind)
        apply(cfg, [(kind, fallback)])


def apply(cfg, calls):
    """Sends the planned calls; a refused service is logged, never fatal."""
    for kind, body in calls:
        if kind == "ask":
            threading.Thread(target=ask_agent, args=(cfg, body), daemon=True).start()
            continue
        try:
            if kind == "event":
                res = call(cfg, "events", {"events": [body]})
                outcome = (res.get("results") or [{}])[0]
                if outcome.get("outcome") == "invalid":
                    log.warning("event %s refused: %s", body["type"], outcome.get("error"))
            elif kind == "notify":
                try:
                    service(cfg, "notify", body)
                except urllib.error.HTTPError as e:
                    # a recipient not linked in People: the owner gets it
                    if e.code == 400 and body["to"] != "owner":
                        service(cfg, "notify", {**body, "to": "owner"})
                    else:
                        raise
            else:
                service(cfg, kind, body)
        except urllib.error.HTTPError as e:
            log.warning("%s: HTTP %s %s", kind, e.code, e.read()[:200].decode("utf-8", "replace"))
        except Exception as e:  # network: logged, the next event tries again
            log.warning("%s: %s", kind, e)


def sse_events(url, token, last_id):
    """Yields (id, event) from the stream until it closes; raises on connection errors."""
    headers = {"Authorization": "Bearer " + token, "Accept": "text/event-stream"}
    if last_id:
        headers["Last-Event-ID"] = last_id
    req = urllib.request.Request(url.rstrip("/") + "/events", headers=headers)
    # the server sends a ping every 20 s: 60 s of silence means a dead connection
    with urllib.request.urlopen(req, timeout=60) as res:
        ev_id, data = None, []
        for raw in res:
            if stopping.is_set():
                return
            line = raw.decode("utf-8").rstrip("\r\n")
            if line == "":
                if data:
                    yield ev_id, json.loads("\n".join(data))
                ev_id, data = None, []
            elif line.startswith("id:"):
                ev_id = line[3:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].lstrip())


def run_events(cfg, last):
    delay = 5
    while not stopping.is_set():
        try:
            log.info("events: connecting%s", f" (from {last.value})" if last.value else "")
            for ev_id, event in sse_events(cfg["PERCEZIONE_URL"], cfg["PERCEZIONE_TOKEN"], last.value):
                delay = 5
                apply(cfg, plan(event, cfg))
                if event.get("type") in ("arrived", "left"):
                    poll_now.set()
                if ev_id:
                    last.save(ev_id)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                log.error("events: Percezione refused the token (401): check PERCEZIONE_TOKEN")
                delay = 300
            else:
                log.warning("events: HTTP %s", e.code)
        except Exception as e:
            log.warning("events: %s", e)
        if stopping.wait(delay):
            return
        delay = min(delay * 2, 120)


def run_presence(cfg):
    every = max(30, int(cfg.get("PRESENCE_POLL_S") or 60))
    state = {}
    while not stopping.is_set():
        try:
            reports, state = presence_reports(mcp_tool(cfg, "who_is_where"), state, datetime.now(timezone.utc), cfg)
            apply(cfg, [("presence.report", r) for r in reports])
        except Exception as e:
            log.warning("presence: %s", e)
        poll_now.wait(every)
        poll_now.clear()


def main():
    data = json.loads(sys.stdin.read() or "{}")
    cfg = data.get("_config", data)
    missing = [k for k in ("PERCEZIONE_URL", "PERCEZIONE_TOKEN", "PLUGIN_TOKEN") if not cfg.get(k)]
    if missing:
        log.error("missing settings: %s", ", ".join(missing))
        sys.exit(1)
    last = LastId(os.environ.get("SKILL_STATE_DIR"))
    presence = threading.Thread(target=run_presence, args=(cfg,), daemon=True)
    presence.start()
    run_events(cfg, last)
    presence.join(timeout=5)


if __name__ == "__main__":
    main()
