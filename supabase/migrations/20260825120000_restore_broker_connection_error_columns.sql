-- Restore columns dropped by 20260616120000_fxsocket_unify_broker_accounts.sql.
-- Worker, fxsocket-broker, and admin-mutate still write these fields; without
-- them PostgREST returns schema-cache errors and broker status freezes.

ALTER TABLE public.broker_accounts
  ADD COLUMN IF NOT EXISTS connection_error_kind text;

ALTER TABLE public.broker_accounts
  ADD COLUMN IF NOT EXISTS connection_error_message text;

COMMENT ON COLUMN public.broker_accounts.connection_error_kind IS
  'Classified connect failure: wrong_password, wrong_login, wrong_server, investor_password, account_disabled, session_expired, unknown.';

COMMENT ON COLUMN public.broker_accounts.connection_error_message IS
  'User-facing explanation of the last connect/reconnect failure. Cleared when connected.';
