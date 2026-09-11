// world-ports.ts — cruise ports beyond the tracker gazetteer, for itinerary resolution.
//
// ports.ts (CRUISE_LOCATIONS) is the tracker's gazetteer: it drives port-call
// detection and the forecast page's lists, so it stays small and curated. The
// operators' itineraries (Widgety archive, 646 distinct port names) reach far
// past it — Med, Northern Europe, the Gulf, Asia. This list exists ONLY to put
// a planned route on the water: a coordinate on the port's harbour is enough
// to build a leg; it is never used for "in port" detection.
//
// Coordinates are harbour/cruise-terminal positions, good to about a mile.
import { CRUISE_LOCATIONS, type CruiseLocation } from "./ports";

export interface WorldPort { slug: string; name: string; lat: number; lon: number; aliases?: string[] }

export const WORLD_PORTS: WorldPort[] = [
  // Western Med
  { slug: "wp-genoa", name: "Genoa, Italy", lat: 44.4080, lon: 8.9260, aliases: ["genova"] },
  { slug: "wp-palermo", name: "Palermo, Sicily", lat: 38.1230, lon: 13.3700 },
  { slug: "wp-valletta", name: "Valletta, Malta", lat: 35.8980, lon: 14.5130, aliases: ["malta"] },
  { slug: "wp-valencia", name: "Valencia, Spain", lat: 39.4520, lon: -0.3200 },
  { slug: "wp-ibiza", name: "Ibiza, Spain", lat: 38.9110, lon: 1.4450 },
  { slug: "wp-palma", name: "Palma de Mallorca, Spain", lat: 39.5560, lon: 2.6330, aliases: ["palma", "mallorca", "palma de mallorca"] },
  { slug: "wp-la-goulette", name: "La Goulette (Tunis), Tunisia", lat: 36.8180, lon: 10.3050, aliases: ["tunis"] },
  { slug: "wp-cannes", name: "Cannes, France", lat: 43.5500, lon: 7.0200 },
  { slug: "wp-cagliari", name: "Cagliari, Sardinia", lat: 39.2100, lon: 9.1100 },
  { slug: "wp-tarragona", name: "Tarragona, Spain", lat: 41.1080, lon: 1.2500 },
  { slug: "wp-malaga", name: "Malaga, Spain", lat: 36.7130, lon: -4.4170 },
  { slug: "wp-alicante", name: "Alicante, Spain", lat: 38.3390, lon: -0.4830 },
  { slug: "wp-cadiz", name: "Cadiz, Spain", lat: 36.5330, lon: -6.2920 },
  { slug: "wp-gibraltar", name: "Gibraltar", lat: 36.1420, lon: -5.3530 },
  { slug: "wp-cartagena-es", name: "Cartagena, Spain", lat: 37.5950, lon: -0.9850, aliases: ["cartagena (spain)", "cartagena, spain"] },
  { slug: "wp-ajaccio", name: "Ajaccio, Corsica", lat: 41.9200, lon: 8.7400 },
  { slug: "wp-olbia", name: "Olbia, Sardinia", lat: 40.9230, lon: 9.5300 },
  { slug: "wp-toulon", name: "Toulon, France", lat: 43.1150, lon: 5.9300 },
  { slug: "wp-villefranche", name: "Villefranche (Nice), France", lat: 43.7030, lon: 7.3120, aliases: ["nice", "villefranche-sur-mer"] },
  { slug: "wp-monaco", name: "Monte Carlo, Monaco", lat: 43.7350, lon: 7.4250, aliases: ["monte carlo"] },
  { slug: "wp-portofino", name: "Portofino, Italy", lat: 44.3030, lon: 9.2100 },
  { slug: "wp-trapani", name: "Trapani, Sicily", lat: 38.0170, lon: 12.5100 },
  { slug: "wp-catania", name: "Catania, Sicily", lat: 37.5000, lon: 15.0950 },
  { slug: "wp-syracuse", name: "Syracuse, Sicily", lat: 37.0620, lon: 15.2900, aliases: ["siracusa"] },
  { slug: "wp-taranto", name: "Taranto, Italy", lat: 40.4750, lon: 17.2100 },
  { slug: "wp-ancona", name: "Ancona, Italy", lat: 43.6220, lon: 13.5060 },
  { slug: "wp-ravenna", name: "Ravenna, Italy", lat: 44.4900, lon: 12.2830 },
  { slug: "wp-trieste", name: "Trieste, Italy", lat: 45.6500, lon: 13.7620 },
  { slug: "wp-bari", name: "Bari, Italy", lat: 41.1330, lon: 16.8720 },
  { slug: "wp-brindisi", name: "Brindisi, Italy", lat: 40.6440, lon: 17.9400 },
  { slug: "wp-koper", name: "Koper, Slovenia", lat: 45.5480, lon: 13.7290 },
  // Adriatic / Greece / Turkey
  { slug: "wp-split", name: "Split, Croatia", lat: 43.5060, lon: 16.4400 },
  { slug: "wp-zadar", name: "Zadar, Croatia", lat: 44.1170, lon: 15.2270 },
  { slug: "wp-kotor", name: "Kotor, Montenegro", lat: 42.4250, lon: 18.7700 },
  { slug: "wp-corfu", name: "Corfu, Greece", lat: 39.6250, lon: 19.9200, aliases: ["kerkyra"] },
  { slug: "wp-katakolon", name: "Katakolon (Olympia), Greece", lat: 37.6440, lon: 21.3190, aliases: ["katakolon", "olympia"] },
  { slug: "wp-argostoli", name: "Argostoli (Kefalonia), Greece", lat: 38.1790, lon: 20.4870, aliases: ["kefalonia", "cephalonia"] },
  { slug: "wp-chania", name: "Chania (Souda), Crete", lat: 35.4890, lon: 24.0780, aliases: ["souda", "souda bay"] },
  { slug: "wp-heraklion", name: "Heraklion, Crete", lat: 35.3440, lon: 25.1420, aliases: ["iraklion", "crete"] },
  { slug: "wp-rhodes", name: "Rhodes, Greece", lat: 36.4450, lon: 28.2270 },
  { slug: "wp-kusadasi", name: "Kusadasi (Ephesus), Turkey", lat: 37.8620, lon: 27.2560, aliases: ["ephesus"] },
  { slug: "wp-istanbul", name: "Istanbul, Turkey", lat: 41.0230, lon: 28.9830 },
  { slug: "wp-marmaris", name: "Marmaris, Turkey", lat: 36.8500, lon: 28.2700 },
  { slug: "wp-bodrum", name: "Bodrum, Turkey", lat: 37.0330, lon: 27.4300 },
  { slug: "wp-izmir", name: "Izmir, Turkey", lat: 38.4380, lon: 27.1400 },
  { slug: "wp-thessaloniki", name: "Thessaloniki, Greece", lat: 40.6300, lon: 22.9350 },
  { slug: "wp-volos", name: "Volos, Greece", lat: 39.3600, lon: 22.9450 },
  { slug: "wp-limassol", name: "Limassol, Cyprus", lat: 34.6500, lon: 33.0100, aliases: ["cyprus"] },
  { slug: "wp-haifa", name: "Haifa, Israel", lat: 32.8200, lon: 34.9950 },
  { slug: "wp-alexandria", name: "Alexandria, Egypt", lat: 31.2000, lon: 29.8800 },
  { slug: "wp-port-said", name: "Port Said, Egypt", lat: 31.2500, lon: 32.3000 },
  // Atlantic Europe / Canaries
  { slug: "wp-lisbon", name: "Lisbon, Portugal", lat: 38.7050, lon: -9.1450 },
  { slug: "wp-porto", name: "Porto (Leixoes), Portugal", lat: 41.1850, lon: -8.7000, aliases: ["leixoes", "oporto"] },
  { slug: "wp-vigo", name: "Vigo, Spain", lat: 42.2400, lon: -8.7250 },
  { slug: "wp-a-coruna", name: "A Coruna, Spain", lat: 43.3660, lon: -8.3950, aliases: ["la coruna", "coruna"] },
  { slug: "wp-bilbao", name: "Bilbao (Getxo), Spain", lat: 43.3450, lon: -3.0300, aliases: ["getxo"] },
  { slug: "wp-gijon", name: "Gijon, Spain", lat: 43.5500, lon: -5.6650 },
  { slug: "wp-la-rochelle", name: "La Rochelle, France", lat: 46.1580, lon: -1.2000 },
  { slug: "wp-le-havre", name: "Le Havre (Paris), France", lat: 49.4850, lon: 0.1070 },
  { slug: "wp-cherbourg", name: "Cherbourg, France", lat: 49.6500, lon: -1.6200 },
  { slug: "wp-funchal", name: "Funchal, Madeira", lat: 32.6450, lon: -16.9100, aliases: ["madeira"] },
  { slug: "wp-las-palmas", name: "Las Palmas, Gran Canaria", lat: 28.1400, lon: -15.4200, aliases: ["gran canaria"] },
  { slug: "wp-tenerife", name: "Santa Cruz de Tenerife, Canary Islands", lat: 28.4700, lon: -16.2450, aliases: ["tenerife", "santa cruz de tenerife"] },
  { slug: "wp-lanzarote", name: "Arrecife, Lanzarote", lat: 28.9600, lon: -13.5400, aliases: ["arrecife"] },
  { slug: "wp-fuerteventura", name: "Puerto del Rosario, Fuerteventura", lat: 28.5000, lon: -13.8600, aliases: ["puerto del rosario"] },
  // Northern Europe / Baltic / UK / Iceland
  { slug: "wp-dover", name: "Dover, England", lat: 51.1270, lon: 1.3250 },
  { slug: "wp-portsmouth", name: "Portsmouth, England", lat: 50.8000, lon: -1.1000 },
  { slug: "wp-liverpool", name: "Liverpool, England", lat: 53.4050, lon: -3.0000 },
  { slug: "wp-greenock", name: "Greenock (Glasgow), Scotland", lat: 55.9500, lon: -4.7600, aliases: ["glasgow"] },
  { slug: "wp-invergordon", name: "Invergordon, Scotland", lat: 57.6900, lon: -4.1700 },
  { slug: "wp-leith", name: "Edinburgh (Leith), Scotland", lat: 55.9800, lon: -3.1700, aliases: ["edinburgh", "south queensferry"] },
  { slug: "wp-belfast", name: "Belfast, Northern Ireland", lat: 54.6200, lon: -5.9100 },
  { slug: "wp-dublin", name: "Dublin, Ireland", lat: 53.3450, lon: -6.2000 },
  { slug: "wp-cobh", name: "Cobh (Cork), Ireland", lat: 51.8500, lon: -8.2950, aliases: ["cork"] },
  { slug: "wp-hamburg", name: "Hamburg, Germany", lat: 53.5450, lon: 9.9700 },
  { slug: "wp-kiel", name: "Kiel, Germany", lat: 54.3200, lon: 10.1400 },
  { slug: "wp-warnemunde", name: "Warnemunde (Berlin), Germany", lat: 54.1800, lon: 12.0900, aliases: ["warnemuende", "rostock", "berlin"] },
  { slug: "wp-rotterdam", name: "Rotterdam, Netherlands", lat: 51.9050, lon: 4.4850 },
  { slug: "wp-zeebrugge", name: "Zeebrugge (Bruges), Belgium", lat: 51.3300, lon: 3.2100, aliases: ["bruges", "brugge"] },
  { slug: "wp-oslo", name: "Oslo, Norway", lat: 59.9080, lon: 10.7400 },
  { slug: "wp-stavanger", name: "Stavanger, Norway", lat: 58.9700, lon: 5.7300 },
  { slug: "wp-alesund", name: "Alesund, Norway", lat: 62.4720, lon: 6.1550, aliases: ["aalesund"] },
  { slug: "wp-geiranger", name: "Geiranger, Norway", lat: 62.1010, lon: 7.2060 },
  { slug: "wp-flam", name: "Flam, Norway", lat: 60.8620, lon: 7.1130, aliases: ["flaam"] },
  { slug: "wp-tromso", name: "Tromso, Norway", lat: 69.6480, lon: 18.9550 },
  { slug: "wp-honningsvag", name: "Honningsvag (North Cape), Norway", lat: 70.9820, lon: 25.9700, aliases: ["north cape"] },
  { slug: "wp-stockholm", name: "Stockholm, Sweden", lat: 59.3250, lon: 18.1000 },
  { slug: "wp-helsinki", name: "Helsinki, Finland", lat: 60.1650, lon: 24.9550 },
  { slug: "wp-tallinn", name: "Tallinn, Estonia", lat: 59.4450, lon: 24.7650 },
  { slug: "wp-riga", name: "Riga, Latvia", lat: 56.9700, lon: 24.1000 },
  { slug: "wp-klaipeda", name: "Klaipeda, Lithuania", lat: 55.7100, lon: 21.1300 },
  { slug: "wp-gdansk", name: "Gdansk (Gdynia), Poland", lat: 54.5300, lon: 18.5500, aliases: ["gdynia"] },
  { slug: "wp-akureyri", name: "Akureyri, Iceland", lat: 65.6900, lon: -18.0900 },
  { slug: "wp-isafjordur", name: "Isafjordur, Iceland", lat: 66.0700, lon: -23.1200 },
  // Caribbean extras
  { slug: "wp-la-romana", name: "La Romana, Dominican Republic", lat: 18.4200, lon: -68.9500 },
  { slug: "wp-fort-de-france", name: "Fort-de-France, Martinique", lat: 14.6000, lon: -61.0700, aliases: ["fort de france", "martinique"] },
  { slug: "wp-pointe-a-pitre", name: "Pointe-a-Pitre, Guadeloupe", lat: 16.2300, lon: -61.5300, aliases: ["pointe a pitre", "guadeloupe"] },
  { slug: "wp-roseau", name: "Roseau, Dominica", lat: 15.3000, lon: -61.3900, aliases: ["dominica"] },
  { slug: "wp-kingstown", name: "Kingstown, St Vincent", lat: 13.1550, lon: -61.2300, aliases: ["st vincent", "saint vincent"] },
  { slug: "wp-st-georges", name: "St George's, Grenada", lat: 12.0500, lon: -61.7500, aliases: ["st georges", "grenada"] },
  { slug: "wp-port-of-spain", name: "Port of Spain, Trinidad", lat: 10.6500, lon: -61.5200, aliases: ["trinidad"] },
  { slug: "wp-philipsburg", name: "Philipsburg, St Maarten", lat: 18.0200, lon: -63.0450 },
  { slug: "wp-st-croix", name: "Frederiksted, St Croix", lat: 17.7120, lon: -64.8830, aliases: ["frederiksted", "st croix"] },
  { slug: "wp-samana", name: "Samana, Dominican Republic", lat: 19.2050, lon: -69.3350 },
  { slug: "wp-santo-domingo", name: "Santo Domingo, Dominican Republic", lat: 18.4700, lon: -69.8850 },
  { slug: "wp-havana", name: "Havana, Cuba", lat: 23.1400, lon: -82.3500 },
  { slug: "wp-colon", name: "Colon, Panama", lat: 9.3600, lon: -79.9000 },
  { slug: "wp-puerto-limon", name: "Puerto Limon, Costa Rica", lat: 10.0000, lon: -83.0300, aliases: ["limon"] },
  { slug: "wp-bimini", name: "Bimini, Bahamas", lat: 25.7300, lon: -79.2950 },
  { slug: "wp-celebration-key", name: "Celebration Key, Grand Bahama", lat: 26.5650, lon: -78.4650 },
  { slug: "wp-lookout-cay", name: "Lookout Cay at Lighthouse Point, Bahamas", lat: 24.6300, lon: -76.1600, aliases: ["lighthouse point"] },
  { slug: "wp-harvest-caye", name: "Harvest Caye, Belize", lat: 16.2200, lon: -88.6000 },
  { slug: "wp-progreso", name: "Progreso, Mexico", lat: 21.3395, lon: -89.6660 },
  // Bermuda / Canada / New England (beyond the gazetteer)
  { slug: "wp-bar-harbor", name: "Bar Harbor, Maine", lat: 44.3900, lon: -68.2050 },
  { slug: "wp-portland-me", name: "Portland, Maine", lat: 43.6560, lon: -70.2500 },
  { slug: "wp-quebec", name: "Quebec City, Quebec", lat: 46.8150, lon: -71.2000, aliases: ["quebec city"] },
  { slug: "wp-charlottetown", name: "Charlottetown, PEI", lat: 46.2350, lon: -63.1200 },
  { slug: "wp-saguenay", name: "Saguenay, Quebec", lat: 48.4300, lon: -70.8800 },
  // Pacific / Alaska extras
  { slug: "wp-icy-strait", name: "Icy Strait Point, Alaska", lat: 58.1300, lon: -135.4500, aliases: ["hoonah"] },
  { slug: "wp-whittier", name: "Whittier, Alaska", lat: 60.7750, lon: -148.6850 },
  { slug: "wp-seward", name: "Seward, Alaska", lat: 60.1200, lon: -149.4400 },
  { slug: "wp-san-pedro", name: "Los Angeles (San Pedro)", lat: 33.7400, lon: -118.2800 },
  { slug: "wp-mazatlan", name: "Mazatlan, Mexico", lat: 23.2000, lon: -106.4200 },
  { slug: "wp-kahului", name: "Kahului, Maui", lat: 20.9000, lon: -156.4700, aliases: ["maui"] },
  { slug: "wp-nawiliwili", name: "Nawiliwili, Kauai", lat: 21.9500, lon: -159.3600, aliases: ["kauai"] },
  { slug: "wp-hilo", name: "Hilo, Hawaii", lat: 19.7300, lon: -155.0600 },
  { slug: "wp-kona", name: "Kailua-Kona, Hawaii", lat: 19.6400, lon: -155.9900, aliases: ["kona", "kailua kona"] },
  // Gulf / Asia / Australia / Africa / South America
  { slug: "wp-abu-dhabi", name: "Abu Dhabi, UAE", lat: 24.5200, lon: 54.3700 },
  { slug: "wp-doha", name: "Doha, Qatar", lat: 25.2900, lon: 51.5300 },
  { slug: "wp-muscat", name: "Muscat, Oman", lat: 23.6200, lon: 58.5700 },
  { slug: "wp-tokyo", name: "Tokyo, Japan", lat: 35.6500, lon: 139.7700 },
  { slug: "wp-kobe", name: "Kobe, Japan", lat: 34.6800, lon: 135.1900 },
  { slug: "wp-busan", name: "Busan, South Korea", lat: 35.1000, lon: 129.0400 },
  { slug: "wp-shanghai", name: "Shanghai, China", lat: 31.3600, lon: 121.6500 },
  { slug: "wp-kaohsiung", name: "Kaohsiung, Taiwan", lat: 22.6100, lon: 120.2800 },
  { slug: "wp-keelung", name: "Keelung (Taipei), Taiwan", lat: 25.1300, lon: 121.7400, aliases: ["taipei"] },
  { slug: "wp-ho-chi-minh", name: "Ho Chi Minh City (Phu My), Vietnam", lat: 10.5900, lon: 107.0400, aliases: ["phu my", "saigon"] },
  { slug: "wp-laem-chabang", name: "Laem Chabang (Bangkok), Thailand", lat: 13.0800, lon: 100.8900, aliases: ["bangkok"] },
  { slug: "wp-penang", name: "Penang, Malaysia", lat: 5.4200, lon: 100.3400 },
  { slug: "wp-port-klang", name: "Port Klang (Kuala Lumpur), Malaysia", lat: 3.0000, lon: 101.4000, aliases: ["kuala lumpur"] },
  { slug: "wp-colombo", name: "Colombo, Sri Lanka", lat: 6.9500, lon: 79.8500 },
  { slug: "wp-mumbai", name: "Mumbai, India", lat: 18.9200, lon: 72.8400 },
  { slug: "wp-brisbane", name: "Brisbane, Australia", lat: -27.4400, lon: 153.1000 },
  { slug: "wp-melbourne", name: "Melbourne, Australia", lat: -37.8400, lon: 144.9300 },
  { slug: "wp-auckland", name: "Auckland, New Zealand", lat: -36.8400, lon: 174.7700 },
  { slug: "wp-noumea", name: "Noumea, New Caledonia", lat: -22.2700, lon: 166.4400 },
  { slug: "wp-cape-town", name: "Cape Town, South Africa", lat: -33.9100, lon: 18.4200 },
  { slug: "wp-durban", name: "Durban, South Africa", lat: -29.8700, lon: 31.0200 },
  { slug: "wp-port-louis", name: "Port Louis, Mauritius", lat: -20.1600, lon: 57.5000, aliases: ["mauritius"] },
  { slug: "wp-rio", name: "Rio de Janeiro, Brazil", lat: -22.8950, lon: -43.1800, aliases: ["rio de janeiro"] },
  { slug: "wp-santos", name: "Santos (Sao Paulo), Brazil", lat: -23.9500, lon: -46.3100, aliases: ["sao paulo"] },
  { slug: "wp-montevideo", name: "Montevideo, Uruguay", lat: -34.9100, lon: -56.2100 },
  { slug: "wp-valparaiso", name: "Valparaiso, Chile", lat: -33.0300, lon: -71.6300 },
  { slug: "wp-ushuaia", name: "Ushuaia, Argentina", lat: -54.8100, lon: -68.3000 },
  { slug: "wp-punta-arenas", name: "Punta Arenas, Chile", lat: -53.1600, lon: -70.9100 },
  { slug: "wp-callao", name: "Callao (Lima), Peru", lat: -12.0500, lon: -77.1400, aliases: ["lima"] },
  // Seen in the Widgety archive and missing above
  { slug: "wp-mahon", name: "Mahon, Menorca", lat: 39.8880, lon: 4.2650, aliases: ["menorca"] },
  { slug: "wp-catalina-island", name: "Catalina Island, Dominican Republic", lat: 18.3550, lon: -69.0200 },
  { slug: "wp-buzios", name: "Buzios, Brazil", lat: -22.7500, lon: -41.8800 },
  { slug: "wp-salvador", name: "Salvador de Bahia, Brazil", lat: -12.9700, lon: -38.5100, aliases: ["salvador"] },
  { slug: "wp-maceio", name: "Maceio, Brazil", lat: -9.6700, lon: -35.7200 },
  { slug: "wp-ilhabela", name: "Ilhabela, Brazil", lat: -23.7800, lon: -45.3600 },
  { slug: "wp-ilha-grande", name: "Ilha Grande, Brazil", lat: -23.1400, lon: -44.2300 },
  { slug: "wp-hellesylt", name: "Hellesylt, Norway", lat: 62.0850, lon: 6.8700 },
  { slug: "wp-syros", name: "Syros, Greece", lat: 37.4400, lon: 24.9400 },
  { slug: "wp-virgin-gorda", name: "Virgin Gorda, BVI", lat: 18.4500, lon: -64.4300 },
  { slug: "wp-la-palma", name: "Santa Cruz de La Palma, Canary Islands", lat: 28.6800, lon: -17.7700, aliases: ["la palma"] },
  { slug: "wp-st-george-bermuda", name: "St. George's, Bermuda", lat: 32.3800, lon: -64.6800 },
];

/** Three-letter port codes as the Widgety sailing refs use them (MSC…SOUSOU, NCL…-IST-BCN). */
export const SAILING_PORT_CODES: Record<string, string> = {
  MIA: "miami", FLL: "fort-lauderdale", PEF: "fort-lauderdale", PCV: "port-canaveral", CPV: "port-canaveral", MCO: "port-canaveral",
  TPA: "tampa", GLS: "galveston", MSY: "new-orleans", NYC: "new-york", BAY: "new-york", BOS: "boston", BAL: "baltimore", CHS: "charleston-sc",
  JAX: "jacksonville", ORF: "norfolk", SEA: "seattle", LAX: "los-angeles", LGB: "los-angeles", SAN: "san-diego", SFO: "san-francisco", HNL: "honolulu",
  YVR: "vancouver", SJU: "san-juan", NAS: "nassau", CZM: "cozumel", BGI: "barbados", FDF: "wp-fort-de-france", PTP: "wp-pointe-a-pitre", LRM: "wp-la-romana",
  SOU: "southampton", DVR: "wp-dover", LEH: "wp-le-havre", HAM: "wp-hamburg", KEL: "wp-kiel", WAR: "wp-warnemunde", CPH: "copenhagen", AMS: "amsterdam", RTM: "wp-rotterdam", ZEE: "wp-zeebrugge",
  BCN: "barcelona", VLC: "wp-valencia", PMI: "wp-palma", TAR: "wp-tarragona", MRS: "marseille", CEQ: "wp-cannes", GOA: "wp-genoa", LIV: "livorno", CVV: "rome-civitavecchia", CIV: "rome-civitavecchia",
  NAP: "naples", MSN: "messina", PMO: "wp-palermo", CAG: "wp-cagliari", MLA: "wp-valletta", BRI: "wp-bari", BDS: "wp-brindisi", AOI: "wp-ancona", VCE: "venice", TRS: "wp-trieste", SPU: "wp-split",
  PIR: "athens-piraeus", ATH: "athens-piraeus", IST: "wp-istanbul", MRM: "wp-marmaris", KUS: "wp-kusadasi", DBV: "dubrovnik", LIS: "wp-lisbon", MAD: "wp-funchal", LPA: "wp-las-palmas", TCI: "wp-tenerife",
  RIO: "wp-rio", SSZ: "wp-santos", BUE: "buenos-aires", MVD: "wp-montevideo", DXB: "dubai", AUH: "wp-abu-dhabi", SIN: "singapore", HKG: "hong-kong", SYD: "sydney", YOK: "yokohama", TYO: "wp-tokyo",
};
export function resolvePortCode(code: string | null | undefined): ResolvedPort | null {
  if (!code) return null;
  const slug = SAILING_PORT_CODES[code.toUpperCase()];
  if (!slug) return null;
  const g = byGazSlug.get(slug);
  if (g) return { slug: g.slug, name: g.name, lat: g.lat, lon: g.lon };
  const w = WORLD_PORTS.find((p) => p.slug === slug);
  return w ? { slug: w.slug, name: w.name, lat: w.lat, lon: w.lon } : null;
}

/** Provider spellings that map onto a GAZETTEER slug (ports.ts). */
const GAZETTEER_ALIASES: Record<string, string> = {
  "civitavecchia": "rome-civitavecchia", "rome": "rome-civitavecchia", "rome (civitavecchia)": "rome-civitavecchia",
  "piraeus": "athens-piraeus", "athens": "athens-piraeus", "athens (piraeus)": "athens-piraeus",
  "isla de roatan": "roatan", "roatan": "roatan", "mahogany bay": "roatan",
  "puerto plata": "amber-cove", "amber cove": "amber-cove", "taino bay": "amber-cove",
  "bridgetown": "barbados", "castries": "st-lucia", "basseterre": "st-kitts", "philipsburg": "st-maarten",
  "st. john's": "antigua", "st johns": "antigua", "saint john's": "antigua",
  "charlotte amalie": "st-thomas", "st. thomas": "st-thomas", "st thomas": "st-thomas",
  "george town": "grand-cayman", "georgetown": "grand-cayman", "grand cayman": "grand-cayman",
  "oranjestad": "aruba", "willemstad": "curacao", "kralendijk": "bonaire",
  "ocean cay": "ocean-cay", "ocean cay msc marine reserve": "ocean-cay",
  "great stirrup cay": "great-stirrup", "cococay": "cococay", "perfect day at cococay": "cococay",
  "half moon cay": "halfmoon-cay", "castaway cay": "castaway-cay", "princess cays": "princess-cays",
  "freeport": "freeport-bahamas", "nassau": "nassau", "cozumel": "cozumel", "costa maya": "costa-maya", "mahahual": "costa-maya",
  "belize city": "belize-city", "belize": "belize-city", "cartagena": "cartagena", "cartagena (colombia)": "cartagena",
  "kings wharf": "bermuda", "king's wharf": "bermuda", "bermuda": "bermuda", "royal naval dockyard": "bermuda",
  "san juan": "san-juan", "key west": "key-west", "miami": "miami", "fort lauderdale": "fort-lauderdale", "port everglades": "fort-lauderdale",
  "port canaveral": "port-canaveral", "orlando": "port-canaveral", "tampa": "tampa", "galveston": "galveston", "new orleans": "new-orleans",
  "new york": "new-york", "new york city": "new-york", "manhattan": "new-york", "brooklyn": "new-york", "cape liberty": "new-york", "bayonne": "new-york",
  "boston": "boston", "baltimore": "baltimore", "charleston": "charleston-sc", "jacksonville": "jacksonville", "norfolk": "norfolk",
  "seattle": "seattle", "vancouver": "vancouver", "victoria": "victoria-bc", "juneau": "juneau", "ketchikan": "ketchikan", "skagway": "skagway", "sitka": "sitka",
  "los angeles": "los-angeles", "long beach": "los-angeles", "san diego": "san-diego", "san francisco": "san-francisco",
  "honolulu": "honolulu", "ensenada": "ensenada", "cabo san lucas": "cabo-san-lucas", "puerto vallarta": "puerto-vallarta",
  "southampton": "southampton", "amsterdam": "amsterdam", "copenhagen": "copenhagen", "reykjavik": "reykjavik",
  "barcelona": "barcelona", "marseille": "marseille", "livorno": "livorno", "la spezia": "la-spezia", "naples": "naples", "napoli": "naples",
  "messina": "messina", "salerno": "salerno", "venice": "venice", "venezia": "venice", "dubrovnik": "dubrovnik", "mykonos": "mykonos", "santorini": "santorini",
  "bergen": "bergen", "halifax": "halifax", "sydney (nova scotia)": "sydney-ns", "saint john": "saint-john-nb", "newport": "newport-ri",
  "dubai": "dubai", "singapore": "singapore", "hong kong": "hong-kong", "yokohama": "yokohama", "sydney": "sydney", "buenos aires": "buenos-aires",
  "bali": "bali", "benoa": "bali", "phuket": "phuket", "bora bora": "bora-bora", "montego bay": "montego-bay", "ocho rios": "ocho-rios", "falmouth": "falmouth-jamaica",
  "grand turk": "grand-turk", "labadee": "labadee", "tortola": "tortola", "road town": "tortola", "st. maarten": "st-maarten", "st maarten": "st-maarten", "sint maarten": "st-maarten",
  "antigua": "antigua", "barbados": "barbados", "st. lucia": "st-lucia", "st lucia": "st-lucia", "st. kitts": "st-kitts", "st kitts": "st-kitts", "aruba": "aruba", "curacao": "curacao", "bonaire": "bonaire",
  "progreso": "progreso", "nice": "wp-villefranche",
  "venice-marghera": "venice", "venice marghera": "venice", "marghera": "venice",
  "st john s": "antigua", "st. john's (antigua)": "antigua",
  "las palmas de g.canaria": "wp-las-palmas", "las palmas de gran canaria": "wp-las-palmas",
  "arrecife de lanzarote": "wp-lanzarote", "cefalonia": "wp-argostoli",
  "bermuda: royal naval dockyard": "bermuda",
  "hoonah": "wp-icy-strait", "icy strait point": "wp-icy-strait",
};

/** Names that are not ports at all (Widgety writes a country when the day has no port, or for a sea day). */
const NOT_A_PORT = new Set(["italy", "spain", "france", "greece", "united states", "bahamas", "croatia", "germany", "turkey", "malta", "portugal", "norway", "denmark", "sweden", "finland", "estonia", "netherlands", "belgium", "united kingdom", "ireland", "iceland", "mexico", "canada", "japan", "china", "australia", "new zealand", "brazil", "argentina", "chile", "uruguay", "south africa", "india", "thailand", "vietnam", "malaysia", "singapore ", "uae", "united arab emirates", "oman", "qatar", "egypt", "israel", "cyprus", "montenegro", "slovenia", "tunisia", "morocco", "at sea", "sea day", "cruising", "days at sea", "day at sea"]);

export interface ResolvedPort { slug: string; name: string; lat: number; lon: number }

function norm(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’'`]/g, "'").replace(/\s+/g, " ").trim();
}
const byGazSlug = new Map<string, CruiseLocation>(CRUISE_LOCATIONS.map((l) => [l.slug, l]));
const worldIndex = new Map<string, WorldPort>();
for (const w of WORLD_PORTS) {
  worldIndex.set(norm(w.name.split(",")[0]!.split(" (")[0]!), w);
  worldIndex.set(norm(w.name), w);
  for (const a of w.aliases ?? []) worldIndex.set(norm(a), w);
}
const gazIndex = new Map<string, CruiseLocation>();
for (const l of CRUISE_LOCATIONS) {
  gazIndex.set(norm(l.name), l);
  gazIndex.set(norm(l.name.split(",")[0]!.split(" (")[0]!.split(" /")[0]!), l);
}

/** A provider's port name → a coordinate we can route to; null for sea days, countries and unknowns. */
export function resolvePortName(raw: string): ResolvedPort | null {
  const n = norm(raw);
  if (!n || NOT_A_PORT.has(n)) return null;
  const aliased = GAZETTEER_ALIASES[n];
  if (aliased) {
    const g = byGazSlug.get(aliased);
    if (g) return { slug: g.slug, name: g.name, lat: g.lat, lon: g.lon };
    const w = WORLD_PORTS.find((p) => p.slug === aliased);
    if (w) return { slug: w.slug, name: w.name, lat: w.lat, lon: w.lon };
  }
  const g = gazIndex.get(n);
  if (g) return { slug: g.slug, name: g.name, lat: g.lat, lon: g.lon };
  const w = worldIndex.get(n);
  if (w) return { slug: w.slug, name: w.name, lat: w.lat, lon: w.lon };
  // "Palma de Mallorca (Spain)" / "Genoa, Italy" style: try the part before a bracket or comma.
  const head = n.split(" (")[0]!.split(",")[0]!.trim();
  if (head !== n) return resolvePortName(head);
  return null;
}
