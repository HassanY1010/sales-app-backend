CREATE TABLE IF NOT EXISTS "due_reminder_logs" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "recipientBusinessId" TEXT NOT NULL,
  "reminderDate" TIMESTAMP(3) NOT NULL,
  "dueDate" TIMESTAMP(3) NOT NULL,
  "amount" DECIMAL(15, 2) NOT NULL,
  "direction" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "due_reminder_logs_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'due_reminder_logs_recipientBusinessId_fkey'
  ) THEN
    ALTER TABLE "due_reminder_logs"
      ADD CONSTRAINT "due_reminder_logs_recipientBusinessId_fkey"
      FOREIGN KEY ("recipientBusinessId") REFERENCES "businesses"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "due_reminder_once_per_day"
  ON "due_reminder_logs"("connectionId", "recipientBusinessId", "reminderDate");

CREATE INDEX IF NOT EXISTS "due_reminder_logs_recipient_idx"
  ON "due_reminder_logs"("recipientBusinessId");

CREATE INDEX IF NOT EXISTS "due_reminder_logs_due_date_idx"
  ON "due_reminder_logs"("dueDate");
