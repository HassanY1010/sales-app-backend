const fs = require('fs');
const schema = fs.readFileSync('c:/Users/HP/Desktop/pro/sales_app/backend/prisma/schema.prisma', 'utf8');

const lines = schema.split('\n');
let insideAccount = false;
let accountModel = '';
lines.forEach((line) => {
  if (line.trim().startsWith('model Account ')) {
    insideAccount = true;
  }
  if (insideAccount) {
    accountModel += line + '\n';
    if (line.trim() === '}') {
      insideAccount = false;
    }
  }
});

console.log('=== ACCOUNT MODEL ===');
console.log(accountModel);
