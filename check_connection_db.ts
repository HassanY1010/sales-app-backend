import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Finding connections with name containing الياسر...');
  const conns = await prisma.connection.findMany({
    where: {
      OR: [
        { requester: { name: { contains: 'الياسر' } } },
        { receiver: { name: { contains: 'الياسر' } } },
        { pendingName: { contains: 'الياسر' } },
        { pendingBizName: { contains: 'الياسر' } },
      ],
    },
    include: {
      requester: { include: { user: true } },
      receiver: { include: { user: true } },
    },
  });

  console.log(`Found ${conns.length} connections:`);
  for (const c of conns) {
    console.log({
      id: c.id,
      status: c.status,
      connectionType: c.connectionType,
      requestSource: c.requestSource,
      requiresReceiverInput: c.requiresReceiverInput,
      requesterId: c.requesterId,
      requesterName: c.requester?.name,
      requesterUserId: c.requester?.user?.id,
      receiverId: c.receiverId,
      receiverName: c.receiver?.name,
      receiverUser: c.receiver?.user ? { id: c.receiver.user.id } : null,
      pendingName: c.pendingName,
      pendingBizName: c.pendingBizName,
    });
  }

  // Also print all PENDING connections
  console.log('\n--- All PENDING connections in DB: ---');
  const allPending = await prisma.connection.findMany({
    where: { status: 'PENDING' },
    include: {
      requester: { include: { user: true } },
      receiver: { include: { user: true } },
    },
    take: 10,
    orderBy: { createdAt: 'desc' },
  });
  for (const p of allPending) {
    console.log({
      id: p.id,
      requesterName: p.requester?.name,
      requesterUserId: p.requester?.user?.id,
      receiverId: p.receiverId,
      receiverName: p.receiver?.name,
      receiverUser: p.receiver?.user ? { id: p.receiver.user.id } : null,
      status: p.status,
      connectionType: p.connectionType,
      requiresReceiverInput: p.requiresReceiverInput,
    });
  }
}

main()
  .catch((e) => {
    console.error('ERROR in script:', e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
