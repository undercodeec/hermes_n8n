# Retention and recovery policy (F2)

Status: `F2_RETENTION_RECOVERY_TECHNICALLY_VALIDATED_POLICY_APPROVAL_PENDING`.
This implementation does not approve production values, deploy itself, or turn on periodic work.

## Architecture

Hermes owns a single `retention_recovery_policy` row in PostgreSQL. Its absence
means periodic backup and restore checks are disabled. `backup_artifacts` indexes
only dumps written by Hermes to the dedicated `hermes_backups` Docker volume.
`backup_operations` records attempts and outcomes. `audit_logs` records every
policy update with actor, old values, and new values in the same transaction.
The CRM only calls ADMIN endpoints and presents their state; it never runs host
commands.

The backend image contains PostgreSQL 16 client tools. `pg_dump` creates a
custom-format temporary file, `pg_restore -l` verifies its catalog, and Hermes
computes SHA-256 before atomically renaming it to a `.dump` artifact. Commands
use argument arrays without a shell. Credentials come from the existing
`DATABASE_URL` at runtime and are passed to child processes through `PGPASSWORD`.
They are not stored in the policy, API response, or audit record.

The optional Compose `retention-check` profile provisions a separate PostgreSQL
16 instance with its own volume and credentials. Restore checks require
`RESTORE_CHECK_DATABASE_URL` in the backend environment, with host
`restore-postgres` and database `postgres`. Hermes creates a random temporary
database on that instance, restores the selected managed dump, queries its
public tables, and drops the temporary database. No restore command targets
the production PostgreSQL host. If teardown fails, the check fails and logs an
operational error; an operator must inspect the isolated instance.

## Configurable values

| Field | Range | Initial value |
| --- | --- | --- |
| `backupEnabled` | Boolean | `false` |
| `backupIntervalHours` | 6–720 | 72, inactive |
| `maximumBackupCount` | 1–365 | 5, inactive |
| `maximumBackupAgeDays` | 1–3650 | 30, inactive |
| `maximumBackupStorageGiB` | 1–1024 | 2, inactive |
| `restoreCheckEnabled` | Boolean | `false` |
| `restoreCheckIntervalDays` | 30–365 | 60, inactive |

These initial numbers are software placeholders, not an approved productive
policy. Saving a policy never runs backup, rotation, or restore check. The
operator must explicitly enable periodic work. The scheduler waits at least
one configured interval from the policy update or last attempt.

The new retention policy migration has not been deployed to the VPS. Its
initial table definition is adjusted in place before the first deployment,
so this feature still adds one migration relative to the productive backend.

## Fixed safety rules

- The backup and restore-check capacity guard requires at least 8 GiB free,
  at most 85% of the backup filesystem used, and free space for an estimated
  database-sized dump plus 1 GiB. These values are not CRM settings.
- A PostgreSQL transaction advisory lock serializes backup, restore check, and
  rotation across Hermes instances. The due time is checked again after the
  lock is acquired. Crash or process exit releases the lock.
- Automatic rotation considers only indexed `PERIODIC` dumps. `MANUAL` dumps
  are protected. Predeploy and historic backups made outside the managed
  volume remain unmanaged and are never automatically deleted. The current
  release rollback backup must remain in the predeploy process.
- A periodic dump marked protected or in use is never selected. The newest
  valid periodic dump is kept even if all limits are exceeded. When limits
  conflict with protection, protection wins and the API reports a warning.
- Rotation runs only after a successful managed backup has been recorded. It
  applies age, count, and then storage limits to the eligible set. The preview
  uses the same selection function and never deletes files. Rotation removes
  index records before unlinking files; an interruption can leave an orphaned
  dump in the managed volume, which is treated as legacy and never deleted
  automatically. This favors recovery over silent loss of a retained dump.
- Redis and BullMQ are reconstructible from PostgreSQL, not backup sources.
  Learning evidence and source deletion guards remain unchanged.
- AuditLog legal retention is `NOT_CONFIGURABLE_YET` pending a separate legal
  and business decision.
- The predeploy backup, checksum, and `pg_restore -l` procedure is mandatory
  for critical deployments and independent of `backupEnabled`.

## API and operator flow

All endpoints require a valid Hermes JWT with `ADMIN` role:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/retention-recovery-policy` | Policy, bounds, operational state, capacity, warnings |
| `PUT /api/admin/retention-recovery-policy` | Validate and save entire policy; audit change |
| `POST /api/admin/retention-recovery-policy/rotation-preview` | Preview proposed policy, no mutation |
| `POST /api/admin/retention-recovery-policy/backup` | Explicit protected manual dump |
| `POST /api/admin/retention-recovery-policy/restore-check` | Explicit isolated restore |

The CRM shows this in **Administración general → Retención y recuperación**
only for ADMIN. Reducing retention prompts for confirmation when the preview
selects existing managed periodic dumps. A save does not delete them.

## Deployment and recovery runbook

1. Create and verify the mandatory predeploy PostgreSQL backup, checksum, and
   `pg_restore -l` using the existing release procedure. Preserve its rollback
   reference outside `hermes_backups`.
2. Deploy the migration and backend/frontend artifacts. Confirm the policy GET
   reports `configured=false`, `backupEnabled=false`, and
   `restoreCheckEnabled=false`. Confirm no new backup operation exists.
3. Confirm the `hermes_backups` volume is mounted and backed by a filesystem
   with sufficient space. Existing VPS backups outside this volume are not
   inventoried by the CRM. Do not move them into the volume to make them
   appear managed; that would not create index records.
4. For restore checks, provision a separate secret file at
   `/etc/hermes/restore-postgres.env`, enable the `retention-check` Compose
   profile, and put its dedicated URL in the backend environment as
   `RESTORE_CHECK_DATABASE_URL`. The URL must use `restore-postgres` as host.
5. In CRM, inspect disk and preview. Run a manual backup and isolated restore
   check with a synthetic/local environment first. The manual backup is
   protected and must be managed by an operator outside automatic rotation.
   Manual API calls wait for completion; validate the VPS reverse-proxy timeouts
   before using the CRM actions on a large database.
6. The operator decides and records productive frequency, count, age, budget,
   and restore interval. Only then enable periodic work in CRM. A policy change
   is recorded in AuditLog.
7. For recovery, stop write traffic, select a verified backup using its
   checksum, restore into an isolated PostgreSQL instance, validate queries,
   and follow the existing release rollback procedure. Never point the
   automatic restore-check URL at production.

## Known operational limits

The CRM counts legacy `.dump` files visible inside the managed volume, but
cannot inventory external VPS backup directories. Protected manual backups
can exceed the configured storage budget; the capacity guard then blocks new
space-intensive operations. Offsite provider, legal AuditLog retention, and
productive values remain operator decisions. The restore-check sidecar is
disabled until explicitly provisioned and enabled. VPS validation remains
necessary before declaring this policy operational.
