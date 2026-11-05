-- Package table, second read (Mark 2026-11-05: "how can we analyze without the actual numbers").
-- Every non-Margaritaville row of 0067 was re-read against the line's own page text (not a summary).
-- The numbers in 0067 all matched; these are the lines the first read dropped, and the prices the pages print.

-- Celebrity: the page's Classic Drinks sentence lists more than the first read kept
update public.package_inclusions
   set inclusions = array[
         'Classic Drinks Package: unlimited beers, spirits, cocktails, liqueurs, frozen drinks and wines by the glass, plus bottled water, sodas, premium coffees and teas',
         'Unlimited Basic Wi-Fi (web, email and messaging)'],
       notes = 'Sold only at booking, as a fare; cannot be added later. All guests in the stateroom take the same rate. The line''s page gives no per-serving cap and says nothing about tips; check both before telling a guest.',
       updated_at = now()
 where cruise_line = 'Celebrity Cruises' and package_name = 'All Included';

-- Norwegian: the comparison chart's bottle discount
update public.package_inclusions
   set inclusions = array[
         'Open bar: unlimited premium spirits, cocktails, wines, draft beer, juice and soda',
         '20% off all bottles of champagne and wine',
         'Specialty dining: 1 meal on 2- to 4-night, 2 on 5- to 6-night, 3 on 7- to 8-night, 4 on 9-night and longer cruises',
         '$50 shore excursion credit at every port (first guest on the reservation)',
         '150 minutes of Wi-Fi per guest'],
       notes = 'Open bar is for guests 21+; gratuities on the bar and dining packages are pre-paid on top. Bought on board instead, the open bar is $45 per person per day plus 20% gratuity. Guests 3 and 4 sailing free is a separate offer.',
       updated_at = now()
 where cruise_line = 'Norwegian Cruise Line' and package_name = 'Free at Sea';

update public.package_inclusions
   set inclusions = array[
         'Everything in Free at Sea',
         'Unlimited streaming high-speed Wi-Fi',
         'Top-shelf spirits',
         'Premium wines and champagne by the glass (over 50 labels) and 40% off all other bottles',
         'Unlimited Starbucks coffee (one drink per visit)',
         'Bottled water at the bar and premium bottled water in restaurants',
         '50% off the cover charge on additional specialty dining nights',
         'Prepaid daily service charges'],
       notes = '$49.99 per person, per day; $15 a day less when the service charges are already prepaid; $40 a day for guests under 21. The prepaid daily service charges do not cover bar, beverage or specialty dining gratuities.',
       updated_at = now()
 where cruise_line = 'Norwegian Cruise Line' and package_name = 'Free at Sea Plus';

-- Carnival: the prices and caps the pages print
update public.package_inclusions
   set notes = 'Up to 15 alcoholic drinks per person per 24 hours. $69.95 per person per day bought before sailing, $74.95 on board, plus a 20% service charge; whole cruise only. Not covered: room service, souvenir glasses, drinks bought in port (incl. Half Moon Cay and Princess Cays).',
       updated_at = now()
 where cruise_line = 'Carnival Cruise Line' and package_name = 'CHEERS!';

update public.package_inclusions
   set notes = 'CHEERS! here is up to 15 alcoholic drinks a day, each up to $20. Service charges on the pack''s own drinks and dining are in the FunPack price. The dining benefit cannot be put toward a dearer restaurant; an excursion over $100 is paid by the difference.',
       updated_at = now()
 where cruise_line = 'Carnival Cruise Line' and package_name = 'Epic FunPack';

update public.package_inclusions
   set notes = 'CHEERS! Social is unlimited non-alcoholic drinks plus the first three alcoholic drinks each day, each up to $20. Service charges on the pack''s own drinks and dining are in the FunPack price.',
       updated_at = now()
 where cruise_line = 'Carnival Cruise Line' and package_name = 'Social FunPack';

update public.package_inclusions
   set notes = 'The $25 and $50 are credits toward one pre-cruise purchase each, on an item priced above the credit. Service charges on the pack''s own drinks are in the FunPack price.',
       updated_at = now()
 where cruise_line = 'Carnival Cruise Line' and package_name = 'ZeroProof FunPack';

-- Princess: the chart's prices
update public.package_inclusions
   set notes = '$70 per person per day bought 4 or more days before sailing, $75 after ($75 and $80 on Sun Princess and Star Princess). Guests 1 and 2 only. No specialty dining, shore excursion credit, photos or reserved theater seating.',
       updated_at = now()
 where cruise_line = 'Princess Cruises' and package_name = 'Princess Plus';

update public.package_inclusions
   set notes = '$105 per person per day bought 4 or more days before sailing, $110 after ($110 and $115 on Sun Princess and Star Princess). Guests 1 and 2 only. Shore excursion credit by cruise length (the page''s FAQ, from 2026-01-14): $100 for 6 to 9 days, $200 for 10 to 20 days, $300 for 21 or more.',
       updated_at = now()
 where cruise_line = 'Princess Cruises' and package_name = 'Princess Premier';
