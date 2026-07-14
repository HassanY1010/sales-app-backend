const fs = require('fs');
const schema = fs.readFileSync('c:/Users/HP/Desktop/pro/sales_app/backend/prisma/schema.prisma', 'utf8');
const lines = schema.split('\n');

console.log('=== RELATIONS TO BUSINESS ===');
lines.forEach((line, idx) => {
  if (line.includes('Business') && !line.includes('model Business')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
