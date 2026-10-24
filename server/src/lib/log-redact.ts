// log-redact.ts — what the request log may say about an address.
//
// A traveler's paperwork link is a credential: /forms.html?t=<token> (the query is already dropped
// from every log line) and /api/forms/<token>[/sign] (the token is a path segment, so it would be
// written out). Both boxes' nginx logs are outside this code, but our own are not.
export function redactLogUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.split("?")[0]!.replace(/^(\/api\/forms\/)[^/]+/, "$1[link]");
}
