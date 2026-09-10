// searoute-js ships no types. Only the call we make is declared.
declare module "searoute-js" {
  type PointFeature = { type: "Feature"; geometry: { type: "Point"; coordinates: [number, number] } };
  type RouteFeature = { geometry: { coordinates: [number, number][] }; properties: { length: number } };
  function searoute(origin: PointFeature, destination: PointFeature, units?: string): RouteFeature;
  export default searoute;
}
