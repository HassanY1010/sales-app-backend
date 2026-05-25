CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "userAgent" TEXT,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_tokenHash_key"
  ON "refresh_tokens"("tokenHash");

CREATE INDEX IF NOT EXISTS "refresh_tokens_user_idx"
  ON "refresh_tokens"("userId");

CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_idx"
  ON "refresh_tokens"("expiresAt");

ALTER TABLE "refresh_tokens"
  DROP CONSTRAINT IF EXISTS "refresh_tokens_userId_fkey";

ALTER TABLE "refresh_tokens"
  ADD CONSTRAINT "refresh_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
