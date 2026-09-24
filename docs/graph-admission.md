# graph-admission: the commit order for a pull request

`graph-admission` is a required check in this repository: «no receipt, no merge» (DEC-AUP-0008). It is the vendored
gate in `.github/graph-admission/`, called from `.github/workflows/ci.yml` with a pinned `program_ref`.

## Why the order matters here

`apps/api/test/assembly/mutation-results.json` pins a hash of the whole tracked tree (`supplementalGit`). Every commit
moves that hash, including the commit that adds a receipt. `lint-and-test` runs `--verify-structure` on it, so the
evidence has to be rebound last.

`supplementalGit` is not the only derived field (MUN-0060). `buildBinding()` also hashes `apps/api/package.json`,
the root `package.json`, `pnpm-lock.yaml`, both `tsconfig`s and everything under `apps/api/test/assembly`, so a
change to any of those additionally invalidates `binding.aggregateSha256` and that file's entry in
`binding.files`, and `--verify-structure` then reports `binding aggregate, binding files` on top of
`supplemental git`. All three are recomputable without a mutation run: `buildBinding()` and `gitSupplement()` are
exported from `mutation-harness.js` (`:1050-1068`) — import them and write the result back, never transcribe a
hash by hand from a failing diff.

## The order

1. **Commit the content change — with the mutation evidence already rebound into it.** `lint-and-test` runs
   `--verify-structure` on whatever head it is given, and every commit moves the tracked-tree hash, so a content
   head that does not carry a rebind is red before anything else is judged. Measured on this very pull request
   (A2-275, 2026-09-24): a documentation-only commit turned `test/mutation-evidence.spec.ts` red on three
   expectations, `uses a non-self-referential Git snapshot supplement` among them. The rebind of step 4 is a
   *second* one, made after the receipt lands; it is not a substitute for this first one.

   **1b. Push the content head and read the conclusion of `lint-and-test` on it — before writing the receipt.**
   This repository declares a derived artefact (`.arcana/derived-artefacts.v1.json`), so the exemption that carries
   the receipt is issued by `admit_change.py exempt`, and its B6.6 arm asks whether *the job the declaration names
   is green on this head*. That answer comes from the caller's workflow inputs, not from the tree: with no
   `--verifier-job` / `--verifier-conclusion` the arm is `not_measured` — «not_measured is not a pass: no exemption,
   the change pauses» (`.github/graph-admission/tools/graph/admit_change.py:1703-1718`) — and the whole B6 set, and
   with it eligibility, falls to `NOT ELIGIBLE (gate_self_update): the change stays paused_safe`. Measured on
   A2-273, 2026-09-24. So the real order is: push the content head, wait for `lint-and-test` to conclude, read its
   conclusion from the check-runs API, and pass it:

   ```bash
   gh api repos/Arcanada-one/muneral/commits/<content head>/check-runs \
     --jq '.check_runs[] | select(.name=="lint-and-test") | .conclusion'
   python3 <program tools>/admit_change.py exempt --repo . --range <base>..<content head> \
     --receipt receipts/graph/<receipt>.json \
     --verifier-job lint-and-test --verifier-conclusion success
   ```

   A conclusion read before the job finishes is `null`, which is not `success` and pauses exactly as it should;
   poll the API rather than guessing. This step is also why the receipt cannot be written on an unpushed branch.
2. **Issue the ChangeAdmissionReceipt/v1 on that range.** Run `verify.py --diff <base>..<content head> --graph auto
   --work-item <ID>` from the pinned program tools. Put the output under `receipts/graph/`, or in the pull-request body
   as a ```json block.
3. **Commit the receipt.**
4. **Rebind the mutation evidence again — into the receipt commit, with `git commit --amend`.** The receipt file
   feeds the tracked-tree hash, so the rebind of step 1 is stale the moment the receipt lands, and a *new* commit
   after the receipt would refuse as `CHANGE_SET_INCOMPLETE`. Amending is what the gate allows: the receipt itself
   and a declared derived artefact are the only paths that may move in a record commit
   (`.arcana/derived-artefacts.v1.json` → `ordering`). Only `supplementalGit` has to change when no mutation site moved.
   Check it with `node apps/api/test/assembly/mutation-harness.js --verify-structure
   apps/api/test/assembly/mutation-results.json` on the Node version the evidence records — which is pinned, and
   which arcana-devs does not carry by default (§ Installing the tree before a local `verify.py` run).
5. **If the receipt comes out `paused_safe`, attach the exemptions — then commit it (step 3).** This is the
   ordinary case, not an incident: see below. Touching the receipt file after it is committed is a new change set
   (`CHANGE_SET_INCOMPLETE`), so the exemptions go in before step 3, and step 4 is redone afterwards.

## Installing the tree before a local `verify.py` run

The install recipe in `.arcana/derived-artefacts.v1.json:13` — `pnpm install --frozen-lockfile --ignore-scripts` —
is written for the **mutation harness**, and `--ignore-scripts` is deliberate there: the gate runs this repository's
verifier, not its postinstall hooks.

It is the wrong recipe for a local `verify.py` run, and it fails in a way that looks like a real defect rather than
like a missing step. `postinstall` is what generates the Prisma client; without it `@prisma/client` exports no
`Prisma` namespace, and `v-type-check` reports **335 errors across 32 files** on a change that touches no `.ts` file
at all — `deployable_unit:.` `failed`, admission **REFUSED**. Measured on auth-arcana in A2-273 (2026-09-24), whose
`postinstall` is `prisma generate` (`auth-arcana/package.json:11`); the same recipe and the same trap apply here.
After `pnpm prisma generate` the same check exits 0 with no errors.

So, before `verify.py`:

```bash
pnpm install --frozen-lockfile      # scripts ON, or:
pnpm install --frozen-lockfile --ignore-scripts && pnpm prisma generate
python3 <program tools>/verify.py --repo . --diff <base>..<head> --graph auto \
  --tsc node_modules/.bin/tsc --work-item <ID>
```

Note the `--tsc`: a `tsc unavailable on this host` verdict is the *other* face of the same cause — dependencies not
installed — and unlike the 335 errors it announces itself honestly (A2-236).

### The Node version

`package.json:18` and `.github/workflows/ci.yml:80` pin Node **24.21.0**, and `--verify-structure` refuses before it
checks anything when the running version differs: `TOOLCHAIN_MISMATCH recorded={"node":"v24.21.0"…}
actual={"node":"v24.20.0"…}`. That refusal is correct — the evidence records the toolchain that produced it — but
arcana-devs carries 24.20.0 and has neither nvm nor fnm. Fetch the pinned version **into the run directory** and put
it first on `PATH` for that run; never change the system Node on a shared host:

```bash
curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o runs/<ID>/node.tar.xz
tar -xJf runs/<ID>/node.tar.xz -C runs/<ID>/
export PATH="$PWD/runs/<ID>/node-v24.21.0-linux-x64/bin:$PATH"   # this shell only
```

`admit_change.py gate` needs the same `PATH`: it re-runs the declared artefact's own verifier on the head tree, as
`node`, from wherever `node` resolves. Measured on A2-275: with the host's 24.20.0 first on `PATH` the gate answered
`REFUSE / CHANGE_SET_INCOMPLETE … the declared verifier exits 1 on the honest head tree: TOOLCHAIN_MISMATCH`, and
with the pinned 24.21.0 first the same range answered `ADMIT`. The refusal is correct and it is about the toolchain,
not about the change — read the tail of the message, not the code.

## `not_measured`, and the exemption that carries it

`not_measured` is the third verdict: the verifier that owns the entity could not attribute a result to it. It is
never a pass and never a fail. An entity left `not_measured` with nothing covering it pauses the whole change —
the gate emits `NOT_MEASURED_WITHOUT_EXEMPTION` (C09) plus `ADMISSION_NOT_ADMITTED` (C11) and the check is red.
`admission.verdict: paused_safe` is an honest verdict about the measurement; it is not a verdict the gate merges.

Two things do **not** resolve it. Editing a verdict to `verified` is a false receipt — the gate re-reads every
verdict and a two-valued verdict (`pass`) is refused outright as `RECEIPT_MALFORMED`. And `admit_change.py exempt`
is not the tool for it: that subcommand issues **structural** exemptions only — `NO_IMPACT_BY_CONSTRUCTION`,
`GATE_SELF_UPDATE`, `GATE_DECLARATION_AMEND`, `SPENT_RECEIPT_ARCHIVE`
(`.github/graph-admission/tools/graph/admit_change.py:380-382` and `:593-600`), for a change whose impact the gate
structurally cannot compute. Its own help says it: «issue a structural exemption into a receipt (gate4b) — the
gate, never the change author by hand» (`admit_change.py:3304-3305`). They are bound to the diff digest, expire in
24 h (`:390`) and are re-measured by the gate on every run (C16, `:1796-1805`), so a hand-written one is refused.

An **ordinary** exemption is the other mechanism, and it is attached by the **admitting agent** — the one running
the change — never by the verifier and never by the gate (DEC-AUP-0008, verifier matrix P1/P4). It is a statement
about *coverage*: which verifier did in fact execute the entity, and what is left unmeasured. It is never a
statement that the entity is correct.

One object per `not_measured` entity, in `exemptions[]`:

| field | what the gate does with it |
|-------|----------------------------|
| `entity` | must be an entity that has a verdict in this receipt, or C10 refuses (`EXEMPTION_INADMISSIBLE`) |
| `code` | the reason class (below). `INFERRED_BOUNDARY_WITHOUT_CANARY` is also what silences C12 |
| `owner` | non-empty, and a real addressable owner: card, work item, model, host. Empty ⇒ C10 refuses |
| `expires_at_utc` | must be after `captured_at_utc` (C10). Cap it at **30 days** — the gate's own automated-author TTL (`admission-gate.v1.json` → `exemption_ttl_days: 30`); shorter if the thing it covers dies sooner |
| `reason` | prose, and the part that carries the meaning: **which verifier actually covered the entity, with the command and its result**, and **what residue remains**. «No verifier applies» is not a reason, it is the restatement of the verdict |
| `ref` | pointer into `notes[]` for the shared evidence, so 143 exemptions do not carry 143 copies of it |

An exemption that passes C10 but says nothing is worse than a red check: it admits the change while hiding that
nothing was measured. If the residue is real, the reason says what would close it — a post-deploy live read, a
canary — and the pull request carries that as an evidence gate with a `reverse_if`.

Codes this repository has used (see the worked example below for the wording of each):

- `INFERRED_BOUNDARY_WITHOUT_CANARY` — a route or service boundary reached over an inferred/observed hop. No canary
  can exist before the deploy; residue = a live read after it.
- `BOUNDED_CHECKER_OUT_OF_SCOPE` — the file is outside every `tsconfig` input, so `type_check` cannot attribute a
  verdict. Say which command *did* run it (`pnpm lint`, `node --test …`) — and if none does, the honest conclusion
  is usually that the file is dead and should be deleted, not exempted.
- `HISTORICAL_RECEIPT_ASSERTED` — an already-filed receipt under `receipts/`, asserted, not re-verified (I14).
- `WORK_ITEM_NO_LOCAL_VERIFIER` — a work item lives in Muneral, not in this tree.

**Worked example.** `receipts/graph/change-admission-mun0055-20260923T121431Z.json` (MUN-0055): 417 verdicts —
274 `verified`, 143 `not_measured`, 0 `failed` — and 143 exemptions, one per unmeasured entity, all owned by the
card that issued them and all expiring on the same day as the grant the change renewed. The verdicts were not
touched when the exemptions were attached; `admission.verdict` moved from `paused_safe` to
`admitted_with_exemptions`, and `notes[]` records that the exemptions were attached by the card and not by the
verifier. `admission.rule` in that file is the one-line statement of the whole policy.

Since program_ref `88b71d05` (GATEORDER-0), commits after the receipt's head are **record commits** and are admitted
only if they carry nothing but:

- the bound receipt file itself, byte for byte as the gate read it; and
- a derived artefact declared in `.arcana/derived-artefacts.v1.json` at the base of the pull request. The gate runs its
  declared verifier on the head tree, then again with one byte corrupted, and the second run must fail.

Anything else changed after the receipt head refuses with `CHANGE_SET_INCOMPLETE`. That includes a second edit to a
file the receipt already lists. Re-issue the receipt on the full range instead.

Rule of record: `contracts/graph-verified-change/trailing-record-commits.v1.md` in arcanada-universal-program.
