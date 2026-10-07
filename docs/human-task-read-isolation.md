# Human task read isolation

An authenticated human may read tasks only through a current `WorkspaceMember`
relationship to the task's project's workspace. The existing owner, manager,
developer and viewer memberships authorize reads. A workspace owner ID alone is
not a fallback grant after membership removal. JWT authentication still verifies
the token and user before authorization; this change creates no identity system.

Task rows, project lists, staleness, evidence, checklist, activity, dependency
reads and task git references apply this boundary. Global list filtering and its
count happen in SQL before paging. The project index and workspace digest retain
their existing agent-only restrictions. Agent creator/assignment/read-grant rules
and write handlers are unchanged.

The human guard consumes the authenticated `req.user`, because interceptors set
`req.actor` after guards. Actual data reads also carry the server-derived member
predicate. Human dependency reads verify the root and both endpoints and read the
edges in one RepeatableRead transaction. An inaccessible counterpart refuses the
whole response; dropping a blocker would misrepresent readiness. Authorization
uses that transaction's snapshot rather than promising instantaneous revocation
of an already-running request. Subsequent requests evaluate membership anew.

The real HTTP/disposable PostgreSQL regression suite covers own/foreign reads,
anonymous and expired credentials, paging/count isolation, HEAD and conditional
GET, all existing member roles, membership removal, task project moves, and a
foreign dependency inserted between guard and service. Tests use synthetic
principals and workspaces; they do not request another tenant's production data.

Release still requires the source-bound graph receipt, current CI, independent
review, canonical merge gate and deployment readback. A passing local fixture is
not a production verification. Rollback must keep denial of unrelated human
reads; restoring the former unrestricted read path is not a safe rollback.
