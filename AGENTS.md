## Post-merge cleanup
Once a change has landed in `main` and has been deployed where the repository deploys from `main`, delete in the same working session only the branch, worktrees and clones, build outputs and caches, test databases and containers, and CI artifacts that existed only to carry that merged change.
Never delete unmerged work; finish it into `main` or show with evidence that it is already in `main` in another form.
See [the ecosystem mandate](https://github.com/Arcanada-one/arcanada-workspace/blob/main/documentation/mandates/post-merge-cleanup-mandate.md).
