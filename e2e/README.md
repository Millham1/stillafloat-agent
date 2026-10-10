# e2e/ — the whole-site release gate

Mark, 2026-10-04: *"every time we launch a revision or feature the entire system is supposed to be
tested end to end very thoroughly… think of the website holistically, not as separate features."*
This folder is that test, and the tools around it make it the only road to prod.

## What it is
- `checks/*.mjs` — 148 checks over 14 areas (news, commentary, affiliate, ships, cabins, audience,
  editorial, ops, pages, flows, jobs, vitals, weather, storm). Each check requests real pages and endpoints of a
  running box and asserts what a visitor or Mark would see. One check may cover many routes.
- `run.mjs` — the runner. `--mode dev|prod`, `--site/--news/--ops` base addresses, `--only a,b`
  (a PARTIAL run, never a pass), `--compare before.json` (what disappeared or changed), `--json out`.
- `surface.mjs` — derives every page, API route and scheduled job from the code and audits that each
  is **covered** by a check, **exempt** with a written reason, or an **admitted gap** (reason + date)
  under `coverage/_ceiling.json`. The ceiling may only go down.
- `lib/vacuity.mjs` — every check must FAIL against four fake sites (500 / empty / `{}` / 404). A check
  that passes on nothing is worse than none (the Storm Watch list that "passed" empty for 8 days).
- `known-failures.json` — the only way to release past a failing check: an entry with `id`, `since`,
  `reason` and `decision` naming who accepted it. Every run still prints it. Nothing is waived
  silently; Mark's 2026-10-08 ruling is that everything listed is to be FIXED, not waived.
- `sweep-on-box.sh <dev|prod>` — runs the suite on a box from its own checkout (used by CI).

## The rules the tools enforce
1. **Empty ≠ pass.** A check must assert something; `t.require()` turns a precondition that is not
   met into UNTESTABLE, and an untestable check FAILS the run. There is no flag to ignore a failure.
2. **Partial never passes.** `--only` runs are recorded as partial and never open the gate.
3. **Dev is the mirror.** Every check runs on dev unless it says why not (`prodOnlyBecause`). A
   failure that exists only on dev is a dev-mirror gap to FIX on dev (seed/enable), not to waive.
4. **Prod is read-only.** In prod mode the harness refuses writes; only refusal paths are probed.
5. **Covers must be real.** A check that claims to cover a route it never requested fails.
6. **Cooldown.** A full sweep sends refusal probes to endpoints limited to ~5 per visitor per hour.
   A second full sweep within the hour is refused (Mac) or waited out (box).
7. **Every check cites its design source (Mark, 2026-10-09).** A gate check tests a property of the
   SITE — what the code promises, or what a design document or one of Mark's dated rulings says the
   site must do — never whether the world happens to be in some state (a ship in front of a webcam, a
   storm active, traffic from AI assistants, a newsletter sent this week, a third-party stream being up
   this minute). Each check carries a `basis` string, enforced by the linter, in one of five forms:
   - `ruling: <memory file> — <Mark's words or a paraphrase, with the date>`
   - `tad: <section heading> — <what the Technical Architecture Document says>`
   - `master-ref: <section number/title> — <what the Master Reference says>`
   - `code: <file path> — <the promise the code makes>` (a route, a page, a job: "the code returns X" is a
     basis for "X must still be returned", never for an expectation about traffic, weather, positions or time of day)
   - `incident: <date> — <what broke and what this prevents>`
   Every assertion inside `run(t)` must follow from the basis. Where one assumes a world state, rewrite it
   to compare two of the site's own outputs, or to assert the honest empty case; do not loosen a check to
   make it pass. `t.require(...)` is for a precondition the box cannot satisfy on purpose — a real
   Turnstile key on prod, a seeded dev fixture that Mark's 2026-10-04 mirror ruling says dev must carry
   (and then only `if (t.mode === "dev")`) — never for "the world is not in the state I wanted".

## How it runs
| Where | Command | Result file |
|---|---|---|
| Mac → box | `saf-ops-tools/site-e2e.sh dev` / `prod` (`--compare <json>`) | `~/.config/saf/release-gate/runs/`, `latest-<box>.json` |
| On the box | `bash /root/saf-full/e2e/sweep-on-box.sh dev` / `prod` | `/root/saf-e2e/latest-<mode>.json` |
| CI, after every deploy | jobs `sweep-dev` / `sweep-production` in `deploy.yml` | GitHub run (red = emailed) |
| CI, scheduled | `sweep-prod.yml` every 6 h | GitHub run (red = emailed) |
| Unit suite | `server/src/e2e-gate.test.ts` (lint + vacuity + coverage + waiver format) | `pnpm test` |

Each run prints one line: `SWEEP <box> PASS|FAIL pass=N fail=N untestable=N known=N suite=<sha> …`.

## How a release happens (and cannot happen otherwise)
1. Work on a feature branch → merge to **dev** → the dev box deploys → `site-e2e.sh dev` PASSES with
   the box on origin/dev (the record carries the box heads, the suite commit and process states).
2. Mark's GO.
3. `saf-ops-tools/promote.sh` — refuses unless: main ⊂ dev, the dev PASS record is complete, committed,
   under 24 h, on exactly origin/dev, all processes online, news/ops boxes on their origin/dev, and any
   new `supabase/migrations` are declared applied to prod (`--migrations-applied`). Takes a prod
   baseline sweep, pushes `origin/dev → main`, waits for `verify-deploy.sh`, sweeps prod `--compare`.
4. `~/.claude/hooks/saf-main-guard.sh` re-checks the same facts on any `git push` to main typed by
   hand: whole-dev tree only, and a qualifying dev PASS record. No override flag, by design.

## Adding a check
Export default an array from `checks/<area>.mjs`: `{ id: "area.what-it-checks", basis, title, covers: [...],
modes: ["dev","prod"], run(t) }`. `t.get/post`, `t.success`, `t.html`, `t.require`, `t.equal/ok/matches`.
Name every route/page the check requests in `covers`. Run `node e2e/run.mjs --coverage` and
`pnpm --filter @workspace/api-server test` (e2e-gate.test.ts) before committing.
