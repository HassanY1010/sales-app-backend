const fs = require('fs');
const content = fs.readFileSync('c:/Users/HP/Desktop/pro/sales_app/backend/src/transactions/transactions.service.ts', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('balance') || line.includes('Account')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
