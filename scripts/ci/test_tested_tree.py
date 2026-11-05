import unittest

from scripts.ci.tested_tree import (
    associated_merged_pr_is_exact,
    exact_successful_run,
    reuse_qualified,
    runtime_inputs_qualified,
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
    workflow = """
    runs-on: [self-hosted, linux, ci-general]
    runs-on: [self-hosted, linux, ci-general]
    uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
    uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
    node-version: 24.22.1
    image: postgres:16
    """
    package = {"packageManager": "pnpm@11.5.2"}
    return pr, merge, runs, jobs, check_run, check_suite, workflow, package


class TestedTreeQualificationTests(unittest.TestCase):
    def test_exact_merged_pr_and_successful_pinned_workflow_job_qualify(self):
        pr, merge, runs, jobs, check_run, suite, workflow, package = fixture()
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
                package,
            )
        )

    def test_missing_or_ambiguous_pr_never_qualifies(self):
        pr, merge, runs, jobs, check_run, suite, workflow, package = fixture()
        self.assertIsNone(associated_merged_pr_is_exact(REPOSITORY, PUSH_SHA, merge, []))
        self.assertFalse(
            reuse_qualified(
                REPOSITORY,
                PUSH_SHA,
                merge,
                [pr, pr],
                "same-tree",
                "same-tree",
                WORKFLOW_ID,
                runs,
                jobs,
                check_run,
                suite,
                workflow,
                package,
            )
        )

    def test_foreign_repo_wrong_base_or_merge_sha_refuses(self):
        pr, merge, *_ = fixture()
        for field, value in (("base", {"ref": "release", "repo": {"full_name": REPOSITORY}}),
                             ("head", {"sha": HEAD_SHA, "repo": {"full_name": "fork/muneral"}})):
            altered = dict(pr, **{field: value})
            self.assertIsNone(associated_merged_pr_is_exact(REPOSITORY, PUSH_SHA, merge, [altered]))
        self.assertIsNone(associated_merged_pr_is_exact(REPOSITORY, "other-sha", merge, [pr]))

    def test_different_tree_or_merge_shape_refuses(self):
        pr, merge, runs, jobs, check_run, suite, workflow, package = fixture()
        bad_merge = dict(merge, parents=[{"sha": "only-one-parent"}])
        for merge_commit, pr_tree in ((merge, "changed-tree"), (bad_merge, "same-tree")):
            self.assertFalse(
                reuse_qualified(
                    REPOSITORY, PUSH_SHA, merge_commit, [pr], "same-tree", pr_tree,
                    WORKFLOW_ID, runs, jobs, check_run, suite, workflow, package
                )
            )

    def test_wrong_workflow_run_attempt_job_or_check_identity_refuses(self):
        pr, _, runs, jobs, check_run, suite, *_ = fixture()
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

    def test_workflow_and_toolchain_inputs_must_be_qualified(self):
        _, _, _, _, _, _, workflow, package = fixture()
        self.assertTrue(runtime_inputs_qualified(workflow, package))
        for changed in (
            workflow.replace("node-version: 24.22.1", "node-version: 22"),
            workflow.replace("image: postgres:16", "image: postgres:latest"),
            workflow.replace("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", "actions/setup-node@main"),
        ):
            self.assertFalse(runtime_inputs_qualified(changed, package))
        self.assertFalse(runtime_inputs_qualified(workflow, {"packageManager": "pnpm@latest"}))

    def test_workflow_failure_and_unknown_do_not_become_reuse(self):
        pr, _, runs, jobs, check_run, suite, *_ = fixture()
        for altered in (
            dict(runs[0], conclusion="failure"),
            dict(runs[0], status="in_progress"),
        ):
            self.assertFalse(exact_successful_run(REPOSITORY, pr, WORKFLOW_ID, [altered], jobs, check_run, suite))
        self.assertFalse(exact_successful_run(REPOSITORY, pr, WORKFLOW_ID, runs, [], check_run, suite))

    def test_deploy_predicate_requires_reuse_or_successful_cold_test_and_all_existing_gates(self):
        def deploy_allowed(reuse, lint, gates):
            return gates == {"secrets": "success", "network": "success", "preflight": "success"} and (
                reuse == "true" or lint == "success"
            )

        good_gates = {"secrets": "success", "network": "success", "preflight": "success"}
        self.assertTrue(deploy_allowed("true", "skipped", good_gates))
        self.assertTrue(deploy_allowed("false", "success", good_gates))
        self.assertFalse(deploy_allowed("false", "failure", good_gates))
        self.assertFalse(deploy_allowed("false", "skipped", good_gates))
        self.assertFalse(deploy_allowed("true", "skipped", dict(good_gates, network="failure")))


if __name__ == "__main__":
    unittest.main()
