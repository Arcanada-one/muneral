"""gen_plan.py must not invent the contour label (MUN-0083 finding from PR #422).

    python3 -m unittest discover -s scripts/canary -p 'test_*.py'

The plan's `environment` is copied into every CanaryResult, so a candidate-local run must not be
labelled "production" by a hard-coded literal. The tool takes it from `--environment`, has no
default, and writes nothing when it is absent or blank.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
GEN_PLAN = HERE / "gen_plan.py"
GRAPH = {
    "nodes": [{"id": "route:GET /tasks", "type": "route"}],
    "edges": [{"type": "provides_route", "from": "code_unit:apps/api/src/tasks.controller.ts", "to": "route:GET /tasks"}],
}


class GenPlanEnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.graph = Path(self.tmp.name) / "graph.json"
        self.graph.write_text(json.dumps(GRAPH), encoding="utf-8")
        self.out = Path(self.tmp.name) / "plan" / "plan.json"

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, *extra):
        return subprocess.run([sys.executable, "-I", str(GEN_PLAN), "--graph", str(self.graph), "--out", str(self.out), *extra],
                              capture_output=True, text=True, timeout=60)

    def test_missing_environment_is_refused_and_writes_nothing(self):
        result = self.run_tool()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--environment", result.stderr)
        self.assertFalse(self.out.exists())
        self.assertFalse(self.out.parent.exists())

    def test_blank_environment_is_refused_and_writes_nothing(self):
        for blank in ("", "   "):
            result = self.run_tool("--environment", blank)
            self.assertNotEqual(result.returncode, 0, repr(blank))
            self.assertIn("--environment", result.stderr)
            self.assertFalse(self.out.exists())

    def test_explicit_value_is_carried_exactly(self):
        result = self.run_tool("--environment", "candidate-local")
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(plan["environment"], "candidate-local")
        self.assertEqual(plan["schema"], "CanaryPlan/v1")
        self.assertEqual(plan["base_url"], "http://127.0.0.1:3500")

    def test_production_only_when_passed_explicitly(self):
        self.assertNotEqual(self.run_tool().returncode, 0)
        self.assertFalse(self.out.exists())
        result = self.run_tool("--environment", "production")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.out.read_text(encoding="utf-8"))["environment"], "production")


if __name__ == "__main__":
    unittest.main()
