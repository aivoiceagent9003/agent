-- Call recordings: store a playable WAV per call in Supabase Storage and keep its
-- path on the call row. The client dashboard shows the RECORDING + an English
-- summary instead of the noisy live transcript.

-- 1. Path to the uploaded recording (bucket-relative, e.g. "<tenant>/<call>.wav").
alter table public.calls add column if not exists recording_path text;

-- 2. Private Storage bucket for the audio. Access is via short-lived signed URLs
--    minted server-side (service role), so the bucket stays private.
insert into storage.buckets (id, name, public)
values ('call-recordings', 'call-recordings', false)
on conflict (id) do nothing;
