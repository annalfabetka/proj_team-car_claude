# Spolujízdy na zápasy

Webová aplikace, která týmu navrhne, kdo pojede autem, koho vyzvedne a v jakém pořadí, aby cesta do haly byla co nejkratší.

Živá verze: https://annalfabetka.github.io/proj_team-car_claude/ (rozcestník)

K dispozici jsou dvě verze vedle sebe. Plánovač (výpočet tras) mají společný.

| Verze | Adresa | Pro koho |
|---|---|---|
| **Prototyp s Google tabulkou** | [`sheet/`](sheet/) | Hráčky vyplňují společnou Google tabulku, která sama kontroluje adresy. Aplikace z ní čte a plánuje. |
| **Lokální verze** | [`local/`](local/) | Jedno zařízení bez sdílení. Soupisku zadává jedna osoba, uloží se jen v jejím prohlížeči. Nic se nenastavuje. Z rozcestníku je dočasně skrytá (zakomentovaná v `index.html`), přímý odkaz funguje. |

## Stavy hráček

V obou verzích se u hráčky vybírá stav:

- **Určitě beru auto**: pojede jako řidička. Vyplní počet míst v autě (včetně sebe).
- **Můžu vzít auto**: pojede autem, jen když to plánovači vyjde. Vybere ji podle bydliště.
- **Potřebuji odvoz**: pojede jako spolucestující.
- **Nejedu**: do plánu se nepočítá.

Hráčky s prázdným stavem se do plánu nepočítají a aplikace na ně upozorní.

---

## Lokální verze (`local/`)

Bez nastavení. Otevřete stránku, zadejte hráčky (jméno, adresa, stav, případně počet míst), adresu haly a čas příjezdu a klikněte na **Naplánovat jízdy**. Výsledkem jsou auta s časy výjezdu a vyzvednutí, mapa a zpráva do skupiny.

- Soupiska se ukládá jen v tomto prohlížeči. Na jiné zařízení ji přenesete tlačítkem **Stáhnout soubor** a **Nahrát soubor**.
- Adresy se hledají přes OpenStreetMap Nominatim.
- **Nový zápas: vynulovat stavy** smaže stavy, adresy zůstanou.

---

## Prototyp s Google tabulkou (`sheet/`)

Hráčky vyplňují Google tabulku a aplikace z ní čte a plánuje. Tabulka sama ověřuje adresy přes Google Mapy, takže překlep se ukáže hned při psaní. Nepotřebujete žádnou databázi ani klíče. Nastavení trvá asi 10 minut.

### 1. Vytvoření tabulky

1. Na https://sheets.google.com vytvořte novou **prázdnou** tabulku.
2. **Rozšíření → Apps Script**. Smažte vše, co tam je, a vložte obsah souboru [`sheet/Code.gs`](sheet/Code.gs). Uložte.
3. V horní liště vyberte funkci **`setup`** a klikněte na **Spustit**. Google se zeptá na oprávnění (je to váš vlastní skript, pro Mapy a úpravu tabulky). Povolte je. Pokud se zobrazí „Aplikace není ověřena“, zvolte **Upřesnit → Přejít na … (nezabezpečeno)**.
4. Tabulka se připraví: list **Tým** se záhlavím, rozbalovací nabídkou stavu, kontrolou počtu míst a barvami. Zkuste do sloupce **Adresa** napsat adresu. Vedle se objeví kontrola:
   - `✓ Adresa nalezena`: v pořádku, vedle je nalezená adresa a souřadnice.
   - `⚠ Zkontrolujte, zda nalezená adresa sedí`: Google si není jistý (překlep). Souřadnice se použijí, ale ověřte adresu.
   - `⚠ Upřesněte adresu`: chybí ulice a číslo domu (např. jen „Praha“). Souřadnice se nevyplní.
   - `✗ Adresa nenalezena`: zkuste tvar „Ulice číslo, Město“.

### 2. Sdílení a zveřejnění

1. **Sdílet → Kdokoli s odkazem → Editor.** Tento odkaz pošlete hráčkám, aby si doplnily řádek.
2. **Soubor → Sdílet → Publikovat na webu.** Vyberte list **Tým** a formát **CSV** a klikněte na **Publikovat**. Zkopírujte vzniklý odkaz. Aplikace z něj čte data.
3. **Vložte tento odkaz do žlutého pole v prvním řádku tabulky** (řádek „Odkaz pro aplikaci“). Pak je vždy po ruce a nemusíte ho znovu hledat v nastavení zveřejnění. Skript ho sám zjistit neumí, vkládá se jednou ručně.
4. Otevřete [`sheet/`](sheet/) a vložte tentýž odkaz (a volitelně odkaz na úpravy tabulky). Aplikace vytvoří odkaz pro hráčky.

**Rozložení listu Tým:** řádek 1 odkaz na zveřejněnou tabulku, řádek 2 hala, řádek 3 datum zápasu, řádek 4 čas příjezdu, řádek 6 záhlaví, od řádku 7 hráčky. Sloupce E–H se plní samy. Aplikace hledá řádky podle popisků v prvním sloupci („Hala…“, „Datum…“, „Čas…“, „Jméno“), proto je nepřejmenovávejte.

**Datum zápasu:** vyplňte ho ručně (např. `2. 12. 2026`), vedle se samo doplní **den v týdnu**. Datum se zobrazí v aplikaci i ve zprávě do skupiny („Zápas středa 2. 12. 2026 – sraz v hale 18:30…“). Slouží také k odlišení starých záznamů: když datum chybí (žlutě) nebo je v minulosti (červeně), upozorní na to tabulka i aplikace, že stavy hráček jsou nejspíš ze starého zápasu.

**Počet míst v autě** se vyplňuje jen u řidiček (stav „Určitě beru auto“ nebo „Můžu vzít auto“), celé číslo 2–9 včetně řidičky. U ostatních stavů je políčko šedé a tabulka do něj nepustí žádnou hodnotu. Když hráčka přepne stav na „Potřebuji odvoz“ nebo „Nejedu“, zbylé číslo se samo smaže. Řidička bez počtu míst má políčko oranžové a aplikace před plánem upozorní, že se počítá se 4 místy. Plánovač počet míst u spolucestujících stejně nepoužívá. Nové zápasy (**Nový zápas**) počty míst řidiček nemažou, takže je nemusí zadávat znovu.

**Cesta zpět (sloupce I–O).** Výchozí je, že se všichni vracejí na stejnou adresu jako tam, a pak není nutné nic vyplňovat. Jakmile se řádek hráčky začne vyplňovat, tabulka sama doplní **„Stejně jako tam“** a u řidiček ve sloupci „Míst zpět“ **stejný počet míst jako tam**. Výjimky se zadávají v těchto sloupcích:

- **Návrat**: *Stejně jako tam* (výchozí), *Jinam* (zadejte adresu návratu), nebo *Odvoz zpět nepotřebuji* (domů se dostanete sami, takže nezabíráte místo v autě).
- **Míst zpět**: jen pro řidičky, počet míst v autě cestou zpět **včetně řidičky**. Výchozí je stejný počet jako tam (doplní se vzorcem, který se při změně počtu míst sám přepočítá). Kdo chce nabídnout méně, přepíše vzorec číslem: *1* = nikoho nevezmu (např. řidička jede na chatu), *2* = jednoho spolucestujícího, a tak dál. Víc než míst v autě tam zadat nejde.
- **Adresa návratu**: u *Stejně jako tam* se **vyplní sama** jako adresa cesty tam (včetně kontroly a souřadnic ve sloupcích L–O), a mění se spolu s ní. Stačí **napsat jinou adresu přímo do tohoto sloupce** a volba se sama přepne na *Jinam* a adresa se zkontroluje. Můžete také nejdřív zvolit *Jinam* a adresu napsat. U *Odvoz zpět nepotřebuji* se sloupce vyprázdní.
- Políčka, která vyplňuje tabulka nebo která se v daném případě nevyplňují, jsou šedá. Oranžové je „Jinam“ bez adresy.
- **Nový zápas** vrací cestu zpět na výchozí hodnoty (stejně jako tam), aby výjimka z minulého zápasu nezůstala, a počty míst řidiček nechává.

**Aktualizace skriptu ve starší tabulce:** vložte novou verzi skriptu `Code.gs` (nahraďte celý starý kód) a uložte. Pak **hned spusťte funkci `migrate`** (v nabídce **Spolujízdy → Aktualizovat starší tabulku (nové řádky)**, po obnovení stránky, nebo v editoru skriptů výběrem funkce `migrate` a tlačítkem **Spustit**). Je to nutné i tehdy, když se rozložení tabulky nezměnilo: funkce se jmenovaly česky a spouštěč kontroly adres odkazoval na starý název, `migrate` ho přeinstaluje. Bez toho by se po úpravě adresy nic nekontrolovalo.

Funkce `migrate` navíc doplní řádky, které starší tabulce chybí (řádek s odkazem, řádek s datem), nastaví pravidla pro počet míst a pro sloupce cesty zpět (I–O), smaže zbylé počty míst u spolucestujících a doplní chybějící nadpisy sloupců, třeba nové nadpisy I–O (existující text nepřepisuje), a existujícím hráčkám nastaví výchozí hodnoty cesty zpět a vyplní adresu návratu. Už zadané výjimky nechá. Staré odpovědi *ano*/*ne* ve sloupci J (z předchozí verze) převede na počet míst zpět (*ano* = jako tam, *ne* = 1) a přejmenuje nadpis. Nové sloupce jsou vpravo, takže se řádky ani stávající sloupce neposunou. Jinak **nic nemaže**: hráčky, adresy a stavy zůstanou. Funguje pro každou dřívější verzi a při opakovaném spuštění nic neposune. Funkci `setup` na tabulce s daty znovu nespouštějte, před smazáním se sice zeptá, ale smazala by hráčky.

**Nový zápas:** v nabídce **Spolujízdy** (u názvu tabulky) zvolte **Nový zápas (vymazat stavy)**. Adresy zůstanou. Pak nastavte datum nového zápasu.

### Co je dobré vědět

- **Zpoždění:** Google zveřejněnou tabulku obnovuje sám a změny se v aplikaci mohou objevit až za několik minut. Tlačítko **Obnovit** to neurychlí.
- **Soukromí:** odkaz na zveřejněnou tabulku je veřejný, kdo ho zná, přečte všechny adresy. Je proto v adrese aplikace za `#` a **není v repozitáři**. Odkaz posílejte jen do týmové skupiny. Editační odkaz dává právo měnit data.
- **Limity Google Map:** kontrola adres běží přes službu Mapy v Apps Scriptu a má denní limit (řádově tisíce adres). Pro tým to bohatě stačí, opakované adresy se navíc ukládají do cache.
- **Spuštění funkce z editoru skriptů:** výsledek se zobrazí jako okno v **záložce s tabulkou**, ne v editoru. Dokud v tabulce neklepnete na **OK**, ukazuje editor „Execution started“ a vypadá to, že se nic neděje. Mějte proto tabulku otevřenou v druhé záložce a okno potvrďte.
- **Ochrana proti rozbitému rozložení:** když se řádky v tabulce neshodují s tím, co skript čeká (např. po vložení nového skriptu do starší tabulky), skript **nic nezmění** a ohlásí to. Napraví to funkce `migrate`.
- **Aplikace z tabulky jen čte.** Přidávat a upravovat se musí v tabulce.
- **Sloupce E–H** se doplňují po úpravě adresy. Když se někdy nedoplní, použijte **Spolujízdy → Zkontrolovat všechny adresy**.
- **Neověřeno na ostrém Googlu:** logika skriptu je otestovaná proti simulované tabulce a čtení tabulky proti simulovanému CSV. První spuštění na skutečné tabulce proto berte jako zkoušku.

---

## Celková doba a odkaz na navigaci

U každého auta (tam i zpět) je pod seznamem zastávek **celková doba cesty řidičky** (od výjezdu do příjezdu, včetně času na nastoupení) a odkaz:

- **Trasa v Google Maps**: jeden odkaz s celou trasou (start, zastávky ve správném pořadí, cíl), který se na telefonu otevře v aplikaci a ukáže aktuální dopravu. Cestou tam vede z domova řidičky přes vyzvednutí do haly, cestou zpět od haly přes vysazení k adrese řidičky.
- Odkaz obsahuje souřadnice adres, proto je jen na stránce a **není ve zprávě do skupiny**.

## Jak plánovač rozhoduje

- Minimalizuje součet dob jízdy všech aut. Každé další auto se počítá jako pokuta (výchozí 20 min), takže se bez důvodu nejezdí ve více autech. Hodnotu změníte v nastavení plánování.
- Hlídá zajížďku: spolucestující by neměla v autě strávit o víc než 20 minut (nastavitelné) navíc oproti přímé cestě. Je to měkký limit. Když to jinak nejde, plánovač ho překročí.
- **Hlídá i zajížďku řidičky:** řidička by neměla jet o víc než 25 minut (nastavitelné) déle, než by jela přímo do haly, kvůli tomu, aby svezla ostatní. Bez toho plánovač minimalizuje jen celkový počet minut a aut, takže jedné řidičce může naložit velkou zajížďku, aby ušetřil jiné auto (třeba aby svezla i hráčku, která má vlastní auto a bydlí blízko haly). Díky limitu se zátěž rozloží a hráčka s „Můžu vzít auto“ jede raději s někým, kdo ji míjí. Celkem to stojí jen pár minut jízdy navíc. Je to měkký limit: když to jinak nejde, plánovač ho překročí. Stejný limit platí i pro cestu zpět (od haly přes vysazení k adrese řidičky).
- Počítá s časem na nastoupení u každé vyzvednuté hráčky (výchozí 2 min).
- Pro 10–15 lidí a 3–5 aut je výsledek skoro okamžitý. Test porovnává plánovač s úplným průchodem všech možností na malých úlohách a výsledek je stejný. U velkých týmů nemusí být rozdělení do aut vždy přesně nejlepší možné.
- Nezohledňuje spravedlivé střídání řidiček, dopravní špičky, cestu zpět ani osobní preference.

Časy v plánu jsou **jen orientační** (typické doby jízdy bez aktuální dopravy). Aplikace to uvádí pod plánem a na konci zprávy do skupiny doporučuje před odjezdem zkontrolovat dopravu v Google Maps.

Časy jízdy počítá veřejný server OSRM a adresy v lokální verzi hledá Nominatim. Obě služby jsou bez záruky dostupnosti. Když OSRM nefunguje, aplikace to oznámí a použije odhad vzdušnou čarou.

### Cesta zpět

Cesta zpět se plánuje jen tehdy, když se někdo nevrací stejně jako tam. Jinak se o ní nic nezobrazuje.

- **Auta zůstávají u haly**, takže zpět mohou jet jen ta, která tam přijela. Spolucestující tedy zpět neřídí. Řidičky se proto vybírají už pro cestu tam tak, aby měly dohromady dost volných míst i na cestu zpět. Když to nejde, plán to řekne („zpět by chybělo aspoň N míst“).
- **Stejně jako tam, pokud se nedá výrazně lépe.** Lidé se vracejí v tom autě, v jakém přijeli. Auto se změní jen v těchto případech: (1) pro člověka v autě řidičky zpět není místo, nebo (2) změna ušetří víc než pár minut jízdy (výchozí „cena“ změny je 8 minut na osobu). Typicky když dva lidé jedou na stejné místo, třeba oba do Satalic: jedou spolu, i když tam jeli každý jinak. Přesuny plán vypíše („řidička tam: Anna, zpět: Hana“). Plánovač také mírně preferuje, aby spolucestující jeli s řidičkou, která je vrátí, takže se přesuny často vůbec nepotřebují. Pokud auto zpět nabízí méně míst, než kolik lidí přivezlo, uvolní místo ti, jejichž adresa je řidičce nejméně po cestě.
- **Směr řidičky je hlavní.** Cesta zpět vede od haly přes místa, kde se spolucestující vysadí, k adrese řidičky (domů nebo jinam). Zda kvůli spolucestujícím zajede až k jejich adrese, je na domluvě s řidičkou, plán je jen návrh. U auta se proto ukazuje, o kolik minut jede řidička déle než přímo.
- **Bez časů.** U cesty zpět se zobrazuje jen pořadí zastávek.
- Lidé, kteří se vracejí sami, se do cesty zpět nepočítají a uvolňují místo v autě.
- Když se nikdo nevrací jinak, pod plánem je pod upozorněním k časům věta „Doprava zpět je stejná: všichni se vracejí ve stejných autech na stejné adresy jako cestou tam.“ (a ve zprávě do skupiny „Zpět jedeme stejně jako tam“). Místo ní se pak zobrazí podrobná část „Cesta zpět“.

## Struktura repozitáře

Názvy složek, souborů a komentáře v kódu jsou anglicky. Česky zůstávají jen texty, které vidí hráčky (rozhraní, popisky v tabulce) a tento návod.

```
index.html            chooser page
style.css             shared styles
planner.js            the planner (pure logic, no dependencies)
common.js             shared code: statuses, routes, the plan, the map, the group message
test.js               planner tests
version.js            sets the version number in the HTML (run after changing code)
local/                local version (index.html, app.js)
sheet/                Google Sheet prototype
  index.html, app.js    the page that reads from the sheet
  Code.gs               script for the Google Sheet (address validation, sheet setup)
  test-code.js          tests of the script against a simulated sheet
```

Testy: `node test.js` (plánovač) a `node sheet/test-code.js` (skript tabulky).

**Číslo verze:** soubory se v HTML načítají jako `app.js?v=…` a číslo se ukazuje i v patičce stránek. Po každé změně kódu spusťte před nahráním `node version.js`. Prohlížeč si pak po nasazení stáhne nové soubory místo starých z paměti (GitHub Pages je jinak drží až 10 minut). Samotná stránka se obnoví nejpozději za 10 minut, nebo hned po tvrdém obnovení (Ctrl+F5).

## Soukromí

- Adresy hráček jsou osobní údaje. V lokální verzi zůstávají v prohlížeči. V tabulkové verzi jsou v Google tabulce a jejím zveřejněném CSV.
- Soubor se zálohou soupisky (`carpool-roster.json`) obsahuje adresy. Je v `.gitignore`, aby se omylem nenahrál do veřejného repozitáře.

## Historie: verze s Firebase

Dříve vznikla i verze se sdílenou databází Firebase (hráčky vyplňují přímo v aplikaci a změny se projeví do několika sekund). Do současné struktury nepatří, ale je zachovaná v historii gitu v commitu `ec6050b` (`git show ec6050b --stat`). Dá se k ní vrátit, pokud pilot s tabulkou nebude stačit.

## Možná rozšíření

- Spravedlivé střídání řidiček (počítat, kdo kolikrát řídil).
- Omezení „raději nejede s…“.
- Rychlejší aktualizace než zveřejněné CSV (Google Sheets API s klíčem z vašeho Cloud projektu).
- Uložené haly a kalendář zápasů.
