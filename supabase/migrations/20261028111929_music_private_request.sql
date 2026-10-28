-- Keep the privileged enqueue helper out of the exposed public schema.
create schema if not exists music_private;
revoke all on schema music_private from public, anon;
grant usage on schema music_private to authenticated, service_role;
alter function public.music_request_tracks(bigint[]) set schema music_private;
revoke all on function music_private.music_request_tracks(bigint[]) from public, anon;
grant execute on function music_private.music_request_tracks(bigint[]) to authenticated, service_role;

create function public.music_request_tracks(p_song_ids bigint[])
returns setof public.music_tracks
language sql
security invoker
set search_path = ''
as $$
  select * from music_private.music_request_tracks(p_song_ids);
$$;
revoke all on function public.music_request_tracks(bigint[]) from public, anon;
grant execute on function public.music_request_tracks(bigint[]) to authenticated, service_role;
comment on function public.music_request_tracks(bigint[]) is
  'App requests at most 20 tracks; private helper derives owner from auth.uid(). Never accepts a caller-supplied owner.';
