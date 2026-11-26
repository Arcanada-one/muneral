import hashlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tested_tree as tested_tree_module
from tested_tree import (
    associated_merged_pr_is_exact,
    exact_successful_run,
    reuse_qualified,
)


REPOSITORY = "Arcanada-one/muneral"
PUSH_SHA = "merge-sha"
HEAD_SHA = "pr-head-sha"
WORKFLOW_ID = 260321154
TREE = "4" * 40
OTHER_TREE = "5" * 40
STAMP = "2026-11-26T03:36:12Z"


class ReceiptAPI:
    def __init__(self, conclusions):
        self.responses = {}
        self.runs = []
        self.logs = {}
        self.log_reads = []
        for offset, conclusion in enumerate(conclusions):
            run_id, job_id, suite_id = 100 + offset, 200 + offset, 300 + offset
            run = dict(
                fixture()[2][0], id=run_id, path=tested_tree_module.WORKFLOW_PATH, check_suite_id=suite_id
            )
            steps = [
                {"name": name, "status": "completed", "conclusion": "success",
                 "started_at": STAMP, "completed_at": STAMP}
                for name in sorted(tested_tree_module.FULL_SUITE_STEPS)
            ] if conclusion == "success" else []
            job = dict(
                fixture()[3][0], id=job_id, run_id=run_id, status="completed", head_sha=HEAD_SHA,
                conclusion=conclusion, steps=steps,
                check_run_url=f"{tested_tree_module.API}/repos/{REPOSITORY}/check-runs/{job_id}",
            )
            check = dict(fixture()[4], id=job_id, conclusion=conclusion, check_suite={"id": suite_id})
            self.responses[f"actions/runs/{run_id}/attempts/1/jobs?per_page=100"] = {
                "total_count": 1, "jobs": [job],
            }
            self.responses[f"check-runs/{job_id}"] = check
            self.responses[f"check-suites/{suite_id}"] = {
                "id": suite_id, "head_sha": HEAD_SHA, "status": "completed",
                "app": {"id": tested_tree_module.GITHUB_ACTIONS_APP_ID},
            }
            self.runs.append(run)
            self.logs[job_id] = f"{STAMP} tested-tree reuse= tree={TREE}\n".encode()

    def get(self, path):
        return self.responses[path]

    def get_job_log(self, job_id):
        self.log_reads.append(job_id)
        return self.logs[job_id]

    def qualify(self):
        return tested_tree_module.candidate_receipts_qualified(
            self, REPOSITORY, fixture()[0], WORKFLOW_ID, self.runs, TREE,
        )


class CandidateReceiptTests(unittest.TestCase):
    def test_qualify_requires_complete_run_page_and_pinned_workflow_identity(self):
        api = ReceiptAPI(("skipped", "success"))
        pr, merge, *_ = fixture()
        merge["commit"]["tree"]["sha"] = TREE
        page = {"total_count": len(api.runs), "workflow_runs": api.runs}
        run_path = f"actions/runs?head_sha={HEAD_SHA}&event=pull_request&per_page=100"
        workflow = {"id": WORKFLOW_ID, "path": tested_tree_module.WORKFLOW_PATH}
        api.responses.update({
            f"commits/{PUSH_SHA}": merge, f"commits/{PUSH_SHA}/pulls": [pr],
            f"commits/{HEAD_SHA}": merge, "actions/workflows/ci.yml": workflow, run_path: page,
        })
        self.assertTrue(tested_tree_module.qualify(api, REPOSITORY, PUSH_SHA))
        page["total_count"] += 1
        self.assertFalse(tested_tree_module.qualify(api, REPOSITORY, PUSH_SHA))
        page["total_count"] -= 1
        with patch.object(tested_tree_module, "QUALIFIED_WORKFLOW_SHA256", "0" * 64):
            self.assertFalse(tested_tree_module.qualify(api, REPOSITORY, PUSH_SHA))
        workflow["path"] = ".github/workflows/another.yml"
        self.assertFalse(tested_tree_module.qualify(api, REPOSITORY, PUSH_SHA))

    def test_one_skipped_and_one_full_suite_selects_only_full_suite_in_either_order(self):
        for conclusions, log_id in ((("skipped", "success"), 201), (("success", "skipped"), 200)):
            with self.subTest(order=conclusions):
                api = ReceiptAPI(conclusions)
                api.runs.append({"workflow_id": WORKFLOW_ID + 1, "path": ".github/workflows/unrelated.yml"})
                self.assertTrue(api.qualify())
                self.assertEqual(api.log_reads, [log_id])

    def test_only_skipped_two_eligible_and_duplicate_run_refuse(self):
        self.assertFalse(ReceiptAPI(("skipped",)).qualify())
        self.assertFalse(ReceiptAPI(("success", "success")).qualify())
        api = ReceiptAPI(("success",))
        api.runs *= 2
        self.assertFalse(api.qualify())

    def test_wrong_run_job_check_or_suite_identity_refuses(self):
        cases = (
            ("run", "head_sha", "wrong"), ("run", "event", "push"),
            ("run", "workflow_id", WORKFLOW_ID + 1), ("run", "path", ".github/workflows/other.yml"),
            ("run", "conclusion", "cancelled"), ("run", "run_attempt", None),
            ("job", "run_attempt", 2), ("job", "labels", ["self-hosted", "linux", "deploy-gate"]),
            ("job", "head_sha", "wrong"), ("job", "status", None), ("job", "id", 99),
            ("check", "app", {"id": 1}), ("check", "head_sha", "wrong"),
            ("check", "check_suite", {"id": 301}), ("suite", "id", 301), ("suite", "app", {"id": 1}),
        )
        for where, key, val in cases:
            with self.subTest(where=where, field=key):
                api = ReceiptAPI(("success", "skipped"))
                records = {
                    "run": api.runs[0], "job": api.responses["actions/runs/100/attempts/1/jobs?per_page=100"]["jobs"][0],
                    "check": api.responses["check-runs/200"], "suite": api.responses["check-suites/300"],
                }
                records[where][key] = val
                self.assertFalse(api.qualify())

    def test_wrong_missing_ambiguous_and_out_of_step_tree_proof_refuses(self):
        prefix = f"{STAMP} tested-tree reuse= tree=".encode()
        marker = prefix + TREE.encode() + b"\n"
        for log in (
            prefix + OTHER_TREE.encode(), b"", marker * 2,
            marker.replace(STAMP.encode(), b"2026-11-26T03:36:15Z"),
            marker.replace(b"reuse= ", b"reuse=true "), b" " * (tested_tree_module.MAX_JOB_LOG + 1),
        ):
            with self.subTest(length=len(log)):
                api = ReceiptAPI(("skipped", "success"))
                api.logs[201] = log
                self.assertFalse(api.qualify())

    def test_missing_skipped_or_duplicate_required_step_refuses(self):
        for alteration in ("absent", "skipped", "duplicate"):
            with self.subTest(step=alteration):
                api = ReceiptAPI(("success", "skipped"))
                steps = api.responses["actions/runs/100/attempts/1/jobs?per_page=100"]["jobs"][0]["steps"]
                step = next(step for step in steps if step["name"] == "Jest machine report")
                if alteration == "absent":
                    steps.remove(step)
                elif alteration == "skipped":
                    step["conclusion"] = "skipped"
                else:
                    steps.append(step.copy())
                self.assertFalse(api.qualify())

    def test_missing_or_truncated_jobs_and_ambiguous_job_refuse(self):
        for kind in ("missing", "truncated", "ambiguous"):
            with self.subTest(kind=kind):
                api = ReceiptAPI(("success", "skipped"))
                jobs = api.responses["actions/runs/100/attempts/1/jobs?per_page=100"]
                if kind == "missing":
                    jobs.pop("total_count")
                else:
                    jobs["total_count"] = 2
                    if kind == "ambiguous":
                        jobs["jobs"] *= 2
                self.assertFalse(api.qualify())

    def test_api_error_selects_cold_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "output"
            with patch.dict(os.environ, {
                "GITHUB_OUTPUT": str(output), "GITHUB_REPOSITORY": REPOSITORY,
                "GITHUB_SHA": PUSH_SHA, "GITHUB_TOKEN": "fixture-only",
            }), patch.object(tested_tree_module.GitHubAPI, "get", side_effect=RuntimeError):
                self.assertEqual(tested_tree_module.main(), 0)
            self.assertEqual(output.read_text().splitlines(), [
                "reuse=false", "reason=proof lookup failed: RuntimeError",
            ])

    def test_log_download_does_not_forward_authenticated_request(self):
        location = "https://download.example.invalid/log"
        redirect = HTTPError("https://api.github.com", 302, "Found", {"Location": location}, io.BytesIO())
        opener = Mock()
        opener.open.side_effect = [redirect, io.BytesIO(b"expected log")]
        api = tested_tree_module.GitHubAPI(REPOSITORY, "fixture-only")
        with patch.object(tested_tree_module.urllib.request, "build_opener", return_value=opener):
            self.assertEqual(api.get_job_log(200), b"expected log")
        request = opener.open.call_args_list[0].args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer fixture-only")
        self.assertEqual(opener.open.call_args_list[1].args, (location,))


def fixture():
    pr = {
        "state": "closed",
        "merged_at": "2026-11-05T02:53:06Z",
        "merge_commit_sha": PUSH_SHA,
        "head": {"sha": HEAD_SHA, "repo": {"full_name": REPOSITORY}},
        "base": {"ref": "main", "repo": {"full_name": REPOSITORY}},
    }
    merge = {
        "parents": [{"sha": "main-parent"}, {"sha": HEAD_SHA}],
        "commit": {"tree": {"sha": "same-tree"}},
    }
    runs = [
        {
            "id": 41953243182,
            "run_attempt": 1,
            "workflow_id": WORKFLOW_ID,
            "event": "pull_request",
            "status": "completed",
            "conclusion": "success",
            "head_sha": HEAD_SHA,
            "head_repository": {"full_name": REPOSITORY},
        }
    ]
    jobs = [
        {
            "id": 127001903416,
            "run_id": 41953243182,
            "name": "lint-and-test",
            "run_attempt": 1,
            "conclusion": "success",
            "labels": ["self-hosted", "linux", "ci-general"],
            "check_run_url": f"https://api.github.com/repos/{REPOSITORY}/check-runs/127001903416",
        }
    ]
    check_run = {
        "id": 127001903416,
        "name": "lint-and-test",
        "head_sha": HEAD_SHA,
        "status": "completed",
        "conclusion": "success",
        "app": {"id": 15368},
        "check_suite": {"id": 901},
    }
    check_suite = {"id": 901, "head_sha": HEAD_SHA}
    workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/ci.yml").read_bytes()
    return pr, merge, runs, jobs, check_run, check_suite, workflow


class TestedTreeQualificationTests(unittest.TestCase):
    def test_missing_github_output_exits_successfully_without_granting_reuse(self):
        with tempfile.TemporaryDirectory() as workdir:
            result = subprocess.run(
                [sys.executable, "-I", "-B", str(Path(tested_tree_module.__file__).resolve())],
                cwd=workdir,
                env={},
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(
                result.stderr, "tested-tree: missing GITHUB_OUTPUT; cold path selected\n"
            )
            self.assertNotIn("reuse=true", result.stdout + result.stderr)
            self.assertEqual(list(Path(workdir).iterdir()), [])

    def test_exact_merged_pr_and_successful_pinned_workflow_job_qualify(self):
        pr, merge, runs, jobs, check_run, suite, workflow = fixture()
        self.assertTrue(
            reuse_qualified(
                REPOSITORY,
                PUSH_SHA,
                merge,
                [pr],
                "same-tree",
                "same-tree",
                WORKFLOW_ID,
                runs,
                jobs,
                check_run,
                suite,
                workflow,
            )
        )

    def test_complete_workflow_bytes_match_fixed_identity(self):
        *_, workflow = fixture()
        self.assertEqual(hashlib.sha256(workflow).hexdigest(), tested_tree_module.QUALIFIED_WORKFLOW_SHA256)
        self.assertTrue(tested_tree_module.runtime_inputs_qualified(workflow))

    def test_one_byte_workflow_change_refuses(self):
        *_, workflow = fixture()
        replacement = b" " if workflow[-1:] != b" " else b"\n"
        changed = workflow[:-1] + replacement
        self.assertEqual(len(changed), len(workflow))
        self.assertEqual(sum(left != right for left, right in zip(workflow, changed)), 1)
        self.assertFalse(tested_tree_module.runtime_inputs_qualified(changed))

    def test_comment_unrelated_job_malformed_and_missing_workflows_refuse(self):
        *_, workflow = fixture()
        mutations = (
            workflow + b"\n# runs-on: [self-hosted, linux, ci-general]\n# node-version: 26.13.0\n",
            workflow.replace(
                b"  notify-deploy-failure:\n",
                b"  unrelated-decoy:\n    runs-on: [self-hosted, linux, ci-general]\n"
                b"    steps:\n      - run: echo 'node-version: 26.13.0'\n"
                b"  notify-deploy-failure:\n",
                1,
            ),
            b"jobs: [malformed",
            b"",
        )
        for changed in mutations:
            with self.subTest(suffix=changed[-48:]):
                self.assertFalse(tested_tree_module.runtime_inputs_qualified(changed))

    def test_changed_effective_fields_refuse_even_with_old_value_decoys(self):
        *_, workflow = fixture()
        mutations = (
            (b"node-version: 26.13.0", b"node-version: 25.1.0"),
            (b"image: postgres:16", b"image: postgres:17"),
            (
                b"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
                b"actions/setup-node@main",
            ),
            (
                b"run: python3 -I scripts/ci/tested_tree.py",
                b"run: python3 -I scripts/ci/other-verifier.py",
            ),
            (b"VAULT_ADDR: ${{ vars.VAULT_ADDR }}", b"VAULT_ADDR: https://other.invalid"),
            (
                b"if: github.ref == 'refs/heads/main' && github.event_name == 'push'",
                b"if: github.ref == 'refs/heads/release' && github.event_name == 'push'",
            ),
        )
        for old, new in mutations:
            with self.subTest(field=old):
                self.assertIn(old, workflow)
                changed = workflow.replace(old, new, 1) + b"\n# old-value decoy: " + old + b"\n"
                self.assertFalse(tested_tree_module.runtime_inputs_qualified(changed))

    def test_changed_identity_operand_refuses_candidate_workflow(self):
        *_, workflow = fixture()
        original = tested_tree_module.QUALIFIED_WORKFLOW_SHA256
        try:
            tested_tree_module.QUALIFIED_WORKFLOW_SHA256 = "0" * 64
            self.assertFalse(tested_tree_module.runtime_inputs_qualified(workflow))
        finally:
            tested_tree_module.QUALIFIED_WORKFLOW_SHA256 = original

    def test_unexpected_input_type_refuses(self):
        *_, workflow = fixture()
        self.assertFalse(tested_tree_module.runtime_inputs_qualified(workflow.decode("utf-8")))

    def test_missing_or_ambiguous_pr_never_qualifies(self):
        pr, merge, runs, jobs, check_run, suite, workflow = fixture()
        self.assertIsNone(associated_merged_pr_is_exact(REPOSITORY, PUSH_SHA, merge, []))
        self.assertFalse(
            reuse_qualified(
                REPOSITORY, PUSH_SHA, merge, [pr, pr], "same-tree", "same-tree",
                WORKFLOW_ID, runs, jobs, check_run, suite, workflow
            )
        )

    def test_foreign_repo_wrong_base_or_merge_sha_refuses(self):
        pr, merge, *_ = fixture()
        cases = (
            dict(pr, base={"ref": "release", "repo": {"full_name": REPOSITORY}}),
            dict(pr, head={"sha": HEAD_SHA, "repo": {"full_name": "fork/muneral"}}),
        )
        for altered in cases:
            self.assertIsNone(associated_merged_pr_is_exact(REPOSITORY, PUSH_SHA, merge, [altered]))
        self.assertIsNone(associated_merged_pr_is_exact(REPOSITORY, "other-sha", merge, [pr]))

    def test_different_tree_or_merge_shape_refuses(self):
        pr, merge, runs, jobs, check_run, suite, workflow = fixture()
        bad_merge = dict(merge, parents=[{"sha": "only-one-parent"}])
        for merge_commit, pr_tree in ((merge, "changed-tree"), (bad_merge, "same-tree")):
            self.assertFalse(
                reuse_qualified(
                    REPOSITORY, PUSH_SHA, merge_commit, [pr], "same-tree", pr_tree,
                    WORKFLOW_ID, runs, jobs, check_run, suite, workflow
                )
            )

    def test_pr_head_absent_from_two_nonempty_merge_parents_refuses(self):
        pr, merge, runs, jobs, check_run, suite, workflow = fixture()
        bad_merge = dict(merge, parents=[{"sha": "main-parent"}, {"sha": "other-parent"}])
        self.assertFalse(
            reuse_qualified(
                REPOSITORY, PUSH_SHA, bad_merge, [pr], "same-tree", "same-tree",
                WORKFLOW_ID, runs, jobs, check_run, suite, workflow
            )
        )

    def test_wrong_workflow_run_attempt_job_or_check_identity_refuses(self):
        pr, _, runs, jobs, check_run, suite, _ = fixture()
        cases = []
        for path, value in (
            (("run", "workflow_id"), WORKFLOW_ID + 1),
            (("run", "event"), "push"),
            (("run", "head_sha"), "other-sha"),
            (("run", "head_repository"), {"full_name": "fork/muneral"}),
            (("job", "run_id"), 41953243183),
            (("job", "run_attempt"), 2),
            (("job", "labels"), ["self-hosted", "linux", "deploy-gate"]),
            (("job", "conclusion"), "failure"),
            (("check", "name"), "other-job"),
            (("check", "app"), {"id": 1}),
            (("check", "head_sha"), "other-sha"),
            (("check", "status"), "in_progress"),
            (("check", "conclusion"), "failure"),
            (("suite", "id"), 900),
            (("suite", "head_sha"), "other-sha"),
        ):
            run_copy = dict(runs[0])
            job_copy = dict(jobs[0])
            check_copy = dict(check_run)
            suite_copy = dict(suite)
            target, key = path
            selected = {"run": run_copy, "job": job_copy, "check": check_copy, "suite": suite_copy}[target]
            selected[key] = value
            cases.append((run_copy, job_copy, check_copy, suite_copy))
        for run, job, check, check_suite in cases:
            self.assertFalse(exact_successful_run(REPOSITORY, pr, WORKFLOW_ID, [run], [job], check, check_suite))
        self.assertFalse(exact_successful_run(REPOSITORY, pr, WORKFLOW_ID, runs + runs, jobs, check_run, suite))

    def test_failed_or_unknown_github_proof_never_qualifies(self):
        pr, _, runs, jobs, check_run, suite, _ = fixture()
        for altered in (dict(runs[0], conclusion="failure"), dict(runs[0], status="in_progress")):
            self.assertFalse(exact_successful_run(REPOSITORY, pr, WORKFLOW_ID, [altered], jobs, check_run, suite))
        self.assertFalse(exact_successful_run(REPOSITORY, pr, WORKFLOW_ID, runs, [], check_run, suite))

    def test_deploy_readiness_requires_reuse_or_cold_success_and_every_gate(self):
        def readiness(reuse, lint, gates, tested_tree_result="success"):
            if reuse == "true":
                test_path = lint == "success"
            else:
                test_path = lint == "success"
            return (
                tested_tree_result == "success"
                and gates == {"secrets": "success", "network": "success", "preflight": "success"}
                and test_path
            )

        all_green = {"secrets": "success", "network": "success", "preflight": "success"}
        self.assertTrue(readiness("true", "success", all_green))
        self.assertFalse(readiness("true", "failure", all_green))
        self.assertTrue(readiness("false", "success", all_green))
        self.assertTrue(readiness("unknown", "success", all_green))
        self.assertFalse(readiness("unknown", "failure", all_green))
        self.assertFalse(readiness("false", "skipped", all_green))
        self.assertFalse(readiness("true", "success", all_green, tested_tree_result="failure"))
        self.assertFalse(readiness("false", "success", all_green, tested_tree_result="cancelled"))
        for gate in all_green:
            for result in ("failure", "cancelled", "skipped"):
                self.assertFalse(readiness("true", "success", dict(all_green, **{gate: result})))
                self.assertFalse(readiness("false", "success", dict(all_green, **{gate: result})))
        self.assertFalse(readiness("true", "success", {"secrets": "success", "network": "success"}))


if __name__ == "__main__":
    unittest.main()
