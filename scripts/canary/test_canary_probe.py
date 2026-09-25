"""The canary must be able to go red (A2-330). Each arm here is a mutant the probe has to catch.

    python3 -m unittest discover -s scripts/canary -p 'test_*.py'

A stub HTTP server plays the resident: its route table, its router no-match body (which, like
Express's, names the requested path), guarded routes (401), a handler 404, a 405 and a 5xx. Every
result is also handed to the admission gate's own reader, `canary_evidence.consume`, vendored under
.github/graph-admission, so the document shape is checked by the real consumer (A2-287).
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / ".github/graph-admission/tools/graph"))
import canary_probe  # noqa: E402
import canary_evidence  # noqa: E402

UUID = "00000000-0000-4000-8000-000000000000"


class Stub:
    def __init__(self):
        self.table = [
            {"method": "GET", "path": "/api/v1/tasks/:taskId"},
            {"method": "POST", "path": "/api/v1/tasks"},
            {"method": "GET", "path": "/api/v1/gone-handler/:id"},
        ]
        self.table_status = 200
        self.answers = {  # path -> (status, body)
            f"/api/v1/tasks/{UUID}": (401, b'{"message":"API key required","statusCode":401}'),
            f"/api/v1/gone-handler/{UUID}": (404, b'{"message":"Task not found","statusCode":404}'),
        }
        self.seen: list[tuple[str, str]] = []
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _answer(self):
                stub.seen.append((self.command, self.path))
                if self.path == "/health/routes":
                    body = json.dumps({"schema": "MuneralRouteTable/v1", "routes": stub.table}).encode()
                    status = stub.table_status
                elif self.path == "/health":
                    status, body = 200, b'{"status":"ok","version":"0.4.6","build":{"sha":null}}'
                elif self.path in stub.answers:
                    status, body = stub.answers[self.path]
                else:
                    status = 404
                    body = f"<pre>Cannot {self.command} {self.path}</pre>".encode()
                self.send_response(status)
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = do_DELETE = do_PATCH = _answer

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()


def probe(method, route, entity=None):
    import re
    return {"id": f"p-{method}-{route}".lower().replace("/", "-").replace(":", ""), "kind": "route_presence",
            "method": method, "route": route, "path": re.sub(r":[A-Za-z0-9_]+", UUID, route),
            "entities": [entity or f"route:{method} {route}"]}


class CanaryProbeTest(unittest.TestCase):
    def setUp(self):
        self.stub = Stub()
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        g = ["git", "-C", str(self.repo)]
        subprocess.run([*g, "init", "-q"], check=True)
        (self.repo / "f.txt").write_text("x\n")
        subprocess.run([*g, "add", "."], check=True)
        subprocess.run([*g, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"], check=True)

    def tearDown(self):
        self.stub.close()
        self.tmp.cleanup()

    def run_plan(self, probes):
        plan = {"schema": "CanaryPlan/v1", "id": "t", "environment": "test", "probes": probes}
        out = Path(self.tmp.name) / "out" / "result.json"
        doc = canary_probe.run(plan, self.stub.base, "pre", self.repo, out, 5.0)
        rows, errors, _ = canary_evidence.consume(out, self.repo, "HEAD")
        self.assertEqual(errors, [], "the gate's own reader refused the document")
        return doc, {e: r["verdict"] for e, r in rows.items()}

    def test_guarded_declared_route_is_verified(self):
        _, v = self.run_plan([probe("GET", "/api/v1/tasks/:taskId")])
        self.assertEqual(v, {"route:GET /api/v1/tasks/:taskId": "verified"})

    def test_route_missing_from_resident_table_fails_even_with_401(self):
        self.stub.table = [r for r in self.stub.table if r["path"] != "/api/v1/tasks/:taskId"]
        _, v = self.run_plan([probe("GET", "/api/v1/tasks/:taskId")])
        self.assertEqual(v["route:GET /api/v1/tasks/:taskId"], "failed")

    def test_405_is_a_refusal(self):
        self.stub.answers[f"/api/v1/tasks/{UUID}"] = (405, b"Method Not Allowed")
        _, v = self.run_plan([probe("GET", "/api/v1/tasks/:taskId")])
        self.assertEqual(v["route:GET /api/v1/tasks/:taskId"], "failed")

    def test_router_no_match_404_fails_even_when_declared(self):
        # The table still lists it (stale declaration) but the router does not match the path.
        del self.stub.answers[f"/api/v1/tasks/{UUID}"]
        _, v = self.run_plan([probe("GET", "/api/v1/tasks/:taskId")])
        self.assertEqual(v["route:GET /api/v1/tasks/:taskId"], "failed")

    def test_handler_404_on_declared_route_is_served(self):
        _, v = self.run_plan([probe("GET", "/api/v1/gone-handler/:id")])
        self.assertEqual(v["route:GET /api/v1/gone-handler/:id"], "verified")

    def test_status_alone_is_not_presence(self):
        self.stub.table_status = 404
        _, v = self.run_plan([probe("GET", "/api/v1/tasks/:taskId"), probe("POST", "/api/v1/tasks")])
        self.assertEqual(set(v.values()), {"not_measured"})

    def test_5xx_is_not_measured(self):
        self.stub.answers[f"/api/v1/tasks/{UUID}"] = (500, b"boom")
        _, v = self.run_plan([probe("GET", "/api/v1/tasks/:taskId")])
        self.assertEqual(v["route:GET /api/v1/tasks/:taskId"], "not_measured")

    def test_write_route_is_never_called(self):
        _, v = self.run_plan([probe("POST", "/api/v1/tasks"), probe("DELETE", "/api/v1/tasks/:taskId")])
        self.assertEqual(v["route:POST /api/v1/tasks"], "verified")
        self.assertEqual(v["route:DELETE /api/v1/tasks/:taskId"], "failed")  # verb not in the table
        self.assertEqual({m for m, _ in self.stub.seen}, {"GET"})

    def test_unreachable_contour_is_not_measured(self):
        self.stub.close()
        plan = {"schema": "CanaryPlan/v1", "id": "t", "environment": "test",
                "probes": [probe("GET", "/api/v1/tasks/:taskId")]}
        doc = canary_probe.run(plan, self.stub.base, "pre", self.repo, Path(self.tmp.name) / "o.json", 1.0)
        self.assertEqual(doc["entity_verdicts"][0]["verdict"], "not_measured")
        self.stub = Stub()

    def test_controller_row_is_worst_of_its_routes(self):
        c = "code_unit:apps/api/src/tasks/tasks.controller.ts"
        self.stub.table = [r for r in self.stub.table if r["method"] != "POST"]
        _, v = self.run_plan([probe("GET", "/api/v1/tasks/:taskId", c), probe("POST", "/api/v1/tasks", c)])
        self.assertEqual(v[c], "failed")

    def test_a_write_probe_is_refused(self):
        for bad in ({"mutating": True}, {"body": []}, {"auth": "api_key"}):
            plan = {"schema": "CanaryPlan/v1", "id": "t", "environment": "test",
                    "probes": [{**probe("POST", "/api/v1/tasks"), **bad}]}
            with self.assertRaises(canary_probe.Refusal):
                canary_probe.run(plan, self.stub.base, "pre", self.repo, Path(self.tmp.name) / "o.json", 1.0)
        self.assertEqual(self.stub.seen, [])


class CommittedPlanTest(unittest.TestCase):
    def test_committed_plan_is_read_only_and_names_every_graph_route(self):
        plan = json.loads((ROOT / "deploy/canary/muneral-route-presence.plan.json").read_text())
        self.assertEqual(plan["schema"], "CanaryPlan/v1")
        for spec in plan["probes"]:
            self.assertNotIn("body", spec)
            self.assertFalse(spec.get("mutating"))
            self.assertIn(spec.get("auth"), (None, "none"))
        routes = [e for s in plan["probes"] for e in s["entities"] if e.startswith("route:")]
        routes += [u["entity"] for u in plan["not_measured_by_this_plan"]]
        self.assertEqual(len(routes), len(set(routes)))


if __name__ == "__main__":
    unittest.main()
