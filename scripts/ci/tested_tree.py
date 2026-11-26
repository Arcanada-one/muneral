#!/usr/bin/env python3
"""Fail-closed qualification for reusing the exact successful PR test job."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


API = "https://api.github.com"
EXPECTED_RUNNER_LABELS = {"self-hosted", "linux", "ci-general"}
GITHUB_ACTIONS_APP_ID = 15368
WORKFLOW_PATH = ".github/workflows/ci.yml"
SUITE_JOB = "lint-and-test"
TREE_STEP = "Confirm tested-tree reuse proof"
FULL_SUITE_STEPS = {
    TREE_STEP, "Install dependencies", "ESLint machine report",
    "TypeScript machine report", "Build", "Apply DB migrations",
    "Jest machine report", "Vitest machine report", "Verify structure machine report",
    "Collect ErrorLedger",
}
MAX_JOB_LOG = 16 * 1024 * 1024
TREE_LOG_LINE = re.compile(
    rb"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})"
    rb"(?:\.[0-9]+)?Z tested-tree reuse= tree=([0-9a-f]{40})"
)
# Candidate identity for the complete, independently reviewable CI workflow.
# Reuse remains false until a reviewer recomputes this from the whole workflow.
QUALIFIED_WORKFLOW_SHA256 = "aded39775129369b537ec31f2a9d8ce252306d04afa9bf3d96b3787d93942996"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


class GitHubAPI:
    def __init__(self, repository: str, token: str):
        self.repository = repository
        self.token = token

    def request(self, path: str) -> urllib.request.Request:
        return urllib.request.Request(
            f"{API}/repos/{self.repository}/{path.lstrip('/')}",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "User-Agent": "muneral-tested-tree/1.0",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
    def get(self, path: str) -> Any:
        with urllib.request.urlopen(self.request(path), timeout=12) as response:
            return json.load(response)

    def get_job_log(self, job_id: int) -> bytes:
        opener = urllib.request.build_opener(NoRedirect)
        try:
            with opener.open(self.request(f"actions/jobs/{job_id}/logs"), timeout=12) as response:
                return response.read(MAX_JOB_LOG + 1)
        except urllib.error.HTTPError as error:
            with error:
                location = error.headers.get("Location", "")
                target = urllib.parse.urlsplit(location)
                if error.code != 302 or target.scheme != "https" or not target.hostname or target.username is not None:
                    raise
        # Do not forward the Actions token to the signed download URL.
        with opener.open(location, timeout=12) as response:
            return response.read(MAX_JOB_LOG + 1)


def runtime_inputs_qualified(workflow_bytes: bytes) -> bool:
    """Qualify only the complete workflow whose fixed digest received review."""
    if not isinstance(workflow_bytes, bytes) or len(QUALIFIED_WORKFLOW_SHA256) != 64:
        return False
    return hashlib.sha256(workflow_bytes).hexdigest() == QUALIFIED_WORKFLOW_SHA256


def associated_merged_pr_is_exact(
    repository: str, push_sha: str, merge_commit: dict[str, Any], prs: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if len(prs) != 1:
        return None
    pr = prs[0]
    head = pr.get("head") or {}
    base = pr.get("base") or {}
    if not (
        pr.get("state") == "closed"
        and pr.get("merged_at")
        and pr.get("merge_commit_sha") == push_sha
        and (base.get("repo") or {}).get("full_name") == repository
        and base.get("ref") == "main"
        and (head.get("repo") or {}).get("full_name") == repository
        and head.get("sha")
    ):
        return None
    parents = merge_commit.get("parents") or []
    if len(parents) != 2 or not parents[0].get("sha") or not parents[1].get("sha") or parents[1]["sha"] != head["sha"]:
        return None
    return pr


def exact_successful_run(
    repository: str,
    pr: dict[str, Any],
    workflow_id: int,
    runs: list[dict[str, Any]],
    jobs: list[dict[str, Any]],
    check_run: dict[str, Any],
    check_suite: dict[str, Any],
) -> bool:
    head_sha = pr["head"]["sha"]
    qualifying_runs = [
        run
        for run in runs
        if run.get("workflow_id") == workflow_id and run.get("event") == "pull_request"
    ]
    if len(qualifying_runs) != 1:
        return False
    run = qualifying_runs[0]
    attempt = run.get("run_attempt")
    if not (
        run.get("status") == "completed"
        and run.get("conclusion") == "success"
        and run.get("head_sha") == head_sha
        and run.get("head_repository", {}).get("full_name") == repository
        and isinstance(attempt, int)
        and attempt > 0
    ):
        return False
    test_jobs = [job for job in jobs if job.get("name") == "lint-and-test"]
    if len(test_jobs) != 1:
        return False
    job = test_jobs[0]
    check_run_url = job.get("check_run_url", "")
    check_id = check_run_url.rstrip("/").rsplit("/", 1)[-1]
    labels = set(job.get("labels") or [])
    if not (
        job.get("conclusion") == "success"
        and job.get("run_id") == run.get("id")
        and job.get("run_attempt") == attempt
        and labels == EXPECTED_RUNNER_LABELS
        and check_id.isdigit()
        and check_run.get("id") == int(check_id)
        and check_run.get("name") == "lint-and-test"
        and check_run.get("head_sha") == head_sha
        and check_run.get("status") == "completed"
        and check_run.get("conclusion") == "success"
        and (check_run.get("app") or {}).get("id") == GITHUB_ACTIONS_APP_ID
        and check_suite.get("id") == (check_run.get("check_suite") or {}).get("id")
        and check_suite.get("head_sha") == head_sha
    ):
        return False
    return True


def reuse_qualified(
    repository: str,
    push_sha: str,
    merge_commit: dict[str, Any],
    prs: list[dict[str, Any]],
    merge_tree: str,
    pr_tree: str,
    workflow_id: int,
    runs: list[dict[str, Any]],
    jobs: list[dict[str, Any]],
    check_run: dict[str, Any],
    check_suite: dict[str, Any],
    workflow_bytes: bytes,
) -> bool:
    pr = associated_merged_pr_is_exact(repository, push_sha, merge_commit, prs)
    return bool(
        pr
        and merge_tree
        and merge_tree == pr_tree
        and runtime_inputs_qualified(workflow_bytes)
        and exact_successful_run(repository, pr, workflow_id, runs, jobs, check_run, check_suite)
    )


def complete_page(response: dict[str, Any], key: str) -> list[dict[str, Any]] | None:
    records = response.get(key)
    count = response.get("total_count")
    if isinstance(records, list) and type(count) is int and count == len(records) < 100:
        return records
    return None


def observed_full_suite_tree(job: dict[str, Any], log: bytes, expected_tree: str) -> bool:
    if len(log) > MAX_JOB_LOG or not re.fullmatch(r"[0-9a-f]{40}", expected_tree):
        return False
    steps = job.get("steps") or []
    for name in FULL_SUITE_STEPS:
        found = [step for step in steps if step.get("name") == name]
        if len(found) != 1 or found[0].get("status") != "completed" or found[0].get("conclusion") != "success":
            return False
    marker = next(step for step in steps if step["name"] == TREE_STEP)
    start = marker.get("started_at")
    end = marker.get("completed_at")
    if not all(isinstance(value, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", value)
               for value in (start, end)):
        return False
    matches = [match for line in log.splitlines() if (match := TREE_LOG_LINE.fullmatch(line))]
    if len(matches) != 1:
        return False
    timestamp, tree = matches[0].groups()
    return tree.decode() == expected_tree and start <= timestamp.decode() + "Z" <= end


def candidate_receipts_qualified(
    api: GitHubAPI, repository: str, pr: dict[str, Any], workflow_id: int,
    runs: list[dict[str, Any]], tree: str,
) -> bool:
    eligible = 0
    seen = set()
    head = pr["head"]["sha"]
    for run in runs:
        if run.get("workflow_id") != workflow_id:
            if not isinstance(run.get("workflow_id"), int) or run.get("path") == WORKFLOW_PATH:
                return False
            continue
        run_id, attempt, suite_id = (run.get(field) for field in ("id", "run_attempt", "check_suite_id"))
        if not (
            all(type(value) is int and value > 0 for value in (run_id, attempt, suite_id))
            and run_id not in seen
            and run.get("path") == WORKFLOW_PATH
            and run.get("event") == "pull_request"
            and run.get("head_sha") == head
            and (run.get("head_repository") or {}).get("full_name") == repository
            and run.get("status") == "completed"
            and run.get("conclusion") == "success"
        ):
            return False
        seen.add(run_id)
        jobs = complete_page(api.get(f"actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100"), "jobs")
        if jobs is None:
            return False
        matching = [job for job in jobs if job.get("name") == SUITE_JOB]
        if len(matching) != 1:
            return False
        job = matching[0]
        job_id = job.get("id")
        if not (
            type(job_id) is int and job_id > 0
            and job.get("run_id") == run_id
            and job.get("run_attempt") == attempt
            and job.get("head_sha") == head
            and job.get("status") == "completed"
            and set(job.get("labels") or []) == EXPECTED_RUNNER_LABELS
            and job.get("check_run_url") == f"{API}/repos/{repository}/check-runs/{job_id}"
        ):
            return False
        check = api.get(f"check-runs/{job_id}")
        suite = api.get(f"check-suites/{suite_id}")
        if not (
            check.get("id") == job_id
            and check.get("name") == SUITE_JOB
            and check.get("status") == "completed"
            and check.get("head_sha") == head
            and check.get("conclusion") == job.get("conclusion")
            and (check.get("app") or {}).get("id") == GITHUB_ACTIONS_APP_ID
            and (check.get("check_suite") or {}).get("id") == suite_id == suite.get("id")
            and suite.get("status") == "completed"
            and suite.get("head_sha") == head
            and (suite.get("app") or {}).get("id") == GITHUB_ACTIONS_APP_ID
        ):
            return False
        if job.get("conclusion") == "skipped" and job.get("steps") == []:
            continue
        if not exact_successful_run(repository, pr, workflow_id, [run], matching, check, suite):
            return False
        if not observed_full_suite_tree(job, api.get_job_log(job_id), tree):
            return False
        eligible += 1
        if eligible > 1:
            return False
    return eligible == 1


def qualify(api: GitHubAPI, repository: str, push_sha: str) -> bool:
    encoded_sha = urllib.parse.quote(push_sha, safe="")
    merge_commit = api.get(f"commits/{encoded_sha}")
    prs = api.get(f"commits/{encoded_sha}/pulls")
    pr = associated_merged_pr_is_exact(repository, push_sha, merge_commit, prs)
    if not pr:
        return False

    head_sha = pr["head"]["sha"]
    merge_tree = (merge_commit.get("commit") or {}).get("tree", {}).get("sha")
    head_commit = api.get(f"commits/{urllib.parse.quote(head_sha, safe='')}")
    pr_tree = (head_commit.get("commit") or {}).get("tree", {}).get("sha")
    if not merge_tree or merge_tree != pr_tree or not runtime_inputs_qualified(Path(WORKFLOW_PATH).read_bytes()):
        return False

    workflow = api.get("actions/workflows/ci.yml")
    workflow_id = workflow.get("id")
    if type(workflow_id) is not int or workflow_id < 1 or workflow.get("path") != WORKFLOW_PATH:
        return False
    query = urllib.parse.urlencode({"head_sha": head_sha, "event": "pull_request", "per_page": 100})
    runs = complete_page(api.get(f"actions/runs?{query}"), "workflow_runs")
    return runs is not None and candidate_receipts_qualified(api, repository, pr, workflow_id, runs, merge_tree)


def main() -> int:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        print("tested-tree: missing GITHUB_OUTPUT; cold path selected", file=sys.stderr)
        return 0
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    push_sha = os.environ.get("GITHUB_SHA", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    reuse = False
    reason = "proof absent or ambiguous"
    try:
        if repository and push_sha and token:
            reuse = qualify(GitHubAPI(repository, token), repository, push_sha)
        else:
            reason = "required GitHub context missing"
    except Exception as error:  # Unknown API/schema errors must select the cold path.
        reason = f"proof lookup failed: {type(error).__name__}"
    with open(output_path, "a", encoding="utf-8") as output:
        output.write(f"reuse={'true' if reuse else 'false'}\n")
        output.write(f"reason={reason if not reuse else 'exact successful PR test qualified'}\n")
    print(f"tested-tree: reuse={'true' if reuse else 'false'} ({reason})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
