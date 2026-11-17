"""Calls to Percezione's MCP server, with the token in the plugin's settings."""
import json
import urllib.request


def mcp_tool(cfg, name, arguments=None):
    """The JSON a tool answers (a stateless server takes a bare tools/call)."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments or {}}}).encode()
    req = urllib.request.Request(
        cfg["PERCEZIONE_URL"].rstrip("/") + "/mcp",
        data=body,
        method="POST",
        headers={"Authorization": "Bearer " + cfg["PERCEZIONE_TOKEN"], "Content-Type": "application/json", "Accept": "application/json, text/event-stream"},
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        answer = json.loads(res.read().decode("utf-8"))
    return json.loads(answer["result"]["content"][0]["text"])
