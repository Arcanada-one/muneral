# Candidate-local route canary — 3452dd9

Work item 0553bc03-aba5-42a0-bb38-f85dbc431eec (DEC-AUP-0033 A3, standing project-read grants).

- Subject: `3452dd965cd499f99eae0c76339002a4ff0acc50` (tree `dd31ef8bc416cf04de12037c1677868563c8aa1a`), captured 2026-10-28T11:05:59Z.
- 51 routes, 102 probes, 0 failed; 60/60 entities verified.
- `GET /tasks/project/08a50f9a-a735-4605-91ce-ce4a41193fbb/index` with the aup-orchestrator key answered 200 with grant `{"decision": "DEC-AUP-0033", "until": "9999-12-31T00:00:00Z"}`.
- Environment: candidate-local Nest API on loopback with disposable PostgreSQL 16 and private Redis; synthetic owner and agent principals. Runner: `route-sweep.mjs.txt` (sha256 c03b99406a986180f46c18207120143629421e7e8cb1146d362d8a55e8127777).
