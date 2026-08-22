# NCL in-session deck-plan reading (proven on Luna deck 12, 2026-08-21)

Zero-API method. Sources: Widgety deck-plan PNGs/JPGs (urls in ncl/deck_image_urls.json).
DB slug vs widgety slug differ for three ships: norwegian-luna↔norwegian-luna-ship,
norwegian-star↔norwegian-star-ship, norwegian-sun↔norwegian-sun-ship.

1. Targets: awk -F, '$1=="<db-slug>" {print $2","$3}' "/Users/millh_y3006x1/Desktop/Claude Local/remaining-cabin-rooms.csv"
2. curl the deck image (quote URLs — they contain spaces; %20-encode).
3. LEGEND: every NCL deck image carries its own category-chip column on the LEFT edge
   (small coloured squares with 2-char codes, text rotated). Build/extend
   ncl/<db-slug>.legend.json = {"RRGGBB": ["CODE","Category"], ...}.
   - Zoom the chip column (PIL crop + resize 4x, add a grid overlay if needed), read the
     codes with your eyes, sample each chip's colour at its CENTRE with a SMALL window
     (the two chip columns sit ~12px apart at native scale — a wide window bleeds into
     the neighbour; sample ±4px and verify each colour visually plausible).
   - Category NAME by code family, matching the ship's existing DB names
     (Balcony / Inside / Oceanview / Studio / The Haven / Club Balcony Suite):
     H* = The Haven · M*/S* = Club Balcony Suite · B* = Balcony · O* = Oceanview ·
     I* = Inside · T* = Studio. (Older ships may use different letters — if unsure of a
     family, check the ship's existing categories in the DB or SKIP.)
   - Luna's legend already exists (ncl/norwegian-luna.legend.json) — reuse for Luna and
     as a colour reference for Prima-class (Aqua/Viva/Prima likely near-identical).
4. LOCATE each target: crop+zoom regions, verify the cabin number DIGIT BY DIGIT.
   NCL numbers print inside their coloured block, often rotated 90°.
5. SAMPLE: strip_tools.py sample <image> ncl/<db-slug>.legend.json "NUM:x:y" ...
   (normalized coords INSIDE the block; strip_tools lives in this directory).
   White cutoff is 740 (NCL's palest Haven chip sums 717 — do NOT lower back to 690).
   Votes < 30 or NO MATCH → re-place; consistent off-legend colour → extend the legend
   from THIS deck's own chip column (per-deck legends list only that deck's categories);
   if still unresolvable, SKIP with the hex + evidence. NEVER guess.
6. WRITE per ship+deck: JSON {"cabin":["CODE","Category"],...} → scp to saf-dev:/tmp/ →
   ssh saf-dev 'cd /root/saf-full/server && set -a; . /opt/stillafloat/shared.env; set +a; node write_batch.mjs <db-slug> <deck> "Claude in-session read of the Widgety deck plan (NCL chip legend), colour snapped deterministically, 2026-08-21" < /tmp/<file>.json'
   (write_batch touches only view-null rows.)
SAFETY: dev DB only; never ALLOW_PROD; no repo edits outside ncl/<slug>.legend.json;
use UNIQUE /tmp filenames prefixed with your ship slug (concurrent agents!).

## Breakaway-Plus addendum (learned 2026-08-21, Bliss/Encore/Joy)
These ships' Widgety strips carry NO chip column (cropped to the hull). Fallback:
build the legend from the ship's OWN DB-known cabins (view set, category filled) —
sample 4+ labeled anchor cabins per colour on the ship's own deck images, then snap
targets as usual. Note the anchor count in the write provenance. Watch the aft-taper
teal (~#31566B): it sits Δ22 from CBS navy (#2C4967) — always anchor it, never assume.
Also: strip_tools.py lives in cabin-advisor/ (one level up from ncl/), run it with the
saf-runtime venv python (system python lacks fitz).

## Older-scan addendum (Star/Dawn/Sun/Sky, 2026-08-21)
No chip column or printed key anywhere in these JPG sets. Working adaptation:
DB-anchor legends (≥2 independent unanimous same-colour anchors, identity-sound) +
run-pinned numbering (long gap-free category sequences pin DB↔plan alignment).
Hazards recorded in the legend code strings: Star/Dawn grey #E4E4E4 is Inside ONLY in
hull-isolated rows (bow Oceanviews print the same grey); Sun/Sky brick/olive/steel-blue/
pale-pink lack clean anchors — settle those from NCL's live keyed plans, never colour alone.
Widgety cabin lists drift at bow/stern roundings on these ships.

## MSC addendum (World Atlantic agent, 2026-08-21)
- If a ship's deck_image_urls.json entry is a single "<Ship> Deck Plan.png", it may be only
  the 300px COVER THUMBNAIL of a brochure — check widgety-archive/<slug>/ship.json
  `attachments[]` for the full "<Ship> Deck Plan.pdf" (Atlantic's is 6 pages, vector).
  widgety-archive "deckplans/" folders are PORT MAPS, not deck plans.
- MSC brochure PDFs beat colour-guessing twice over: page 1 IS a printed legend (grade
  code + name + deck range, row-bar fill = the plan colour — read fills via
  page.get_drawings()), and pages carry a TEXT LAYER (get_text("words") gives every cabin
  number + bbox; no OCR, no digit-verify needed). Decks are page columns — split by the
  "DECK n" label x positions.
- DB names collapse MSC grades: greens (BGA/BA/BR*/BP/PV/PR*)→Balcony; oranges
  (SX*/SL*/SRP)→Family Suite; VLA/VL1→Infinite Ocean View; OR*/OS→Ocean View;
  IR*/IS→Interior; YC4/YC3/YD3/YJD/YCD/YC1→MSC Yacht Club Deluxe. Anchor-corroborated on
  Atlantic (2291 anchors; DB has ~1-9% per-colour mislabel noise — majority + printed
  legend must agree).
- ⚠ YIN (MSC Yacht Club Interior Suite, pale grey ~#D5D5D2) has NO settled DB name:
  America collapsed it to "MSC Yacht Club Deluxe", Europa kept "MSC Yacht Club Interior",
  Asia is null. SKIP YIN cabins (Atlantic 16012/16014/16018 + DB-absent 15004-15014)
  until Mark picks the convention.
- ⚠ Black digit strokes sit Δ40 from BGA #002800 — a mostly-off-legend block (e.g. YIN)
  can false-snap to BGA/dark browns on <30 votes. The votes<30 rule catches it; also
  sanity-check every snap against the printed deck range for its code.
- Duplex YC suites print on TWO deck columns (16001-16008 on decks 16+18); DB splits them
  arbitrarily between the decks — write against the DB's deck, sample either instance.

## Extra sources + hazards (Breakaway-class agent, 2026-08-21)
- ~/Desktop/Claude Local/widgety-archive/<ship>/ship.json = the operator's grade roster +
  per-deck category lists (no cabin-precise placement — class-generic in spots). Good for
  proving a grade exists/doesn't (e.g. no "Spa" grade on Breakaway-class today).
- norwegian-breakaway "Deck 13" Widgety asset is byte-identical to Deck 12 (md5 c28ac443…) —
  deck-13 reads need another source.

## MSC World-class addendum (World Asia agent, 2026-08-21)
The Widgety STRIPS have no legend, but ship.json (widgety-archive) attachments carry the
operator's full deck-plan PDF — and that PDF HAS a printed legend page (grade code + deck
band per colour bar) AND every cabin number as vector text. Skip pixel-reading entirely:
fitz get_text("words") -> smallest containing filled rect -> exact legend hex. 2583/2583
numbers resolved that way; cross-check a few cells per write-group against the PNG strips
for version drift (2025 PDF vs 2026 strips agreed everywhere).
Hazards burned into msc-world-asia.legend.json:
- The DB import zone-matched, so isolated DB labels INSIDE a foreign colour run are junk
  (Owner's Suite 18001='Interior', 9026-9055 green='YC Deluxe', 12100-12116 even/odd
  pair-swaps, bow 10001-4/11001-4 OR-colour='Infinite Ocean View'). Anchor on unanimous
  RUNS, never lone labels; msc-world-europa is hand-curated and is the tiebreak precedent.
- Grades with no ship-DB name (Studio OS/IS, YC Interior YIN, YC suite tiers YC3/YC4/
  YJD/YCD/YD3) were SKIPPED — Europa's names exist ('Studio', 'MSC Yacht Club Interior',
  'MSC Yacht Club Royal Suite', ...) but adopting them for a ship that lacks them is
  Mark's call, not the agent's.
- Widgety truncates some numbers (DB 4001/4002 on deck 14 = plan 14001/14002; also
  10117/14517 vs printed 10097/10101/15520/15535 drift). Duplex suites print TWICE
  (lower deck 16 + upper deck 18) with the same fill.

## MSC round-2 addendum (audit of already-labeled rows, 2026-08-21)
- YC fleet-name convention, settled by America's rows + Europa's hand-curation (both agree):
  YC1→"MSC Yacht Club Deluxe" · YIN→"MSC Yacht Club Interior" · YCD→"MSC Yacht Club Duplex
  Suite" · YJD→"MSC Yacht Club Whirlpool Duplex" · YC3→"MSC Yacht Club Royal Suite" ·
  YC4→"MSC Yacht Club Owners Suite". (Any summary list that omits Whirlpool Duplex is
  shorthand — the DB convention has six YC names.)
- ⚠ YD3 ("MSC Yacht Club Royal Duplex Suite with Whirlpool Bath", 6F5946) exists ONLY on
  Atlantic (America/Europa print YC1 at the same cabin numbers 16024/26/28/30). NO fleet
  name exists — Atlantic's four YD3 rooms were LEFT as 'MSC Yacht Club Deluxe' pending
  Mark's naming pick. Do not collapse them silently.
- The shared 98C899 green disambiguates on the plan itself: Promenade-view cabins (PV/PR*)
  carry a printed "P" chip in the cell; BP (Partial View) cells have no P and sit outboard
  beside grey obstruction blocks. No more BP-vs-PR guessing.
- Deck-14 bow studio pattern is identical Asia/Atlantic: 14001/14002 = IS Studio Interior
  (F7E3F0 renders near-white — don't read it as 'no fill'), 14006/14010 + 14005/14009 = OS.
  Asia DB rows '4001'/'4002' are Widgety truncations of plan 14001/14002.
- audit_write.mjs touches category ONLY. Rows flipped to Interior-family in round 2 still
  hold view='ocean' from the old label (asia 9028-9052 evens, asia 4001; atlantic
  14001/14002, 14056) — open follow-up, needs a view-column pass.

## Carnival close-out addendum (last-17 agent, 2026-08-21)
- Vista-class STRIPS ARE EMBEDDED JPEGs (only the legend is vector) — page.get_drawings()
  finds nothing under cabins, and page 1 of the 2-page posters is a GREYSCALE twin (useless
  for colour). Sample pixels at 10x off page 0 only.
- ⚠ F0 "Family Harbor Aft-View Extended Balcony" (Horizon/Panorama d2 transom row) renders
  in the strip raster as ~879EA4, NOT its printed chip 6C7B7C — Δ~100, while every other FH
  grade matches its chip ≤20 on the same strip. It false-snaps to FS 879CBC (Δ26)! Split on
  HUE: F0/tint has G≈B (teal), FS has B−G≈+32 (blue), and the strip's true-FS ∞ rows print
  879CBC exactly. Both legends now carry the tint hex. Vista has NO F0 grade — its identical
  transom row is FE orange (Family Harbor Ocean View), exact chip match.
- The printed FH legend line is "F0 Family Harbor Aft-View Extended Balcony" (already
  branded) — the legend parser prepends the brand again. Doubled name fixed in both legend
  files; panorama d2 2488 still holds the doubled string in the DB (cleanup flagged).
- Stern-row DB labels from the 8x API pipeline are systematically junk on Vista-class decks
  2/7/8/9 (rotated digits → misplaced samples): rows like Horizon 7459/7463/7465/7467,
  8461/8465/8470, 9471, d2 2484-2505 hold 9B/8E/6L/"Ocean View" where the posters print
  HI/HM/F0/FE. Only the null rows were in-scope 8/21; the mislabels are reported, not fixed.
- ⚠ VENEZIA-CLASS NUMBERING DIVERGES FROM THE POSTER: Firenze/Venezia DB rows 8426-8432
  (evens, "Balcony") DO NOT EXIST on the operators' posters (port hull runs 8422→8434
  directly, digit-verified) and DB 8420/8424 "Balcony" print as inner-column INTERIORS.
  The ships' DB room list for that zone came from another numbering scheme (Costa?). Do not
  poster-fill those numbers — portal items. SAME on d2 (final-closure agent 2026-08-21):
  poster evens top out at 2482 (transom arc = 2476-2482 + 2495-2503, all 8M A6A1A6 exact;
  corners 2493/2472 6A) — DB rows 2484/2486 (both ships) and 2488 (Firenze only, "Havana")
  are phantoms; Firenze d2 2488 left unwritten.
- Norwegian Sky aft template: pale-pink corner block with "+" = SD Aft-Facing Penthouse
  (4/4 portal anchors 8277/9075/10064/10264, deck 10 BOTH corners); the pine ▲ stack
  between the corners = Inside (345962). Sky 8078 is PINE (Inside — import had view=ocean,
  flipped); Sky 8077 "Oceanview" is blank-provenance import junk of the same pale-pink-+
  template — portal item.

## Excel-class final-closure addendum (2026-08-21)
- Excel posters (Mardi Gras/Celebration/Jubilee) share ONE layout: page 0 colour, vertical
  strips forward-at-top, deck-label row at y≈747 gives column x's; legend chips are VECTOR
  (get_drawings) even though strips are raster. Strip SS teal renders ~019BA3-009CA5 vs
  printed chip 00AAAC (Δ25) — anchor on same-strip DB-known SS rooms (17229/17233 pattern);
  hue splits it: SS teal B−G≈+8, OS blue B−G≈+35, 4A green B−G≈−40.
- Legend JSONs were missing HE (printed "HE Cabana" under Havana; chip 009CD8 — sits Δ~57
  from 4N 007DBE, watch it) and held the doubled "Havana Havana Extended Cabana" for HG.
  Both fixed in all three carnival/<slug>.legend.json 2026-08-21.
- ⚠ MARDI GRAS GHOST ROWS (Venezia-precedent): DB d14 14508 + d15 15486/15488 DO NOT EXIST
  on the operator's poster — stern runs digit-verified contiguous around them (d14 evens
  end 14496→transom 14498-14504; d15 prints 15484/15485/15487/15489 with no 15486/15488).
  The ghosts sit wedged between real rows; left unwritten, portal items.
- MG/Excel stern-zone NEIGHBOUR labels are 8x-pipeline junk (transom 8N orange held as
  "Cove Balcony", pale-blue LS corners as "Interior view=none", Jubilee d17 17258-17269
  teal/blue held as "Interior") — reported, not in the null-row scope.

## Zone-sweep closure addendum (stern/spa zones + Venezia d8, 2026-08-21)
All four reported zones SWEPT AND WRITTEN on dev (audit_write + a view/real_ocean/tier
alignment pass; provenance "Claude zone-sweep ... 2026-08-21"). Facts for future agents:
- MG d14/d15 stern: transom = 8N (14500-04/14519-23, 15480-82/15497-99), corners = LS
  (14498/14517, 15478/15495). Extras found IN-zone: 15484/15501 = 4O (dark grey pair),
  15485 = 4H green inner (its 8x "8E" src was junk), 15476/15493 = 6B. Ghosts 14508 +
  15486/15488 re-confirmed digit-by-digit; left untouched (still hold "Family Harbor").
- ⚠ 6B-vs-8A strip drift (MG poster): raw ~B66BA6 sits Δ32/Δ34 from both chips — split on
  the G channel with same-poster anchors (6B renders G≈0x62-0x71 vs A562A5 @d5 5216-5224;
  8A renders G≈0x4F vs BA4F95 @d9 9220-9236). Celebration's poster has NO such drift
  (6B prints 9F66AA exact).
- Excel d17 = the spa deck, and the WHOLE deck was scrambled, not just the reported four:
  85/88 rooms per ship corrected on Jubilee AND Celebration (identical class raster).
  Layout: bow 17201-08 = 8V (strip tint ~99CC55, a dulled 96ED5D lime — split from 8D by
  sampling a true-8D run: d12 12489-12505 renders ~9BB45C); 17209/10 = SV exact 867A85;
  hull/aft runs = 8P; inners = 4T; 17229/33 + 17258/67/84/93 = SS (double-width teal;
  the DB's "LS"/"8M" labels there were junk). SS/SV/LS tiers: suite=4, SV=5, 8V/8P=3.
- Celebration stern ≠ MG stern (sister assumption is FATAL): its d14 corners/transom are
  14506/14525-LS + 14508/10/12/27/29/31-8N, magentas 14504/14523 = 6B, and 14486's
  "SV (legend line)" src was junk (prints plain 8E). Poster rooms MISSING from DB:
  d14 14510/14512/14525/14527/14529/14531, d15 15490/15492/15503/15505/15507/15509 —
  portal items, NOT poster-fillable via audit_write (row absent).
- Venezia-class d8 (Firenze+Venezia, identical): bow section 8201-8256 (8C pink hull /
  4F blue inner) was CORRECT in DB; everything aft of 8257 was systematically scrambled —
  112/111 rooms corrected per ship (8D green hull / 4G yellow inner mid-zone, 8C/4F aft,
  TM corners 8489/8484, TI transom, 9B 8485/8480). GHOSTS confirmed digit-by-digit on
  BOTH posters: 8291/8293/8295/8297/8299, 8313, 8426/8428/8430/8432 (port runs jump
  8287→8301, 8311→8317, 8422→8434; inner 8289→8305, 8424→8440). Poster rooms MISSING
  from DB: 8478/8480/8482-8493 evens+odds as printed + printed cell "8505" (sits between
  8493 and 8490 on the transom — more Costa-numbering residue). Ghosts left untouched.
- Grey machinery voids false-snap to 8E DBD1CD (Δ22) and corridor beige gets within Δ43 —
  never trust an 8E/large-vote snap that sits between rows; row-scan bands (modal colour
  per x, mapped to the digit-verified cell ORDER) beat per-cell point sampling on dense
  strips.

## Final-closure addendum (bow sweep + missing-room creates, 2026-08-21)
- Excel-class BOW family CLOSED on dev (MG/Celebration/Jubilee, d14+d15, identical prints
  on all three posters): x201-x209-odd/evens = 8L 66885B stack (8/deck), x210/x211 (d14)
  and x209/x210 (d15) = KS 71C385 corners, first hull cells aft of the corners
  (14212/14215, 15211/15212) = 4O 7E7E7E. 72 rows corrected (Ocean View→8L/KS,
  Interior→4O) + tiers aligned 8L=3, KS=4 (suite tier per LS/SS precedent). 14203 = 4G
  yellow (DB was already right — don't "fix" it).
- Celebration stern creates (12): d14 14510/14512-8N-port, 14525-LS-stbd,
  14527/29/31-8N-stbd; d15 15490-8N-port, 15503-LS-stbd, 15505/07-8N-stbd, and ⚠
  15509/15492 print DARK-GREY 4O INTERIOR (not 8N — the number-sequence assumption lies;
  they're the aft inner pair). Anchors 14508/15488 (8N) + 14506/15486 (LS) all agreed.
- Venezia-class d8 Terrazza block creates (14/ship, Firenze+Venezia identical): inners
  8478/8482/8483/8487 = 4F; stair-wrap cells 8480/8485 = 9B D8E1DF (digit-verified at 40x;
  raw modal D7E0DF-DBE4E3 — cool G≈B cast splits it from 8E DBD1CD); transom arc
  8486/8488/8490/8505/8493/8491 = TI DD5C3C exact; corners 8484/8489 = TM A64746.
  "8505" is DIGIT-CERTAIN on BOTH posters (8-5-0-5 at 40x, contrasted vs 8490/8493 digit
  shapes) — more Costa residue; NO 8492 prints anywhere. Tier call: TI/TM/9B = 3 (Terrazza
  grades are balconies, not suites; 9B's 34 existing rows are all tier 3), 4F = 1.
  Side: odds=stbd/evens=port; 8505 straddles centre → side "center".
- Open observation (mid-hull, NOT fixed): 14235 prints 6B 9F66AA exact on ALL THREE Excel
  posters (votes 42-62) while DB holds "Balcony" on all three ships — same 8x junk family,
  needs its own sweep. Celebration 14523/14504 left as prior sweep's 6B call.
