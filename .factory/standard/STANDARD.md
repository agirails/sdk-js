# Standard tvornice softvera

Generirano iz `standard/rules.toml` komandom `bin/standard gen`. Ne uređuj ručno: `bin/standard gen --check` i `tests/test_standard.py` padaju kad se razlikuju.

Jedna ljestvica kvalitete i sigurnosti za sav kod koji gradimo, bez obzira tko ga piše: Claude, Codex, drugi model ili osoba. Pravilo živi na najvišoj razini koja ga može provesti. Postojeće kršenje stoji u baselineu koji smije samo padati: pravilo pada na novim i promijenjenim redcima i na kršenju koje je nastalo brisanjem. Ulaz za provjeru je `bin/code-check`. Exit 0 je čisto, exit 1 su nova kršenja, a exit 2 znači da provjera nije mogla izmjeriti; exit 2 nikad nije prolaz. Budžet performansi (P) je prvo izvještaj, a brana postaje tek kad je šum izmjeren i budžet zapisan u `standard/repos/<id>.toml`.

## Razine provedbe

1. **Kod i arhitektura**: loš uzorak se ne može napisati.
2. **Statička provjera**: lint, typecheck, `code-check` i CI; loš uzorak se ne može isporučiti.
3. **Skillovi i pravila**: za prosudbu koju stroj ne može provjeriti.
4. **Ljudski review**: samo za ono što razine 1–3 još ne pokrivaju; svaki takav nalaz je kandidat za višu razinu.

## Kvaliteta (K)

| ID | Pravilo | Razina | Provodi | Jezici | Provjera |
|---|---|---|---|---|---|
| K1 | **Jedan put za istu stvar**: Novi kod koristi postojeći modul ili API i ne uvodi paralelni. | 1 + 2 | arhitektura po repou; zabranjeni importi u `standard/repos/<id>.toml` | all | — |
| K2 | **Komentar je samo dokumentacija ili direktiva**: Komentar postoji samo kao dokumentacija javnog simbola ili modula, direktiva s razlogom ili `EXTERNAL(...)`. | 2 | `code-check comments` | py, ts, sol, sh | `factory.comments` |
| K3 | **Nema komentara o zaobilasku ni TODO-a**: Ni u doc komentaru. Nedovršeno ide u issue. | 2 | `code-check comments` (rječnik ispod, engleski i hrvatski) | all | `factory.comments` |
| K4 | **Greška se ne guta**: Nema praznog `except` ili `catch`, `except Exception: pass`, `.catch(() => {})` ni prazne rejection funkcije u `.then(_, () => {})`. Rukovatelj koji hvata svaku grešku i samo vraća stalnu vrijednost (`.catch(() => null)`, `catch { return null; }`, `except Exception: return None`) također guta grešku. | 2 | ruff `BLE001`, `S110`, `SIM105`; eslint `no-empty`, `@typescript-eslint/no-floating-promises`; AST provjera praznih callbacka u `code-check`, jer `no-empty` izuzima tijela funkcija | py, ts | `factory.checks.handlers` |
| K5 | **Isključenje lintera samo uz ime pravila i razlog**: `eslint-disable-next-line <pravilo> -- razlog`, `biome-ignore <kategorija>: razlog`, `# noqa: KOD`, `@ts-expect-error razlog`. `@ts-ignore` i goli `# type: ignore` su zabranjeni. Isključenje ispravnosnog pravila traži `factory-allow`; isključenje provjere tipova (`@ts-expect-error`, `# type: ignore[kod]`, `# pyright: ignore[kod]`) je ispravnosno. Isključenje za cijelu datoteku (`@ts-nocheck`, `# mypy: ignore-errors` i ostale slabije `mypy:` postavke, `# pyright: basic` i `report*=false`) je kršenje i uz razlog. | 2 | eslint `@eslint-community/eslint-comments/require-description`, `@typescript-eslint/ban-ts-comment`; ruff `PGH003`, `PGH004`; razvrstavanje pravila u `standard/configs/rule-classes.toml` | py, ts | `factory.comments` |
| K6 | **Strogi tipovi**: TypeScript `strict` i `noUncheckedIndexedAccess`; Python SDK i servisi s type hintovima i mypy. | 2 | `tsc --noEmit` sa `standard/configs/tsconfig.strict.json`; mypy | ts, py | — |
| K7 | **Upozorenje je greška na novim redcima**: Linter se vrti s `--max-warnings 0`. | 2 | CI i `code-check` | ts, py | — |
| K8 | **Bez mrtvog koda**: Nema neiskorištenih importa, varijabli ni exporta. | 2 | ruff `F401`, `F841`; `@typescript-eslint/no-unused-vars` = error; knip za tier A | ts, py | — |
| K9 | **Bez lokalnih putanja i interne infrastrukture**: Isporučeni kod i docsi ne sadrže apsolutne putanje korisničkih direktorija, putanje u interni radni prostor ni imena internih repoa. Uzorci putanja su u provjeri, a interna imena u `standard/configs/internal-names.txt`. | 2 | `code-check paths` | all, md | `factory.checks.paths` |
| K10 | **Ovisnosti idu jednim smjerom**: Nema importa unutar funkcija kao zaobilaska kružnih ovisnosti. | 1 + 2 | ruff `PLC0415` | py | — |
| K11 | **Formatter je jedini izvor stila**: Stil određuje formatter u check načinu, a ne review. | 2 | `ruff format --check`, `prettier --check` ili formatter repoa, `forge fmt --check` | all | — |
| K12 | **Promjena ponašanja ima test koji bez nje pada**: Test se piše prije izmjene i mora pasti iz pravog razloga. | 3 + 2 | skill `prove`; `code-check` upozorava na izmjenu u `src/` bez izmjene testova | all | `factory.checks.testdelta` |
| K13 | **Datoteka ili funkcija ne raste preko praga**: 800 redaka po datoteci, 120 po funkciji. Pada samo rast. | 2 | `code-check size` | all | `factory.checks.size` |
| K14 | **Granice modula su zapisane i provode se kroz graf importa**: Electron main, preload i renderer su odvojeni; Next.js serverski kod (baza, tajne, ključevi) nikad nije u klijentskoj komponenti (`import "server-only"`); javni API SDK-a ide samo kroz `index`. | 1 + 2 | dependency-cruiser (TS), import-linter (Python), granice u `standard/repos/<id>.toml` | ts, py | — |
| K15 | **Stari i paralelni putovi se brišu**: Deprecated API ima datum uklanjanja; mrtvi exporti i nekorištene datoteke se brišu. | 1 + 2 | inventar putova po repou; knip ili vulture; `code-check` pada na `@deprecated` bez datuma | ts, py, sol | `factory.comments` |
| K16 | **Ponovljena skripta postaje CLI**: Skripta koju agenti napišu u dvije sesije postaje CLI u `scripts/` skilla ili repoa. | 3 + 2 | rudar transkripata koji hrani skill `correct` | all | — |
| K17 | **TypeScript bez izlaza iz sustava tipova**: Nema `as` (osim `as const`), `!`, `any` ni `console.*` u bibliotekama; `switch` je exhaustive; nema `no-unsafe-*` kršenja. | 2 | typescript-eslint `no-explicit-any`, `no-non-null-assertion`, `consistent-type-assertions`, `switch-exhaustiveness-check`, `no-unsafe-*`; eslint `no-console` | ts | — |
| K18 | **Nema ručno usklađenih popisa**: Kad iste stvari žive na dva mjesta, jedno se generira iz drugog ili test pada kad se razlikuju. | 1 + 2 | `bin/standard gen --check`; `tests/test_standard.py` | all | — |
| K19 | **Testovi se ne isključuju i ne slabe**: Dodani `.only`, `.skip`, `.fixme`, `.fail`, `xit`, `xfail`, `pytest.skip` i `vm.skip` padaju; uklonjena asercija daje upozorenje; novi test mora pasti na mutaciji koja kvari ponašanje. | 2 + 3 | `code-check tests`; skill `prove` | all | `factory.checks.tests_guard` |

### K2: Komentar je samo dokumentacija ili direktiva

Dopušteno na novim redcima:
- Python docstring na javnom simbolu i module docstring;
- Solidity NatSpec (`///` ili `/** */` s `@notice`, `@dev`, `@param`, `@return`, `@custom`) na ugovorima, funkcijama, eventima i greškama;
- JSDoc/TSDoc neposredno iznad exportane deklaracije ili javnog člana exportane klase;
- `/** … */` zaglavlje na vrhu TS ili Solidity datoteke;
- `SPDX-License-Identifier`, shebang, direktive iz K5 i `factory-allow`.

Ograničenje izvana (ovisnost, platforma, vendor, protokol) smije stajati uz poziv samo u obliku `EXTERNAL(<ovisnost>): <pravilo> <url>`. Prednost ima kodiranje ograničenja tipom, assertom, testom ili lintom.

Nije dopušten nijedan drugi komentar u tijelu koda. Ako kod treba objašnjenje, mijenja se ime, struktura ili test. Ako je pozadina odluka, ide u zapis odluke. Kad nije jasno vrijedi li iznimka, komentar ne ostaje. JSDoc na lokalnoj ili privatnoj funkciji pada na novim redcima.

Riječi koje signaliziraju ograničenje (IMPORTANT, do not remove, ne diraj, pazi) padaju s porukom „kodiraj ograničenje (tip, assert, test, lint), pa obriši komentar".

Provjera čita kod tokenizerom po jeziku, a ne regexom po retku: string `"// not a comment"` ne pada. Uzastopni `//`, `///` i `#` redci su jedan komentar.

### K3: Nema komentara o zaobilasku ni TODO-a

Rječnik: `for now`, `TODO`, `FIXME`, `XXX`, `hack`, `kludge`, `band-aid`, `quick fix`, `workaround`, `temporary fix`, `temporary solution`, `temporary hack`, `temporary patch`, `temporarily disabled`, `temporarily skipped`, `temporarily hardcoded`, `privremeno rješenje`, `za sada`, `zasad`, `zaobilazak`.

„temporary" i „temporarily" broje se samo u frazama iz rječnika. „no workaround", „without workaround" i „workaround mode" se ne broje. Rječnik se može izigrati („for now" → „currently"), pa se uzorak novih doc komentara pregledava tjedno; pregled prijavljuje, ali ne odlučuje.

## Sigurnost (S)

| ID | Pravilo | Razina | Provodi | Jezici | Provjera |
|---|---|---|---|---|---|
| S1 | **Nema tajni u diffu ni u povijesti**: Tajna ne ulazi u diff; povijest se jednom skenira, a izvještaj ne sadrži vrijednosti tajni. Konfiguracija ne preuzima upstream allowliste putanja (vendor, node_modules, lockfileovi), a repo `.gitleaksignore` se ne poštuje. | 2 | gitleaks (pinan, `standard/configs/gitleaks.toml` generiran iz njegove zadane konfiguracije) nad diffom u `code-check` i u CI-ju | all, md | `factory.checks.external` |
| S2 | **Nova ovisnost je pinana i pregledana**: Lockfile, pinana verzija, audit bez high ili critical nalaza, pregledane install skripte. | 2 + 3 | `code-check deps` na promjeni lockfilea (`npm audit --omit=dev --audit-level=high`, osv-scanner ili pip-audit); skill `supply-chain-security` za svaku novu ovisnost | ts, py | — |
| S3 | **GitHub Actions su pinane i minimalne**: Akcije su pinane na SHA, `permissions:` je minimalan, nema `pull_request_target` s checkoutom koda PR-a ni `${{ github.event.* }}` u `run:`. Workflow ili `action.yml` koji se ne može pročitati nije prolaz, a skripte u `run:` provjerava shellcheck. | 2 | zizmor `--strict-collection`, actionlint i shellcheck (pinani, `standard/configs/zizmor.yml`) | gha | `factory.checks.external` |
| S4 | **Solidity bez novih high ili medium nalaza**: slither bez novih high ili medium nalaza, NatSpec na external i public funkcijama, CEI. | 2 + 3 | slither u CI-ju uz baseline; solhint (`standard/configs/.solhint.json`); skill `smart-contract-implementation` | sol | — |
| S5 | **Bez opasnih poziva**: Nema `eval`, `exec` s ulazom, `shell=True` s varijablom, `child_process.exec` s interpolacijom, `pickle` nad nepovjerljivim ulazom ni SQL-a spojenog iz stringova. | 2 | ruff `S`; eslint `no-eval`, `no-implied-eval`, `no-new-func`, ograničen `child_process.exec` | py, ts | — |
| S6 | **Diff na granici povjerenja prolazi sigurnosni pregled**: Auth, mostovi, egress, dozvole, novac i potpisi prolaze `blast-radius`, `security-audit` guidance i Codex Security `security-diff-scan` prije shipa. Ugovori i SDK major prije releasea idu u puni audit. | 2 + 3 | `code-check` označi diff koji dira `trust_boundary` iz `standard/repos/<id>.toml`; `prove` traži zapis audita | all | — |
| S7 | **Kod repoa se izvršava samo u sandboxu**: Provjera koja izvršava kod repoa (konfiguracija lintera, testovi, repro nalaza) ide kroz sandbox koji čuva i mrežu i povjerljivost. Poznato ograničenje: ukupna memorija svih procesa i ukupno pisanje u putanje za pisanje nisu ograničeni, jer bi to tražilo cgroup preko korisničkog systemd busa; po procesu su ograničeni privatna memorija u heapu i privatnim mapiranjima (RLIMIT_DATA, zadano 4 GB), adresni prostor (RLIMIT_AS, zadano 4 GB; poziv koji pokreće code-check s gitleaksom traži 8 GB, jer pinani gitleaks rezervira oko 5,4 GB, a koristi oko 0,15 GB) i CPU vrijeme, a uz to broj procesa, veličina jedne datoteke, tmpfs i izlaz. RLIMIT_DATA ne broji stog (glavni stog, MAP_GROWSDOWN, mremap stoga) ni dijeljena mapiranja, pa je adresni prostor gornja granica memorije jednog procesa. | 1 + 2 | `bin/sandbox-run`; tier B koristi samo našu konfiguraciju | all | — |

## Budžeti performansi (P)

| ID | Proizvod | Početni budžet | Provodi |
|---|---|---|---|
| P1 | Solidity ugovori | Plin po funkciji ne raste bez razloga. | `forge snapshot --check` u CI-ju; promjena snapshota traži razlog u commitu |
| P2 | SDK paketi | Veličina paketa i vrijeme importa ne rastu više od 5 %. | `npm pack --dry-run`, vrijeme `require`, `python -X importtime` |
| P3 | Web | LCP < 2,5 s, CLS < 0,1, INP < 200 ms na mobilnom profilu; JS po ruti ne raste bez razloga. | Lighthouse CI ili verify skill nad preview buildom |
| P4 | Desktop aplikacija | Nema long taskova > 50 ms na glavnim putovima; okvir ≤ 16 ms pri skrolanju. | verify skill s CDP traceom |
| P5 | API-ji i servisi | p95 po endpointu je zapisan i ne raste više od 20 %. | verify skill ili benchmark skripta |
