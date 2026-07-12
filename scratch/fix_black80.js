const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      if (file.endsWith('.dart')) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = walk('C:/Users/HP/Desktop/pro/sales_app/app/lib');
files.forEach((file) => {
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes('Colors.black80')) {
    console.log(`Fixing Colors.black80 in ${file}`);
    content = content.replace(/Colors\.black80/g, 'Colors.black87');
    fs.writeFileSync(file, content, 'utf8');
  }
});
console.log('Done!');
