-- AlterTable
ALTER TABLE `connections` ADD COLUMN `blockedById` VARCHAR(191) NULL,
    ADD COLUMN `lastRequestedAt` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `retryCount` INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX `orders_status_idx` ON `orders`(`status`);

-- CreateIndex
CREATE INDEX `orders_createdAt_idx` ON `orders`(`createdAt`);

-- CreateIndex
CREATE INDEX `transactions_createdAt_idx` ON `transactions`(`createdAt`);

-- RedefineIndex
CREATE INDEX `orders_receiverId_idx` ON `orders`(`receiverId`);
DROP INDEX `orders_receiverId_fkey` ON `orders`;

-- RedefineIndex
CREATE INDEX `orders_senderId_idx` ON `orders`(`senderId`);
DROP INDEX `orders_senderId_fkey` ON `orders`;

-- RedefineIndex
CREATE INDEX `transactions_receiverId_idx` ON `transactions`(`receiverId`);
DROP INDEX `transactions_receiverId_fkey` ON `transactions`;

-- RedefineIndex
CREATE INDEX `transactions_senderId_idx` ON `transactions`(`senderId`);
DROP INDEX `transactions_senderId_fkey` ON `transactions`;
