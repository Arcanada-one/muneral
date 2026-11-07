#!/usr/bin/env python3
"""Build ErrorLedger/v1 from CI step outcomes + report files.

BATCH-004 owns the continue-on-error + reports + collect job wiring in ci.yml.
BATCH-005 owns clustering: this script records step outcomes, then shells out to
`scripts/ci/error-ledger.mjs` to fill `clusters` over reports/ (+ optional
graph-admission-result.json and raw --log inputs).

Deploy-on-main is never modified here. Inputs are files/CLI flags only (no
process-environment config keys) so the graph v-config-schema verifier does not
see undeclared GITHUB_* / STEP_* keys.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


REPORT_FILES = (
    "reports/eslint.json",
    "reports/tsc.txt",
    "reports/jest.json",
    "reports/vitest.json",
    "reports/verify-structure.txt",
)


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def parse_step_outcomes(raw: str) -> list[dict]:
    steps: list[dict] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        step_id, outcome = line.split("=", 1)
        step_id = step_id.strip()
        outcome = outcome.strip() or "unknown"
        if not step_id:
            continue
        steps.append({"id": step_id, "outcome": outcome})
    return steps


def run_cluster_collector(
    *,
    reports_dir: Path,
    out_json: Path,
    out_md: Path,
    graph_admission: Path,
    extra_logs: list[Path],
    repo_root: Path,
) -> dict:
    """Invoke error-ledger.mjs; return parsed ledger (clusters + summary)."""
    script = repo_root / "scripts" / "ci" / "error-ledger.mjs"
    cmd = [
        "node",
        str(script),
        "--reports-dir",
        str(reports_dir),
        "--out",
        str(out_json),
        "--md",
        str(out_md),
    ]
    if graph_admission.is_file():
        cmd.extend(["--graph-admission", str(graph_admission)])
    for log in extra_logs:
        if log.is_file():
            cmd.extend(["--log", str(log)])
    receipts = repo_root / "receipts" / "graph"
    if receipts.is_dir():
        cmd.extend(["--receipts-dir", str(receipts)])
    proc = subprocess.run(cmd, cwd=str(repo_root), capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout or "")
        sys.stderr.write(proc.stderr or "")
        raise SystemExit(f"error-ledger.mjs failed with rc={proc.returncode}")
    if proc.stdout:
        sys.stdout.write(proc.stdout)
    return json.loads(out_json.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build ErrorLedger/v1 (BATCH-004 collect + BATCH-005 clusters)")
    parser.add_argument(
        "--step-outcomes-file",
        default="",
        help="Text file of id=outcome lines for check steps (optional for local cluster-only runs)",
    )
    parser.add_argument(
        "--run-meta-file",
        default="",
        help="Optional JSON file with run metadata (repository/run_id/sha/...)",
    )
    parser.add_argument(
        "--summary-file",
        default="",
        help="Optional path to append the human step summary (e.g. GITHUB_STEP_SUMMARY path)",
    )
    parser.add_argument(
        "--out",
        default="reports/error-ledger.json",
        help="Output ErrorLedger path",
    )
    parser.add_argument(
        "--md",
        default="reports/error-ledger.md",
        help="Output ErrorLedger markdown path",
    )
    parser.add_argument(
        "--reports-dir",
        default="reports",
        help="BATCH-004 reports directory",
    )
    parser.add_argument(
        "--graph-admission",
        default="graph-admission-result.json",
        help="Optional graph-admission-result.json",
    )
    parser.add_argument(
        "--log",
        action="append",
        default=[],
        help="Optional raw CI log (repeatable)",
    )
    parser.add_argument(
        "--repo-root",
        default=".",
        help="Repository root (default: cwd)",
    )
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    reports_dir = (repo_root / args.reports_dir).resolve()
    reports_dir.mkdir(parents=True, exist_ok=True)

    steps: list[dict] = []
    if args.step_outcomes_file:
        step_outcomes_raw = Path(args.step_outcomes_file).read_text(encoding="utf-8")
        steps = parse_step_outcomes(step_outcomes_raw)
    failed_steps = [s for s in steps if s["outcome"] == "failure"]

    reports = []
    for rel in REPORT_FILES:
        path = repo_root / rel
        digest = sha256_file(path)
        reports.append(
            {
                "path": rel,
                "present": digest is not None,
                "sha256": digest,
                "bytes": path.stat().st_size if path.is_file() else 0,
            }
        )

    run_meta: dict = {}
    if args.run_meta_file:
        raw_meta = Path(args.run_meta_file).read_text(encoding="utf-8").strip()
        if raw_meta:
            try:
                parsed = json.loads(raw_meta)
                if isinstance(parsed, dict):
                    run_meta = parsed
            except json.JSONDecodeError:
                run_meta = {"parse_error": "run-meta-file is not valid JSON"}

    out_path = (repo_root / args.out).resolve()
    md_path = (repo_root / args.md).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    clustered = run_cluster_collector(
        reports_dir=reports_dir,
        out_json=out_path,
        out_md=md_path,
        graph_admission=(repo_root / args.graph_admission).resolve(),
        extra_logs=[(repo_root / p).resolve() for p in args.log],
        repo_root=repo_root,
    )

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ledger = {
        "schema": "ErrorLedger/v1",
        "captured_at_utc": clustered.get("captured_at_utc") or now,
        "run": run_meta,
        "steps": steps,
        "reports": reports,
        "clusters": clustered.get("clusters") or [],
        "collector": {
            "status": "active",
            "seam_for": "BATCH-004+BATCH-005",
            "note": "Step outcomes from collect-error-ledger.py; clusters from error-ledger.mjs.",
            "cluster_collector": clustered.get("collector"),
        },
        "summary": {
            "check_steps": len(steps),
            "failed_steps": len(failed_steps),
            "failed_step_ids": [s["id"] for s in failed_steps],
            "reports_present": sum(1 for r in reports if r["present"]),
            "reports_expected": len(REPORT_FILES),
            "cluster_count": len(clustered.get("clusters") or []),
            "by_class": (clustered.get("summary") or {}).get("by_class"),
        },
    }

    out_path.write_text(json.dumps(ledger, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    # Re-render md is already written by mjs; append step summary section
    md_extra = [
        "",
        "## Collect step outcomes",
        "",
        f"- failed check steps: **{len(failed_steps)}** / {len(steps)}",
        f"- reports present: **{ledger['summary']['reports_present']}** / {ledger['summary']['reports_expected']}",
        f"- clusters: **{ledger['summary']['cluster_count']}**",
        "",
    ]
    if failed_steps:
        md_extra.append("### Failed steps")
        for step in failed_steps:
            md_extra.append(f"- `{step['id']}` → `{step['outcome']}`")
        md_extra.append("")
    with md_path.open("a", encoding="utf-8") as fh:
        fh.write("\n".join(md_extra) + "\n")

    lines = [
        "## ErrorLedger/v1",
        "",
        f"- failed check steps: **{len(failed_steps)}** / {len(steps)}",
        f"- reports present: **{ledger['summary']['reports_present']}** / {ledger['summary']['reports_expected']}",
        f"- clusters: **{ledger['summary']['cluster_count']}**",
        f"- artifact path: `{out_path.as_posix()}`",
        f"- collector: active seam BATCH-004+BATCH-005",
        "",
    ]
    if failed_steps:
        lines.append("### Failed steps")
        for step in failed_steps:
            lines.append(f"- `{step['id']}` → `{step['outcome']}`")
        lines.append("")
    summary_text = "\n".join(lines) + "\n"
    if args.summary_file:
        with open(args.summary_file, "a", encoding="utf-8") as fh:
            fh.write(summary_text)
    else:
        sys.stdout.write(summary_text)

    if failed_steps:
        sys.stderr.write(
            "collect-error-ledger: failing job due to prior check-step failures: "
            + ", ".join(s["id"] for s in failed_steps)
            + "\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
