#!/usr/bin/env python3
"""Generate deploy/canary/muneral-route-presence.plan.json from the relationship graph (A2-330).

One probe per `route:` node the graph builder derives from the NestJS decorators, each citing the
route AND the controller that provides it (`provides_route` edge). A controller's row in the result
is `verified` only when every route it provides is.

    python3 .github/graph-admission/tools/graph/build_graph.py . --rev HEAD --out /path/graph.json
    python3 scripts/canary/gen_plan.py --graph /path/graph.json --environment production \\
        --out deploy/canary/muneral-route-presence.plan.json

`--environment` is required and has no default: the label ends up in every CanaryResult, so a run
against a candidate-local contour must say so ("production" is accepted only when passed explicitly).
A missing or blank value is refused (exit 2, message on stderr) and no plan file is written.

The plan is generated, then reviewed and committed: the deploy runs the committed file, never a
freshly generated one. `tests` in scripts/canary/test_canary_plan.py check it still matches the tree.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

PREFIX = "/api/v1"
UNPREFIXED = ("/health",)  # main.ts setGlobalPrefix exclude list
HTTP_METHODS = ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
PLACEHOLDER = "00000000-0000-4000-8000-000000000000"


def served_path(template: str) -> str:
    if any(template == p or template.startswith(p + "/") for p in UNPREFIXED):
        return template
    return PREFIX + template


def plan_from_graph(graph: dict, environment: str) -> dict:
    if not isinstance(environment, str) or not environment.strip():
        raise ValueError("environment must be a non-empty string; there is no default")
    providers: dict[str, list[str]] = {}
    for edge in graph["edges"]:
        if edge.get("type") == "provides_route":
            providers.setdefault(edge["to"], []).append(edge["from"])
    # The bootstrap and the root module have no route of their own; what the contour can observe of
    # them is that the resident process they build boots and answers. Every route probe below then
    # observes what they registered.
    probes = [{"id": "health-version", "kind": "health", "method": "GET", "path": "/health",
               "entities": ["code_unit:apps/api/src/main.ts", "code_unit:apps/api/src/app.module.ts"],
               "means": "reads the resident version and proves the process bootstrapped by main.ts/app.module.ts answers"}]
    unmeasured: list[dict] = []
    for node in sorted(graph["nodes"], key=lambda n: n["id"]):
        if node.get("type") != "route":
            continue
        method, _, template = node["id"][len("route:"):].partition(" ")
        if method not in HTTP_METHODS:
            # A websocket gateway event (`route:WS join:project`) is not in the HTTP router at all, so
            # this canary cannot observe it. Named, so it stays not_measured instead of vanishing.
            unmeasured.append({"entity": node["id"], "why": "not an HTTP route: a websocket gateway event is outside the HTTP router this canary reads"})
            continue
        route = served_path(template)
        probes.append({
            "id": "route-" + re.sub(r"[^a-z0-9]+", "-", f"{method} {template}".lower()).strip("-"),
            "kind": "route_presence",
            "method": method,
            "route": route,
            "path": re.sub(r":[A-Za-z0-9_]+", PLACEHOLDER, route),
            "entities": [node["id"], *sorted(set(providers.get(node["id"], [])))],
        })
    return {
        "schema": "CanaryPlan/v1",
        "id": "muneral-route-presence",
        "card": "A2-330",
        "environment": environment,
        "base_url": "http://127.0.0.1:3500",
        "route_table_path": "/health/routes",
        "owner": "none: read-only plan (GET only, no body, no credential)",
        "read_only_declared": True,
        "purpose": ("Route presence in the RESIDENT version for every route the graph derives, judged by the "
                    "resident route table and the router's no-match fingerprint, never by a status code "
                    "(admission-gate.v1 decision_exemptions.classes.no_live_contour.live_contours)."),
        "probes": probes,
        "not_measured_by_this_plan": unmeasured,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--graph", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--environment", required=True,
                        help="contour label written into the plan and every CanaryResult (no default; e.g. production, candidate-local)")
    args = parser.parse_args()
    if not args.environment.strip():
        parser.error("--environment must not be blank; there is no default")
    plan = plan_from_graph(json.loads(Path(args.graph).read_text(encoding="utf-8")), args.environment.strip())
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(plan, indent=1) + "\n", encoding="utf-8")
    print(f"{args.out}: {len(plan['probes'])} probes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
