"""Tests of the plugin's daemon: python3 -m unittest discover -s integrations/arkimede/tests"""
import json
import os
import sys
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "skills", "percezione", "scripts"))
import bridge  # noqa: E402
import people  # noqa: E402
from mapping import plan, presence_reports  # noqa: E402

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
SETTINGS = {"OUTDOOR_PLACES": "outdoor", "LATE_AFTER_S": "120"}


def event(type_, place="living_room", person="Alice", reactions=(), age_s=5, **extra):
    return {
        "event_id": f"{type_}-1",
        "schema_version": 3,
        "ts": (NOW - timedelta(seconds=age_s)).isoformat().replace("+00:00", "Z"),
        "type": type_,
        "camera": "front_right" if place == "outdoor" else place,
        "place": place,
        "person": {"name": person, "confidence": 0.93, "source": "face"} if person else None,
        "text": f"{person or 'Unknown person'}: {type_}",
        "reactions": list(reactions),
        "importance": "normal",
        "media": {"frigate_ids": []},
        **extra,
    }


class PlanTest(unittest.TestCase):
    def test_plugin_event_always_reactions_from_rules(self):
        """every fresh event is a plugin event; memory, notification and voice only from the rules / sempre un evento del plugin; memoria, notifica e voce solo dalle regole"""
        calls = plan(event("arrived"), SETTINGS, NOW)
        self.assertEqual([k for k, _ in calls], ["event"])
        self.assertEqual(calls[0][1]["type"], "person.arrived")
        self.assertEqual(calls[0][1]["data"]["person"], "Alice")

        rules = [{"react": "notify", "to": "family", "urgent": True, "snapshot": True, "rules": ["Night at the entrance"]}, {"react": "memory", "importance": "low"}, {"react": "announce"}]
        calls = dict(plan(event("approach", place="outdoor", person=None, reactions=rules, zone="entrance"), SETTINGS, NOW))
        self.assertEqual(calls["event"]["type"], "entrance.approach")
        self.assertEqual(calls["event"]["data"]["zone"], "entrance")
        self.assertNotIn("notify", calls)
        self.assertEqual(calls["perceive"]["keepDays"], 7)
        self.assertNotIn("people", calls["perceive"])
        self.assertNotIn("say", calls)

    def test_external_event(self):
        """an external event (the doorbell) carries everyone recognized / un evento esterno (il campanello) porta tutti i riconosciuti"""
        e = event("external", place="entrance", value={"from": None, "to": "ring"}, people=[{"name": "Alice", "confidence": 0.9, "source": "face"}, {"name": "Bob", "confidence": 0.95, "source": "face"}], unrecognized=1)
        data = dict(plan(e, SETTINGS, NOW))["event"]
        self.assertEqual(data["type"], "external.event")
        self.assertEqual((data["data"]["to"], data["data"]["people"], data["data"]["unrecognized"]), ("ring", ["Alice", "Bob"], 1))

    def test_announcement_goes_to_the_agent(self):
        """an announcement asks the agent, which speaks the people's language; the English sentence only as a fallback / un annuncio chiede all'agente, che parla la lingua di chi c'è; la frase inglese solo di riserva"""
        rules = [{"react": "notify", "to": "family"}, {"react": "announce", "to": "kitchen", "rules": ["door"]}]
        asks = [b for k, b in plan(event("approach", place="outdoor", person=None, reactions=rules), SETTINGS, NOW) if k == "ask"]
        self.assertEqual([a["ask"]["conversation"] for a in asks], ["notifications", "announcements"])
        say = asks[1]
        for part in ("announce something by voice", "Say it out loud in kitchen", "in the language of the people there", "Rule: door"):
            self.assertIn(part, say["ask"]["text"])
        self.assertEqual(say["fallback"], ("say", {"text": "Unknown person: approach", "place": "kitchen"}))

    def test_notification_goes_to_the_agent(self):
        """a notification asks the agent, the owner only as a fallback / una notifica chiede all'agente, il proprietario solo di riserva"""
        rules = [{"react": "notify", "to": "family", "urgent": True, "snapshot": True, "rules": ["Night at the entrance"]}]
        ask = dict(plan(event("approach", place="outdoor", person=None, reactions=rules), SETTINGS, NOW))["ask"]
        self.assertEqual(ask["ask"]["from"], {"id": "percezione", "name": "Percezione"})
        self.assertEqual(ask["ask"]["conversation"], "notifications")
        text = ask["ask"]["text"]
        for part in ("Notify: the household", "Urgent: yes", "Rule: Night at the entrance", "Who: not recognized", "camera_snapshot of camera front_right"):
            self.assertIn(part, text)
        self.assertEqual(ask["fallback"][0], "notify")
        self.assertEqual(ask["fallback"][1]["to"], "owner")
        self.assertIn("urgent", ask["fallback"][1]["title"])
        ask = dict(plan(event("arrived", reactions=[{"react": "notify", "to": "Bob"}]), {**SETTINGS, "ASK_AS": "robot"}, NOW))["ask"]
        self.assertEqual(ask["ask"]["from"]["id"], "robot")
        self.assertIn("Notify: Bob", ask["ask"]["text"])
        self.assertIn("Who: Alice", ask["ask"]["text"])
        self.assertNotIn("camera_snapshot", ask["ask"]["text"])

    def test_recognized_person_in_memory(self):
        """the recognized person in the memory / la persona riconosciuta nel ricordo"""
        calls = dict(plan(event("passage", place="outdoor", reactions=[{"react": "memory"}]), SETTINGS, NOW))
        self.assertEqual(calls["perceive"]["people"], [{"id": "Alice", "confidence": 0.93}])
        self.assertNotIn("keepDays", calls["perceive"])

    def test_late_event_only_memory(self):
        """a replayed old event reaches only the memory / un evento vecchio, ripreso, arriva solo alla memoria"""
        rules = [{"react": "notify", "to": "family"}, {"react": "memory"}, {"react": "announce"}]
        calls = plan(event("approach", reactions=rules, age_s=3600), SETTINGS, NOW)
        self.assertEqual([k for k, _ in calls], ["perceive"])
        self.assertTrue(calls[0][1]["at"].startswith("2026-11-11T11:00"))

    def test_unknown_types_ignored(self):
        """other schemas and types are ignored / altri schemi e tipi ignorati"""
        self.assertEqual(plan({**event("arrived"), "schema_version": 2}, SETTINGS, NOW), [])
        self.assertEqual(plan(event("new_type"), SETTINGS, NOW), [])


class PresenceTest(unittest.TestCase):
    def snapshot(self, *people, someone=()):
        return {
            "in_view": [{"name": n, "place": p, "face_confidence": 0.9} for n, p in people],
            "unrecognized_in_view": [{"camera": p, "place": p, "people": c} for p, c in someone],
        }

    def test_report_renew_move_and_leave(self):
        """reported once, renewed, followed to another room, then left / segnalata, rinnovata, seguita in un'altra stanza, poi uscita"""
        r, st = presence_reports(self.snapshot(("Alice", "living_room"), ("Dave", "outdoor")), {}, NOW, SETTINGS)
        self.assertEqual(r, [{"place": "living_room", "people": [{"id": "Alice", "confidence": 0.9}], "ttlSeconds": 600}])
        r, st = presence_reports(self.snapshot(("Alice", "living_room")), st, NOW + timedelta(seconds=60), SETTINGS)
        self.assertEqual(r, [])
        r, st = presence_reports(self.snapshot(("Alice", "living_room")), st, NOW + timedelta(seconds=300), SETTINGS)
        self.assertEqual(len(r), 1)
        r, st = presence_reports(self.snapshot(("Alice", "attic")), st, NOW + timedelta(seconds=320), SETTINGS)
        self.assertEqual(sorted((x["place"], x.get("left", False)) for x in r), [("attic", False), ("living_room", True)])
        r, st = presence_reports(self.snapshot(), st, NOW + timedelta(seconds=380), SETTINGS)
        self.assertEqual(r, [{"place": "attic", "people": [{"id": "Alice"}], "left": True}])
        self.assertEqual(st, {})

    def test_someone(self):
        """unrecognized people as someone, never outdoors / i non riconosciuti come someone, mai all'esterno"""
        r, st = presence_reports(self.snapshot(someone=[("living_room", 2), ("outdoor", 1)]), {}, NOW, SETTINGS)
        self.assertEqual(r, [{"place": "living_room", "someone": 2, "ttlSeconds": 120}])
        r, st = presence_reports(self.snapshot(someone=[("living_room", 2)]), st, NOW + timedelta(seconds=30), SETTINGS)
        self.assertEqual(r, [])
        r, st = presence_reports(self.snapshot(someone=[("living_room", 1)]), st, NOW + timedelta(seconds=40), SETTINGS)
        self.assertEqual(r, [{"place": "living_room", "someone": 1, "ttlSeconds": 120}])


class SseTest(unittest.TestCase):
    def test_reads_frames_and_sends_last_id(self):
        """reads the SSE frames and resumes from the last id / legge i frame SSE e riprende dall'ultimo id"""
        seen = {}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen["auth"] = self.headers.get("Authorization")
                seen["last"] = self.headers.get("Last-Event-ID")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                body = "retry: 5000\n\n: ping\n\n"
                for i in ("e1", "e2"):
                    body += f"id: {i}\nevent: perception\ndata: {json.dumps(event('arrived') | {'event_id': i})}\n\n"
                self.wfile.write(body.encode())

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}"
        got = list(bridge.sse_events(url, "pcz_x", "e0"))
        self.assertEqual([i for i, _ in got], ["e1", "e2"])
        self.assertEqual(got[1][1]["event_id"], "e2")
        self.assertEqual(seen, {"auth": "Bearer pcz_x", "last": "e0"})

    def test_last_id_on_disk(self):
        """the last id survives a restart / l'ultimo id sopravvive a un riavvio"""
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            bridge.LastId(d).save("abc")
            self.assertEqual(bridge.LastId(d).value, "abc")
            self.assertIsNone(bridge.LastId(None).value)


class AskTest(unittest.TestCase):
    def test_agent_refused_owner_notified(self):
        """agent.ask refused: the owner gets a plain notification / agent.ask rifiutato: il proprietario riceve una notifica semplice"""
        paths = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                paths.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                denied = self.path.endswith("agent.ask")
                body = json.dumps({"error": "denied"} if denied else {"ok": True}).encode()
                self.send_response(403 if denied else 200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        os.environ["BACKEND_INTERNAL_URL"] = f"http://127.0.0.1:{server.server_address[1]}"
        self.addCleanup(os.environ.pop, "BACKEND_INTERNAL_URL")
        ask = dict(plan(event("arrived", reactions=[{"react": "notify", "to": "family"}]), SETTINGS, NOW))["ask"]
        with self.assertLogs("percezione", "WARNING"):
            bridge.ask_agent({"PLUGIN_TOKEN": "t"}, ask)
        self.assertEqual([p for p, _ in paths], ["/internal/plugins/services/agent.ask", "/internal/plugins/services/notify"])
        self.assertEqual(paths[1][1]["to"], "owner")


class PeopleTest(unittest.TestCase):
    def test_people_from_mcp(self):
        """the People card's list comes from Percezione's people tool / l'elenco della card Persone viene dal tool people di Percezione"""
        seen = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                seen["auth"] = self.headers.get("Authorization")
                seen["call"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["params"]
                tool = [{"id": "Alice", "name": "Alice", "last_seen": "2026-11-11T10:00:00+01:00"}, {"id": "Carol_Jones", "name": "Carol Jones", "last_seen": None}]
                body = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": json.dumps(tool)}]}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        cfg = {"PERCEZIONE_URL": f"http://127.0.0.1:{server.server_address[1]}", "PERCEZIONE_TOKEN": "pcz_x"}
        self.assertEqual(
            people.people(cfg),
            [{"id": "Alice", "name": "Alice", "lastSeen": "2026-11-11T10:00:00+01:00"}, {"id": "Carol_Jones", "name": "Carol Jones", "lastSeen": None}],
        )
        self.assertEqual(seen, {"auth": "Bearer pcz_x", "call": {"name": "people", "arguments": {}}})


if __name__ == "__main__":
    unittest.main()
