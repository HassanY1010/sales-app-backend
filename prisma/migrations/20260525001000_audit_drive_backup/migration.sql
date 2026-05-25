ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "method" TEXT,
  ADD COLUMN IF NOT EXISTS "path" TEXT,
  ADD COLUMN IF NOT EXISTS "statusCode" INTEGER,
  ADD COLUMN IF NOT EXISTS "businessId" TEXT;

CREATE INDEX IF NOT EXISTS "audit_logs_business_idx" ON "audit_logs"("businessId");
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs"("createdAt");

CREATE TABLE IF NOT EXISTS "cloud_backup_credentials" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'GOOGLE_DRIVE',
  "refreshToken" TEXT NOT NULL,
  "email" TEXT,
  "scope" TEXT,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cloud_backup_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "cloud_backup_credentials_businessId_key"
  ON "cloud_backup_credentials"("businessId");

ALTER TABLE "cloud_backup_credentials"
  DROP CONSTRAINT IF EXISTS "cloud_backup_credentials_businessId_fkey";

ALTER TABLE "cloud_backup_credentials"
  ADD CONSTRAINT "cloud_backup_credentials_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "cloud_backup_records" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'GOOGLE_DRIVE',
  "fileId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileSize" INTEGER,
  "checksum" TEXT,
  "status" TEXT NOT NULL DEFAULT 'UPLOADED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cloud_backup_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cloud_backup_records_business_idx"
  ON "cloud_backup_records"("businessId");

ALTER TABLE "cloud_backup_records"
  DROP CONSTRAINT IF EXISTS "cloud_backup_records_businessId_fkey";

ALTER TABLE "cloud_backup_records"
  ADD CONSTRAINT "cloud_backup_records_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
