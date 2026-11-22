#!/usr/bin/env python3
"""Emit a fixed Muneral candidate dependency setup manifest for the exact PR range."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

API_POLICY = "pnpm-frozen-api-prisma-typecheck/v1"
WEB_POLICY = "pnpm-frozen-web-typecheck/v1"
CALLER_REPOSITORY = "Arcanada-one/muneral"
DEPENDENCY_SETUP_FILES = (
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/web/package.json",
    "packages/types/package.json",
    ".arcana/derived-artefacts.v1.json",
)
LOCKFILES = {
    "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "npm-shrinkwrap.json",
    "Cargo.lock", "poetry.lock", "uv.lock", "bun.lockb", "bun.lock",
}
GLOBAL_ROOT_FILES = {
    "package.json", "nx.json", "turbo.json", "pnpm-workspace.yaml", "lerna.json",
    ".npmrc", ".nvmrc", ".env.example", ".env.schema", ".env.template", "env.schema.json",
}
API_PRISMA_INPUTS = {
    "apps/api/package.json", "apps/api/prisma/schema.prisma", "prisma.config.ts",
}
AUXILIARY_PATHS = (
    "docs/", "receipts/", ".arcana/derived-artefacts.v1.json", "AGENTS.md",
)


class SetupRefused(ValueError):
    """The exact candidate range or a fixed source input cannot be read safely."""


def _is_deployable_fallback(path: str) -> bool:
    parts = PurePosixPath(path).parts
    suffix = PurePosixPath(path).suffix.lower()
    if suffix in {".php", ".css"}:
        return True
    return suffix == ".json" and any(part in {"locale", "locales"} for part in parts[:-1])


def _is_global_fallback(path: str) -> bool:
    name = PurePosixPath(path).name
    is_root = "/" not in path
    return (
        name in LOCKFILES
        or name == "package.json"
        or (is_root and (name in GLOBAL_ROOT_FILES or (name.startswith("tsconfig") and name.endswith(".json"))))
        or path in API_PRISMA_INPUTS
        or _is_deployable_fallback(path)
    )


def classify_policy(changed_paths: list[str]) -> tuple[str, str, tuple[str, ...]]:
    """Use API Prisma setup only for API source-only changes; all other classes keep web setup."""
    paths = sorted(set(changed_paths))
    if not paths:
        return WEB_POLICY, "apps/web", DEPENDENCY_SETUP_FILES
    if any(_is_global_fallback(path) for path in paths):
        return WEB_POLICY, "apps/web", DEPENDENCY_SETUP_FILES

    def auxiliary(path: str) -> bool:
        return any(path == allowed or path.startswith(allowed) for allowed in AUXILIARY_PATHS)

    api = [path for path in paths if path.startswith("apps/api/")]
    sidecars = [path for path in paths if auxiliary(path)]
    if api and len(api) + len(sidecars) == len(paths):
        return API_POLICY, "apps/api", DEPENDENCY_SETUP_FILES
    return WEB_POLICY, "apps/web", DEPENDENCY_SETUP_FILES


def _git(repo: Path, *args: str, binary: bool = False):
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_NO_LAZY_FETCH"] = "1"
    try:
        result = subprocess.run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env, check=False, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SetupRefused("candidate Git binding is unavailable") from exc
    if result.returncode:
        raise SetupRefused("candidate Git binding is unavailable")
    return result.stdout if binary else result.stdout.decode("utf-8").strip()


def build_manifest(repo: Path, base: str, head: str, repository: str) -> dict:
    if repository != CALLER_REPOSITORY:
        raise SetupRefused("candidate repository is unsupported")
    if not re.fullmatch(r"[0-9a-f]{40}", base) or not re.fullmatch(r"[0-9a-f]{40}", head) or base == head:
        raise SetupRefused("candidate range must contain two distinct full commit ids")
    actual_head = _git(repo, "rev-parse", "--verify", "HEAD^{commit}")
    if actual_head != head:
        raise SetupRefused("checkout does not match the candidate head")
    _git(repo, "cat-file", "-e", f"{base}^{{commit}}")
    _git(repo, "merge-base", "--is-ancestor", base, head)
    raw_paths = _git(repo, "diff", "--name-only", "-z", base, head, binary=True)
    changed_paths = [path.decode("utf-8") for path in raw_paths.split(b"\0") if path]
    policy, scope, files = classify_policy(changed_paths)
    manifest = {
        "schema": "CallerDependencySetup/v1",
        "policy": policy,
        "repository": repository,
        "base": base,
        "head": head,
        "working_directory": ".",
        "scope": scope,
        "files": {},
    }
    for relative in files:
        raw = _git(repo, "show", f"{head}:{relative}", binary=True)
        oid = _git(repo, "rev-parse", "--verify", f"{head}:{relative}")
        manifest["files"][relative] = {
            "blob_oid": oid,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
        }
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--repository", required=True)
    args = parser.parse_args(argv)
    try:
        manifest = build_manifest(args.repo, args.base, args.head, args.repository)
    except (OSError, SetupRefused) as exc:
        print(f"CANDIDATE_DEPENDENCY_SETUP_REFUSED: {exc}", file=sys.stderr)
        return 2
    print("manifest=" + json.dumps(manifest, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
