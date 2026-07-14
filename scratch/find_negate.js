const fs = require('fs');
const content = fs.readFileSync('c:/Users/HP/Desktop/pro/sales_app/backend/src/connections/connections.service.ts', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.includes('negat')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
