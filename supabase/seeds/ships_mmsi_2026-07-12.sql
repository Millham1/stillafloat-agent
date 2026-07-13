-- ships_mmsi_2026-07-12.sql — AIS identifiers for the 28 curated ships.
-- Every MMSI/IMO pair verified against two agreeing trackers (VesselFinder +
-- MarineTraffic/vesseltracker) on 2026-07-12; MID country prefixes match each
-- ship's current flag. Two reflaggings caught during verification (stale MMSIs
-- widely cached elsewhere — do not "correct" these backward):
--   • MSC Seaside → Malta 248392000 (old 371029000/247387700 are stale)
--   • Navigator of the Seas → Cyprus 210662000 as of Apr 2026 (old 311478000)
-- Apply DEV first, then PROD with the 0004 migration promotion.

UPDATE public.ships SET mmsi='311001223', imo='9837456' WHERE name='Carnival Celebration';
UPDATE public.ships SET mmsi='370039000', imo='9767091' WHERE name='Carnival Horizon';
UPDATE public.ships SET mmsi='311001390', imo='9851737' WHERE name='Carnival Jubilee';
UPDATE public.ships SET mmsi='374527000', imo='9802384' WHERE name='Carnival Panorama';
UPDATE public.ships SET mmsi='311001049', imo='9837444' WHERE name='Mardi Gras';
UPDATE public.ships SET mmsi='256191000', imo='9838400' WHERE name='Celebrity Ascent';
UPDATE public.ships SET mmsi='215808000', imo='9838395' WHERE name='Celebrity Beyond';
UPDATE public.ships SET mmsi='311058700', imo='9445590' WHERE name='Disney Fantasy';
UPDATE public.ships SET mmsi='311001098', imo='9834739' WHERE name='Disney Wish';
UPDATE public.ships SET mmsi='246648000', imo='9378450' WHERE name='Nieuw Amsterdam';
UPDATE public.ships SET mmsi='311001063', imo='9187796' WHERE name='Margaritaville at Sea Islander';
UPDATE public.ships SET mmsi='311000969', imo='8716502' WHERE name='Margaritaville at Sea Paradise';
UPDATE public.ships SET mmsi='249973000', imo='9760512' WHERE name='MSC Meraviglia';
UPDATE public.ships SET mmsi='256059000', imo='9843807' WHERE name='MSC Seascape';
UPDATE public.ships SET mmsi='248392000', imo='9745366' WHERE name='MSC Seaside';
UPDATE public.ships SET mmsi='311000879', imo='9751511' WHERE name='Norwegian Encore';
UPDATE public.ships SET mmsi='311018500', imo='9410569' WHERE name='Norwegian Epic';
UPDATE public.ships SET mmsi='311050900', imo='9606924' WHERE name='Norwegian Getaway';
UPDATE public.ships SET mmsi='366994450', imo='9209221' WHERE name='Pride of America';
UPDATE public.ships SET mmsi='310423000', imo='9215490' WHERE name='Caribbean Princess';
UPDATE public.ships SET mmsi='310812000', imo='9837468' WHERE name='Discovery Princess';
UPDATE public.ships SET mmsi='310780000', imo='9802396' WHERE name='Sky Princess';
UPDATE public.ships SET mmsi='311001178', imo='9829930' WHERE name='Icon of the Seas';
UPDATE public.ships SET mmsi='309374000', imo='9349681' WHERE name='Independence of the Seas';
UPDATE public.ships SET mmsi='210662000', imo='9227508' WHERE name='Navigator of the Seas';
UPDATE public.ships SET mmsi='311000660', imo='9744001' WHERE name='Symphony of the Seas';
UPDATE public.ships SET mmsi='311001033', imo='9838345' WHERE name='Wonder of the Seas';
UPDATE public.ships SET mmsi='311000807', imo='9804801' WHERE name='Scarlet Lady';
