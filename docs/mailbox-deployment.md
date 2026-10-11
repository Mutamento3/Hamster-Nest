# Mailbox deployment closeout

Schema source: PR #539 / 6b9c620. The original planned migration was 20261011093000; production application through the Supabase management API created version 20261011103258. The local migration is renamed to match that receipt. Historical unrelated migration version mismatches were not repaired or pushed.

The project grants broad default table privileges, so this migration explicitly revokes PUBLIC/anon/authenticated defaults. Authenticated users may select/delete their own rows and update only status/read_at; ingestion remains service-role only. The rollback-only SQL verification in supabase/tests/mailbox_access.sql tests owner read/mark-read, immutable mail bodies, cross-account read/update/delete denial and absence of anonymous/insert/truncate grants.

Both Web and Expo full generated type files were regenerated from the same production public schema using the Supabase type-generation API; only mailbox_messages was added. No manual edits to generated definitions.

Production checks: table exists, RLS enabled, no mailbox-specific security advisor findings; invalid secret returns 401 and an unlisted sender returns 403. Web check and 177 tests, App check and 577 tests pass. Cloudflare Worker/routing and real inbox acceptance are recorded separately in the private delivery receipt; these checks alone do not prove end-to-end email delivery.

Secrets and the sender allowlist are configured only in service secret stores, never in this repository. Keep the same MAIL_INGEST_SECRET on the Email Worker and mail-ingest, and enable the address route only after both are configured. The Worker is receive-only, stores attachment metadata only, and performs no business actions from message content.

The checked-in `cloudflare/mail-worker/wrangler.jsonc` deploys the receive-only `syzygy-mailbox` Worker; workers.dev and preview URLs are disabled. Use the authorized Cloudflare account via `CLOUDFLARE_ACCOUNT_ID`. With Wrangler 4.149.0, `deploy --config cloudflare/mail-worker/wrangler.jsonc --secrets-file <private-env-file>` uploads code and the shared secret together; the private file must contain only `MAIL_INGEST_SECRET` and must never be committed. The sender allowlist stays in Supabase.

Production Worker version `2e4c7f7c-0e7f-4e61-8e99-4f271f6caf74` was deployed with this configuration. Email Routing reports enabled/ready, with an enabled exact-recipient rule from `syzygy@syzygycc.com` to `syzygy-mailbox`; catch-all remains disabled. Public DNS resolves the three Cloudflare MX records. Real sender delivery and rejection remain separate acceptance checks.
