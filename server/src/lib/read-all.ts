// Read EVERY row of a Supabase query, 1,000 at a time.
//
// PostgREST caps a response at 1,000 rows and `.limit(n)` does NOT raise that cap.
// An unpaged read of a table that can exceed 1,000 rows silently returns an
// arbitrary subset: the Storm Watch impacted-ships list read planned_sailings with
// `.limit(3000)` and, with 1,076–1,128 rows in each live storm's window on
// 2026-10-08, dropped 7–11% of sailings with no error (ships in the storm's path
// never listed, pinned or watched for course changes). cabins.ts hit the same
// trap twice on 2026-08-17.
//
// The query builder MUST apply a total ordering (e.g. `.order("ref")` on a unique
// column) or pages overlap and skip rows.
export const PAGE = 1000;

export async function readAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; error: { message: string } | null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { rows, error };
    const got = data ?? [];
    rows.push(...got);
    if (got.length < PAGE) return { rows, error: null };
  }
}
