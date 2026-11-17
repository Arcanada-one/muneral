# Preflight-check pin v4.12.6 — admission note

Muneral pull request #438 pinned `Arcanada-one/datarim` `preflight-check` and
`preflight-caller-contract` to `e3136b1b6d245c29805cc7ef1555fcbc1e3c92ff`
(`# v4.12.6`) and refreshed `scripts/ci/tested_tree.py`
`QUALIFIED_WORKFLOW_SHA256` to match `.github/workflows/ci.yml`.

#438 merged at `d2d048a2` before a tree `ChangeAdmissionReceipt/v1` landed.
Content-range verify (`ffc68682..d2d048a2`) produced
`admitted_with_exemptions` (eight honest `not_measured` exemptions). That draft is
kept as `receipts/graph/change-admission-preflight-pin-content-v4.12.6-20261117.json`.

The follow-up pull request that adds the range-bound receipt for the post-merge
diff is evidenced by
`receipts/graph/change-admission-preflight-pin-v4.12.6-20261117.json`
(work item `597f92c3-ed72-4791-ab6e-c5e8e2ee30d0`).
