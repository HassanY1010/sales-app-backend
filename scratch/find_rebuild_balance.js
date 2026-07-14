const fs = require('fs');
const glob = require('glob');

const files = glob.sync('c:/Users/HP/Desktop/pro/sales_app/backend/src/**/*.ts');
files.forEach((file) => {
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes('rebuildAccountBalance')) {
    console.log(`Found in: ${file}`);
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (line.includes('rebuildAccountBalance') && line.includes('async')) {
        console.log(`  Line ${idx + 1}: ${line.trim()}`);
      }
    });
  }
});
