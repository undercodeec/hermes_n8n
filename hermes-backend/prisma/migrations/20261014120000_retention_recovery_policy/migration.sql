CREATE TABLE "retention_recovery_policy" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "backupEnabled" BOOLEAN NOT NULL DEFAULT false,
  "backupIntervalHours" INTEGER NOT NULL DEFAULT 72,
  "maximumBackupCount" INTEGER NOT NULL DEFAULT 5,
  "maximumBackupAgeDays" INTEGER NOT NULL DEFAULT 30,
  "maximumBackupStorageGiB" INTEGER NOT NULL DEFAULT 2,
  "restoreCheckEnabled" BOOLEAN NOT NULL DEFAULT false,
  "restoreCheckIntervalDays" INTEGER NOT NULL DEFAULT 60,
  "updatedBy" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "retention_recovery_policy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "retention_policy_singleton" CHECK ("id" = 'global'),
  CONSTRAINT "retention_policy_backup_interval" CHECK ("backupIntervalHours" BETWEEN 6 AND 720),
  CONSTRAINT "retention_policy_backup_count" CHECK ("maximumBackupCount" BETWEEN 1 AND 365),
  CONSTRAINT "retention_policy_backup_age" CHECK ("maximumBackupAgeDays" BETWEEN 1 AND 3650),
  CONSTRAINT "retention_policy_storage" CHECK ("maximumBackupStorageGiB" BETWEEN 1 AND 1024),
  CONSTRAINT "retention_policy_restore_interval" CHECK ("restoreCheckIntervalDays" BETWEEN 30 AND 365)
);
CREATE TABLE "backup_artifacts" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sha256" TEXT NOT NULL,
  "protected" BOOLEAN NOT NULL DEFAULT false,
  "inUse" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "restoreCheckedAt" TIMESTAMP(3),
  "restoreCheckPassed" BOOLEAN,
  CONSTRAINT "backup_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "backup_artifact_kind" CHECK ("kind" IN ('PERIODIC', 'MANUAL')),
  CONSTRAINT "backup_artifact_size" CHECK ("sizeBytes" > 0)
);
CREATE TABLE "backup_operations" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "artifactId" TEXT,
  "detail" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "backup_operations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "backup_artifacts_fileName_key" ON "backup_artifacts"("fileName");
CREATE INDEX "backup_artifacts_kind_createdAt_idx" ON "backup_artifacts"("kind", "createdAt");
CREATE INDEX "backup_operations_kind_startedAt_idx" ON "backup_operations"("kind", "startedAt");
