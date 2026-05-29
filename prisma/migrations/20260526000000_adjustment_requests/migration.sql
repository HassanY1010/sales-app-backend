CREATE TABLE IF NOT EXISTS "adjustment_requests" (
  "id" TEXT NOT NULL,
  "requesterBusinessId" TEXT NOT NULL,
  "receiverBusinessId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "requestedAmount" DECIMAL(15, 2),
  "requestedDueDate" TIMESTAMP(3),
  "requestedNote" TEXT,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "rejectionReason" TEXT,
  "createdById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "adjustment_requests_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'adjustment_requests_requesterBusinessId_fkey'
  ) THEN
    ALTER TABLE "adjustment_requests"
      ADD CONSTRAINT "adjustment_requests_requesterBusinessId_fkey"
      FOREIGN KEY ("requesterBusinessId") REFERENCES "businesses"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'adjustment_requests_receiverBusinessId_fkey'
  ) THEN
    ALTER TABLE "adjustment_requests"
      ADD CONSTRAINT "adjustment_requests_receiverBusinessId_fkey"
      FOREIGN KEY ("receiverBusinessId") REFERENCES "businesses"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'adjustment_requests_createdById_fkey'
  ) THEN
    ALTER TABLE "adjustment_requests"
      ADD CONSTRAINT "adjustment_requests_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'adjustment_requests_reviewedById_fkey'
  ) THEN
    ALTER TABLE "adjustment_requests"
      ADD CONSTRAINT "adjustment_requests_reviewedById_fkey"
      FOREIGN KEY ("reviewedById") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "adjustment_requests_requester_idx"
  ON "adjustment_requests"("requesterBusinessId");

CREATE INDEX IF NOT EXISTS "adjustment_requests_receiver_idx"
  ON "adjustment_requests"("receiverBusinessId");

CREATE INDEX IF NOT EXISTS "adjustment_requests_target_idx"
  ON "adjustment_requests"("targetType", "targetId");
