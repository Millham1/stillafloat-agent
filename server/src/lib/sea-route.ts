// sea-route.ts — a path between two points that stays on water.
//
// 2026-09-10, Mark, looking at Carnival Jubilee at Cozumel with her route drawn
// as a great circle from Galveston straight across the Yucatán: "it's not
// possible for a ship to go through an island." Straight lines are for
// aircraft. This wraps `searoute-js` (MIT, Eurostat's global maritime network,
// bundled — no service, no key): shortest path over shipping lanes, computed on
// our server in a few milliseconds. The network is coarse offshore (nodes a few
// degrees apart) so a path can run 20-50% longer than the ship's real track;
// dead-reckoning caps the length it trusts (see estimatePosition).
//
// Fail-closed: if a route cannot be computed we return null and the caller
// draws NOTHING for that leg — never a straight line across land.

// No logger import: tests bundle this module and the pino transport is not
// available there. The server injects its logger at boot (index.ts).
let warn: (meta: Record<string, unknown>, msg: string) => void = () => {};
export function setSeaRouteLogger(fn: typeof warn): void { warn = fn; }

export interface SeaPath {
  /** [lat, lon] points, first = origin, last = destination */
  points: [number, number][];
  lengthNm: number;
}

type SearouteFn = (
  origin: { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] } },
  destination: { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] } },
  units?: string,
) => { geometry: { coordinates: [number, number][] }; properties: { length: number } };

let fn: SearouteFn | null | undefined; // undefined = not loaded yet, null = load failed
const cache = new Map<string, SeaPath | null>();
const CACHE_MAX = 500;

async function load(): Promise<SearouteFn | null> {
  if (fn !== undefined) return fn ?? null;
  try {
    // Lazy: the package builds its lane graph from a 3.5 MB network on require.
    const mod = (await import("searoute-js")) as unknown as { default?: SearouteFn };
    const candidate: unknown = mod.default ?? mod;
    fn = typeof candidate === "function" ? (candidate as SearouteFn) : null;
  } catch (err) {
    warn({ err }, "sea-route: package unavailable — route lines disabled");
    fn = null;
  }
  return fn;
}

const key = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
  `${a.lat.toFixed(2)},${a.lon.toFixed(2)}>${b.lat.toFixed(2)},${b.lon.toFixed(2)}`;

/** Water path from a to b, or null when none can be computed. Cached by rounded endpoints. */
export async function seaRoute(a: { lat: number; lon: number }, b: { lat: number; lon: number }): Promise<SeaPath | null> {
  const k = key(a, b);
  if (cache.has(k)) return cache.get(k)!;
  const f = await load();
  let out: SeaPath | null = null;
  if (f) {
    try {
      const pt = (p: { lat: number; lon: number }) =>
        ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] as [number, number] } });
      const r = f(pt(a), pt(b), "nauticalmiles");
      const coords = r?.geometry?.coordinates ?? [];
      if (coords.length >= 2 && isFinite(r.properties?.length)) {
        const points = coords.map(([lon, lat]) => [lat, lon] as [number, number]);
        // The network snaps both ends to its nearest nodes; pin the real endpoints.
        points[0] = [a.lat, a.lon];
        points[points.length - 1] = [b.lat, b.lon];
        out = { points, lengthNm: r.properties.length };
      }
    } catch (err) {
      warn({ err, from: a, to: b }, "sea-route: no path");
    }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(k, out);
  return out;
}
