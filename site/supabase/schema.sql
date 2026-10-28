-- Gutta Golf bookings and customers.
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Only the server (api/, using the service role key) reads or writes these tables; RLS with no policies blocks everyone else.

create extension if not exists btree_gist;

create table if not exists public.customers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text,                              -- as typed; walk-ins may leave it out
  phone_key   text unique,                       -- digits only, used to recognise a returning customer
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.bookings (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,                 -- GG-XXXXXX shown to the customer
  customer_id        uuid not null references public.customers(id),
  date               date not null,                        -- booking day (a day runs 9 AM – 6 AM next morning)
  bay                smallint not null check (bay between 1 and 8),
  start_slot         smallint not null check (start_slot >= 0),   -- 15-minute slots from 9 AM
  len                smallint not null check (len >= 2),
  subtotal_cents     integer not null,
  tax_cents          integer not null,
  total_cents        integer not null,
  source             text not null check (source in ('online', 'admin')),
  status             text not null default 'confirmed' check (status in ('confirmed', 'canceled', 'conflict')),
  stripe_session_id  text unique,
  created_at         timestamptz not null default now(),
  canceled_at        timestamptz,
  -- Two confirmed bookings can never overlap in the same bay on the same day.
  constraint bookings_no_overlap exclude using gist (
    date with =, bay with =, int4range(start_slot, start_slot + len) with &&
  ) where (status = 'confirmed')
);

create index if not exists bookings_date_idx on public.bookings (date);
create index if not exists bookings_customer_idx on public.bookings (customer_id);

-- Added for the admin payments view (safe to run again on an existing table).
alter table public.bookings add column if not exists stripe_payment_intent text;

-- Everything that happens: admin logins, bookings, payments, door and bay power. Shown and downloaded in admin.html.
create table if not exists public.logs (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  category  text not null check (category in ('auth', 'booking', 'payment', 'door', 'system', 'error')),
  action    text not null,                       -- e.g. login, login_fail, booking_add, paid, door_open, power_on
  ok        boolean not null default true,
  actor     text,                                -- admin user name, 'customer' or 'server'
  ref       text,                                -- booking code, device name …
  ip        text,
  detail    jsonb
);

create index if not exists logs_at_idx on public.logs (at desc);
create index if not exists logs_category_at_idx on public.logs (category, at desc);
create index if not exists logs_ip_at_idx on public.logs (ip, at desc);

alter table public.customers enable row level security;
alter table public.bookings  enable row level security;
alter table public.logs      enable row level security;
