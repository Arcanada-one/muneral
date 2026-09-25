#!/usr/bin/env python3
"""CanaryPlan/v1 -> CanaryResult/v1 against a live muneral contour (AUP-GRAPH-008 rules C1..C5, A2-330).

Ported from Arcanada-one/scrutator tools/canary_probe.py (A2-311/A2-324/A2-329). The program's own
producer (`tools/graph/deploy_gate.py canary`) is not reachable from here: the vendored
GraphAdmissionBundle carries only what the gate needs. What travels is the DOCUMENT contract, and
every result this writes is readable by the gate's own reader, `canary_evidence.consume`.

    python3 -I scripts/canary/canary_probe.py --plan deploy/canary/<plan>.json --phase post \
        --base-url http://127.0.0.1:3500 --repo . --out <dir>/<name>.json

Route presence is NOT read off a status code. A 401 comes from a guard, a 404 may be the router
saying "no such route" or a handler saying "no such task", and a 405 says the path matched and the
verb did not. Two observations decide instead, neither of which a handler can supply:

  - DECLARATION: the resident process's own routing table, `GET /health/routes`
    (apps/api/src/route-table.controller.ts), read from the Express router that serves every
    request. A route it does not list is `failed` whatever the status. An unreadable table is
    `not_measured` — never evidence either way.
  - NO-MATCH FINGERPRINT (GET/HEAD probes): a 404 is compared with the router's own no-match answer,
    fingerprinted live on the same contour by a GET to an unrouted sibling path. Express's no-match
    body names the requested path, so both bodies are compared with their own path replaced by a
    placeholder. Identical => the router did not match: `failed`.

A 405 is `failed`. A 5xx is `not_measured` (an observation of a fault, not of the route).

WRITES. None. Every request this sends is a GET, unauthenticated and body-less. A route whose verb
is not GET/HEAD is never called: its presence is decided by the declaration alone, recorded as
`evidence_kind: resident_route_table`. The canary therefore holds rule C4 by construction, and a plan
that asks for any other method is refused (MUTATING_PROBE_UNDECLARED) rather than sent.

Secrets: this probe uses none. Response bodies are recorded only as a length and a sha256.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SAFE_METHODS = ("GET", "HEAD")
RANK = {"verified": 0, "not_measured": 1, "failed": 2}
TOOL = "scripts/canary/canary_probe.py"
VERSION = "1.0.0"
UNROUTED_SUFFIX = "/__canary_unrouted__"
PATH_MARK = b"\x00PATH\x00"


class Refusal(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


def fetch(url: str, timeout: float) -> tuple[int | None, bytes]:
    """An unauthenticated body-less GET; a 4xx/5xx is an observation. (None, b"") if it could not run."""
    request = urllib.request.Request(url, method="GET")
    request.add_header("User-Agent", "aup-orchestrator/1.0")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(1 << 20)
    except urllib.error.HTTPError as error:
        return error.code, error.read(65536)
    except Exception:  # noqa: BLE001 — absence of an observation, handled by the caller
        return None, b""


def masked(body: bytes, path: str) -> bytes:
    """The body with the request path replaced, so two no-match answers for different paths compare."""
    return body.replace(path.encode(), PATH_MARK)


class Resident:
    """The resident process's routing table, read once per run.

    `declares(method, path)` is True/False when the table was read, None when it was not."""

    def __init__(self, base_url: str, table_path: str, timeout: float):
        self.url = base_url.rstrip("/") + table_path
        self.timeout = timeout
        self._routes: set[tuple[str, str]] | None = None
        self.observation: dict | None = None

    def routes(self) -> set[tuple[str, str]] | None:
        if self.observation is None:
            status, payload = fetch(self.url, self.timeout)
            self.observation = {"url": self.url, "status": status, "sha256": sha_bytes(payload)}
            try:
                document = json.loads(payload) if status == 200 else None
                rows = document.get("routes") if isinstance(document, dict) else None
                if isinstance(rows, list) and all(
                    isinstance(r, dict) and isinstance(r.get("method"), str) and isinstance(r.get("path"), str)
                    for r in rows
                ):
                    self._routes = {(r["method"].upper(), r["path"]) for r in rows}
                build = document.get("build") if isinstance(document, dict) else None
                self.observation["build"] = build if isinstance(build, dict) else None
            except ValueError:
                self._routes = None
            self.observation["routes"] = None if self._routes is None else len(self._routes)
        return self._routes

    def declares(self, method: str, path: str) -> bool | None:
        routes = self.routes()
        if routes is None:
            return None
        return (method.upper(), path) in routes


def presence(base_url: str, spec: dict, resident: Resident, timeout: float) -> dict:
    """One route-presence probe -> a CanaryResult probe row (outcome, reason, status, evidence)."""
    method = spec["method"].upper()
    template = spec["route"]
    declared = resident.declares(method, template)
    row: dict = {"id": spec["id"], "kind": "http", "route": template, "declared_by_resident_route_table": declared}
    if method not in SAFE_METHODS:
        # Never sent. The declaration is the whole observation; its status is the table's read.
        row.update(method="GET", url=resident.url, status=resident.observation["status"], executed=True,
                   evidence_kind="resident_route_table", declared_method=method, elapsed_ms=0)
        if declared is None:
            row.update(outcome="not_measured", status=None, executed=False,
                       reason=f"{method} {template}: the resident route table could not be read")
        elif declared:
            row.update(outcome="verified", reason=f"{method} {template} is in the resident route table (not called: not a safe verb)")
        else:
            row.update(outcome="failed", reason=f"{method} {template} is NOT in the resident route table: the route is not served")
        return row

    url = base_url.rstrip("/") + spec["path"]
    started = time.time()
    status, payload = fetch(url, timeout)
    row.update(method=method, url=url, status=status, executed=status is not None,
               elapsed_ms=int((time.time() - started) * 1000), evidence_kind="resident_route_table+no_match_fingerprint")
    if status is None:
        row.update(outcome="not_measured", reason="probe could not run: the contour did not answer (rule C3)")
        return row
    row.update(body_sha256=sha_bytes(payload), body_bytes=len(payload))
    if declared is False:
        row.update(outcome="failed", reason=f"{method} {template} is NOT in the resident route table: the route is not served")
        return row
    if status == 405:
        row.update(outcome="failed", reason=f"405: the path matches but {method} is NOT served on it")
        return row
    if 500 <= status < 600:
        row.update(outcome="not_measured", reason=f"status {status}: the contour answered with a fault, not with the route")
        return row
    if status == 404:
        unrouted = spec["path"].rstrip("/") + UNROUTED_SUFFIX
        u_status, u_body = fetch(base_url.rstrip("/") + unrouted, timeout)
        fingerprint = sha_bytes(masked(u_body, unrouted)) if u_status == 404 else None
        row["unrouted_404_sha256"] = fingerprint
        if fingerprint is not None and fingerprint == sha_bytes(masked(payload, spec["path"])):
            row.update(outcome="failed", reason="404 identical to the router's own no-match answer: the route is NOT served")
            return row
        if declared and fingerprint is not None:
            row.update(outcome="verified", reason="404 from the handler (differs from the router's no-match answer) on a declared route")
            return row
        row.update(outcome="not_measured", reason=f"404 not attributable: route table {'unreadable' if declared is None else 'declares it'}, "
                                                  f"no-match fingerprint {'unavailable' if fingerprint is None else 'differs'}")
        return row
    if declared is None:
        row.update(outcome="not_measured", reason=f"status {status}, but the resident route table could not be read: a status alone is not presence")
        return row
    row.update(outcome="verified", reason=f"status {status} (not 404/405/5xx) and {method} {template} is in the resident route table")
    return row


def health(base_url: str, spec: dict, timeout: float) -> tuple[dict, str | None]:
    url = base_url.rstrip("/") + spec["path"]
    status, payload = fetch(url, timeout)
    row = {"id": spec["id"], "kind": "http", "method": "GET", "url": url, "status": status, "executed": status is not None}
    if status is None:
        row.update(outcome="not_measured", reason="probe could not run: the contour did not answer (rule C3)")
        return row, None
    row.update(body_sha256=sha_bytes(payload), body_bytes=len(payload))
    try:
        document = json.loads(payload)
    except ValueError:
        document = None
    if status != 200 or not isinstance(document, dict) or document.get("status") != "ok":
        row.update(outcome="failed", reason=f"status {status}: /health did not answer status ok")
        return row, None
    version = document.get("version")
    build = document.get("build") if isinstance(document.get("build"), dict) else {}
    resident = f"{version}+{build.get('sha')}" if build.get("sha") else version
    row.update(outcome="verified", observed_version=resident, reason=f"status 200, status ok, resident version {resident}")
    return row, resident


def subject_of(repo: Path, evidence_path: Path) -> dict:
    """The immutable Git subject of this measurement (DEC-AUP-0040) and its MeasuredGitSource/v1 claim."""
    if git(repo, "status", "--porcelain", "--untracked-files=no"):
        raise Refusal("the working tree is dirty: a canary measures a commit, not a working copy")
    commit = git(repo, "rev-parse", "HEAD")
    tree = git(repo, "rev-parse", "HEAD^{tree}")
    claim = {"schema": "MeasuredGitSource/v1", "commit": commit, "tree": tree, "dirty": False,
             "producer": {"tool": TOOL, "version": VERSION}, "captured_at_utc": now_iso()}
    raw = json.dumps(claim, indent=1, sort_keys=True).encode() + b"\n"
    evidence_path.parent.mkdir(parents=True, exist_ok=True)
    evidence_path.write_bytes(raw)
    return {"schema": "GitCanarySubject/v1", "commit": commit, "tree": tree,
            "evidence": {"path": evidence_path.name, "sha256": sha_bytes(raw), "source_field": "commit"}}


def run(plan: dict, base_url: str, phase: str, repo: Path, out: Path, timeout: float,
        environment: str | None = None, card: str = "A2-330") -> dict:
    if plan.get("schema") != "CanaryPlan/v1":
        raise Refusal("plan is not a CanaryPlan/v1")
    for spec in plan["probes"]:
        kind = spec.get("kind", "route_presence")
        if kind not in ("route_presence", "health"):
            raise Refusal(f"probe {spec.get('id')}: unknown kind {kind!r}")
        if kind == "health" and spec.get("method", "GET").upper() != "GET":
            raise Refusal(f"MUTATING_PROBE_UNDECLARED: health probe {spec['id']} must be GET (rule C4)")
        if spec.get("mutating") or "body" in spec or spec.get("auth") not in (None, "none"):
            raise Refusal(f"MUTATING_PROBE_UNDECLARED: probe {spec['id']} asks for a write, a body or a credential; "
                          f"this producer sends none (rule C4)")
    subject = subject_of(repo, out.with_name(out.stem + ".source-evidence.json"))
    resident_table = Resident(base_url, plan.get("route_table_path", "/health/routes"), timeout)
    results, resident = [], None
    for spec in plan["probes"]:
        if spec.get("kind") == "health":
            row, seen = health(base_url, spec, timeout)
            resident = seen or resident
        else:
            resident_table.routes()
            row = presence(base_url, spec, resident_table, timeout)
        results.append(row)

    by_id = {r["id"]: r for r in results}
    rows: dict[str, dict] = {}
    for spec in plan["probes"]:
        result = by_id[spec["id"]]
        for entity in spec.get("entities", []):
            row = rows.setdefault(entity, {"entity": entity, "verdict": result["outcome"],
                                           "reason": f"{spec['id']}: {result['reason']}"[:400], "probe_ids": []})
            row["probe_ids"].append(spec["id"])
            if RANK[result["outcome"]] > RANK[row["verdict"]]:
                row["verdict"] = result["outcome"]
                row["reason"] = f"{spec['id']}: {result['reason']}"[:400]
    for row in rows.values():
        if row["verdict"] == "verified" and len(row["probe_ids"]) > 1:
            row["reason"] = f"all {len(row['probe_ids'])} cited probes verified; first: {row['reason']}"[:400]

    document = {
        "schema": "CanaryResult/v1",
        "card": card,
        "captured_at_utc": now_iso(),
        "producer": {"tool": TOOL, "version": VERSION},
        "model": "none: deterministic HTTP producer",
        "plan": {"id": plan["id"], "path": Path(plan["_path"]).name if plan.get("_path") else plan["id"],
                 "digest": plan.get("_digest")},
        "environment": environment or plan["environment"],
        "base_url": base_url,
        "phase": phase,
        "read_only": True,
        "resident_version": resident,
        "resident_route_table": resident_table.observation,
        "subject": subject,
        "probes": results,
        "entity_verdicts": sorted(rows.values(), key=lambda r: r["entity"]),
        "counters": {k: sum(1 for r in results if r["outcome"] == k) for k in RANK},
        "rules": ["C3 a probe that could not run is not_measured, never verified",
                  "C4 read-only: GET only, no body, no credential; a non-GET route is judged by the resident route table and never called"],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return document


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--plan", required=True)
    parser.add_argument("--base-url")
    parser.add_argument("--phase", choices=("pre", "post"), required=True)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--out", required=True)
    parser.add_argument("--environment", help="override the plan's environment (a local candidate run is not production)")
    parser.add_argument("--card", default="A2-330")
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args(argv)
    raw = Path(args.plan).read_bytes()
    plan = json.loads(raw)
    plan["_path"], plan["_digest"] = args.plan, "sha256:" + sha_bytes(raw)
    try:
        document = run(plan, args.base_url or plan["base_url"], args.phase, Path(args.repo), Path(args.out),
                       args.timeout, environment=args.environment, card=args.card)
    except Refusal as refusal:
        print(f"canary refused: {refusal}", file=sys.stderr)
        return 2
    worst = max((RANK[r["verdict"]] for r in document["entity_verdicts"]), default=0)
    for row in document["entity_verdicts"]:
        print(f"{row['verdict']:12} {row['entity']}  {row['reason'][:120]}")
    print(f"{args.out}: {document['counters']}")
    return {0: 0, 1: 3, 2: 1}[worst]


if __name__ == "__main__":
    raise SystemExit(main())
