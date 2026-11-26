// Sets the version number (date and time) on the assets in the HTML files and in the page footers.
// Run it after every code change, before publishing:  node version.js
// Thanks to URLs like app.js?v=... the browser fetches the new file after a deploy instead of
// reusing the old one from its cache.
const fs = require('fs');

const v = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-'); // e.g. 20261125-2310 (UTC)
const files = ['index.html', 'local/index.html', 'sheet/index.html'];

for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace(/((?:style\.css|planner\.js|common\.js|app\.js))(\?v=[^"']*)?(?=["'])/g, `$1?v=${v}`);
  s = s.replace(/<!--version-->.*?<!--\/version-->/g, `<!--version-->${v}<!--/version-->`);
  fs.writeFileSync(f, s);
}
console.log('Version set to', v);
