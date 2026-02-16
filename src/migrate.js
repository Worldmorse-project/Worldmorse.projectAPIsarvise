import { q } from "./db.js";

export async function migrate() {
  await q(`
    create table if not exists stations (
      callsign text primary key,
      channel text not null,
      mode text default 'morse',
      frequency double precision,
      last_seen timestamptz not null default now()
    );
  `);

  await q(`
    create table if not exists messages (
      id bigserial primary key,
      channel text not null,
      from_callsign text not null,
      to_callsign text,
      type text not null,
      payload jsonb not null,
      created_at timestamptz not null default now()
    );
  `);

  await q(`
    create table if not exists contacts (
      id bigserial primary key,
      my_callsign text not null,
      callsign text not null,
      name text,
      location text,
      notes text,
      last_contact_date timestamptz,
      qso_count int default 0,
      unique(my_callsign, callsign)
    );
  `);
}
