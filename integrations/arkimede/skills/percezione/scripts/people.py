#!/usr/bin/env python3
"""The people Percezione knows (its face library), for the plugin's People card: {"people": [{id, name, lastSeen}]}.

id is the name Percezione uses in events and presence; seen ones come first."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from percezione import mcp_tool  # noqa: E402


def people(cfg):
    return [{"id": p["id"], "name": p["name"], "lastSeen": p.get("last_seen")} for p in mcp_tool(cfg, "people")]


def main():
    data = json.loads(sys.stdin.read() or "{}")
    cfg = data.get("_config", data)
    print(json.dumps({"people": people(cfg)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
