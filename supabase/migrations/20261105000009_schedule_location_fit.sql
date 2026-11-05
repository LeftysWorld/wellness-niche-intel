-- Re-judge places against the owner's description weekly, before the fit screen.
select cron.schedule('location-fit-weekly', '47 10 * * 1', $$select private.invoke('location-fit', '{}')$$);
