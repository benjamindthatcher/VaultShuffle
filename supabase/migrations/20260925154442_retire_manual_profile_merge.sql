-- URL sign-in resumes an existing manual profile. Retire the separate
-- account-promotion/merge RPCs, retaining historical audit rows and user data.
-- Apply alongside the app release that removes their routes and callers.
begin;
drop function if exists public.create_manual_profile_security_intent(uuid, uuid, text, timestamptz);
drop function if exists public.complete_manual_profile_security(text, uuid, text, text, text, text, timestamptz, text);
commit;
