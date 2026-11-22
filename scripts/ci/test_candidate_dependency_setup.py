#!/usr/bin/env python3
"""Pure path-classification checks for the fixed candidate setup profiles."""
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from candidate_dependency_setup import API_POLICY, WEB_POLICY, classify_policy


class ClassifierTests(unittest.TestCase):
    def test_api_only_change_uses_api_prisma_policy(self):
        policy, scope, _ = classify_policy([
            "apps/api/src/tasks/task-staleness.service.ts",
            "apps/api/test/tasks/task-staleness.service.spec.ts",
            "docs/how-to/task-staleness.md",
            "receipts/graph/task-staleness.json",
        ])
        self.assertEqual((API_POLICY, "apps/api"), (policy, scope))

    def test_dependency_global_mixed_and_unknown_changes_keep_web_policy(self):
        for paths in (
            ["pnpm-lock.yaml"],
            ["package.json"],
            ["pnpm-workspace.yaml"],
            ["turbo.json"],
            ["apps/api/src/tasks/task.ts", "apps/api/prisma/schema.prisma"],
            ["apps/api/locales/en/messages.json"],
            ["apps/api/src/tasks/task.ts", "apps/web/src/app.tsx"],
            ["unknown/new-source.ts"],
        ):
            with self.subTest(paths=paths):
                policy, scope, files = classify_policy(paths)
                self.assertEqual(WEB_POLICY, policy)
                self.assertEqual("apps/web", scope)
                self.assertIn("apps/web/package.json", files)

    def test_web_only_and_documentation_only_keep_web_profile(self):
        self.assertEqual(WEB_POLICY, classify_policy(["apps/web/src/app.tsx"])[0])
        self.assertEqual(WEB_POLICY, classify_policy(["docs/architecture.md"])[0])
        self.assertEqual(WEB_POLICY, classify_policy([])[0])


if __name__ == "__main__":
    unittest.main()
