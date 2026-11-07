-- Run kinds for the evaluation suite and the backtest collector (own file:
-- new enum values cannot be used in the transaction that adds them).
alter type run_kind add value if not exists 'eval';
alter type run_kind add value if not exists 'backtest_collect';
