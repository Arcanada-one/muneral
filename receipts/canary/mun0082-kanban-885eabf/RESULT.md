# Canary: Kanban status-change failure feedback (MUN-0082), measured code head 885eabf

- Entity: `code_unit:apps/web/components/kanban/KanbanBoard.tsx` (changed by PR #421).
- Measured subject: commit `885eabf1560d139e33ac877321357ad57d14369e`, tree `0442624179b0d30923e2f5a073c6b38e78f057d2`
  (clean detached worktree; later commits on the branch touch only `receipts/`).
- Probe: `vitest run components/kanban/KanbanBoard.status-error.test.tsx` (3 tests) under Node from `/usr/bin/node`,
  inside bubblewrap private user/net/pid/ipc/uts namespaces, source mounted read-only at `/repo`, no network.
- Producer: `harness.py.txt` calls the vendored `process_observation.run`; launcher `run_sandbox.sh.txt`.
- Limits: the input inventory in `plan.json` is a named set (25 files), not a full import closure. Escaped
  descendants are not proven absent. No negative control (mutant) was run in this record.
