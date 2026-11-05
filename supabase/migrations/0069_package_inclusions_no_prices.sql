-- Mark 2026-11-05: "you are collecting package details, not the costs of the drink packages."
-- The table says what a package includes. The prices 0068 put in the notes come out; nothing else changes.

update public.package_inclusions
   set notes = 'Up to 15 alcoholic drinks per person per 24 hours. Whole cruise only. Not covered: room service, souvenir glasses, drinks bought in port (incl. Half Moon Cay and Princess Cays).',
       updated_at = now()
 where cruise_line = 'Carnival Cruise Line' and package_name = 'CHEERS!';

update public.package_inclusions
   set notes = 'Guests 1 and 2 only. No specialty dining, shore excursion credit, photos or reserved theater seating.',
       updated_at = now()
 where cruise_line = 'Princess Cruises' and package_name = 'Princess Plus';

update public.package_inclusions
   set notes = 'Guests 1 and 2 only. Shore excursion credit by cruise length (the page''s FAQ, from 2026-01-14): $100 for 6 to 9 days, $200 for 10 to 20 days, $300 for 21 or more.',
       updated_at = now()
 where cruise_line = 'Princess Cruises' and package_name = 'Princess Premier';

update public.package_inclusions
   set notes = 'Open bar is for guests 21+; gratuities on the bar and dining packages are pre-paid on top. Guests 3 and 4 sailing free is a separate offer.',
       updated_at = now()
 where cruise_line = 'Norwegian Cruise Line' and package_name = 'Free at Sea';

update public.package_inclusions
   set notes = 'The prepaid daily service charges do not cover bar, beverage or specialty dining gratuities.',
       updated_at = now()
 where cruise_line = 'Norwegian Cruise Line' and package_name = 'Free at Sea Plus';
