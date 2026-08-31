-- sql/support-private.sql — make "Vocera Support" a PRIVATE thread per person.
--
-- THE BUG
--   Support threads were provisioned one per BUSINESS, with every active member
--   joined via syncTeamMembers(). So when an employee asked Vocera a question,
--   their employer was sitting in the thread reading it. Support is where someone
--   raises a problem they may not want to raise in front of their boss; it has to
--   be private.
--
-- THE SHAPE AFTER THIS
--   conversations.created_by identifies WHOSE support thread it is, and that
--   person is its only member. Vocera staff still answer from the admin panel,
--   which addresses threads by id and does not rely on membership.
--
-- RUN THIS BEFORE (or with) the matching code change. Until it runs, the old
-- one-support-thread-per-tenant unique index rejects the second thread a business
-- needs, and services/conversations.js will log a warning and leave the existing
-- shared thread in place rather than erroring.
--
-- Safe to run more than once.

begin;

-- ─── 1. Drop the one-per-business rule ───────────────────────────────────────
drop index if exists public.conversations_one_support_idx;

-- ─── 2. Give every legacy shared thread an owner ─────────────────────────────
-- Whoever actually used it: the first person to send a non-system message. A
-- thread nobody ever wrote in (only the seeded greeting) goes to the business
-- owner, who is the person that thread was nominally for.
--
-- This deliberately keeps the history with ONE person rather than copying it to
-- everybody: the messages are that person's, and duplicating them into the
-- employer's new thread would be the exact leak this migration exists to close.
with claimant as (
  select
    c.id as conversation_id,
    coalesce(
      (select m.sender_id
         from public.messages m
        where m.conversation_id = c.id
          and not m.is_system
          and m.sender_id is not null
        order by m.created_at asc
        limit 1),
      (select p.id
         from public.profiles p
        where p.tenant_id = c.tenant_id
          and p.tenant_role = 'owner'
          and p.status = 'active'
        order by p.created_at asc
        limit 1)
    ) as profile_id
  from public.conversations c
  where c.kind = 'support'
    and c.created_by is null
)
update public.conversations c
   set created_by = cl.profile_id
  from claimant cl
 where c.id = cl.conversation_id
   and cl.profile_id is not null;

-- ─── 3. Evict everyone else ──────────────────────────────────────────────────
-- This is the line that actually stops the leak: after it, the only member of a
-- support thread is the person it belongs to.
delete from public.conversation_members cm
 using public.conversations c
 where cm.conversation_id = c.id
   and c.kind = 'support'
   and c.created_by is not null
   and cm.profile_id <> c.created_by;

-- …and make sure the claimant is definitely in their own thread.
insert into public.conversation_members (conversation_id, profile_id)
select c.id, c.created_by
  from public.conversations c
 where c.kind = 'support'
   and c.created_by is not null
on conflict (conversation_id, profile_id) do nothing;

-- ─── 4. New rule: one support thread per person, per business ────────────────
-- Postgres treats NULLs as distinct in a unique index, so any thread step 2 could
-- not claim (a tenant with no owner and no messages) stays put without blocking
-- the real ones.
create unique index if not exists conversations_one_support_per_person_idx
  on public.conversations (tenant_id, created_by) where kind = 'support';

commit;

-- ─── Verify ──────────────────────────────────────────────────────────────────
-- Expect one row per support thread, member_count = 1, and a non-null owner.
--
--   select c.id, c.tenant_id, p.email as belongs_to,
--          (select count(*) from public.conversation_members m
--            where m.conversation_id = c.id) as member_count
--     from public.conversations c
--     left join public.profiles p on p.id = c.created_by
--    where c.kind = 'support'
--    order by c.tenant_id;
