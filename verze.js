// Nastaví číslo verze (datum a čas) u souborů v HTML a do patičky stránek.
// Spusťte po každé změně kódu před nahráním:  node verze.js
// Díky číslu ve tvaru app.js?v=... si prohlížeč po nasazení stáhne nový soubor, ne starý z paměti.
const fs = require('fs');

const v = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-'); // např. 20261125-2310 (UTC)
const files = ['index.html', 'lokalni/index.html', 'tabulka/index.html'];

for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace(/((?:style\.css|planner\.js|common\.js|app\.js))(\?v=[^"']*)?(?=["'])/g, `$1?v=${v}`);
  s = s.replace(/<!--verze-->.*?<!--\/verze-->/g, `<!--verze-->${v}<!--/verze-->`);
  fs.writeFileSync(f, s);
}
console.log('Verze nastavena na', v);
