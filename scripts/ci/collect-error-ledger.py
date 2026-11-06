#!/usr/bin/env python3
"""Build ErrorLedger/v1 from CI step outcomes + report files (BATCH-004).

BATCH-005 owns richer clustering (C01/C02/C03). This script is the explicit seam:
it records step outcomes, attaches report file digests when present, writes
GITHUB_STEP_SUMMARY, and exits non-zero when any listed check step failed.
"""
from __future__ import annotations

import hashlib
import json
import os
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


def main() -> int:
    reports_dir = Path("reports")
    reports_dir.mkdir(parents=True, exist_ok=True)

    step_outcomes_raw = os.environ.get("STEP_OUTCOMES", "")
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

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ledger = {
        "schema": "ErrorLedger/v1",
        "captured_at_utc": now,
        "run": {
            "repository": os.environ.get("GITHUB_REPOSITORY", ""),
            "run_id": os.environ.get("GITHUB_RUN_ID", ""),
            "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", ""),
            "sha": os.environ.get("GITHUB_SHA", ""),
            "ref": os.environ.get("GITHUB_REF", ""),
            "event_name": os.environ.get("GITHUB_EVENT_NAME", ""),
            "head_ref": os.environ.get("GITHUB_HEAD_REF", ""),
        },
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

    out_path = reports_dir / "error-ledger.json"
    out_path.write_text(json.dumps(ledger, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
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
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as fh:
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
