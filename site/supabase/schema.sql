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

-- Added for paying at Gutta (safe to run again). An unpaid booking has paid_at null until the admin marks it paid.
alter table public.bookings add column if not exists paid_at timestamptz;
alter table public.bookings add column if not exists pay_method text check (pay_method in ('stripe', 'card', 'cash', 'other'));
update public.bookings set paid_at = created_at, pay_method = 'stripe' where stripe_session_id is not null and paid_at is null;

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

-- ============================================================================
-- Marketing and Green (the admin assistant). Safe to run again.
-- ============================================================================

-- Who the customer is, for region / age / gender analysis. All optional; the booking form asks, the admin can fill them in.
alter table public.customers add column if not exists postal_code   text;                 -- e.g. M3B 2M3; the first 3 characters (FSA) are the area
alter table public.customers add column if not exists age_band      text check (age_band in ('under18', '18-24', '25-34', '35-44', '45-54', '55-64', '65plus'));
alter table public.customers add column if not exists gender        text check (gender in ('female', 'male', 'other', 'na'));
-- Marketing texts need express consent (CASL). Only customers with sms_opt_in = true are ever texted.
alter table public.customers add column if not exists sms_opt_in     boolean not null default false;
alter table public.customers add column if not exists sms_opt_in_at  timestamptz;
alter table public.customers add column if not exists sms_opt_out_at timestamptz;

-- Which promotion and which campaign (popup, text, …) a booking came from.
alter table public.bookings add column if not exists promo_code     text;
alter table public.bookings add column if not exists discount_cents integer not null default 0;
alter table public.bookings add column if not exists campaign_ref   text;
create index if not exists bookings_campaign_idx on public.bookings (campaign_ref) where campaign_ref is not null;

-- Discount codes. Applied on the server to the subtotal before HST.
create table if not exists public.promos (
  code         text primary key check (code ~ '^[A-Z0-9]{3,16}$'),
  percent_off  smallint not null check (percent_off between 1 and 50),
  starts_on    date,
  ends_on      date,
  active       boolean not null default false,       -- turned on when its campaign is sent or published
  campaign_ref text,
  note         text,
  created_at   timestamptz not null default now()
);

-- Text campaigns and website popups. Green writes drafts; only the admin sends or publishes them.
create table if not exists public.campaigns (
  ref         text primary key,                      -- sms-xxxxx / pop-xxxxx, also the ?src= on links
  kind        text not null check (kind in ('sms', 'popup')),
  status      text not null default 'draft' check (status in ('draft', 'active', 'sent', 'ended')),
  name        text not null,
  promo_code  text references public.promos(code),
  content     jsonb not null,                        -- sms: { text }; popup: { title, body, cta, pages }
  audience    jsonb,                                 -- sms: who gets it (see api/_marketing.js)
  starts_on   date,
  ends_on     date,
  stats       jsonb,                                 -- sms: { sent, failed }
  created_by  text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create table if not exists public.sms_sends (
  id           bigint generated always as identity primary key,
  campaign_ref text not null references public.campaigns(ref),
  customer_id  uuid references public.customers(id),
  phone        text not null,
  ok           boolean not null,
  sid          text,
  error        text,
  at           timestamptz not null default now()
);
create index if not exists sms_sends_campaign_idx on public.sms_sends (campaign_ref);

-- Website visits and popup views / clicks, sent by site.js. No names, phones or IP addresses.
create table if not exists public.events (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  type      text not null check (type in ('view', 'popup_view', 'popup_click', 'popup_close', 'book_start', 'booked')),
  page      text,
  sid       text,                                    -- random id per browser tab session
  vid       text,                                    -- random id per browser, to count returning visitors
  src       text,                                    -- ?src= (campaign ref) or utm_source
  referrer  text,                                    -- host only
  device    text check (device in ('mobile', 'desktop'))
);
create index if not exists events_at_idx on public.events (at desc);
create index if not exists events_src_idx on public.events (src, at desc) where src is not null;

-- Reports Green saves, and Green's ElevenLabs setup (agent, tool and secret ids) in app_settings.
-- Green's conversations themselves are kept by ElevenLabs.
create table if not exists public.green_reports (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  body             text not null,                    -- Markdown
  created_at       timestamptz not null default now()
);
create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Logs get a marketing category (texts sent, popups published).
alter table public.logs drop constraint if exists logs_category_check;
alter table public.logs add constraint logs_category_check check (category in ('auth', 'booking', 'payment', 'door', 'system', 'error', 'marketing'));

alter table public.promos        enable row level security;
alter table public.campaigns     enable row level security;
alter table public.sms_sends     enable row level security;
alter table public.events        enable row level security;
alter table public.app_settings  enable row level security;
alter table public.green_reports enable row level security;
