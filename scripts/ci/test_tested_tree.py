import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

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

    def test_comment_unrelated_job_malformed_and_missing_workflows_refuse(self):
        *_, workflow = fixture()
        mutations = (
            workflow + b"\n# runs-on: [self-hosted, linux, ci-general]\n# node-version: 24.22.1\n",
            workflow.replace(
                b"  notify-deploy-failure:\n",
                b"  unrelated-decoy:\n    runs-on: [self-hosted, linux, ci-general]\n"
                b"    steps:\n      - run: echo 'node-version: 24.22.1'\n"
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
            (b"node-version: 24.22.1", b"node-version: 25.1.0"),
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
            test_path = (reuse == "true" and lint == "skipped") or (reuse != "true" and lint == "success")
            return (
                tested_tree_result == "success"
                and gates == {"secrets": "success", "network": "success", "preflight": "success"}
                and test_path
            )

        all_green = {"secrets": "success", "network": "success", "preflight": "success"}
        self.assertTrue(readiness("true", "skipped", all_green))
        self.assertTrue(readiness("false", "success", all_green))
        self.assertTrue(readiness("unknown", "success", all_green))
        self.assertFalse(readiness("unknown", "failure", all_green))
        self.assertFalse(readiness("false", "skipped", all_green))
        self.assertFalse(readiness("true", "skipped", all_green, tested_tree_result="failure"))
        self.assertFalse(readiness("false", "success", all_green, tested_tree_result="cancelled"))
        for gate in all_green:
            for result in ("failure", "cancelled", "skipped"):
                self.assertFalse(readiness("true", "skipped", dict(all_green, **{gate: result})))
                self.assertFalse(readiness("false", "success", dict(all_green, **{gate: result})))
        self.assertFalse(readiness("true", "skipped", {"secrets": "success", "network": "success"}))


if __name__ == "__main__":
    unittest.main()
