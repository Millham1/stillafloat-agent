-- Mark 2026-11-05: "without the per day cost of the package itself we cannot do the comparison to the cruise fare."
-- 0069 and 0070 took the package prices out on a misreading of his note. They go back, as the lines' pages printed them on 2026-11-05.

update public.package_inclusions set notes = 'Up to 15 alcoholic drinks per person per 24 hours. $69.95 per person per day bought before sailing, $74.95 on board, plus a 20% service charge; whole cruise only. Not covered: room service, souvenir glasses, drinks bought in port (incl. Half Moon Cay and Princess Cays).', updated_at = now()
 where cruise_line = 'Carnival Cruise Line' and package_name = 'CHEERS!';

update public.package_inclusions set notes = '$70 per person per day bought 4 or more days before sailing, $75 after ($75 and $80 on Sun Princess and Star Princess). Guests 1 and 2 only. No specialty dining, shore excursion credit, photos or reserved theater seating.', updated_at = now()
 where cruise_line = 'Princess Cruises' and package_name = 'Princess Plus';

update public.package_inclusions set notes = '$105 per person per day bought 4 or more days before sailing, $110 after ($110 and $115 on Sun Princess and Star Princess). Guests 1 and 2 only. Shore excursion credit by cruise length (the page''s FAQ, from 2026-01-14): $100 for 6 to 9 days, $200 for 10 to 20 days, $300 for 21 or more.', updated_at = now()
 where cruise_line = 'Princess Cruises' and package_name = 'Princess Premier';

update public.package_inclusions set notes = 'Open bar is for guests 21+; gratuities on the bar and dining packages are pre-paid on top. Bought on board instead, the open bar is $45 per person per day plus 20% gratuity. Guests 3 and 4 sailing free is a separate offer.', updated_at = now()
 where cruise_line = 'Norwegian Cruise Line' and package_name = 'Free at Sea';

update public.package_inclusions set notes = '$49.99 per person, per day; $15 a day less when the service charges are already prepaid; $40 a day for guests under 21. The prepaid daily service charges do not cover bar, beverage or specialty dining gratuities.', updated_at = now()
 where cruise_line = 'Norwegian Cruise Line' and package_name = 'Free at Sea Plus';

update public.package_inclusions set notes = 'From $599 per person. Adults 21+.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Beachcomber License to Chill';
update public.package_inclusions set notes = 'From $799 per person. Adults 21+.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Beachcomber Ultimate License to Chill';
update public.package_inclusions set notes = 'From $399 per person on 2-night sailings. Adults 21+. The daily stateroom gratuity is not part of the package.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Paradise License to Chill';
update public.package_inclusions set notes = '$89 per person; the price includes the 20% service charge for the JWB dinner and the brunch. Ages 13+.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name in ('Beachcomber Prime Dining Package', 'Paradise Prime Dining Package');
update public.package_inclusions set notes = '$89 per person; the price includes the 20% service charge. Ages 13+.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Prime Dining Package';
update public.package_inclusions set notes = '$159 per person. Ages 13+.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Ultimate Dining Chill';
update public.package_inclusions set notes = '$75 per person. Ages 18+. Each credit is used in a single visit.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Far Side Sampler Package';
update public.package_inclusions set notes = 'From $129 per stateroom on 2-night sailings; for all guests in the stateroom.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Faster Chill';
update public.package_inclusions set notes = 'From $49 per cabin on 2-night sailings.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Express Pass';
