const fs = require('fs');
const content = fs.readFileSync('c:/Users/HP/Desktop/pro/sales_app/backend/src/admin/admin.service.ts', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.toLowerCase().includes('notification') || line.toLowerCase().includes('findmany')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
