#!/usr/bin/env python3
"""Build ErrorLedger/v1 from CI step outcomes + report files (BATCH-004).

BATCH-005 owns richer clustering (C01/C02/C03). This script is the explicit seam:
it records step outcomes, attaches report file digests when present, optionally
appends a step summary file, and exits non-zero when any listed check step failed.

Inputs are files/CLI flags only (no process-environment config keys) so the
graph v-config-schema verifier does not see undeclared GITHUB_* / STEP_* keys.
"""
from __future__ import annotations

import argparse
import hashlib
import json
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build ErrorLedger/v1 (BATCH-004 stub)")
    parser.add_argument(
        "--step-outcomes-file",
        required=True,
        help="Text file of id=outcome lines for check steps",
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
    args = parser.parse_args(argv)

    reports_dir = Path("reports")
    reports_dir.mkdir(parents=True, exist_ok=True)

    step_outcomes_raw = Path(args.step_outcomes_file).read_text(encoding="utf-8")
    steps = parse_step_outcomes(step_outcomes_raw)
    failed_steps = [s for s in steps if s["outcome"] == "failure"]

    reports = []
    for rel in REPORT_FILES:
        path = Path(rel)
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

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ledger = {
        "schema": "ErrorLedger/v1",
        "captured_at_utc": now,
        "run": run_meta,
        "steps": steps,
        "reports": reports,
        "clusters": [],
        "collector": {
            "status": "stub",
            "seam_for": "BATCH-005",
            "note": "Clusters left empty; BATCH-005 replaces stub clustering over the same reports/ + steps.",
        },
        "summary": {
            "check_steps": len(steps),
            "failed_steps": len(failed_steps),
            "failed_step_ids": [s["id"] for s in failed_steps],
            "reports_present": sum(1 for r in reports if r["present"]),
            "reports_expected": len(REPORT_FILES),
        },
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(ledger, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    lines = [
        "## ErrorLedger/v1 (BATCH-004 stub)",
        "",
        f"- failed check steps: **{len(failed_steps)}** / {len(steps)}",
        f"- reports present: **{ledger['summary']['reports_present']}** / {ledger['summary']['reports_expected']}",
        f"- artifact path: `{out_path.as_posix()}`",
        f"- collector: stub seam for `{ledger['collector']['seam_for']}`",
        "",
    ]
    if failed_steps:
        lines.append("### Failed steps")
        for step in failed_steps:
            lines.append(f"- `{step['id']}` → `{step['outcome']}`")
        lines.append("")
    lines.append("### Reports")
    for report in reports:
        mark = "present" if report["present"] else "missing"
        lines.append(f"- `{report['path']}` — {mark}")
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
