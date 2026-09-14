# graph-admission: the commit order for a pull request

`graph-admission` is a required check in this repository: «no receipt, no merge» (DEC-AUP-0008). It is the vendored
gate in `.github/graph-admission/`, called from `.github/workflows/ci.yml` with a pinned `program_ref`.

## Why the order matters here

`apps/api/test/assembly/mutation-results.json` pins a hash of the whole tracked tree (`supplementalGit`). Every commit
moves that hash, including the commit that adds a receipt. `lint-and-test` runs `--verify-structure` on it, so the
evidence has to be rebound last.

## The order

1. **Commit the content change.**
2. **Issue the ChangeAdmissionReceipt/v1 on that range.** Run `verify.py --diff <base>..<content head> --graph auto
   --work-item <ID>` from the pinned program tools. Put the output under `receipts/graph/`, or in the pull-request body
   as a ```json block.
3. **Commit the receipt.**
4. **Rebind the mutation evidence and commit it.** Only `supplementalGit` has to change when no mutation site moved.
   Check it with `node apps/api/test/assembly/mutation-harness.js --verify-structure
   apps/api/test/assembly/mutation-results.json` on the Node version the evidence records.

Since program_ref `88b71d05` (GATEORDER-0), commits after the receipt's head are **record commits** and are admitted
only if they carry nothing but:

- the bound receipt file itself, byte for byte as the gate read it; and
- a derived artefact declared in `.arcana/derived-artefacts.v1.json` at the base of the pull request. The gate runs its
  declared verifier on the head tree, then again with one byte corrupted, and the second run must fail.

Anything else changed after the receipt head refuses with `CHANGE_SET_INCOMPLETE`. That includes a second edit to a
file the receipt already lists. Re-issue the receipt on the full range instead.

Rule of record: `contracts/graph-verified-change/trailing-record-commits.v1.md` in arcanada-universal-program.
