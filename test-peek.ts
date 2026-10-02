import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const businessId = '1bc47970-07ed-4158-b116-cbf70a2f4ab6'; // I need to get a valid businessId
  
  // Let's get the first order's senderId
  const order = await prisma.order.findFirst();
  if (!order) {
    console.log("No orders found");
    return;
  }
  console.log("Testing with businessId:", order.senderId);
  const id = order.senderId;

  try {
      const rows = (await prisma.$queryRawUnsafe(
        `
        WITH current_max AS (
          SELECT COALESCE(
            MAX(
              CASE 
                WHEN "orderNumber" ~ '^[0-9]+$' THEN "orderNumber"::BIGINT 
                ELSE 0 
              END
            ), 
            0
          ) AS max_num
          FROM orders
          WHERE "senderId" = $1
        ),
        counter AS (
          SELECT "lastNum"
          FROM business_invoice_counter
          WHERE "businessId" = $1
        )
        SELECT GREATEST(
          COALESCE((SELECT "lastNum" + 1 FROM counter), 1),
          (SELECT max_num + 1 FROM current_max)
        ) AS peekNum;
        `,
        id,
      )) as any[];

      console.log("Result rows:", rows);
      console.log("peekNum:", rows[0]?.peekNum);
    } catch (e) {
      console.error("Error:", e);
    }
}

main().finally(() => prisma.$disconnect());
