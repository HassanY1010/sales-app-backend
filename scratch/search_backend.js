const fs = require('fs');
const path = require('path');

function searchDir(dir, query) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== 'dist') {
        searchDir(fullPath, query);
      }
    } else {
      if (file.endsWith('.ts')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes(query)) {
          console.log(`Found in: ${fullPath}`);
          // Find matching lines
          const lines = content.split('\n');
          lines.forEach((line, index) => {
            if (line.includes(query)) {
              console.log(`  Line ${index + 1}: ${line.trim()}`);
            }
          });
        }
      }
    }
  }
}

const query = process.argv[2];
if (!query) {
  console.log('Please provide a query.');
  process.exit(1);
}
console.log(`Searching for: "${query}" in backend...`);
searchDir('c:\\Users\\HP\\Desktop\\pro\\sales_app\\backend', query);
