// Work a route does not make the visitor wait for, so it is still running after they have their answer: Mark's item on his list, the ONE email of a group
// reply's road and its line in the email log. The route does not await it. It is kept here until it has finished, so the route tests can wait for it to
// finish instead of guessing how long it takes: on 2026-10-26, in a loaded full `pnpm test`, the email log of one test's hold landed in the NEXT test's
// freshly reset tables, and that test, which checks that the bot trap writes nothing, failed.

const running = new Set<Promise<unknown>>();

/** Start `work` without making the visitor wait for it. It handles its own failures (it ends in .catch): a rejection that reaches here is dropped. */
export function afterAnswer(work: Promise<unknown>): void {
  running.add(work);
  const done = () => { running.delete(work); };
  work.then(done, done);
}

/** For the tests: resolves once every piece of after-the-answer work has finished, including any started while it waited. */
export async function _afterAnswerSettledForTests(): Promise<void> {
  while (running.size) await Promise.allSettled([...running]);
}
