const fs = require('fs');
const path = require('path');

function searchDir(dir, query) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== 'build' && file !== '.dart_tool') {
        searchDir(fullPath, query);
      }
    } else {
      if (file.endsWith('.dart')) {
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

const query = process.argv[2] || 'اتصال';
console.log(`Searching for: "${query}"...`);
searchDir('c:\\Users\\HP\\Desktop\\pro\\sales_app\\app', query);
