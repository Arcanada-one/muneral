#!/usr/bin/env python3
"""Fail-closed qualification for reusing the exact successful PR test job."""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


API = "https://api.github.com"
EXPECTED_RUNNER_LABELS = {"self-hosted", "linux", "ci-general"}
GITHUB_ACTIONS_APP_ID = 15368
# Candidate identity for the complete, independently reviewable CI workflow.
# Reuse remains false until a reviewer recomputes this from the whole workflow.
QUALIFIED_WORKFLOW_SHA256 = "ff47dfb8a60cd1af9de6016a391db63f7f0d0a828a8059662762ff51672f9359"


class GitHubAPI:
    def __init__(self, repository: str, token: str):
        self.repository = repository
        self.token = token

    def get(self, path: str) -> Any:
        request = urllib.request.Request(
            f"{API}/repos/{self.repository}/{path.lstrip('/')}",
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "User-Agent": "muneral-tested-tree/1.0",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.load(response)


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
    if not merge_tree or merge_tree != pr_tree:
        return False

    workflow = api.get("actions/workflows/ci.yml")
    workflow_id = workflow.get("id")
    if not isinstance(workflow_id, int):
        return False
    query = urllib.parse.urlencode({"head_sha": head_sha, "event": "pull_request", "per_page": 100})
    runs_response = api.get(f"actions/runs?{query}")
    runs = runs_response.get("workflow_runs") or []
    matching = [run for run in runs if run.get("workflow_id") == workflow_id]
    if len(matching) != 1:
        return False
    run = matching[0]
    attempt = run.get("run_attempt")
    if not isinstance(attempt, int) or attempt < 1:
        return False
    run_id = run.get("id")
    jobs_response = api.get(f"actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
    jobs = [job for job in jobs_response.get("jobs", []) if job.get("name") == "lint-and-test"]
    if len(jobs) != 1:
        return False
    job = jobs[0]
    check_url = job.get("check_run_url", "")
    prefix = f"{API}/repos/{repository}/check-runs/"
    if not check_url.startswith(prefix):
        return False
    check_id = check_url[len(prefix) :].split("/", 1)[0]
    if not check_id.isdigit():
        return False
    check_run = api.get(f"check-runs/{check_id}")
    suite_id = (check_run.get("check_suite") or {}).get("id")
    if not isinstance(suite_id, int):
        return False
    check_suite = api.get(f"check-suites/{suite_id}")

    workflow_bytes = Path(".github/workflows/ci.yml").read_bytes()
    return reuse_qualified(
        repository,
        push_sha,
        merge_commit,
        prs,
        merge_tree,
        pr_tree,
        workflow_id,
        runs,
        jobs,
        check_run,
        check_suite,
        workflow_bytes,
    )


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
