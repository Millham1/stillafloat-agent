-- Mark 2026-11-05: package details, not costs. The Margaritaville rows of 0067 carried the package's price in the notes too.

update public.package_inclusions set notes = 'Adults 21+.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name in ('Beachcomber License to Chill', 'Beachcomber Ultimate License to Chill');

update public.package_inclusions set notes = 'Adults 21+. The daily stateroom gratuity is not part of the package.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Paradise License to Chill';

update public.package_inclusions set notes = 'The package price includes the 20% service charge for the JWB dinner and the brunch. Ages 13+.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name in ('Beachcomber Prime Dining Package', 'Paradise Prime Dining Package');

update public.package_inclusions set notes = 'The package price includes the 20% service charge. Ages 13+.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Prime Dining Package';

update public.package_inclusions set notes = 'Ages 13+.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Ultimate Dining Chill';

update public.package_inclusions set notes = 'Ages 18+. Each credit is used in a single visit.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Far Side Sampler Package';

update public.package_inclusions set notes = 'For all guests in the stateroom.', updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Faster Chill';

update public.package_inclusions set notes = null, updated_at = now()
 where cruise_line = 'Margaritaville at Sea' and package_name = 'Express Pass';
