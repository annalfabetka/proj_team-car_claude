# Spolujízdy na zápasy

Webová aplikace, která týmu navrhne, kdo pojede autem, koho vyzvedne a v jakém pořadí, aby cesta do haly byla co nejkratší. Adresy hráček se zadají jednou, na zápas se jen zaškrtne, kdo jede a kdo může řídit.

## Spuštění

Bez instalace. Otevřete `index.html` v prohlížeči (nebo složku zveřejněte jako statický web, např. GitHub Pages).

```
spolujizdy/
  index.html   rozhraní
  app.js       rozhraní, ukládání, geokódování, mapa
  planner.js   vlastní plánování (čistá logika, bez závislostí)
  test.js      testy plánovače
```

Testy: `node spolujizdy/test.js`

## Jak se používá

1. **Hráčky:** jméno, adresa, jestli má auto a kolik míst (včetně řidičky). Aplikace adresu sama najde na mapě.
2. **Zápas:** adresa haly a čas, kdy tam chcete být. U každé hráčky nastavte „Dnes“: *Nejede*, *Jede*, *Může řídit* nebo *Musí řídit*.
3. **Naplánovat jízdy:** výsledkem jsou auta s časy výjezdu a vyzvednutí, mapa a hotová zpráva do skupiny.

Aplikace sama vybere, které z řidiček pojedou. „Musí řídit“ je pevné zadání, „Může řídit“ nechává výběr na plánovači.

## Jak plánovač rozhoduje

- Minimalizuje součet dob jízdy všech aut. Každé další auto se počítá jako pokuta (výchozí 20 min), takže se bez důvodu nejezdí ve více autech. Hodnotu změníte v nastavení.
- Hlídá zajížďku: spolucestující by neměla v autě strávit o víc než 20 minut (nastavitelné) navíc oproti přímé cestě. Je to měkký limit. Když to jinak nejde, plánovač ho překročí.
- Počítá s časem na nastoupení u každé vyzvednuté hráčky (výchozí 2 min).
- Na velikost týmu 10–15 lidí a 3–5 aut je výsledek skoro okamžitý. Test porovnává plánovač s úplným průchodem všech možností a výsledek je stejný.

## Soukromí a omezení

- Soupiska s adresami se ukládá jen v prohlížeči (`localStorage`). Na jiné zařízení ji převedete exportem do souboru.
- Adresy se posílají na [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap) k nalezení souřadnic a souřadnice na veřejný server [OSRM](https://router.project-osrm.org) k výpočtu časů. Jsou to veřejné služby bez záruky dostupnosti a pro lehké používání jako zde stačí. Pokud je OSRM nedostupný, aplikace to oznámí a použije odhad vzdušnou čarou.
- Nominatim občas nenajde neobvyklý zápis adresy. Zkuste „Ulice číslo, Město“.

## Možná rozšíření

- Spravedlivé střídání řidiček (počítat, kdo kolikrát řídil).
- Sdílený odkaz, přes který si hráčky samy zadají adresu a „jedu / nejedu“. Vyžaduje server nebo databázi.
- Uložené haly a kalendář zápasů.
- Řidička „raději nejede s…“ jako další omezení.
