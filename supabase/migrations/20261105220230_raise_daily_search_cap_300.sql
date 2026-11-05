-- Room for niche write-ups and balanced place suggestions on busy days; the monthly cap (900) still bounds spend.
update settings set value = jsonb_set(value, '{daily_searches}', '300') where key = 'budgets';
