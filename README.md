# Spolujízdy na zápasy

Webová aplikace, která týmu navrhne, kdo pojede autem, koho vyzvedne a v jakém pořadí, aby cesta do haly byla co nejkratší. Každá hráčka si sama zadá svou adresu a vybere stav, organizátorka nemusí nikoho obtěžovat dotazy.

Živá verze: https://annalfabetka.github.io/proj_team-car_claude/

## Jak se používá

1. **Hráčka** otevře odkaz týmu, přidá se tlačítkem „+ Přidat hráčku“, vyplní jméno a adresu a vybere stav:
   - **Určitě beru auto**: pojede jako řidička a vyplní počet míst (včetně sebe).
   - **Můžu vzít auto**: pojede autem, jen když to plánovači vyjde. Vybere ji podle bydliště.
   - **Potřebuji odvoz**: pojede jako spolucestující.
   - **Nejedu**: do plánu se nepočítá.
2. Kdokoli zadá **adresu haly** a **čas příjezdu** a klikne na **Naplánovat jízdy**. Výsledkem jsou auta s časy výjezdu a vyzvednutí, mapa a hotová zpráva do skupiny.
3. Před dalším zápasem tlačítko **Nový zápas: vynulovat stavy** všem smaže stav, adresy zůstanou.

Změny jedné hráčky se ostatním objeví do několika sekund bez obnovení stránky. Co právě píšete, se při příchodu cizí změny nepřepíše.

## Sdílený tým (Firebase) – jednorázové nastavení

Bez nastavení aplikace funguje jen na jednom zařízení (adresy se ukládají v prohlížeči). Aby si hráčky vyplňovaly údaje samy a všechny je viděly, je potřeba bezplatná databáze Firebase (Firestore). Nastavení trvá asi 10 minut a děláte ho jednou.

1. Na https://console.firebase.google.com klikněte na **Add project**, zvolte název (např. `spolujizdy`) a Google Analytics vypněte.
2. V menu **Build → Firestore Database → Create database**. Umístění zvolte v Evropě (např. `eur3` nebo `europe-west3`) a režim **Production mode**.
3. Na záložce **Rules** nahraďte obsah pravidly níže a klikněte na **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /teams/{teamId}/{document=**} {
         allow read, write: if true;
       }
     }
   }
   ```

   Pravidla pouští k datům jen toho, kdo zná dlouhý náhodný identifikátor týmu z odkazu. Výpis všech týmů pravidla nedovolují.
4. Ozubené kolečko **Project settings → General → Your apps → ikona webu `</>`**: zaregistrujte aplikaci (hosting nezapínejte) a z `firebaseConfig` opište `apiKey` a `projectId`.
5. Vložte je do souboru [`config.js`](config.js) a změnu nahrajte do repozitáře. `apiKey` se do veřejného repozitáře dává záměrně, u webových aplikací Firebase to není tajemství.
6. Otevřete web a klikněte na **Založit sdílený tým**. Dostanete odkaz, který pošlete hráčkám. Adresy, které jste už zadala, se do týmu přenesou.

Volitelné zabezpečení klíče: v Google Cloud Console (**APIs & Services → Credentials**) omezte API klíč na vaši doménu (*HTTP referrers*) a na API *Cloud Firestore*.

### Soukromí

- Kdo má odkaz týmu, vidí adresy všech a může je měnit. Odkaz posílejte jen do týmové skupiny. Je v něm za `#`, takže se neposílá na server při načtení stránky.
- Adresy jsou uložené u Google (Firebase) v zvoleném regionu a při hledání souřadnic se posílají na OpenStreetMap Nominatim. Trasy počítá veřejný server OSRM.
- Odkaz lze v aplikaci na daném zařízení odpojit tlačítkem „Odpojit toto zařízení od týmu“. Chcete-li tým zrušit úplně, smažte data v konzoli Firebase.
- Soubor se zálohou soupisky (`spolujizdy-soupiska.json`) obsahuje adresy. Je v `.gitignore`, aby se omylem nenahrál do veřejného repozitáře.

## Vlastní doména

GitHub Pages umí vlastní doménu: v **Settings → Pages → Custom domain** zadejte např. `auta.vasedomena.cz`. U poskytovatele domény pak nastavte záznam **CNAME** pro `auta` na `annalfabetka.github.io` a po chvíli zapněte **Enforce HTTPS**. Doména není pro fungování aplikace nutná.

## Spuštění a vývoj

Bez instalace. Otevřete `index.html` v prohlížeči nebo složku zveřejněte jako statický web.

```
index.html   rozhraní
app.js       rozhraní, ukládání, sdílení týmu, geokódování, mapa
planner.js   vlastní plánování (čistá logika, bez závislostí)
config.js    nastavení Firebase (prázdné = jen toto zařízení)
test.js      testy plánovače
```

Testy plánovače: `node test.js`

## Jak plánovač rozhoduje

- Minimalizuje součet dob jízdy všech aut. Každé další auto se počítá jako pokuta (výchozí 20 min), takže se bez důvodu nejezdí ve více autech. Hodnotu změníte v nastavení plánování.
- Hlídá zajížďku: spolucestující by neměla v autě strávit o víc než 20 minut (nastavitelné) navíc oproti přímé cestě. Je to měkký limit. Když to jinak nejde, plánovač ho překročí.
- Počítá s časem na nastoupení u každé vyzvednuté hráčky (výchozí 2 min).
- Pro 10–15 lidí a 3–5 aut je výsledek skoro okamžitý. Test porovnává plánovač s úplným průchodem všech možností na malých úlohách a výsledek je stejný. U velkých týmů nemusí být rozdělení do aut vždy přesně nejlepší možné.
- Nezohledňuje spravedlivé střídání řidiček, dopravní špičky, cestu zpět ani osobní preference.

## Omezení

- Nominatim občas nenajde neobvyklý zápis adresy. Zkuste „Ulice číslo, Město“.
- Veřejné služby Nominatim a OSRM jsou bez záruky dostupnosti. Když OSRM nefunguje, aplikace to oznámí a použije odhad vzdušnou čarou.
- Ve sdíleném týmu může kdokoli s odkazem upravit údaje kohokoli. Aplikace nerozlišuje uživatele.

## Možná rozšíření

- Spravedlivé střídání řidiček (počítat, kdo kolikrát řídil).
- Omezení „raději nejede s…“.
- Uložené haly a kalendář zápasů.
