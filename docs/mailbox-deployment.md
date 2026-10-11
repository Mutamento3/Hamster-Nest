# Mailbox deployment closeout

Schema source: PR #539 / 6b9c620. The original planned migration was 20261011093000; production application through the Supabase management API created version 20261011103258. The local migration is renamed to match that receipt. Historical unrelated migration version mismatches were not repaired or pushed.

The project grants broad default table privileges, so this migration explicitly revokes PUBLIC/anon/authenticated defaults. Authenticated users may select/delete their own rows and update only status/read_at; ingestion remains service-role only. The rollback-only SQL verification in supabase/tests/mailbox_access.sql tests owner read/mark-read, immutable mail bodies, cross-account read/update/delete denial and absence of anonymous/insert/truncate grants.

Both Web and Expo full generated type files were regenerated from the same production public schema using the Supabase type-generation API; only mailbox_messages was added. No manual edits to generated definitions.

Production checks: table exists, RLS enabled, no mailbox-specific security advisor findings; invalid secret returns 401 and an unlisted sender returns 403. Web check and 177 tests, App check and 577 tests pass. Cloudflare Worker/routing and real inbox acceptance are recorded separately in the private delivery receipt; these checks alone do not prove end-to-end email delivery.

Secrets and the sender allowlist are configured only in service secret stores, never in this repository. Keep the same MAIL_INGEST_SECRET on the Email Worker and mail-ingest, and enable the address route only after both are configured. The Worker is receive-only, stores attachment metadata only, and performs no business actions from message content.
