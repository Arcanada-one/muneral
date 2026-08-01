#!/usr/bin/env python3
"""Independent stdlib-only validator for MUN-0022 Assembly v0 fixtures."""

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from datetime import datetime
from pathlib import Path

FIXTURE_EVALUATED_AT = "2026-08-01T12:00:00.000Z"
MAX_DEPTH = 10
MAX_CONTAINER_ENTRIES = 1024
MAX_ENTRIES = 4096
MAX_BYTES = 1024 * 1024
REQUEST_FIELDS = {
    "schemaVersion", "taskId", "causationId", "correlationId", "evaluatedAt",
    "authorityCeiling", "requestedAuthority", "rolePolicy", "candidateSet",
    "evidenceRefs", "deadline", "attemptBudget", "traceFields", "provenance",
}
AUTHORITY_FIELDS = {"tenant", "principal", "purpose", "audience", "scope"}
ROLE_FIELDS = {"policyId", "policyVersion", "roleName"}
CANDIDATE_FIELDS = {"candidates", "sourceDigest", "capturedAt"}
PROVENANCE_FIELDS = {"policyUri", "policyDigest", "issuedAt", "expiresAt"}
EVIDENCE_FIELDS = {"uri", "digest", "contentType", "label"}
TRACE_BLOCKLIST = REQUEST_FIELDS | {
    "providerConfig", "modelParameters", "credentials", "apiKey", "secret",
    "token", "endpoint",
}
CONTENT_TYPES = {
    "text/plain", "text/markdown", "application/json", "application/x-ndjson",
    "image/png", "image/jpeg", "application/pdf",
}
SCOPE_TOKEN = re.compile(r"^[a-z][a-z0-9._:-]{0,63}$")
INSTANT = re.compile(
    r"^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$"
)
_policy_spec = importlib.util.spec_from_file_location(
    "credential_policy_v0_generated",
    Path(__file__).with_name("credential_policy_v0_generated.py"),
)
_policy = importlib.util.module_from_spec(_policy_spec)
_policy_spec.loader.exec_module(_policy)
CREDENTIAL_PATTERNS = [
    (rule_id, re.compile(source, re.I if flags == "i" else 0))
    for rule_id, source, flags in _policy.CREDENTIAL_RULES
]


class CanonicalError(ValueError):
    pass


CanonicalLexicalError = CanonicalError


def canonical_json(value):
    validate_canonical_value(value)
    output = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    if len(output.encode("utf-8")) > MAX_BYTES:
        raise CanonicalError("emitted canonical JSON exceeds byte budget")
    return output


def validate_canonical_value(value, depth=0, budget=None):
    if budget is None:
        budget = {"entries": 0, "bytes": 0}
    if depth > MAX_DEPTH:
        raise CanonicalError("nesting depth exceeds maximum")
    if value is None or isinstance(value, (bool, str)):
        if isinstance(value, str):
            try:
                encoded = value.encode("utf-8", "strict")
            except UnicodeEncodeError as error:
                raise CanonicalError("lone surrogate") from error
            budget["bytes"] += len(encoded)
        check_budget(budget)
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 2 ** 53 - 1:
            raise CanonicalError("unsafe integer")
        return
    if isinstance(value, float):
        raise CanonicalError("floats are outside the canonical domain")
    if isinstance(value, list):
        if len(value) > MAX_CONTAINER_ENTRIES:
            raise CanonicalError("array too large")
        budget["entries"] += len(value)
        check_budget(budget)
        for child in value:
            validate_canonical_value(child, depth + 1, budget)
        return
    if isinstance(value, dict):
        if len(value) > MAX_CONTAINER_ENTRIES or not all(isinstance(key, str) for key in value):
            raise CanonicalError("object too large or has a non-string key")
        budget["entries"] += len(value)
        try:
            budget["bytes"] += sum(len(key.encode("utf-8", "strict")) for key in value)
        except UnicodeEncodeError as error:
            raise CanonicalError("lone surrogate") from error
        check_budget(budget)
        for child in value.values():
            validate_canonical_value(child, depth + 1, budget)
        return
    raise CanonicalError("unsupported canonical value")


def check_budget(budget):
    if budget["entries"] > MAX_ENTRIES or budget["bytes"] > MAX_BYTES:
        raise CanonicalError("canonical resource budget exceeded")


def independently_validate(request):
    try:
        validate_canonical_value(request)
    except CanonicalError as error:
        return "UNSAFE_NESTING" if "depth" in str(error) else (
            "UNSAFE_SIZE" if "budget" in str(error) or "large" in str(error) else "AMBIGUOUS_CANONICAL_VALUE"
        )
    if not isinstance(request, dict):
        return "UNSUPPORTED_SCHEMA_VERSION"
    if request.get("schemaVersion") != "v0":
        return "UNSUPPORTED_SCHEMA_VERSION"

    # Required field presence and type precede every semantic or closed-schema
    # check, matching the normative TypeScript fail-fast order.
    for field in ("taskId", "causationId", "correlationId"):
        if not isinstance(request.get(field), str):
            return "UNSAFE_SIZE"
    if not isinstance(request.get("evaluatedAt"), str):
        return "AMBIGUOUS_CANONICAL_VALUE"
    for field in ("authorityCeiling", "requestedAuthority"):
        authority = request.get(field)
        if not isinstance(authority, dict) or any(not isinstance(authority.get(key), str) for key in AUTHORITY_FIELDS):
            return "AUTHORITY_WIDENING"
    role = request.get("rolePolicy")
    if not isinstance(role, dict) or any(not isinstance(role.get(field), str) for field in ROLE_FIELDS):
        return "UNSAFE_SIZE"
    candidates = request.get("candidateSet")
    if not isinstance(candidates, dict):
        return "UNSAFE_SIZE"
    items = candidates.get("candidates")
    if not isinstance(items, list) or any(not isinstance(item, str) for item in items):
        return "UNSAFE_SIZE"
    if not isinstance(candidates.get("sourceDigest"), str):
        return "INVALID_DIGEST"
    if not isinstance(candidates.get("capturedAt"), str):
        return "AMBIGUOUS_CANONICAL_VALUE"
    references = request.get("evidenceRefs")
    if not isinstance(references, list):
        return "INVALID_PROVENANCE"
    provenance = request.get("provenance")
    if not isinstance(provenance, dict):
        return "INVALID_PROVENANCE"
    if any(not isinstance(provenance.get(field), str) for field in ("policyUri", "policyDigest", "issuedAt")):
        return "INVALID_PROVENANCE"

    # Assembly-owned bounded strings and collections.
    for field in ("taskId", "causationId", "correlationId"):
        value = request[field]
        if not value or len(value.encode("utf-8")) > 256:
            return "UNSAFE_SIZE"
    for field in ("authorityCeiling", "requestedAuthority"):
        if any(not bounded_string(request[field][key], 256) for key in AUTHORITY_FIELDS):
            return "AUTHORITY_WIDENING"
    if any(not bounded_string(role[field], 128) for field in ROLE_FIELDS):
        return "UNSAFE_SIZE"
    if any(not bounded_string(item, 128) for item in items):
        return "UNSAFE_SIZE"
    if not bounded_string(provenance["policyUri"], 256):
        return "INVALID_PROVENANCE"

    # Exact instant syntax is one phase; relative-time checks follow below.
    evaluated_at = request.get("evaluatedAt")
    if not valid_instant(evaluated_at):
        return "AMBIGUOUS_CANONICAL_VALUE"
    if not valid_instant(candidates.get("capturedAt")):
        return "AMBIGUOUS_CANONICAL_VALUE"
    if not valid_instant(provenance.get("issuedAt")):
        return "INVALID_PROVENANCE"
    if "expiresAt" in provenance:
        if not valid_instant(provenance["expiresAt"]):
            return "EXPIRED_POLICY"
    if "deadline" in request:
        if not valid_instant(request["deadline"]):
            return "DEADLINE_EXCEEDED"

    if "deadline" in request and request["deadline"] < evaluated_at:
        return "DEADLINE_EXCEEDED"
    if "attemptBudget" in request:
        budget = request["attemptBudget"]
        if not isinstance(budget, int) or isinstance(budget, bool) or not (1 <= budget <= 1000):
            return "ATTEMPT_BUDGET_EXCEEDED"

    if not sha256(provenance.get("policyDigest")) or provenance["issuedAt"] > evaluated_at:
        return "INVALID_PROVENANCE"
    if "expiresAt" in provenance and provenance["expiresAt"] < evaluated_at:
        return "EXPIRED_POLICY"
    if not (1 <= len(items) <= 64):
        return "UNSAFE_SIZE"
    if not sha256(candidates.get("sourceDigest")):
        return "INVALID_DIGEST"

    if any(key not in REQUEST_FIELDS for key in request):
        return "UNKNOWN_EXECUTION_FIELD"
    if any(key not in ROLE_FIELDS for key in role):
        return "UNKNOWN_EXECUTION_FIELD"
    if any(key not in CANDIDATE_FIELDS for key in candidates):
        return "UNKNOWN_EXECUTION_FIELD"
    if any(key not in PROVENANCE_FIELDS for key in provenance):
        return "UNKNOWN_EXECUTION_FIELD"

    if credential_path(request) is not None:
        return "CREDENTIAL_IN_PROHIBITED_POSITION"

    ceiling = validate_authority(request.get("authorityCeiling"))
    requested = validate_authority(request.get("requestedAuthority"))
    if ceiling is None or requested is None:
        return "AUTHORITY_WIDENING"
    if any(ceiling[field] != requested[field] for field in ("tenant", "principal", "purpose", "audience")):
        return "AUTHORITY_WIDENING"
    if not set(requested["scope"].split(",")).issubset(set(ceiling["scope"].split(","))):
        return "AUTHORITY_WIDENING"

    if len(references) > 64:
        return "INVALID_PROVENANCE"
    identities = set()
    prior = None
    for reference in references:
        if not valid_evidence_ref(reference):
            return "INVALID_PROVENANCE"
        identity = (reference["uri"], reference["digest"])
        if identity in identities:
            return "INVALID_PROVENANCE"
        identities.add(identity)
        encoded = canonical_json(reference).encode("utf-8")
        if prior is not None and prior >= encoded:
            return "INVALID_PROVENANCE"
        prior = encoded

    if "traceFields" in request:
        trace = request["traceFields"]
        if not isinstance(trace, dict):
            return "AMBIGUOUS_CANONICAL_VALUE"
        if any(key in TRACE_BLOCKLIST for key in trace):
            return "UNKNOWN_EXECUTION_FIELD"
        try:
            canonical_json(trace)
        except CanonicalError as error:
            return "UNSAFE_SIZE" if "budget" in str(error) else "AMBIGUOUS_CANONICAL_VALUE"
    return None


def validate_authority(value):
    if not isinstance(value, dict) or set(value) != AUTHORITY_FIELDS:
        return None
    if any(not bounded_string(value.get(field), 256) for field in AUTHORITY_FIELDS):
        return None
    scope = value["scope"]
    tokens = scope.split(",")
    if len(scope.encode("utf-8")) > 256 or not (1 <= len(tokens) <= 64):
        return None
    if any(not SCOPE_TOKEN.fullmatch(token) for token in tokens):
        return None
    if any(tokens[index - 1] >= tokens[index] for index in range(1, len(tokens))):
        return None
    return value


def valid_evidence_ref(reference):
    if not isinstance(reference, dict) or not {"uri", "digest", "contentType"}.issubset(reference):
        return False
    if any(key not in EVIDENCE_FIELDS for key in reference):
        return False
    uri = reference.get("uri")
    if not isinstance(uri, str) or not uri or js_utf16_length(uri) > 512 or re.search(r"[\x00-\x1f\x7f]", uri):
        return False
    if uri.startswith(("/", "\\")) or "\\" in uri or ":" in uri or "//" in uri:
        return False
    if any(segment in (".", "..") for segment in uri.split("/")):
        return False
    if not sha256(reference.get("digest")) or reference.get("contentType") not in CONTENT_TYPES:
        return False
    if "label" not in reference:
        return True
    label = reference["label"]
    utf16_units = js_utf16_length(label) if isinstance(label, str) else 0
    return isinstance(label, str) and utf16_units <= 128 and not re.search(r"[\x00-\x1f\x7f]", label)


def credential_path(value, path=""):
    if isinstance(value, str):
        if sha256(value) and re.fullmatch(r"candidateSet\.sourceDigest|provenance\.policyDigest|evidenceRefs\[[0-9]+\]\.digest", path):
            return None
        return path if credential_rule_id(value) is not None else None
    if isinstance(value, list):
        for index, child in enumerate(value):
            found = credential_path(child, f"{path}[{index}]")
            if found is not None:
                return found
    if isinstance(value, dict):
        for key, child in value.items():
            if credential_rule_id(key) is not None:
                return f"{path}.<redacted>" if path else "<redacted>"
            found = credential_path(child, f"{path}.{key}" if path else key)
            if found is not None:
                return found
    return None


def credential_rule_id(value):
    for rule_id, pattern in CREDENTIAL_PATTERNS:
        if pattern.search(value):
            return rule_id
    return None


def compile_identity(request):
    constraints = {}
    if "deadline" in request:
        constraints["deadline"] = request["deadline"]
    if "attemptBudget" in request:
        constraints["budget"] = request["attemptBudget"]
    prompt = {
        "kind": "assembly-prompt-v0", "schemaVersion": "v0",
        "taskId": request["taskId"], "causationId": request["causationId"],
        "correlationId": request["correlationId"], "evaluatedAt": request["evaluatedAt"],
        "authority": request["requestedAuthority"], "rolePolicy": request["rolePolicy"],
        "candidateSet": request["candidateSet"], "constraints": constraints,
        "evidenceRefs": request["evidenceRefs"], "provenance": request["provenance"],
    }
    canonical_prompt = canonical_json(prompt)
    invocation_projection = {
        "kind": "prepared-invocation-v0", "targetRole": request["rolePolicy"]["roleName"],
        "canonicalPrompt": canonical_prompt, "constraints": constraints,
        "evidenceRefs": request["evidenceRefs"],
    }
    invocation_id = digest(canonical_json(invocation_projection))
    prepared = {
        "invocationId": invocation_id, "targetRole": request["rolePolicy"]["roleName"],
        "canonicalPrompt": canonical_prompt, "constraints": constraints,
        "evidenceRefs": request["evidenceRefs"],
    }
    decision = {
        "kind": "assembly-artifact-v0", "schemaVersion": "v0",
        "taskId": request["taskId"], "causationId": request["causationId"],
        "correlationId": request["correlationId"], "evaluatedAt": request["evaluatedAt"],
        "authorityCeiling": request["authorityCeiling"], "authority": request["requestedAuthority"],
        "rolePolicy": request["rolePolicy"], "candidateSet": request["candidateSet"],
        "provenance": request["provenance"], "preparedInvocation": prepared,
    }
    if "deadline" in request:
        decision["deadline"] = request["deadline"]
    if "attemptBudget" in request:
        decision["attemptBudget"] = request["attemptBudget"]
    canonical_bytes = canonical_json(decision)
    return canonical_bytes, digest(canonical_bytes)


def validate_positive(path):
    try:
        fixture = load_fixture(path)
        code = independently_validate(fixture.get("input"))
        if code is not None:
            raise AssertionError(f"unexpected {code}")
        _, actual = compile_identity(fixture["input"])
        if actual != fixture.get("expectedDigest"):
            raise AssertionError("digest mismatch")
        if actual != fixture.get("expectedArtifactId"):
            raise AssertionError("artifactId mismatch")
        print(f"PASS positive {path.name}")
        return True
    except Exception as error:
        print(f"FAIL positive {path.name}: {error}")
        return False


def validate_negative(path):
    try:
        raw = path.read_text(encoding="utf-8")
        expected = json.loads(raw).get("expectedErrorCode")
        try:
            fixture = load_fixture(path)
            actual = independently_validate(fixture.get("input"))
        except CanonicalError as error:
            message = str(error)
            actual = "UNSAFE_NESTING" if "depth" in message else (
                "UNSAFE_SIZE" if "budget" in message or "large" in message else "AMBIGUOUS_CANONICAL_VALUE"
            )
        if actual != expected:
            raise AssertionError(f"expected {expected}, received {actual}")
        print(f"PASS negative {path.name}")
        return True
    except Exception as error:
        print(f"FAIL negative {path.name}: {error}")
        return False


def load_fixture(path):
    raw = path.read_text(encoding="utf-8")
    assert_raw_canonical_resource_bounds(raw)
    assert_integer_only_number_tokens(raw)
    def pairs(items):
        output = {}
        for key, value in items:
            if key in output:
                raise CanonicalError("duplicate object key")
            output[key] = value
        return output
    return json.loads(raw, object_pairs_hook=pairs)


def reject_noninteger_tokens(raw):
    index = 0
    while index < len(raw):
        if raw[index] == '"':
            index += 1
            while index < len(raw):
                if raw[index] == "\\":
                    index += 2
                elif raw[index] == '"':
                    index += 1
                    break
                else:
                    index += 1
            continue
        if raw[index] == "-" or raw[index].isdigit():
            start = index
            index += 1
            while index < len(raw) and (raw[index].isdigit() or raw[index] in ".eE+-"):
                index += 1
            token = raw[start:index]
            if token == "-0" or any(mark in token for mark in ".eE") or abs(int(token)) > 2 ** 53 - 1:
                raise CanonicalError("numeric token outside safe-integer domain")
            continue
        index += 1


assert_integer_only_number_tokens = reject_noninteger_tokens


def assert_raw_canonical_resource_bounds(raw):
    if len(raw.encode("utf-8")) > MAX_BYTES:
        raise CanonicalError("raw JSON exceeds byte budget")
    depth = 0
    in_string = False
    escaped = False
    for character in raw:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > MAX_DEPTH:
                raise CanonicalError("raw JSON nesting depth exceeds maximum")
        elif character in "]}":
            depth -= 1


def valid_instant(value):
    if not isinstance(value, str) or not INSTANT.fullmatch(value) or value[:4] == "0000":
        return False
    try:
        datetime(
            int(value[0:4]), int(value[5:7]), int(value[8:10]),
            int(value[11:13]), int(value[14:16]), int(value[17:19]),
            int(value[20:23]) * 1000,
        )
        return True
    except ValueError:
        return False


def bounded_string(value, maximum):
    return isinstance(value, str) and bool(value) and len(value.encode("utf-8")) <= maximum


def js_utf16_length(value):
    return len(value.encode("utf-16-le")) // 2


def sha256(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures-dir", required=True)
    args = parser.parse_args()
    root = Path(args.fixtures_dir)
    positive = sorted((root / "positive").glob("*.json"))
    negative = sorted((root / "negative").glob("*.json"))
    if not positive or not negative:
        print("ERROR: fixture corpus is missing")
        return 1
    passed = sum(validate_positive(path) for path in positive)
    passed += sum(validate_negative(path) for path in negative)
    total = len(positive) + len(negative)
    failed = total - passed
    print(f"Results: {passed}/{total} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
