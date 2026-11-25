# Contributing to Muneral

## Post-merge cleanup

After a merge into `main`, delete the merged branch, the worktrees and clones created for that change, and its unused artifacts in the same tick and working session. Where `main` deploys the change, confirm deployment before cleanup in that tick.

Remove only resources that existed to carry the merged change. This includes its build outputs, caches, and disposable test databases and containers. Verify that the branch head was merged and that local worktrees and clones hold no unmerged work. Preserve live worktrees and artifacts still used by CI, releases, or audits.

Finish unmerged work into `main` or record evidence that it is already present there in another form.

See [the ecosystem mandate](https://github.com/Arcanada-one/arcanada-workspace/blob/main/documentation/mandates/post-merge-cleanup-mandate.md).
