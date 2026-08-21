const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const Decimal = require('decimal.js');

async function rebuildAll() {
  const accounts = await prisma.account.findMany({
    include: { connection: true }
  });

  console.log(`Rebuilding balances for all ${accounts.length} accounts...`);

  for (const account of accounts) {
    if (!account.connection?.receiverId) continue;
    const receiverId = account.connection.receiverId;

    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [
          { connectionId: account.connectionId },
          {
            connectionId: null,
            OR: [
              { senderId: account.connection.requesterId, receiverId },
              { senderId: receiverId, receiverId: account.connection.requesterId },
            ],
          },
        ],
      },
      include: { order: true },
    });

    const isCustomer = (account.connection?.connectionType || 'CUSTOMER').toUpperCase() === 'CUSTOMER';
    let balance = new Decimal(0);
    for (const t of transactions) {
      let amount = new Decimal(t.amount);

      if (t.order && (t.transactionType === 'SALE' || t.transactionType === 'PURCHASE')) {
        if (t.order.isCash) {
          amount = new Decimal(0);
        } else if (t.order.paidAmount) {
          const paid = new Decimal(t.order.paidAmount || '0');
          amount = Decimal.max(0, amount.minus(paid));
        }
      }

      switch (t.transactionType) {
        case 'SALE':
          balance = isCustomer ? balance.plus(amount) : balance.minus(amount);
          break;
        case 'PURCHASE':
          balance = isCustomer ? balance.minus(amount) : balance.plus(amount);
          break;
        case 'PAYMENT':
          balance = balance.minus(amount);
          break;
        case 'ADJUSTMENT':
          if (t.note && t.note.includes('افتتاحي')) {
            balance = balance.plus(amount);
          } else {
            const isSenderRequester = t.senderId === account.connection.requesterId;
            balance = isSenderRequester ? balance.plus(amount) : balance.minus(amount);
          }
          break;
      }
    }

    const numBalance = balance.toNumber();
    let totalDebit = '0';
    let totalCredit = '0';

    if (isCustomer) {
      if (numBalance > 0) totalDebit = balance.toString();
      if (numBalance < 0) totalCredit = balance.abs().toString();
    } else {
      if (numBalance > 0) totalCredit = balance.toString();
      if (numBalance < 0) totalDebit = balance.abs().toString();
    }

    await prisma.account.update({
      where: { id: account.id },
      data: {
        balance: balance.toString(),
        totalDebit,
        totalCredit,
      },
    });
    console.log(`Account ${account.id} (${account.connection.connectionType}) -> Balance: ${balance.toString()}, Debit: ${totalDebit}, Credit: ${totalCredit}`);
  }
}

rebuildAll().catch(console.error).finally(() => prisma.$disconnect());
