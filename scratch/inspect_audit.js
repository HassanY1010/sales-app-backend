const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function inspectAudit() {
  const audits = await prisma.auditLog.findMany({
    where: {
      resource: 'ACCOUNT_TERMS'
    },
    orderBy: { createdAt: 'desc' }
  });
  console.log(`Found ${audits.length} ACCOUNT_TERMS audit logs:`);
  audits.forEach(a => {
    console.log(`- ID: ${a.id}, resourceId: ${a.resourceId}, businessId: ${a.businessId}, details:`, a.details, `createdAt: ${a.createdAt}`);
  });
}

inspectAudit().catch(console.error).finally(() => prisma.$disconnect());
