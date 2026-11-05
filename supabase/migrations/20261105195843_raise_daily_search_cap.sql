-- 60 searches a day was hit by a single exploring session; the monthly cap of
-- 900 is what keeps usage inside Tavily's 1,000 free searches.
update settings set value = value || '{"daily_searches": 150}'::jsonb where key = 'budgets';
