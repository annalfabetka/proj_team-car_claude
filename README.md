# Spolujízdy na zápasy

Webová aplikace, která týmu navrhne, kdo pojede autem, koho vyzvedne a v jakém pořadí, aby cesta do haly byla co nejkratší.

Živá verze: https://annalfabetka.github.io/proj_team-car_claude/ (rozcestník)

K dispozici jsou dvě verze vedle sebe. Plánovač (výpočet tras) mají společný.

| Verze | Adresa | Pro koho |
|---|---|---|
| **Prototyp s Google tabulkou** | [`tabulka/`](tabulka/) | Hráčky vyplňují společnou Google tabulku, která sama kontroluje adresy. Aplikace z ní čte a plánuje. |
| **Lokální verze** | [`lokalni/`](lokalni/) | Jedno zařízení bez sdílení. Soupisku zadává jedna osoba, uloží se jen v jejím prohlížeči. Nic se nenastavuje. Z rozcestníku je dočasně skrytá (zakomentovaná v `index.html`), přímý odkaz funguje. |

## Stavy hráček

V obou verzích se u hráčky vybírá stav:

- **Určitě beru auto**: pojede jako řidička. Vyplní počet míst v autě (včetně sebe).
- **Můžu vzít auto**: pojede autem, jen když to plánovači vyjde. Vybere ji podle bydliště.
- **Potřebuji odvoz**: pojede jako spolucestující.
- **Nejedu**: do plánu se nepočítá.

Hráčky s prázdným stavem se do plánu nepočítají a aplikace na ně upozorní.

---

## Lokální verze (`lokalni/`)

Bez nastavení. Otevřete stránku, zadejte hráčky (jméno, adresa, stav, případně počet míst), adresu haly a čas příjezdu a klikněte na **Naplánovat jízdy**. Výsledkem jsou auta s časy výjezdu a vyzvednutí, mapa a zpráva do skupiny.

- Soupiska se ukládá jen v tomto prohlížeči. Na jiné zařízení ji přenesete tlačítkem **Stáhnout soubor** a **Nahrát soubor**.
- Adresy se hledají přes OpenStreetMap Nominatim.
- **Nový zápas: vynulovat stavy** smaže stavy, adresy zůstanou.

---

## Prototyp s Google tabulkou (`tabulka/`)

Hráčky vyplňují Google tabulku a aplikace z ní čte a plánuje. Tabulka sama ověřuje adresy přes Google Mapy, takže překlep se ukáže hned při psaní. Nepotřebujete žádnou databázi ani klíče. Nastavení trvá asi 10 minut.

### 1. Vytvoření tabulky

1. Na https://sheets.google.com vytvořte novou **prázdnou** tabulku.
2. **Rozšíření → Apps Script**. Smažte vše, co tam je, a vložte obsah souboru [`tabulka/Kod.gs`](tabulka/Kod.gs). Uložte.
3. V horní liště vyberte funkci **`nastavit`** a klikněte na **Spustit**. Google se zeptá na oprávnění (je to váš vlastní skript, pro Mapy a úpravu tabulky). Povolte je. Pokud se zobrazí „Aplikace není ověřena“, zvolte **Upřesnit → Přejít na … (nezabezpečeno)**.
4. Tabulka se připraví: list **Tým** se záhlavím, rozbalovací nabídkou stavu, kontrolou počtu míst a barvami. Zkuste do sloupce **Adresa** napsat adresu. Vedle se objeví kontrola:
   - `✓ Adresa nalezena`: v pořádku, vedle je nalezená adresa a souřadnice.
   - `⚠ Zkontrolujte, zda nalezená adresa sedí`: Google si není jistý (překlep). Souřadnice se použijí, ale ověřte adresu.
   - `⚠ Upřesněte adresu`: chybí ulice a číslo domu (např. jen „Praha“). Souřadnice se nevyplní.
   - `✗ Adresa nenalezena`: zkuste tvar „Ulice číslo, Město“.

### 2. Sdílení a zveřejnění

1. **Sdílet → Kdokoli s odkazem → Editor.** Tento odkaz pošlete hráčkám, aby si doplnily řádek.
2. **Soubor → Sdílet → Publikovat na webu.** Vyberte list **Tým** a formát **CSV** a klikněte na **Publikovat**. Zkopírujte vzniklý odkaz. Aplikace z něj čte data.
3. **Vložte tento odkaz do žlutého pole v prvním řádku tabulky** (řádek „Odkaz na zveřejněnou tabulku“). Pak je vždy po ruce a nemusíte ho znovu hledat v nastavení zveřejnění. Skript ho sám zjistit neumí, vkládá se jednou ručně.
4. Otevřete [`tabulka/`](tabulka/) a vložte tentýž odkaz (a volitelně odkaz na úpravy tabulky). Aplikace vytvoří odkaz pro hráčky.

**Rozložení listu Tým:** řádek 1 odkaz na zveřejněnou tabulku, řádek 2 hala, řádek 3 čas příjezdu, řádek 5 záhlaví, od řádku 6 hráčky. Sloupce E–H se plní samy. Aplikace hledá řádky podle popisků v prvním sloupci („Hala…“, „Čas…“, „Jméno“), proto je nepřejmenovávejte.

**Starší tabulka (bez řádku s odkazem):** nejdřív vložte novou verzi skriptu `Kod.gs` a pak v nabídce **Spolujízdy → Aktualizovat starší tabulku** (nebo spusťte funkci `migrovat`). Skript nahoru vloží řádek pro odkaz a **nic nesmaže**. Funkci `nastavit` na tabulce s daty znovu nespouštějte, před smazáním se sice zeptá, ale smazala by hráčky.

**Nový zápas:** v nabídce **Spolujízdy** (u názvu tabulky) zvolte **Nový zápas (vymazat stavy)**. Adresy zůstanou.

### Co je dobré vědět

- **Zpoždění:** Google zveřejněnou tabulku obnovuje sám a změny se v aplikaci mohou objevit až za několik minut. Tlačítko **Obnovit** to neurychlí.
- **Soukromí:** odkaz na zveřejněnou tabulku je veřejný, kdo ho zná, přečte všechny adresy. Je proto v adrese aplikace za `#` a **není v repozitáři**. Odkaz posílejte jen do týmové skupiny. Editační odkaz dává právo měnit data.
- **Limity Google Map:** kontrola adres běží přes službu Mapy v Apps Scriptu a má denní limit (řádově tisíce adres). Pro tým to bohatě stačí, opakované adresy se navíc ukládají do cache.
- **Aplikace z tabulky jen čte.** Přidávat a upravovat se musí v tabulce.
- **Sloupce E–H** se doplňují po úpravě adresy. Když se někdy nedoplní, použijte **Spolujízdy → Zkontrolovat všechny adresy**.
- **Neověřeno na ostrém Googlu:** logika skriptu je otestovaná proti simulované tabulce a čtení tabulky proti simulovanému CSV. První spuštění na skutečné tabulce proto berte jako zkoušku.

---

## Jak plánovač rozhoduje

- Minimalizuje součet dob jízdy všech aut. Každé další auto se počítá jako pokuta (výchozí 20 min), takže se bez důvodu nejezdí ve více autech. Hodnotu změníte v nastavení plánování.
- Hlídá zajížďku: spolucestující by neměla v autě strávit o víc než 20 minut (nastavitelné) navíc oproti přímé cestě. Je to měkký limit. Když to jinak nejde, plánovač ho překročí.
- Počítá s časem na nastoupení u každé vyzvednuté hráčky (výchozí 2 min).
- Pro 10–15 lidí a 3–5 aut je výsledek skoro okamžitý. Test porovnává plánovač s úplným průchodem všech možností na malých úlohách a výsledek je stejný. U velkých týmů nemusí být rozdělení do aut vždy přesně nejlepší možné.
- Nezohledňuje spravedlivé střídání řidiček, dopravní špičky, cestu zpět ani osobní preference.

Časy jízdy počítá veřejný server OSRM a adresy v lokální verzi hledá Nominatim. Obě služby jsou bez záruky dostupnosti. Když OSRM nefunguje, aplikace to oznámí a použije odhad vzdušnou čarou.

## Struktura repozitáře

```
index.html            rozcestník
style.css             společné styly
planner.js            plánovač (čistá logika, bez závislostí)
common.js             společný kód: stavy, trasy, plán, mapa, zpráva do skupiny
test.js               testy plánovače
verze.js              nastaví číslo verze v HTML (spouští se po změně kódu)
lokalni/              lokální verze (index.html, app.js)
tabulka/              prototyp s Google tabulkou
  index.html, app.js    stránka, která z tabulky čte
  Kod.gs                skript do Google tabulky (kontrola adres, nastavení listu)
  test-kod.js           testy skriptu proti simulované tabulce
```

Testy: `node test.js` (plánovač) a `node tabulka/test-kod.js` (skript tabulky).

**Číslo verze:** soubory se v HTML načítají jako `app.js?v=…` a číslo se ukazuje i v patičce stránek. Po každé změně kódu spusťte před nahráním `node verze.js`. Prohlížeč si pak po nasazení stáhne nové soubory místo starých z paměti (GitHub Pages je jinak drží až 10 minut). Samotná stránka se obnoví nejpozději za 10 minut, nebo hned po tvrdém obnovení (Ctrl+F5).

## Soukromí

- Adresy hráček jsou osobní údaje. V lokální verzi zůstávají v prohlížeči. V tabulkové verzi jsou v Google tabulce a jejím zveřejněném CSV.
- Soubor se zálohou soupisky (`spolujizdy-soupiska.json`) obsahuje adresy. Je v `.gitignore`, aby se omylem nenahrál do veřejného repozitáře.

## Historie: verze s Firebase

Dříve vznikla i verze se sdílenou databází Firebase (hráčky vyplňují přímo v aplikaci a změny se projeví do několika sekund). Do současné struktury nepatří, ale je zachovaná v historii gitu v commitu `ec6050b` (`git show ec6050b --stat`). Dá se k ní vrátit, pokud pilot s tabulkou nebude stačit.

## Možná rozšíření

- Spravedlivé střídání řidiček (počítat, kdo kolikrát řídil).
- Omezení „raději nejede s…“.
- Rychlejší aktualizace než zveřejněné CSV (Google Sheets API s klíčem z vašeho Cloud projektu).
- Uložené haly a kalendář zápasů.
