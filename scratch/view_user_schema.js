const fs = require('fs');
const schema = fs.readFileSync('c:/Users/HP/Desktop/pro/sales_app/backend/prisma/schema.prisma', 'utf8');

// Find Model User
const lines = schema.split('\n');
let insideUser = false;
let userModel = '';
lines.forEach((line) => {
  if (line.trim().startsWith('model User ')) {
    insideUser = true;
  }
  if (insideUser) {
    userModel += line + '\n';
    if (line.trim() === '}') {
      insideUser = false;
    }
  }
});

console.log('=== USER MODEL ===');
console.log(userModel);

console.log('=== RELATIONS TO USER ===');
// Search for relations that reference User
lines.forEach((line, idx) => {
  if (line.includes('User') && !line.includes('model User')) {
    console.log(`Line ${idx + 1}: ${line.trim()}`);
  }
});
