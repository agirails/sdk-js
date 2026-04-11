# x402 v2 Integration — Implementation Plan (v4.2, post-hardening, GREEN LIGHT)

**Status**: Plan finaliziran + 2-sat pre-impl hardening spike gotov. Svi critical unknowns verificirani. Spreman za Faza 1 start.
**Target version**: `@agirails/sdk@3.3.0` (Phase 1: buyer + seller u istom releaseu)
**Author**: Arha + Damir
**Date**: 2026-04-11
**Supersedes**:
- v1 (rani 2026-04-11) — hallucinated `wrapFetchWithPaymentFromConfig` signature, probe routing, legacy rename dance
- v2 (2026-04-11) — EOA-only x402 path, propustio Smart Wallet Permit2 put
- v3 (2026-04-11) — Smart Wallet inclusive via Permit2, ali buyer-only scope; kontradikcije između "must work" i "out of scope"
- v3.1 (2026-04-11) — Smart Wallet spike resolved; introduced v4 blocker findings (silent bugs, lazy-publish race)
- v3.2 (2026-04-11) — Q7/Q11 finalizirani; ali propustio P0/P1 rupe koje je Damir uhvatio u audit-u
- **v4 (ovaj dokument)** — Damirov P0/P1/P2 audit reviewed. Buyer + seller u istom Phase 1. Smart Wallet scope kontradikcije uklonjene. API mismatch fixed. Strict HTTPS. Await approve. Real mapToPayResult. Network defaults expanded to full EVM interop. SLO + compatibility matrix umjesto "nikad problema". Timeline realistično ~2.5-3 tjedna.

---

## Executive summary

Patrick je testirao naš SDK protiv `x402.org/protected` (Coinbase reference endpoint) i našao dvije rupe: x402 adapter nije auto-registriran i ne govori pravi x402 v2 protokol (custom `x-payment-*` flow umjesto standardnog `payment-required` / EIP-3009 / CAIP-2).

Ultra-think audit otkrio je tri stvari:
1. Naš postojeći `X402Adapter` **uopće nije x402** — custom AGIRAILS HTTP payment flow koji koristi 402 status code ali različite headere, network format, payment mechanics, i proof submission
2. **Nitko ga stvarno ne koristi** u produkciji — single call site u cijelom codebaseu je naš vlastiti `n8n-nodes-actp/nodes/ACTP/utils/client.factory.ts:160`; sve ostalo su docs i test stringovi
3. **x402 je funnel, ACTP je monetizacija** — forsiranje 1% fee na x402 flow pada na AGIRAILS-ovim vlastitim Three Tests (trustless/walkaway/self-sovereign) i Vitalikovom simplicity doktrinom

**Pristup**: direktno prepisati `X402Adapter.ts` kao thin wrapper oko stvarnih `@x402/*` paketa. Bez rename-a, bez alijasa, bez legacy/deprecation dance-a, bez probe routing logike, bez fee extrakcije, bez self-hosted facilitatora.

**Ključni zahtjev (Damir, 2026-04-11 v3)**: **Smart Wallet MORA raditi x402** od Phase 1. Razlog nije gassless (x402 je već gassless za buyera bez obzira na wallet tip jer facilitator submita tx), nego **unified UX**: jedan wallet, jedan USDC balance, jedna identity, jedan `actp init`. Korisnik se nikad ne smije pitati "koji wallet koristim sad".

---

## Gassless semantika — razjašnjenje (VAŽNO)

Čest misconception koji smo trebali razjasniti prije fiksiranja plana: **x402 je gassless za buyera nezavisno od wallet tipa.**

Zašto:
1. Buyer potpisuje EIP-3009 `transferWithAuthorization` (ili Permit2 witness) **off-chain** — čisto kriptografska operacija, nula blockchain interakcije, free
2. HTTP request s payload-om se šalje serveru
3. Server (ili njegov facilitator) submita on-chain tx i **plaća gas**
4. USDC se kreće iz buyer address-a u `payTo` address-u

Buyer nikad ne dodiruje mempool. Paymaster/Smart Wallet NIJE tu izvor gasslessnessa — dizajn x402 protokola je.

**Gdje je naš paymaster vrijednost**: za ACTP (gdje buyer direktno submita `createTransaction + approve + linkEscrow` batch userOp) — tamo Smart Wallet + paymaster ima smisla i štedi gas. Za x402 je to nepotrebno.

**Zašto ipak trebamo Smart Wallet za x402**: **unified wallet UX**, ne gasless. Ako user ima USDC u Smart Wallet-u (jer ACTP to zahtijeva), a x402 zahtijeva EOA, imamo dva različita USDC balansa i dva wallet-a. Loš UX za agenta koji radi i ACTP i x402 poslove.

---

## Smart Wallet + x402 tehnički put — verificirano 2026-04-11

Direktni EIP-3009 ne radi za Smart Wallete — USDC `transferWithAuthorization` ne zove ERC-1271 na kontraktima. ALI, **Permit2 put radi** i production-ready je u `@x402/evm@2.9.0`.

### Kako Permit2 put radi

1. **Server advertisira** `extra.assetTransferMethod: "permit2"` u `payment-required` accepts entry
2. **Klijent** (`ExactEvmScheme`) interno bira Permit2 branch umjesto EIP-3009 branch-a, signira `PermitWitnessTransferFrom` EIP-712 poruku preko `signer.signTypedData`
3. **Facilitator** validira signature dvoslojno:
    - Primarni: `viem publicClient.verifyTypedData({ address, ...typedData, signature })` — radi ERC-1271 za deployed Smart Walletove i ERC-6492 za counterfactual (undeployed) Smart Walletove
    - Fallback: ako off-chain validacija padne, `eth_call` simulacija `x402ExactPermit2Proxy.settle(...)` — ako simulacija prođe, accept signature
4. **Facilitator** zove `x402ExactPermit2Proxy.settle(...)` on-chain
5. **Proxy** koristi Permit2 koji preko ERC-1271 validira Smart Wallet signature, zatim izvršava USDC transfer
6. **USDC** stiže na `payTo`

### Ključne adrese i verzije

- `PERMIT2_ADDRESS = 0x000000000022D473030F116dDEE9F6B43aC78BA3` (Uniswap canonical, svi EVM lanci)
- `x402ExactPermit2ProxyAddress = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001` — CREATE2 deterministic, **isti na svim lancima**
- Deployed preko Arachnid deployera `0x4e59...956C`
- ABI: `x402ExactPermit2ProxyABI` exportan iz `@x402/evm@2.9.0`
- Paket: `@x402/evm@2.9.0` (sadržaj verificiran protiv published tarball-a)

**Treba verificirati on-chain prije shippinga**: `eth_getCode(0x402085c248EeA27D92E8b30b2C58ed07f9E20001)` na Base mainnet + Base Sepolia. Source kaže da je canonical, ali rule je "trust but verify".

### Buyer one-time setup

**Opcija A — One-time Permit2 approve**:
- Buyer Smart Wallet zove `USDC.approve(PERMIT2_ADDRESS, MAX_UINT256)` jednom
- Sponsored kroz naš postojeći paymaster (Pimlico/CDP) — zero cost za usera
- Nakon toga, svaki x402 Permit2 plaćanje radi bez dodatnih approves-a
- `createPermit2ApprovalTx(usdcAddress)` helper postoji u `@x402/evm`

**Opcija B — EIP-2612 gas sponsoring auto-path**:
- Ako server advertisira `eip2612GasSponsoring` extension, facilitator atomically radi permit + settle u jednoj tx
- Nula buyer approves, nula one-time tx
- USDC na Base podržava EIP-2612, ali ovisi o serveru

**Preporuka**: podržavati obje opcije. Lazy one-time approve na prvom plaćanju ako server ne nudi B. Ako server nudi B, preskoči approve.

### Test dokaz (upstream unit testovi)

Iz `typescript/packages/mechanisms/evm/test/unit/exact/facilitator.test.ts`:

```ts
it("should accept deployed smart wallet when verifyTypedData fails
    but simulation passes (ERC-1271)", async () => {
  mockFacilitatorSigner.verifyTypedData = vi.fn().mockResolvedValue(false);
  mockFacilitatorSigner.getCode = vi.fn().mockResolvedValue("0x6080604052");
  // ... simulacija prolazi
  expect(result.isValid).toBe(true);
});
```

Plus ERC-6492 testovi za undeployed/counterfactual Smart Walletove uz error code `invalid_exact_evm_payload_undeployed_smart_wallet`. CHANGELOG entry `1a6e08b`: *"Fixed undeployed smart wallet handling to prevent facilitator grieving."*

**Verdict**: Coinbase Smart Wallet implementira ERC-1271 + ERC-6492 (`replaySafeHash`), što je točno ono što Permit2 facilitator path očekuje. Production-ready.

### Ograničenja / caveats

1. **Testni endpoint `x402.org/protected` koristi EIP-3009**, ne Permit2 (`accepts[0].extra = {name: "USDC", version: "2"}` — to je domain version, ne `assetTransferMethod`). Dakle za Smart Wallet put trebamo:
    - Naći drugi public endpoint koji advertisira Permit2, **ili**
    - Napisati lokalni mock server (Express + `@x402/express`, ~50 linija) koji advertisira `assetTransferMethod: "permit2"` za integration testove
2. **Nema runnable example u upstream monorepu** za Smart Wallet + Permit2 — samo unit testovi. Naš X402Adapter impl će biti prvi real-world primjer, trebamo pisati s oprezom
3. **On-chain verifikacija proxy address-e** nije napravljena — memory kaže canonical deploy, ali treba `eth_getCode` provjeriti prije shippinga na obje mreže

---

## IWalletProvider verifikacija — proširenje potrebno

Pročitao sam `src/wallet/IWalletProvider.ts` (177 linija). Nalazi:

### Postojeća površina

```ts
export interface IWalletProvider {
  getAddress(): string;
  sendTransaction(tx: TransactionRequest): Promise<TransactionReceipt>;
  sendBatchTransaction(txs: TransactionRequest[]): Promise<TransactionReceipt>;
  getWalletInfo(): WalletInfo;
  payACTPBatched?(params, prependCalls?): Promise<BatchedPayResult>;
  createACTPTransaction?(params): Promise<CreateACTPTransactionResult>;
}
```

Interface je **namjerno opaque** — plain strings na granici, nula ethers/viem tipova. Dvije konkretne implementacije:
- `EOAWalletProvider` (Tier 2) — direktni ethers.Wallet signing
- `AutoWalletProvider` (Tier 1) — CoinbaseSmartWallet + Paymaster, gassless

### Što nedostaje za x402

Za x402 Permit2 path, potrebna je metoda koja signira EIP-712 typed data:

```ts
export interface EIP712TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

// Dodati u IWalletProvider:
signTypedData?(typedData: EIP712TypedData): Promise<string>;  // 0x-prefixed
```

**Optional** jer ne moraju svi walletovi podržavati (npr. legacy hardware wallet bez 712 podrške). X402Adapter pri registraciji provjerava `typeof walletProvider.signTypedData === "function"` i ne registrira se ako nije dostupno.

### EOAWalletProvider.signTypedData — trivijalno

```ts
async signTypedData(typedData: EIP712TypedData): Promise<string> {
  const { EIP712Domain: _omit, ...types } = typedData.types as any;
  return await this.wallet.signTypedData(
    typedData.domain as any,
    types as any,
    typedData.message as any
  );
}
```

Ethers v6 `Wallet.signTypedData(domain, types, value)` native potpis. ~10 linija uključujući EIP712Domain stripping. **Nizak rizik.**

### AutoWalletProvider.signTypedData — NETRIVIJALNO, najveći Phase 1 nepoznanik

Coinbase Smart Wallet (i slični ERC-4337 contract walletovi) ne signiraju EIP-712 poruke direktno. Flow je:

1. Izračunaj `typedDataHash = _hashTypedDataV4(typedData)` (EIP-712 struct hash + domain separator)
2. Wrap u `replaySafeHash = keccak256("\x19\x01" + smartWalletDomainSep + typedDataHash)` — Coinbase-specific replay protection
3. Owner EOA potpiše `replaySafeHash` (ne originalni typedDataHash)
4. Rezultirajuća signature se enkodira u **1271-compliant format**:
    - Za **deployed** Smart Wallet: `abi.encode(ownerIndex, ownerSignature)` (Coinbase Smart Wallet format) ili jednostavnije ako Smart Wallet koristi single-owner mode
    - Za **undeployed** Smart Wallet: **ERC-6492 wrap** — `abi.encode(factoryAddress, factoryCalldata, signature) ++ 0x6492...6492` magic bytes

Koraci koje spike agent MORA razotkriti:

- **(a) Koji je točan Smart Wallet implementacija** koja se koristi u AutoWalletProvider-u? Coinbase Smart Wallet (`0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a` factory)? Pimlico Simple Account? Safe? Svaki ima različit 1271 signing format.
- **(b) Kako naš AutoWalletProvider danas potpisuje** bilo što? Ima li već `signMessage` koji možemo proširiti, ili sve ide kroz `sendUserOperation`?
- **(c) Koji SDK/library daje replay-safe hashing + 1271 enkoding**? `@coinbase/onchainkit`? `viem/accounts` Smart Wallet utilities? Čisti viem + manual encoding?
- **(d) Kako razlikovati deployed vs undeployed Smart Wallet** u trenutku potpisivanja i odabrati 1271 vs 6492 put?
- **(e) Ima li paymaster neki impact** na 1271 signing, ili je signing potpuno odvojeno od gas sponsorstva?

### Smart Wallet spike rezultati (2026-04-11) — SOLVED

**Smart Wallet implementation**: Coinbase Smart Wallet v0.6, factory `0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842`. Verified u `src/wallet/aa/constants.ts:11,14`. Single-owner mode (`ownerIndex=0`), counterfactual deployment (deploys on first UserOp, not on init). AGIRAILS SDK već potpuno koristi ovaj stack.

**Trenutno stanje**: `AutoWalletProvider` **nema `signTypedData` uopće**. Sav signing ide kroz `UserOpBuilder.signUserOp` — raw ECDSA nad UserOp hash-om, onda wrapping u `SignatureWrapper(ownerIndex=0, rawSig)`. Owner EOA je `ethers.Wallet` instanca u memoriji. Grep za `1271|6492|replaySafe` u cijelom SDK-u vraća **nula** hitova.

**Libraryjski put — viem `toCoinbaseSmartAccount`**: viem ships first-class Coinbase Smart Wallet account factory u `viem/account-abstraction` koji implementira `signTypedData` korektno **uključujući**:
1. Izračun app-level EIP-712 hash-a (`hashTypedData`)
2. Wrap u replay-safe hash (`CoinbaseSmartWalletMessage` struct s verifyingContract = Smart Wallet address)
3. Owner EOA potpiše replay-safe hash
4. Encode u `SignatureWrapper(ownerIndex, rawSig)` za deployed wallet
5. **Automatsko ERC-6492 wrapping** za counterfactual/undeployed wallet (preko `serializeErc6492Signature` koji wrap-a factory+factoryData+innerSig)

Sve ovo radi **jedna funkcija poziva**: `await smartAccount.signTypedData(typedData)`. Nema custom crypto, nema ručnog replay-safe hashing-a, nema ručnog 6492 encoding-a.

**Podudaranje s `@x402/evm@2.9.0`**: facilitator validira preko `viem publicClient.verifyTypedData` koji native podržava 1271 + 6492 + on-chain simulation fallback. **End-to-end usklađeno.** Isti library stack na obje strane.

### AutoWalletProvider.signTypedData — verified pseudocode

```ts
// src/wallet/AutoWalletProvider.ts — novi method, ~25 linija
import { createPublicClient, http, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { base, baseSepolia } from "viem/chains";

async signTypedData(typedData: TypedDataDefinition): Promise<string> {
  // Lazy construction + caching viem account instance
  if (!this._viemAccount) {
    const chain = this.chainId === 8453 ? base : baseSepolia;
    const publicClient = createPublicClient({
      chain,
      transport: http(this.provider._getConnection().url),
    });
    const owner = privateKeyToAccount(this.signer.privateKey as `0x${string}`);
    this._viemAccount = await toCoinbaseSmartAccount({
      client: publicClient,
      owners: [owner],
      ownerIndex: 0,
      // nonce: 0n — must match our DEFAULT_WALLET_NONCE
    });

    // CRITICAL: counterfactual address parity check
    const viemAddr = await this._viemAccount.getAddress();
    if (viemAddr.toLowerCase() !== this.smartWalletAddress.toLowerCase()) {
      throw new Error(
        `Smart Wallet address mismatch: viem=${viemAddr} vs ours=${this.smartWalletAddress}. ` +
        `This means our computeSmartWalletAddress diverges from viem's toCoinbaseSmartAccount. ` +
        `Signatures would be valid but for the wrong contract.`
      );
    }
  }

  return this._viemAccount.signTypedData(typedData);
}
```

**Ključne napomene**:
- **Lazy init**: viem account se kreira samo ako se zaista koristi signTypedData (x402 plaćanja). Agenti koji rade samo ACTP nikad ne plaćaju viem boot cost.
- **Counterfactual address parity check je OBAVEZAN**. Naš `UserOpBuilder.computeSmartWalletAddress` koristi `factory.getAddress([abi.encode(['address'], [signer])], 0)`. viem koristi svoju encoding logiku. Ako se ne poklope, signature je validna ali za krivu adresu — silent fail koji je jako težak za debug. Check u konstruktoru sprječava.
- **EOAWalletProvider.signTypedData** — trivijalna implementacija: `return await this.wallet.signTypedData(domain, types, value)` nakon `EIP712Domain` stripping. ~10 linija.

### Dependency addition

Add to `sdk-js/package.json`:
```json
"dependencies": {
  "viem": "^2.21.0",
  "@x402/fetch": "~2.9.0",
  "@x402/evm": "~2.9.0",
  "@x402/core": "~2.9.0"
}
```

viem je ~80KB min+gz za subset koji koristimo (`account-abstraction`, `accounts`, `chains`, osnovne utilities). Node library, ne browser-critical — prihvatljivo.

**viem/account-abstraction je subpath istog paketa** — nema separate installa.

**NE trebamo**: `permissionless`, `@coinbase/onchainkit`, `@alchemy/aa-*`. Svi ti paketi ionako wrap-aju viem za Coinbase Smart Wallet.

### Complexity verdict (od spike-a)

**Easy → Medium, ~1 radni dan uključujući testove.** Crypto/math je obavljen za nas. Nema custom replay-safe hashing, nema custom 6492 wrapping. Glavni work:

- Dodati viem dependency
- Konstruirati viem PublicClient + LocalAccount iz postojećeg ethers Wallet-a i provider-a (trivijalno)
- Proširiti IWalletProvider s optional `signTypedData`
- Implementirati na oba providera (EOA trivijalno, Auto kao gore)
- Wire X402Adapter
- Unit + integration testovi

**Upgrade na Hard samo ako** hitnemo viem/ethers CJS bundling issue, što je known-clean combo. Vjerojatnost: niska.

### Smart Wallet spike — otvorene watch-outs

Ovo su stvari koje treba verificirati tijekom impl-a (ne blockeri za start):

1. **Counterfactual address parity** (sketched u pseudocode). Ako test pukne, moramo ili ispraviti naš compute ili uskladiti viem args.
2. **viem CJS compatibility** pod Node 18/20/22. viem je ESM-first, ima CJS build od 2.9+, ali naš SDK je CJS (`"main": "dist/index.js"`) i treba test u CI matrix-u. Ako CJS require pukne, alternative: dynamic `import()` ili ESM bump za sdk-js.
3. **x402 facilitator viem version compatibility**. `@x402/evm@2.9.0` mora koristiti viem ≥2.21 da verifyTypedData ima on-chain simulation fallback. Ako je pinned na stariju viem, 6492 verifikacija za naš prvi-x402 signature možda padne off-chain-only pa reject.
4. **Lazy publish + first x402 Permit2 approve race**. Paymaster gate traži `configHash != 0 || hasPendingPublish`. Unpublished agent-ov prvi Permit2 approve (preko `sendTransaction → submitUserOp → paymaster`) pada **osim ako je agent prvo publishan**. Treba ili (a) dokumentirati da `actp publish` ide prije prvog x402 plaćanja, ili (b) napraviti Permit2 approve dio lazy-publish batch-a (kao što `payACTPBatched` već radi preko `prependCalls`).
5. **SILENT BUG u postojećem kodu**: `DeliveryProofBuilder:248`, `QuoteBuilder:275`, `MessageSigner:211` zovu `signer.signTypedData` direktno na ethers Wallet (ne walletProvider). Za Tier 1 (Smart Wallet) agente ovo proizvodi **EOA-recoverable signature**, ne Smart Wallet signature. To je **postojeći, nepovezani bug** — Tier 1 agent-ov attested delivery neće validirati protiv svoje Smart Wallet adrese. **Ne u scope-u Phase 1**, ali treba ga flagati kao follow-up PR nakon što lands `walletProvider.signTypedData`.

### Paymaster interaction — automatski za Permit2 approve

Verified iz AutoWalletProvider koda: `sendTransaction` → `sendBatchTransaction` → `submitUserOp` uvijek calls `paymaster.getPaymasterData(userOp)`. **Nema branche-a, nema config flag-a.** Svaka transakcija preko AutoWalletProvider-a je automatski sponzorirana.

To znači: **one-time Permit2 approve je automatski gas-free za agenta**. Nema custom gas handling-a, nema Tier 1/Tier 2 branching-a u X402Adapter-u. Super clean UX — agent pozove `client.pay('https://x402-server.com')` i sve se dogodi transparent.

Jedina caveat: paymaster gate (`configHash != 0`) mora biti zadovoljen prije prvog Permit2 approve-a. Vidi watch-out #4 gore.

---

## Fiksirane odluke (Damir, 2026-04-11)

1. **`UnifiedPayParams.amount` postaje optional.** Za x402, klijent nikad ne zna iznos unaprijed — dolazi iz `payment-required` response-a. ACTP adapteri (basic/standard) i dalje zahtijevaju `amount`; x402 adapter ga ignorira i koristi SDK config-level maksimume.

2. **`X402Relay` kontrakt se dokumentira kao deprecated.** Ostaje deployed na Base mainnet (`0x81DFb954A3D58FEc24Fc9c946aC2C71a911609F8`) i Sepolia (`0x4DCD02b276Dbeab57c265B72435e90507b6Ac81A`) za historijsku kompatibilnost, ali se iz novog adaptera **nikad ne zove**. Dodati `@deprecated` notice u Solidity + `Protocol/actp-kernel/README.md`.

3. **Zero reputation tracking na x402 plaćanjima.** Samo ACTP plaćanja pišu u ERC-8004. Obrazloženje ide u `docs/x402-design-decisions.md`:
    - x402 je **fire-and-forget HTTP payment** — nema DELIVERED state-a, nema dispute window-a, nema eksplicitnog client-side signala o kvaliteti servisa
    - HTTP 200 nakon plaćanja znači "server je vratio odgovor", ne "servis je bio dobar". To je **uptime signal, ne reputacijski signal**
    - ACTP ima pravi reputacijski ciklus (INITIATED → DELIVERED → SETTLED + opcionalni DISPUTE) — tu reputacija ima stvarno značenje
    - Per-tx reputation write bi također bio ekonomski slomljen (~$0.30-0.50 gas na $0.10 x402 tx = 3-5x trošak iznad vrijednosti transakcije)
    - Reputation usage se mjeri za AGIRAILS agente koji zaračunavaju **kroz ACTP** — x402 je jeftin rail za male pozive, nije mjesto za reputation curation

4. **Docs sweep ide kroz odvojene PR-ove po repu.** Manje koda u jednom PR-u, jasniji change log po mjestu, manji rizik od kolateralnih regresija. PR-ovi:
    - `agirails/sdk-js` — main implementation (ovaj plan)
    - `agirails/n8n-nodes-actp` — update `client.factory.ts` + njegov test
    - `agirails/openclaw-skill` — SKILL.md primjeri
    - `claude-plugin` — skill reference dokumenti
    - `claude-skill` — SKILL.md
    - `agirails.app` — `web/public/protocol/AGIRAILS.md` + docs-site
    - `sdk-examples` — runnable examples

5. **Minor bump `@agirails/sdk@3.3.0`.** Technically breaking za n8n factory call site, ali:
    - Call site je u našem vlastitom monorepu i update-amo ga u istom release sprintu
    - `X402AdapterConfig` export naziv ostaje isti (polja se mijenjaju iznutra)
    - Realni vanjski users x402 legacy adaptera = 0 (po usage auditu)
    - Loud CHANGELOG + migracijska nota

---

## Real x402 v2 API (verified against tarballs + live server)

Ključne stvarne činjenice iz spike-a (provjerene protiv stvarnih `@x402/*@2.9.0` `.d.ts` fajlova i live `x402.org/protected`):

### Paketi i verzije

```json
{
  "dependencies": {
    "@x402/fetch": "~2.9.0",
    "@x402/evm": "~2.9.0",
    "@x402/core": "~2.9.0"
  }
}
```

Sva tri su **dual CJS+ESM** publicirana — bez ESM/CJS blokera za naš SDK (koji je CJS).

`@x402/evm@2.9.0` tranzitivno ovisi o `viem ^2.39.3` i `zod ^3.24.2`. Viem će doći u naš dep tree kao tranzitivni, ali **naš kod ga nikad ne importa direktno**.

### `@x402/fetch` real exports

```ts
function wrapFetchWithPayment(fetch, client): fetch
function wrapFetchWithPaymentFromConfig(fetch, config: x402ClientConfig): fetch

// x402ClientConfig shape:
interface x402ClientConfig {
  schemes: SchemeRegistration[];          // { network: Network, client: SchemeNetworkClient, x402Version?: number }
  policies?: PaymentPolicy[];
  paymentRequirementsSelector?: SelectPaymentRequirements;
}

// Network type je CAIP-2 string — NEMA wildcarda, mora biti eksplicitno:
type Network = "eip155:8453" | "eip155:84532" | "solana:..." | ...
```

Re-exports: `x402Client`, `x402HTTPClient`, `PaymentPolicy`, `SchemeRegistration`, `SelectPaymentRequirements`, `decodePaymentResponseHeader`, `PaymentPayload`, `PaymentRequired`, `PaymentRequirements`, `SchemeNetworkClient`.

### `@x402/evm` real exports

```ts
class ExactEvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  constructor(signer: ClientEvmSigner, options?: ExactEvmSchemeOptions);
  createPaymentPayload(x402Version, paymentRequirements, context?): Promise<PaymentPayloadResult>;
}

// ClientEvmSigner je STRUCTURAL type — nije vezano na viem:
type ClientEvmSigner = {
  readonly address: `0x${string}`;
  signTypedData(message: { domain, types, primaryType, message }): Promise<`0x${string}`>;
  readContract?(...): Promise<unknown>;           // optional, za EIP-2612 enrichment
  signTransaction?(...): Promise<`0x${string}`>;  // optional
  getTransactionCount?(...): Promise<number>;     // optional
  estimateFeesPerGas?(): Promise<{...}>;          // optional
};
```

**Kritično**: `ClientEvmSigner` je structural — bilo koji objekt koji implementira `.address` + `.signTypedData` radi. Naš ethers v6 `Wallet` se adaptira u ~10 linija shima bez uvoza viem-a.

`ExactEvmScheme` **interno potpisuje EIP-3009** dajući `ClientEvmSigner` — mi ne baratamo s `authorization` / `signature` fieldovima direktno.

### Live test endpoint

`https://x402.org/protected` vraća pravi v2 response (confirmed by spike agent):

```
HTTP/1.1 402 Payment Required
content-type: application/json
payment-required: <base64 JSON>
```

Decoded payload (Base Sepolia USDC za $0.01):

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {"url": "https://www.x402.org/protected", "description": "Access to protected content"},
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 300,
      "extra": {"name": "USDC", "version": "2"}
    }
  ]
}
```

**Napomena**: header je lowercase `payment-required`, ne `PAYMENT-REQUIRED` kako sam prije tvrdio.

---

## Phase 1 scope — buyer + seller, Smart Wallet included

**SCOPE v4 (Damir 2026-04-11)**: Phase 1 pokriva **BOTH buyer i seller side u istom releaseu**. Smart Wallet je **uključen**, ne odgođen. Razlog: Damirov cilj je "da radi na buyer i seller strani sa bilo kime tko koristi službeni x402 standard" — fragmentiran release gdje samo jedna strana radi ne zadovoljava cilj.

**Što je uključeno u Phase 1**:
- **Buyer side**: X402V2Adapter (thin wrapper oko `@x402/fetch` + `@x402/evm`), radi s EOA + Smart Wallet preko Permit2 path-a
- **Seller side**: `@agirails/sdk/server` subpath export s helper-om koji gradi x402 server config iz AGIRAILS.md + walletProvider-a. User plug-a config u upstream middleware po izboru (`@x402/express`, `@x402/hono`, `@x402/next`) — **mi ne wrapa-mo nijedan specifičan framework**
- **Zero lock-in dizajn**: seller helper vraća plain `RouteConfig[]` + `x402ResourceServer` instance koji radi s bilo kojim upstream x402 middleware-om. Nula framework-specific koda u našem SDK-u.
- **Onboarding flow update (`actp init`)**: "pay / receive / both" selector, single keystore + Smart Wallet služi oba use-case-a
- **Conformance test suite**: lokalni mock + smoke skripte koji dokazuju da radi s Coinbase demo, upstream @x402/express, @x402/hono, @x402/next

### File-by-file promjene

#### 1. `src/types/adapter.ts` — `UnifiedPayParams.amount` optional

```ts
export interface UnifiedPayParams {
  /** Recipient - address, HTTP endpoint, or ERC-8004 agent ID */
  to: string;

  /**
   * Amount in human-readable format.
   * - REQUIRED for ACTP adapters (basic, standard) — client decides price
   * - IGNORED for x402 adapter — amount comes from server's payment-required response
   * - Leave undefined when paying x402 URLs; SDK enforces maxAmountPerTx from config
   */
  amount?: string | number;

  deadline?: string | number;
  disputeWindow?: number;
  description?: string;
  metadata?: PaymentMetadata;
  erc8004AgentId?: string;
}
```

Zod schema update: `amount: z.union([z.string(), z.number()]).optional()`.

**Per-adapter validation**:
- `BasicAdapter.pay()` i `StandardAdapter.pay()` throw `ValidationError` ako `amount === undefined`
- `X402Adapter.pay()` ignorira `amount` field, koristi config-level `maxAmountPerTx` kao safety cap

#### 2. `src/adapters/X402Adapter.ts` — potpuna zamjena

Sadržaj (trenutno 1000+ linija custom x-payment-* flow-a) se briše i zamjenjuje s thin wrapperom oko `@x402/fetch` + `@x402/evm`. Export imena (`X402Adapter` klasa, `X402AdapterConfig` tip) ostaju isti za backward compat s n8n factory-em i docs referencama.

**Kritična razlika od v2 plana**: adapter prima `IWalletProvider`, ne ethers `Wallet` direktno. To omogućuje rad s oba tier-a (EOA Tier 2 + Smart Wallet Tier 1 via Permit2) transparentno.

Minimalan radni code (v4 skica — svi P1/P2 issues zatvoreni):

```ts
import {
  wrapFetchWithPayment,
  decodePaymentResponseHeader,
  type PaymentRequirements,
  type PaymentResponse,
} from "@x402/fetch";
import {
  ExactEvmScheme,
  createPermit2ApprovalTx,
  PERMIT2_ADDRESS,
  type ClientEvmSigner,
} from "@x402/evm";
import { x402Client } from "@x402/core";
import type { IAdapter, AdapterMetadata } from "./IAdapter";
import type { UnifiedPayParams, UnifiedPayResult } from "../types/adapter";
import type { IWalletProvider, EIP712TypedData } from "../wallet/IWalletProvider";

export interface X402AdapterConfig {
  /** Wallet provider — both EOA (Tier 2) and AutoWallet (Tier 1) work */
  walletProvider: IWalletProvider;

  /**
   * Optional CAIP-2 network allowlist. Undefined (default) = allow ALL EVM
   * networks that @x402/evm supports — maximal interoperability.
   * Set this only if you want to restrict your agent to specific chains.
   */
  allowedNetworks?: ReadonlyArray<string>;

  /** Per-tx safety cap in human-readable USD. Default: "10" */
  maxAmountPerTx?: string;

  /** Optional fetch override for tests */
  fetchImpl?: typeof fetch;

  /** Auto one-time Permit2 approve on first Smart Wallet x402 payment. Default: true */
  autoApprovePermit2?: boolean;

  /**
   * MEV hard cap on signed authorization validity window.
   * Facilitator/server may request longer maxTimeoutSeconds, but we clamp to this.
   * Default: 300 (5 minutes). Lower = safer against facilitator holding signature
   * for MEV opportunity, higher = more tolerance for slow networks.
   */
  maxAuthorizationValidSec?: number;
}

export class X402Adapter implements IAdapter {
  readonly metadata: AdapterMetadata = {
    id: "x402",
    name: "x402 v2",
    priority: 70,
  };

  private readonly x402Client: x402Client;
  private readonly fetchWithPayment: typeof fetch;
  private readonly maxAmountPerTx: bigint;
  private readonly maxAuthorizationValidSec: number;
  private readonly permit2ApprovedCache = new Set<string>();  // network:token
  private readonly permit2InflightApprovals = new Map<string, Promise<void>>();

  constructor(private readonly config: X402AdapterConfig) {
    if (typeof config.walletProvider.signTypedData !== "function") {
      throw new X402ConfigError(
        "X402Adapter requires walletProvider with signTypedData(). " +
        "Both EOAWalletProvider and AutoWalletProvider implement this."
      );
    }

    const signer = walletProviderToClientEvmSigner(config.walletProvider);
    const scheme = new ExactEvmScheme(signer);

    // x402Client builder — register scheme for all EVM networks the caller cares about,
    // plus onBeforePaymentCreation hook for awaited Permit2 approve check.
    this.x402Client = x402Client.fromConfig({
      paymentRequirementsSelector: this.selectRequirements.bind(this),
    });
    const networks = this.resolveAllowedNetworks(config.allowedNetworks);
    for (const network of networks) {
      this.x402Client.register(network, scheme);
    }
    this.x402Client.onBeforePaymentCreation(this.beforePaymentCreationHook.bind(this));

    this.fetchWithPayment = wrapFetchWithPayment(
      config.fetchImpl ?? fetch,
      this.x402Client
    );

    this.maxAmountPerTx = parseUsdcAmount(config.maxAmountPerTx ?? "10");
    this.maxAuthorizationValidSec = config.maxAuthorizationValidSec ?? 300;  // 5 min MEV cap
  }

  /**
   * STRICT HTTPS ONLY. http:// is rejected to prevent MITM interception
   * of PAYMENT-SIGNATURE headers. Tests that need http:// use a dedicated
   * test config flag (not exposed to end users).
   */
  canHandle(params: UnifiedPayParams): boolean {
    return /^https:\/\//i.test(params.to);
  }

  async pay(params: UnifiedPayParams): Promise<UnifiedPayResult> {
    // Single roundtrip — the onBeforePaymentCreation hook we registered in
    // the constructor handles Permit2 approve inline, no preflight fetch.
    const res = await this.fetchWithPayment(params.to, {
      method: "GET",
      headers: { accept: "application/json" },
    });

    if (!res.ok) {
      throw new X402PaymentFailedError(`x402 payment failed: ${res.status} ${res.statusText}`);
    }

    const responseHeader = res.headers.get("payment-response");
    return await this.mapToPayResult(res, responseHeader);
  }

  /**
   * Hook registered on x402Client during construction. Runs AFTER the server's
   * payment-required response is parsed and AFTER selectRequirements has picked
   * a target, but BEFORE the scheme client signs the payload. Awaited — blocks
   * signing until Permit2 approve is confirmed. Single HTTP roundtrip total.
   *
   * Replaces the v4-original preflightPermit2Approve double-fetch anti-pattern.
   * Verified against @x402/core@2.9.0 source: beforePaymentCreationHooks[i](ctx)
   * is awaited and can abort via { abort: true, reason }.
   */
  private async beforePaymentCreationHook(ctx: {
    paymentRequired: PaymentRequired;
    selectedRequirements: PaymentRequirements;
  }): Promise<void | { abort: true; reason: string }> {
    const walletTier = this.config.walletProvider.getWalletInfo().tier;
    if (walletTier !== "auto") return;  // EOA doesn't need Permit2 approve
    if (this.config.autoApprovePermit2 === false) return;

    const method = (ctx.selectedRequirements.extra as Record<string, unknown> | undefined)
      ?.assetTransferMethod;
    if (method !== "permit2") return;

    try {
      await this.ensurePermit2Approved(
        ctx.selectedRequirements.network,
        ctx.selectedRequirements.asset
      );
    } catch (e) {
      return {
        abort: true,
        reason: e instanceof Error ? e.message : "Permit2 approve failed",
      };
    }
  }

  private selectRequirements(
    _version: number,
    requirements: readonly PaymentRequirements[]
  ): PaymentRequirements {
    const allowed = this.resolveAllowedNetworks(this.config.allowedNetworks);
    const candidates = requirements.filter(
      (r) => r.scheme === "exact" && allowed.includes(r.network)
    );

    if (candidates.length === 0) {
      const seen = requirements.map((r) => `${r.scheme}@${r.network}`).join(", ");
      throw new X402NetworkNotAllowedError(
        `x402: no accepted requirement. Server offered [${seen}], ` +
        `allowed: [${allowed.join(", ")}]`
      );
    }

    // Smart Wallet MUST use Permit2 (EIP-3009 won't validate on contract addresses).
    // EOA prefers EIP-3009 (simpler, no one-time approve needed).
    const walletTier = this.config.walletProvider.getWalletInfo().tier;
    const prioritized = walletTier === "auto"
      ? [...candidates].sort((a, b) => {
          const aP2 = (a.extra as any)?.assetTransferMethod === "permit2" ? -1 : 0;
          const bP2 = (b.extra as any)?.assetTransferMethod === "permit2" ? -1 : 0;
          return aP2 - bP2;
        })
      : candidates;

    // Smart Wallet with only EIP-3009 options = incompatible, fail with helpful error
    if (walletTier === "auto") {
      const hasPermit2 = prioritized.some(
        (r) => (r.extra as any)?.assetTransferMethod === "permit2"
      );
      if (!hasPermit2) {
        throw new X402UnsupportedWalletError(
          `x402: Smart Wallet cannot pay this endpoint. Server only offers EIP-3009, ` +
          `which requires the USDC holder to be an EOA. Use a Tier 2 (EOA) wallet ` +
          `for this endpoint, or ask the server to advertise Permit2 support.`
        );
      }
    }

    const chosen = prioritized[0];
    if (BigInt(chosen.amount) > this.maxAmountPerTx) {
      throw new X402AmountExceededError(
        `x402: required amount ${chosen.amount} exceeds maxAmountPerTx ` +
        `${this.maxAmountPerTx.toString()} (${this.config.maxAmountPerTx ?? "10"} USD)`
      );
    }

    // FIX v4.1: MEV hard cap on signed authorization validity.
    // Server-proposed maxTimeoutSeconds may be hours — we clamp so facilitator
    // cannot hold signature waiting for gas opportunity. EIP-3009 and Permit2
    // both honor the deadline encoded in signed payload; @x402/evm reads it from
    // requirements.maxTimeoutSeconds before signing.
    const serverTimeoutSec = chosen.maxTimeoutSeconds ?? this.maxAuthorizationValidSec;
    const clamped: PaymentRequirements = {
      ...chosen,
      maxTimeoutSeconds: Math.min(serverTimeoutSec, this.maxAuthorizationValidSec),
    };

    return clamped;
  }

  private async ensurePermit2Approved(network: string, token: string): Promise<void> {
    const key = `${network}:${token.toLowerCase()}`;
    if (this.permit2ApprovedCache.has(key)) return;

    // Coalesce concurrent calls for the same (network, token)
    const inflight = this.permit2InflightApprovals.get(key);
    if (inflight) return await inflight;

    const approvalPromise = (async () => {
      try {
        // Verified v4.2 spike: createPermit2ApprovalTx takes positional tokenAddress,
        // NOT { token } object. Returns { to, data, value } transaction request.
        const approvalTx = createPermit2ApprovalTx(token as `0x${string}`);
        await this.config.walletProvider.sendTransaction({
          to: approvalTx.to,
          data: approvalTx.data,
          value: "0",
        });
        this.permit2ApprovedCache.add(key);
      } catch (e) {
        if (isPaymasterGateError(e)) {
          throw new X402PublishRequiredError();
        }
        throw new X402ApprovalFailedError(
          `Permit2 approve failed for ${network}:${token}: ${e instanceof Error ? e.message : String(e)}`
        );
      } finally {
        this.permit2InflightApprovals.delete(key);
      }
    })();

    this.permit2InflightApprovals.set(key, approvalPromise);
    return await approvalPromise;
  }

  private async mapToPayResult(
    res: Response,
    paymentResponseHeader: string | null
  ): Promise<UnifiedPayResult> {
    const body = await res.text();

    // FIX v4.1: missing payment-response header is NOT silent success.
    // x402 spec: facilitator sets this header ONLY after on-chain settlement
    // is confirmed. Without it, we have no proof settlement happened — reorg,
    // pending mempool, facilitator bug, or malicious server could all be the cause.
    // Throw so caller knows to retry or investigate, not silently assume SETTLED.
    if (!paymentResponseHeader) {
      throw new X402SettlementProofMissingError(
        "Server returned 200 but no `payment-response` header. Settlement is " +
        "unconfirmed. This may indicate reorg, facilitator failure, or protocol mismatch. " +
        "Do not consider the payment final without on-chain verification."
      );
    }

    const decoded: PaymentResponse = decodePaymentResponseHeader(paymentResponseHeader);
    return {
      txId: decoded.transaction ?? "",
      state: "SETTLED",
      amount: decoded.amount ?? "0",
      to: decoded.payer ?? "",
      network: decoded.network,
      raw: { body, paymentResponse: decoded },
    } as UnifiedPayResult;
  }

  /**
   * Resolve the allowed CAIP-2 network set.
   * Undefined user config = "all EVM networks @x402/evm supports" = maximal interop.
   */
  private resolveAllowedNetworks(allowed?: ReadonlyArray<string>): ReadonlyArray<string> {
    if (allowed && allowed.length > 0) return allowed;
    // @x402/evm-supported EVM networks as of 2.9.0. Spike must verify exact list.
    // Source of truth: @x402/evm/constants — avoid hand-maintained drift.
    return ALL_EVM_NETWORKS_FROM_X402_EVM;
  }
}

/**
 * Bridge IWalletProvider.signTypedData to @x402/evm ClientEvmSigner.
 * Derives primaryType from the types bag — the actual EIP-712 primaryType
 * is always the single non-EIP712Domain type name when there's only one.
 * For schemes with multiple types (e.g. Permit2 witness), @x402/evm passes
 * primaryType explicitly in its signer calls, so we propagate it through.
 */
function walletProviderToClientEvmSigner(wp: IWalletProvider): ClientEvmSigner {
  return {
    address: wp.getAddress() as `0x${string}`,
    async signTypedData(params) {
      const sig = await wp.signTypedData!({
        domain: params.domain as Record<string, unknown>,
        types: params.types as Record<string, Array<{ name: string; type: string }>>,
        primaryType: params.primaryType,
        message: params.message as Record<string, unknown>,
      });
      return sig as `0x${string}`;
    },
  };
}

function parseUsdcAmount(usd: string): bigint {
  const [whole, frac = ""] = usd.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole + fracPadded);
}

function isPaymasterGateError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // Verified v4.2 spike: PaymasterClient throws with messages matching:
  //  - "Gas sponsorship unavailable: {upstream error}"
  //  - "Gas sponsorship temporarily unavailable — both Coinbase and Pimlico paymasters failed"
  // Include generic patterns as belt-and-suspenders for future error message changes.
  return /gas sponsorship|paymaster|policy|sponsorship|unauthorized/i.test(e.message);
}

// v4.2 spike finding: @x402/core uses structural type `Network = `${string}:${string}``,
// not a hardcoded enum. There is NO single-source-of-truth export for "supported EVM networks"
// in @x402/evm. This list is hand-maintained and must be reviewed on each @x402/evm upgrade.
// TODO: add CI check that this list matches networks actually registered by ExactEvmScheme
//       (we can introspect by attempting scheme.createPaymentPayload on a test requirement
//       for each network and catching "no scheme registered" errors).
const ALL_EVM_NETWORKS_FROM_X402_EVM: ReadonlyArray<string> = [
  "eip155:1",        // Ethereum mainnet
  "eip155:8453",     // Base mainnet
  "eip155:84532",    // Base Sepolia
  "eip155:10",       // Optimism
  "eip155:42161",    // Arbitrum One
  "eip155:137",      // Polygon
];
```

**Fixed v4 issues in the sketch above**:

- ✅ **P1-1 strict HTTPS** (L530 → fixed L530): `^https:\/\/` only, no `http://`
- ✅ **P1-2 fire-and-forget race** (L583): `preflightPermit2Approve` runs BEFORE `fetchWithPayment`, awaited, with in-flight coalescing for concurrent calls
- ✅ **P2-1 mapToPayResult** (L610): decodes `payment-response` via `decodePaymentResponseHeader` from `@x402/fetch`, maps to UnifiedPayResult with proper fields + raw passthrough
- ✅ **P2-2 primaryType** (L621): propagated from caller (`params.primaryType`), not hardcoded to ""
- ✅ **P1 network defaults** (L486, L551): undefined `allowedNetworks` = "all EVM networks @x402/evm supports" = maximal interop
- ✅ **Smart Wallet without Permit2 endpoint** = clear fail early error, not silent breakage
- ✅ **Paymaster gate errors** → `X402PublishRequiredError` already in spec

**Remaining spike tasks** (in the "open watch-outs" sense, not blockers):
1. Verify exact public API of `x402Client.fromConfig(...).register(network, scheme)` chain — used here; spike verified `wrapFetchWithPaymentFromConfig` earlier, but `x402Client.fromConfig().register()` lineage needs one last `.d.ts` check
2. Verify `createPermit2ApprovalTx({ token })` exact signature
3. Verify `decodePaymentRequiredHeader` + `decodePaymentResponseHeader` export names (they exist per tarball, names double-check during impl)
4. Replace hand-maintained `ALL_EVM_NETWORKS_FROM_X402_EVM` with direct import from `@x402/evm/constants` or equivalent single-source-of-truth export

**Key properties**:

- **Isti export naziv** (`X402Adapter`) — zero import change za existing code
- **Config shape breaking** — `requesterAddress`, `transferFn`, `feeCollector`, `expectedNetwork` iz stare verzije zamijenjeni s `walletProvider`, `allowedNetworks`, `maxAmountPerTx`, `autoApprovePermit2`. N8n factory update adresira ovo.
- **Safety na tri razine**: allowed networks, maxAmountPerTx cap, selector filtriranje
- **Wallet-aware requirement selection**: Smart Wallet preferira Permit2 requirements, EOA preferira EIP-3009
- **Lazy Permit2 approve**: automatski radi approve na prvom plaćanju kad je potrebno, cache per-network+token, opt-out via `autoApprovePermit2: false`
- **Zero fee logika** — nikad ne ruta kroz X402Relay
- **Nula auto-reputation writes** (per fiksiranu odluku)
- **`walletProviderToClientEvmSigner` shim** — private detalj, ne exportan

#### 2a. `src/wallet/IWalletProvider.ts` — prošireno

Dodati novi tip i optional metodu:

```ts
export interface EIP712TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface IWalletProvider {
  // ... existing methods ...

  /**
   * Sign EIP-712 typed data.
   *
   * EOA wallets sign directly via ethers.Wallet.signTypedData.
   * AA wallets (Smart Wallet) use replay-safe hashing + ERC-1271 / ERC-6492
   * signature encoding so the signature validates on-chain via contract code.
   *
   * Required for x402 v2 payments (EIP-3009 and Permit2 flows both use this).
   *
   * @param typedData EIP-712 message to sign
   * @returns 0x-prefixed signature bytes
   */
  signTypedData?(typedData: EIP712TypedData): Promise<string>;
}
```

#### 2b. `src/wallet/EOAWalletProvider.ts` — dodati signTypedData

Trivijalna implementacija (~10 linija):

```ts
async signTypedData(typedData: EIP712TypedData): Promise<string> {
  const { EIP712Domain: _omit, ...types } = typedData.types;
  return await this.wallet.signTypedData(
    typedData.domain as any,
    types as any,
    typedData.message as any
  );
}
```

Ethers v6 `Wallet.signTypedData(domain, types, value)` native. Test: unit test s EIP-712 vektor + verificiraj recovery-address matches wallet address.

#### 2c. `src/wallet/AutoWalletProvider.ts` — dodati signTypedData (CRITICAL)

**Ovo je najveći Phase 1 nepoznanik.** Implementacija ovisi o Smart Wallet spike-u (vidi "Smart Wallet + x402 tehnički put" sekciju gore).

Post-spike, očekivana struktura:

```ts
async signTypedData(typedData: EIP712TypedData): Promise<string> {
  // 1. Compute typed data hash (domain separator + struct hash)
  const typedDataHash = computeTypedDataHash(typedData);

  // 2. Wrap in replay-safe hash (Coinbase Smart Wallet specific)
  const replaySafeHash = computeReplaySafeHash(this.smartWalletAddress, typedDataHash);

  // 3. Owner EOA signs the replay-safe hash
  const ownerSig = await this.ownerEOA.signMessage(replaySafeHash);

  // 4. Encode as 1271-compatible signature (or 6492-wrapped if undeployed)
  const isDeployed = await this.isSmartWalletDeployed();
  if (isDeployed) {
    return encode1271Signature(this.ownerIndex, ownerSig);
  } else {
    return encode6492Signature(this.factoryAddress, this.factoryCalldata, ownerSig);
  }
}
```

**Sve te helper funkcije** (`computeTypedDataHash`, `computeReplaySafeHash`, `encode1271Signature`, `encode6492Signature`) trebaju biti implementirane ili posuđene iz postojeće library-e. Spike treba otkriti koje je najčišće.

Test plan: unit test s mock Smart Wallet contract-om koji verificira 1271 signature, plus integration test protiv deployed Base Sepolia Smart Wallet.

#### 3. `src/adapters/X402Adapter.test.ts` — nova test suite

Stari 1067-line test file obriši potpuno, zamijeni s novim testovima:

- **Unit**:
  - Config validation (allowedNetworks, maxAmountPerTx parsing)
  - `ethersToClientEvmSigner` shim output shape
  - `selectRequirements` logic (network filter, amount cap, empty candidates error)
  - `canHandle` URL detection
  - `mapToPayResult` decoding PAYMENT-RESPONSE header variants
  - Mock `@x402/fetch` to assert `fetchWithPayment` construction

- **Integration** (guarded by `INTEGRATION=1` env var, not run in CI by default):
  - Real fetch protiv `https://x402.org/protected` sa funded Base Sepolia accountom
  - Assert successful payment + response body + decoded settlement proof
  - Record tx hash u TESTING.md (per CLAUDE.md konvenciju)

Target: ~60 novih testova, 0 regresija (jer stari test file odlazi u cijelosti). Ukupan SDK test count ostaje oko istoga (1780 ± 20).

#### 4. `src/ACTPClient.ts` — auto-registracija

```ts
// Oko ACTPClient.create() ili constructor
if (this.walletProvider && typeof this.walletProvider.signTypedData === "function") {
  this.adapterRegistry.register(
    new X402Adapter({
      walletProvider: this.walletProvider,
      allowedNetworks: config.x402?.allowedNetworks,
      maxAmountPerTx: config.x402?.maxAmountPerTx,
      autoApprovePermit2: config.x402?.autoApprovePermit2 ?? true,
    })
  );
}
```

**Uvjet**: walletProvider mora implementirati `signTypedData` (optional metoda iz proširene IWalletProvider). Nakon Phase 1 impl-a, oba providera (`EOAWalletProvider` i `AutoWalletProvider`) će je imati — dakle auto-registracija radi za sve.

**Migracijska napomena**: postojeći user code koji konstruira ACTPClient bez wallet providera (read-only flow) neće automatski dobiti X402Adapter. To je OK — bez wallet-a ne možemo signirati plaćanja.

**Smart Wallet path je riješen kroz Permit2** (vidi "Smart Wallet + x402 tehnički put" sekciju gore). X402Adapter.selectRequirements prioritizira Permit2 requirements za AA wallet-e, EIP-3009 za EOA wallet-e. Lazy one-time approve za Permit2 se događa transparent na prvom plaćanju.

#### 5. `src/adapters/index.ts` + `src/index.ts` — re-export

Ostaju nepromijenjeni. Export naziv `X402Adapter` i `X402AdapterConfig` ostaju isti — nema rename-a u index fajlovima.

#### 6. `src/config/ClientConfig.ts` (ili ekvivalent) — novi config blok

```ts
export interface ACTPClientConfig {
  // ... existing fields ...
  x402?: {
    /**
     * Allowed CAIP-2 networks for x402 payments.
     * Default: undefined = allow any EVM network that @x402/evm supports.
     * Set this to restrict to a specific allowlist.
     */
    allowedNetworks?: ReadonlyArray<string>;

    /**
     * Per-tx safety cap in human-readable USD (e.g. "10" = $10 USDC).
     * Default: "10"
     */
    maxAmountPerTx?: string;

    /**
     * Auto-run one-time Permit2 approve on first Smart Wallet x402 payment.
     * Default: true. Set false for manual approve (rare).
     */
    autoApprovePermit2?: boolean;
  };
}
```

**Ključna v4 promjena**: `allowedNetworks` je sad **optional bez hardcoded default-a**. Undefined znači "allow any EVM network that the installed @x402/evm version supports" — to je pravi interop default. User koji želi restrikciju eksplicitno postavi allowlist (npr. samo Base za fiksni agent). Ovo zadovoljava Damirov cilj "radi sa bilo kime tko koristi službeni x402 standard" by default.

#### 7. `n8n-nodes-actp/nodes/ACTP/utils/client.factory.ts:160` — update call site

```ts
// Staro:
new X402Adapter(wallet.address, {
  expectedNetwork: "base-sepolia",
  transferFn: async (to, amount) => { ... },
  feeCollector: ...,
});

// Novo (v4): koristi walletProvider, ne ethers wallet direktno
new X402Adapter({
  walletProvider: existingWalletProvider,  // IWalletProvider instance from client
  allowedNetworks: ["eip155:84532"],         // opcionalno override
  maxAmountPerTx: "10",
  autoApprovePermit2: true,                  // default
});
```

**Još bolji pristup za n8n**: potpuno obriši manualnu registraciju X402Adapter-a iz n8n factory-ja. Auto-registracija u `ACTPClient.create()` ionako dodaje X402Adapter čim wallet provider postoji — n8n factory ne mora ručno registrirati. To znači 1 linija obrisana umjesto 4 linije izmijenjene. Cleaner migration.

Plus update `client.factory.test.ts` — ukloniti test za `new X402Adapter(...)` manualno, dodati assertion da auto-registration radi nakon `ACTPClient.create()`.

#### 8. `Protocol/actp-kernel/src/relay/X402Relay.sol` — deprecation notice

```solidity
/**
 * @title X402Relay
 * @notice DEPRECATED as of @agirails/sdk@3.3.0 (2026-04).
 * @dev AGIRAILS SDK no longer routes x402 payments through this contract.
 *      Kept deployed on Base mainnet and Sepolia for historical compatibility only.
 *      No new features will be added. See docs/x402-design-decisions.md for rationale.
 *      Deployed addresses:
 *        Mainnet: 0x81DFb954A3D58FEc24Fc9c946aC2C71a911609F8
 *        Sepolia: 0x4DCD02b276Dbeab57c265B72435e90507b6Ac81A
 */
```

Također update `Protocol/actp-kernel/README.md` s deprecation sekcijom.

#### 8a. Seller-side: `src/server/` — novi framework-agnostic helper (v4 IN SCOPE)

**Dizajn princip**: mi ne wrap-amo `@x402/express`, `@x402/hono`, niti `@x402/next`. Umjesto toga, dajemo thin helper koji gradi config object (scheme registration + route definitions + resource server instance) koji user prosljeđuje **direktno u upstream middleware po izboru**.

Razlog: svaki wrapper je framework lock-in + dodatna površina za sinc s upstreamom. User koji već koristi Express lock-ira se u naš wrapper umjesto da direktno poziva službeni upstream paket. Naš "value-add" na seller strani je **samo mapping iz AGIRAILS.md + walletProvider u ispravni PaymentRequirements**, ne wrap-ovanje HTTP middleware-a.

**File layout**:

```
sdk-js/src/server/
├── index.ts                     → public API re-exports
├── buildX402Server.ts           → factory helper
├── paymentRequirements.ts       → AGIRAILS.md → PaymentRequirements mapping
└── buildX402Server.test.ts
```

**Package.json subpath export**:

```json
{
  "exports": {
    ".": { ... },
    "./storage": { ... },
    "./server": {
      "types": "./dist/server/index.d.ts",
      "require": "./dist/server/index.js",
      "default": "./dist/server/index.js"
    }
  }
}
```

**Zašto subpath export**: `@x402/core` + `@x402/evm` imaju facilitator-side deps (server bundle ~300KB). Subpath znači browser buyers ne povlače server deps — tree-shaking works via subpath boundary.

**Public API**:

```ts
// src/server/index.ts
export { buildX402Server } from "./buildX402Server";
export type { X402ServerConfig, X402RouteDefinition } from "./buildX402Server";

// src/server/buildX402Server.ts
import { x402HTTPResourceServer, HTTPFacilitatorClient } from "@x402/core";
import { ExactEvmScheme } from "@x402/evm";
import type { ACTPClient } from "../ACTPClient";

export interface X402RouteDefinition {
  /** HTTP method + path, e.g. "GET /api/premium" */
  route: string;
  /** Price in human-readable USD, e.g. "$0.10" */
  price: string;
  /** Short description for the payment prompt */
  description?: string;
  /** Override CAIP-2 network (default: client's configured chain) */
  network?: string;
}

export interface X402ServerConfig {
  routes: X402RouteDefinition[];
  /** Custom facilitator URL. Default: https://facilitator.x402.org (public) */
  facilitatorUrl?: string;
  /** Auto-prefer Permit2 scheme for Smart Wallet interop */
  preferPermit2?: boolean;
}

export interface X402ServerResult {
  /** Resource server instance — pass to paymentMiddleware of @x402/express/hono/next */
  resourceServer: x402HTTPResourceServer;
  /** Route config shape matching @x402/* middleware expectations */
  routes: Record<string, unknown>;
}

export function buildX402Server(
  client: ACTPClient,
  config: X402ServerConfig
): X402ServerResult {
  const walletAddress = client.walletProvider.getAddress();
  const chain = resolveCurrentCAIP2(client);

  // Build server-side scheme (facilitator-facing), NOT client-side ExactEvmScheme
  // The server scheme only needs to advertise + validate, not sign.
  const facilitator = new HTTPFacilitatorClient({
    url: config.facilitatorUrl ?? "https://facilitator.x402.org",
  });

  const resourceServer = new x402HTTPResourceServer(facilitator)
    .register(chain, ExactEvmScheme.asServerScheme());  // server variant

  // Transform our routes into @x402/* middleware shape
  const routes: Record<string, unknown> = {};
  for (const def of config.routes) {
    routes[def.route] = {
      accepts: [
        {
          scheme: "exact",
          network: def.network ?? chain,
          price: def.price,
          payTo: walletAddress,
          maxTimeoutSeconds: 300,
          description: def.description,
          // Smart Wallet compatibility: advertise Permit2 by default so Smart Wallet buyers work
          extra: config.preferPermit2 !== false
            ? { assetTransferMethod: "permit2", name: "USDC", version: "2" }
            : { name: "USDC", version: "2" },
        },
      ],
    };
  }

  return { resourceServer, routes };
}
```

**Usage (user's Express app)**:

```ts
import express from "express";
import { ACTPClient } from "@agirails/sdk";
import { buildX402Server } from "@agirails/sdk/server";
import { paymentMiddleware } from "@x402/express";

const client = await ACTPClient.create({ /* existing config */ });
const { resourceServer, routes } = buildX402Server(client, {
  routes: [
    { route: "GET /api/premium", price: "$0.10", description: "Premium content" },
    { route: "POST /api/generate", price: "$0.50", description: "AI generation" },
  ],
});

const app = express();
app.use(paymentMiddleware(routes, resourceServer));

app.get("/api/premium", (req, res) => res.json({ secret: "..." }));
app.listen(3000);
```

**Usage (Hono)**:

```ts
import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
// ... same buildX402Server call ...
const app = new Hono();
app.use("*", paymentMiddleware(routes, resourceServer));
```

**Usage (Next.js App Router)** — works identically because it routes to upstream `@x402/next` which handles Next.js routing conventions. We don't touch Next.js specifics.

**Usage (any other framework — Fastify, Koa, Hapi, raw Node http)**:

`buildX402Server` vraća `resourceServer` koji je framework-agnostic instance iz `@x402/core`. Ako vaš framework nije Express, Hono ili Next, možete direktno koristiti `resourceServer.handleRequest(req, res)` pattern bez ikakvog upstream adaptera:

```ts
import Fastify from "fastify";
import { ACTPClient } from "@agirails/sdk";
import { buildX402Server } from "@agirails/sdk/server";

const client = await ACTPClient.create();
const { resourceServer } = buildX402Server(client, {
  routes: [{ route: "GET /api/premium", price: "$0.10" }],
});

const app = Fastify();
app.get("/api/premium", async (req, reply) => {
  // Pass request to resourceServer for payment validation
  const result = await resourceServer.handleRequest({
    method: req.method,
    url: req.url,
    headers: req.headers,
  });

  if (result.status === 402) {
    reply.code(402).headers(result.headers).send(result.body);
    return;
  }
  // Payment valid, proceed with actual response
  reply.send({ secret: "..." });
});
```

**Ključni princip**: `@x402/core` `resourceServer` je framework-agnostic jezgra. Upstream `@x402/express`, `@x402/hono`, `@x402/next` su samo tanki request/response adapteri oko iste jezgre. Bilo koji framework koji može istom jezgrom izložiti headers + metod + url + body u/iz svog Request/Response tipa radi s našim output-om. Phase 1 testira Express + type-level assertion za Hono/Next; ostalo je dokumentirano kao "use the core pattern directly".

**Key properties**:

- **Framework-agnostic**: same `buildX402Server(...)` output works with Express, Hono, Next, or any future `@x402/*` middleware
- **Zero wrap**: we never re-export, proxy, or wrap `paymentMiddleware` itself — user imports it directly from upstream
- **Permit2-by-default** advertising: `preferPermit2: true` by default means Smart Wallet buyers (incl. AGIRAILS Tier 1 agents) work out of the box
- **`payTo` comes from walletProvider**: whichever wallet the client uses (EOA or Smart Wallet), that's where funds arrive
- **Zero fee layer**: we do NOT route through X402Relay or any splitter. `payTo` = seller's direct address. Consistent with "x402 is funnel, ACTP is monetization" decision.
- **Zero reputation hook**: per Damir's locked-in decision, x402 payments never write ERC-8004. See `docs/x402-design-decisions.md`.

#### 8b. Onboarding flow update — `actp init` "pay/receive/both"

Current `actp init` creates keystore + smart wallet + paymaster allowlist. v4 adds a prompt:

```
$ npx agirails init

? What will this agent do?
  ▸ Pay for services (buyer only)
    Receive payments (seller only)
  ▸ Both (recommended)

? Network?
  ▸ Base Sepolia (testnet) — recommended for testing
    Base Mainnet

✓ Generated keystore at .actp/keystore.json
✓ Base Sepolia Smart Wallet deployed: 0xABC...
✓ Airdropped 10 USDC testnet
✓ Paymaster allowlisted
✓ Created AGIRAILS.md with agent config

Next steps:

  // As buyer:
  import { ACTPClient } from '@agirails/sdk';
  const client = await ACTPClient.create();
  await client.pay({ to: 'https://x402.org/protected' });

  // As seller (Express):
  import express from 'express';
  import { ACTPClient } from '@agirails/sdk';
  import { buildX402Server } from '@agirails/sdk/server';
  import { paymentMiddleware } from '@x402/express';

  const client = await ACTPClient.create();
  const { resourceServer, routes } = buildX402Server(client, {
    routes: [{ route: 'GET /api/hello', price: '$0.01' }],
  });

  const app = express();
  app.use(paymentMiddleware(routes, resourceServer));
  app.get('/api/hello', (req, res) => res.json({ greeting: 'Hello!' }));
  app.listen(3000);
```

**Key onboarding v4 property**: one keystore, one Smart Wallet, one paymaster allowlist, one AGIRAILS.md. Isti wallet prima i plaća. No split identity, no "which wallet am I using" confusion.

#### 9. `docs/x402-design-decisions.md` — novi dokument

Objašnjava **zašto**:
- Zašto je x402 funnel a ne monetizacija
- Zašto x402 plaćanja ne pišu ERC-8004 reputaciju (fire-and-forget semantika, nema DELIVERED signal, ekonomska nepodesnost per-tx writes)
- Zašto smo odbacili self-hosted facilitator, custom scheme, X402Relay v2
- Zašto je x402 samo EOA path (Smart Wallet ostaje ACTP-only)
- Reference na Vitalik protocol simplicity dokument

#### 10. `CHANGELOG.md` + version bump

```
## [3.3.0] — 2026-04-XX

### Changed
- **`X402Adapter` rewritten** as thin wrapper around official @x402/fetch + @x402/evm packages for real x402 v2 protocol support. The adapter now speaks the actual x402 v2 wire protocol (payment-required header, EIP-3009 signing, CAIP-2 networks) instead of the prior custom AGIRAILS HTTP payment flow.
- **`X402AdapterConfig` shape** — constructor now takes `{ wallet, allowedNetworks?, maxAmountPerTx?, fetchImpl? }` instead of prior `{ requesterAddress, expectedNetwork, transferFn, feeCollector, ... }`. Update call sites accordingly.
- **`UnifiedPayParams.amount` is now optional.** For x402 URLs, amount is determined by the server's payment-required response and the field is ignored. ACTP adapters (basic, standard) still require it.
- **Auto-registration**: X402Adapter is automatically registered on ACTPClient when a wallet provider is present. No need to call `client.registerAdapter(new X402Adapter(...))` manually.

### Added
- `ACTPClientConfig.x402.allowedNetworks` — network allowlist (default `["eip155:8453", "eip155:84532"]`)
- `ACTPClientConfig.x402.maxAmountPerTx` — per-transaction safety cap (default `"10"` = $10 USDC)
- Dependency: `@x402/fetch ~2.9.0`, `@x402/evm ~2.9.0`, `@x402/core ~2.9.0`
- `docs/x402-design-decisions.md` — rationale for x402-as-funnel architecture

### Removed
- Custom `x-payment-required` / `x-payment-tx-id` header handling (never part of actual x402 spec)
- X402Relay contract routing from SDK (contract remains deployed but deprecated)
- Zero reputation tracking on x402 payments — reputation is ACTP-exclusive (see design decisions doc)

### Migration
Any code currently constructing `X402Adapter` manually with `{ requesterAddress, transferFn, ... }` config must be updated to `{ wallet }` form. Real known call sites in AGIRAILS ecosystem:
- `agirails/n8n-nodes-actp` — updated in v2.4.0
- `agirails/openclaw-skill` SKILL.md examples — updated in v1.1.0
- All `AGIRAILS.md` / docs site examples — updated in separate PRs per repo
```

---

## Open questions — moraju se riješiti prije koda

### Q1. Smart Wallet + x402 kompatibilnost — **RIJEŠENO v3 (Permit2)**
Status: ✅ Riješeno. Permit2 path production-ready u `@x402/evm@2.9.0`, radi s ERC-1271 (deployed) i ERC-6492 (undeployed) Smart Wallets. Vidi "Smart Wallet + x402 tehnički put" sekciju gore za detalje.

**Damirova odluka (v3)**: Smart Wallet MORA raditi od Phase 1, preko Permit2 flow-a.

### Q2. IWalletProvider surface za x402 — **VERIFICIRANO v3**
Status: ✅ Verificirano čitanjem `src/wallet/IWalletProvider.ts`. Interface ne expose-uje `signTypedData`, treba proširenje. Oba providera (EOA, Auto) moraju implementirati novu optional metodu. EOA je trivijalno; Auto je netrivijalno i zahtijeva Smart Wallet spike.

### Q3. `ClientConfig.x402` schema ili zasebna konfiguracija? — **ODLUČENO (runtime-only)**
Status: ✅ Runtime-only u `ACTPClientConfig.x402`. Ne dira `AGIRAILS.md` schema u 3.3.0. Promote u AGIRAILS.md schemu u 3.5.0 ili kasnije ako bude realna potreba. Zašto: `AGIRAILS.md` schema promjene triggeraju `configHash` rotation za sve deployed agente i to je skup migration.

### Q4. `mapToPayResult` shape — OK finalizirati tijekom impl
Status: ✅ Damirova odluka: OK finalizirati tijekom implementation-a, ne blocker za plan.

### Q5. Facilitator selection
`@x402/fetch` buyer side NE bira facilitator — facilitator je server-side odgovornost. Buyer samo potpiše authorization, server šalje facilitatoru. Za Phase 1 ovo je **not our concern** — mi smo buyer. OK.

Ali Phase 2 (kad gradimo server middleware) hoće trebati odluku: public `facilitator.x402.org` ili self-hosted? Za Phase 1 ovo je eksplicitno out of scope.

### Q6. Smart Wallet signTypedData impl strategija — **RIJEŠENO (2026-04-11 spike)**
Status: ✅ Spike gotov. Rezultati u "Smart Wallet spike rezultati" sekciji gore.

Kratki sažetak:
- (a) **Coinbase Smart Wallet**, factory `0xBA5ED110...` — verified u našem codu
- (b) **Trenutno nema `signTypedData` uopće** — samo UserOp raw ECDSA path preko `UserOpBuilder.signUserOp`
- (c) **viem `toCoinbaseSmartAccount`** je kompletan path — replay-safe hashing, 1271 encoding, 6492 wrapping sve automatski
- (d) **Automatski** — viem `toSmartAccount` wrapper checka deployment status i bira 1271 vs 6492 transparent
- (e) **Zero coupling** — signing je čisto lokalna crypto operacija, paymaster se ne dodiruje tijekom signing-a; samo tijekom submission-a

**Verdict**: Easy → Medium, ~1 dan impl uključujući testove. Nema blocker-a. Phase 1 s full Smart Wallet support-om ide naprijed.

**Novi dependency**: `viem ^2.21.0` (subset: `account-abstraction`, `accounts`, `chains`). ~80KB min+gz, Node library, CJS compatible od v2.9+. Postaje prvi viem import u našem SDK-u (naš stack je inače ethers v6.15.0).

### Q7. Permit2 integration test setup — **RIJEŠENO (Damir 2026-04-11)**
`x402.org/protected` koristi EIP-3009, ne Permit2. Za Smart Wallet Permit2 put trebamo vlastiti test vector.

**Odluka**: **A + B, nema C.**

- **(A) Lokalni mock server u test suite-u — raw `node:http`, ~20 linija, bez upstream deps**. Test spawna server na random localhost portu, server vraća 402 s `paymentRequirements.extra.assetTransferMethod = "permit2"`, naš X402Adapter signira Permit2 payload, mock server verificira strukturu i vraća 200 + mock `payment-response`. Nula on-chain hit, nula real facilitator call, deterministic, CI-safe. Pokriva buyer-side logiku (parsing, signing, retry, response mapping). **v4.1 promjena**: raw `node:http` umjesto Express wrapper-a, jer Express+`@x402/express` bi dodao dva upstream dep-a u test i miješao "što se testira" (naš kod vs upstream).

  ```ts
  // test/helpers/mockPermit2Server.ts
  import { createServer, type Server } from "node:http";

  interface MockPermit2Options {
    network?: string;       // default "eip155:84532"
    asset?: string;          // default Base Sepolia USDC
    amount?: string;         // default "10000" (0.01 USDC)
    payTo?: string;          // default test address
  }

  export function startMockPermit2Server(opts: MockPermit2Options = {}): Promise<{
    url: string;
    close: () => Promise<void>;
  }> {
    const payload = {
      x402Version: 2,
      error: "Payment required",
      accepts: [{
        scheme: "exact",
        network: opts.network ?? "eip155:84532",
        amount: opts.amount ?? "10000",
        asset: opts.asset ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: opts.payTo ?? "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: "permit2", name: "USDC", version: "2" },
      }],
    };

    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        const hasPayment = req.headers["payment-signature"];
        if (!hasPayment) {
          res.statusCode = 402;
          res.setHeader("content-type", "application/json");
          res.setHeader("payment-required", Buffer.from(JSON.stringify(payload)).toString("base64"));
          res.end("{}");
          return;
        }
        // Accept + mock settlement response
        res.statusCode = 200;
        res.setHeader("payment-response", Buffer.from(JSON.stringify({
          transaction: "0xmockhash",
          network: payload.accepts[0].network,
          amount: payload.accepts[0].amount,
          payer: "0xmockbuyer",
        })).toString("base64"));
        res.end('{"ok":true}');
      }).listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({
          url: `http://localhost:${port}`,
          close: () => new Promise<void>((r) => server.close(() => r())),
        });
      });
    });
  }
  ```

  **Napomena**: test koristi `http://localhost` — `X402Adapter.canHandle` je strict HTTPS. Zato X402Adapter dobiva dedicated test config flag `_allowHttpForTests: true` (underscore prefix = intentionally private, nikad dokumentirano za user-e) ili test postavlja strict regex override. Alternativno, koristiti `https://localhost` s self-signed certom i ne testirati canHandle na localhost-u. Odluka u impl-u.

- **(B) Smoke test script pred release** — `scripts/smoke-x402-smartwallet.ts`, ručno pokretati pred `npm publish 3.3.0`. Pravi facilitator (`facilitator.x402.org` ili self-hosted), pravi Base Sepolia USDC, pravi Smart Wallet deployed, pravi on-chain settlement. Hvata real-world bugove koje mock ne može (facilitator signature rejection, viem version mismatch, Base Sepolia gotchas). Ne u CI (sporo, funded wallet required), manual pre-release gate.

- **Nema (C)** — persistent testnet endpoint nije potreban za 3.3.0. Nula business case-a, samo ops overhead.

**Trošak**: 0.75 dana (A) u test suite + 0.25 dana (B) smoke script. Oba već u Q9 timeline-u.

### Q8. Smart Wallet signature za Permit2 witness
Verified kroz spike: `ExactEvmScheme` traži signature na `PermitWitnessTransferFrom` EIP-712 poruci. Smart Wallet mora vratiti 1271-compliant signature na tu strukturu.

**Potencijalni problem**: Permit2 witness zove `ECDSA.recover(digest, signature)` ako signer je EOA, ili `IERC1271.isValidSignature(digest, signature)` ako signer je contract. Permit2 to handling je automatski ako signature odgovara kontrakt address-i.

**Treba verificirati tijekom spike-a**: da Permit2 main kontrakt (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) korektno delegira na 1271 validation umjesto da pokuša ECDSA recovery i crashira. Ako ne, trebamo drugačiji pattern (možda preko `x402ExactPermit2Proxy` koji može imati custom logiku).

### Q9. Timeline realistic check (v4.1 — 3 kohezivna bloka)

**Organizacija rada u tri kohezivna bloka** umjesto fragmentiranih 17 mini-taskova. Svaki blok je jedan mental mode, manje context switching-a, čišća execution:

- **Blok A — buyer side** (~4.5 dana): sve što X402Adapter treba da radi end-to-end, plus oba wallet providera
- **Blok B — seller side** (~2.35 dana): sve što seller treba da radi kroz framework-agnostic helper
- **Blok C — integracija + polish** (~2.75 dana): ACTPClient auto-reg, onboarding, n8n, docs, release comms

**Blok A — buyer side** (~4.5 dana):

| Task | Procjena |
|---|---|
| IWalletProvider signTypedData metoda + tip | 0.25 dana |
| EOAWalletProvider implementacija + unit test | 0.25 dana |
| AutoWalletProvider implementacija (viem bridge) + counterfactual parity test | 0.75 dana |
| viem CJS compatibility verification (CI matrix) | 0.25 dana |
| X402Adapter.ts overwrite (wrapper + walletProvider bridge + strict HTTPS + awaited approve + real mapResult) | 0.75 dana |
| Lazy Permit2 approve logic + lazy-publish race handling + inflight coalescing | 0.5 dana |
| ACTPClient auto-registracija | 0.25 dana |
| UnifiedPayParams.amount optional + Zod update | 0.25 dana |
| X402Adapter.test.ts nova suite | 0.75 dana |
| Lokalni mock Permit2 server (**raw `node:http`, ~20 linija, bez upstream deps**) + Smart Wallet integration test | 0.5 dana |
| Integration test protiv x402.org/protected (EOA EIP-3009) | 0.25 dana |
| Error class taxonomy implementacija + unit testovi | 0.25 dana |
| **Blok A subtotal** | **~4.5 dana** |

**Blok B — seller side** (~2.35 dana):

| Task | Procjena |
|---|---|
| `src/server/` folder + subpath export u package.json | 0.25 dana |
| `buildX402Server.ts` helper + `paymentRequirements.ts` mapping | 0.75 dana |
| `buildX402Server.test.ts` unit testovi | 0.5 dana |
| Integration test: lokalni Express + naš `buildX402Server` + naš X402Adapter klijent = full round-trip Smart Wallet Permit2 | 0.75 dana |
| **Type-level** interop test za Hono i Next (compile-time assertion da `buildX402Server` output prihvaćaju sva tri upstream middleware-a) | 0.1 dana |
| **Blok B subtotal** | **~2.35 dana** |

**Blok C — integracija + polish** (~2.75 dana):

| Task | Procjena |
|---|---|
| `actp init` onboarding flow update (pay/receive/both prompt) + test | 0.75 dana |
| n8n factory update (delete manual X402Adapter registration) + test | 0.25 dana |
| CHANGELOG + x402-design-decisions.md + X402Relay deprecation notice + error taxonomy doc | 0.5 dana |
| SLO + compatibility matrix + gas cost model u README + docs site | 0.25 dana |
| Conformance test matrix (Coinbase demo + lokalni mock + @x402/express) | 0.5 dana |
| **Debug telemetry** — `debug` library s namespace `agirails:x402`, logira pay attempt / approve / settlement / error | 0.25 dana |
| **Loud release communication** — CHANGELOG breaking marker + README upgrade guide + npm release note + one-version console.warn | 0.25 dana |
| **Blok C subtotal** | **~2.75 dana** |

**Phase 1 total**: **Blok A (~4.5) + Blok B (~2.35) + Blok C (~2.75) = ~9.6 dana** work breakdown.
Uštede iz v4.1 fix-eva (type-level Hono/Next umjesto real integration, raw http mock): **~0.4 dana**.

**Realni kalendarski timeline** (s context switches, review, polish):
- **Optimistično**: 9.6 radnih dana solid work, bez prekida → **~2 tjedna**
- **Realistično**: **2-2.5 tjedna** uz normalni task-switching, code review iteracije, integration test debug (tri kohezivna bloka smanjuju context switching vs 17 mini-tasks)
- **Pesimistično** (ako viem CJS interop puče ili upstream api drift): **3 tjedna**

**Buffer za unknown-unknowns**: 20% = ~2 radna dana.

**Finalna procjena**: **~11.5 radnih dana = 2-2.5 tjedna** za Phase 1 (buyer + seller + onboarding + docs). Blok-based organizacija štedi ~0.5 dana od v4 zbog manje fragmentacije, plus ~0.4 dana od v4.1 pojednostavljenja (type-level Hono/Next, raw http mock).

Docs sweep PR-ovi u vanjske repozitorije (claude-skill, openclaw-skill, docs-site, AGIRAILS.md): **dodatno 1-2 dana** disperzirano, može ići paralelno s main PR-om ili sekvencijalno nakon lands.

**Važna napomena**: ovo je **znatno veće** nego Phase 1 v3.2 (5-6 dana buyer-only). Razlog povećanja nije scope creep — to je priznavanje da je Damirov cilj ("buyer + seller, bilo tko, nikad problema") realno 2.5-3 tjedna posla, ne 5 dana. Plan v3.2 je lagao o scope-u.

**Alternativa za brže shippanje**: ako je 2.5-3 tjedna predugo, možemo razmisliti o:
- **Phase 1a (buyer-only)**: 5-6 dana, ships prvo kao `3.3.0-alpha.1`
- **Phase 1b (seller + onboarding)**: 5-6 dana, ships kao `3.3.0-beta.1`
- **Phase 1 GA**: merged kao `3.3.0` kad oboje je solid

Ovo bi dalo Patricku buyer-side fix u tjedan dana, a full interop za 2-3 tjedna. Damirova odluka.

### Q10. Postojeći silent bug — `signer.signTypedData` direct calls (NOVO iz spike-a)

Spike je otkrio da postojeći kod na tri mjesta zove `signer.signTypedData` direktno na ethers Wallet (ne kroz walletProvider):

- `src/settle/DeliveryProofBuilder.ts:248-251`
- `src/builders/QuoteBuilder.ts:275-277`
- `src/utils/MessageSigner.ts:211-258`

Za Tier 1 (Smart Wallet) agente, ovi pozivi proizvode **EOA-recoverable signature** umjesto Smart Wallet (1271) signature-a. Rezultat: attested delivery, quote, i generic message signing za Smart Wallet agente **ne validiraju protiv Smart Wallet adrese** — silent fail.

**Status**: NOT in scope za Phase 1 (x402 focus), ali jasno flagano kao **follow-up PR nakon 3.3.0**. Nakon što lands `walletProvider.signTypedData`, migrirati ova tri call-site-a na `walletProvider.signTypedData` umjesto direct ethers call-a. Dodati u backlog + TODO comment u svakom od tri fajla.

### Q11. Lazy publish + first x402 Permit2 approve race — **RIJEŠENO (Damir 2026-04-11)**

Paymaster policy gate: `configHash != 0 || hasPendingPublish`. Unpublished freshly-initialized agent-ov prvi Permit2 approve (sponsored tx kroz paymaster) **pada** jer agent nije još publishan.

**Odluka**: **(C) za 3.3.0**, razmotriti **(B) za 3.4.0** ako UX friction bude realan problem.

Implementacija (C):

```ts
// src/errors/X402Errors.ts
export class X402PublishRequiredError extends Error {
  constructor() {
    super(
      "Paymaster rejected gas sponsorship because this agent is not published.\n" +
      "Run `actp publish` to activate paymaster sponsorship, then retry your payment.\n" +
      "(This is a one-time setup — subsequent x402 payments will work automatically.)"
    );
    this.name = "X402PublishRequiredError";
  }
}

// src/adapters/X402Adapter.ts — in ensurePermit2Approved
try {
  await walletProvider.sendTransaction(approveCall);
} catch (e) {
  if (isPaymasterGateError(e)) {
    throw new X402PublishRequiredError();
  }
  throw e;
}
```

**Zašto (C) umjesto (B)**:

1. **Nizak risk** — ne mijenja happy path, samo wrapping error-a. (B) bi mijenjao kritični payment path za sve Permit2 flow-ove.
2. **Realistic user flow** — agenti obično rade `actp publish` kao dio setupa ionako (za ACTP receiving + Discover visibility). Samo-buyer bez publish-a je edge case, ne dominant flow.
3. **Learning opportunity** — (C) + dobar error uči user-a AGIRAILS model odmah. (B) sakriva model, onemogućuje debug kad jednog dana pukne.
4. **Pravi fix je drugdje** — automatic publish u `actp init` s `--no-publish` opt-out bi riješio root cause umjesto band-aid-a u X402Adapter-u. To je onboarding redesign (ne Phase 1 stavka).
5. **Phase sequencing** — ships brzo s (C), pratimo realnu frustration metriku, dodajemo (B) u 3.4.0 samo ako je potrebno.

**Trošak**: 0.25 dana za error class + detection + docs u design decisions doc. Već u Q9 timeline-u pod "Lazy Permit2 approve logic + lazy-publish race handling" (0.5 dana).

---

## Release communication plan (v4.1) — loud, because breaking change

Jedini stvarni caller `X402Adapter`-a u našem monorepu je `n8n-nodes-actp/nodes/ACTP/utils/client.factory.ts:160`, koji mi update-amo u istom release-u. Ali postoji **~200 OpenClaw skill downloads** u 7 dana + potencijalno neregistrirani user kod. Ako itko od njih je ručno koristio staru `new X402Adapter(requesterAddress, { transferFn, ... })` signature, **njihov kod pukne** kad instaliraju 3.3.0.

SemVer gledano, ovo je breaking change u major-level sense — ali odluka je `3.3.0` minor bump jer:
- Legacy adapter nikad nije bio real x402 (bio je custom AGIRAILS HTTP flow)
- Zero dokazanih production users osim našeg monorepa
- Full major bump (`4.0.0`) bi signalizirao veći scope nego što jest

Ali **mora biti loud** u communication-u. Plan release sadrži:

### 1. CHANGELOG.md — breaking marker na vrhu

```markdown
## [3.3.0] — 2026-04-XX

> ⚠️ **BREAKING CHANGE**: `X402Adapter` constructor signature completely changed.
> If you manually construct `new X402Adapter(...)` anywhere in your code, you
> MUST update it before upgrading. See migration guide below.
> If you only call `client.pay(...)`, no changes needed — X402Adapter is now
> auto-registered.

### Breaking
- `X402Adapter` rewritten as thin wrapper around official `@x402/fetch` + `@x402/evm`.
  - **Old constructor**: `new X402Adapter(requesterAddress: string, config: { expectedNetwork, transferFn, feeCollector, ... })`
  - **New constructor**: `new X402Adapter({ walletProvider, allowedNetworks?, maxAmountPerTx?, autoApprovePermit2?, maxAuthorizationValidSec? })`
  - **Migration**: see [migration guide](./UPGRADE_3.3.md)
- `UnifiedPayParams.amount` is now optional. For x402 URL targets the field is
  ignored (amount comes from server's payment-required response); for ACTP address
  targets the field is still required.

### Added
- Auto-registration: `X402Adapter` is automatically registered on `ACTPClient`
  when walletProvider is present. No need to call `registerAdapter()` manually.
- Full x402 v2 protocol support (real wire format, EIP-3009 + Permit2 flows).
- Smart Wallet buyer support via Permit2 path (ERC-1271 + ERC-6492).
- `@agirails/sdk/server` subpath with `buildX402Server` framework-agnostic helper.
- Onboarding flow: `actp init` asks "pay / receive / both".
- Error class taxonomy: `X402Error`, `X402PublishRequiredError`, ...
- Gas cost model and SLO documentation.

### Deprecated
- `X402Relay` contract on Base mainnet + Base Sepolia (no longer used by SDK).

### Removed
- Custom `x-payment-required` / `x-payment-tx-id` header flow (never was real x402).
- X402Relay routing from any SDK code path.

### Dependencies
- Added: `viem ~2.21.0`, `@x402/fetch ~2.9.0`, `@x402/evm ~2.9.0`, `@x402/core ~2.9.0`
```

### 2. `UPGRADE_3.3.md` — dedicated migration guide

Dokument u repo root-u (ili `docs/upgrades/3.3.md`) koji pokriva:

- **Who is affected**: samo users koji ručno konstruiraju `X402Adapter`. Users koji zovu `client.pay(...)` direktno — nula promjena.
- **Old code**: primjer stare signature + config
- **New code**: ekvivalentni primjer s novim API-jem
- **Why**: kratki paragraph "ovo je first real x402 support"
- **What if I need old behavior**: odgovor "old behavior nije bio real x402, nema native substitute; ako ti treba AGIRAILS-internal HTTP payment flow, otvori issue i razgovarat ćemo o dedicated adapter-u"
- **Test checklist**: npm install 3.3.0, run test suite, if passing no further action needed

### 3. npm release note

Kratka poruka u npm `dist-tag` release description:

> 3.3.0 introduces real x402 v2 protocol support. **Breaking change** to `X402Adapter` constructor — see UPGRADE_3.3.md. Most users unaffected (X402Adapter is now auto-registered).

### 4. Console warning (one-version only)

U `X402Adapter` constructor-u dodaj transient warning koji ide u 3.3.0 i skida se u 3.3.1:

```ts
// TEMPORARY in 3.3.0, remove in 3.3.1
if (process.env.NODE_ENV !== "production" && !X402Adapter._v330WarningShown) {
  console.warn(
    "[@agirails/sdk 3.3.0] X402Adapter has a new constructor signature in this " +
    "release. If you manually called `new X402Adapter(address, { transferFn, ... })`, " +
    "update to the new form. See https://github.com/agirails/sdk-js/blob/main/UPGRADE_3.3.md"
  );
  X402Adapter._v330WarningShown = true;
}
```

Pokriva scenario gdje user upgrade-uje automatski (renovate bot) i ne čita release notes.

### 5. GitHub release

Standardni GitHub release s checkbox listom:
- [ ] Published to npm (`@agirails/sdk@3.3.0`)
- [ ] n8n-nodes-actp@2.4.0 published with updated factory
- [ ] openclaw-skill updated (SKILL.md examples)
- [ ] docs-site deployed
- [ ] Patrick notified (internal Slack)
- [ ] Moltbook post (optional marketing moment)

### 6. Discord / community channel (ako imamo)

Ako postoji AGIRAILS Discord ili sličan community channel, pin-ati post s:
- Link na upgrade guide
- Link na new X402 documentation
- Offer za help: "if upgrade breaks your code, DM me"

### 7. Post-release monitoring (first 48h)

- Watch GitHub issues za "X402Adapter constructor" errors
- Watch npm download stats za 3.3.0 adoption vs 3.2.x
- Ready za `3.3.1` patch u 24h ako otkrijemo kritičan bug

**Ukupan trošak release communications**: 0.25 dana unutar Bloka C. CHANGELOG + UPGRADE_3.3.md + npm note + console.warn + GitHub release.

---

## Error class taxonomy (v4.1)

Svi x402-specific failure modes imaju dedicated tipizirane error klase koje user može `catch`-ati specifično. Sve extend-aju zajednički `X402Error` base. Nijedna failure ne koristi generički `Error`.

```ts
// src/errors/X402Errors.ts

/** Base class for all x402-related errors. Allows user to catch all in one clause. */
export class X402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Thrown when X402Adapter constructor receives invalid config (e.g. missing signTypedData). */
export class X402ConfigError extends X402Error {}

/** Thrown when paymaster rejects sponsored tx because agent isn't published. */
export class X402PublishRequiredError extends X402Error {
  constructor() {
    super(
      "Paymaster rejected gas sponsorship because this agent is not published.\n" +
      "Run `actp publish` to activate sponsorship, then retry your payment.\n" +
      "(One-time setup — subsequent x402 payments will work automatically.)"
    );
  }
}

/** Thrown when Smart Wallet tries to pay a server that only offers EIP-3009 (incompatible). */
export class X402UnsupportedWalletError extends X402Error {}

/** Thrown when server's payment-required offers no accepted network from user's allowlist. */
export class X402NetworkNotAllowedError extends X402Error {}

/** Thrown when server's required amount exceeds user's maxAmountPerTx safety cap. */
export class X402AmountExceededError extends X402Error {}

/** Thrown when one-time Permit2 approve transaction fails (not for paymaster gate — that's its own). */
export class X402ApprovalFailedError extends X402Error {}

/** Thrown when walletProvider.signTypedData() fails to produce a signature. */
export class X402SignatureFailedError extends X402Error {}

/** Thrown when HTTP payment completes (200 OK) but no payment-response header — settlement unconfirmed. */
export class X402SettlementProofMissingError extends X402Error {}

/** Thrown when HTTP payment returns a non-2xx status after payment attempt. */
export class X402PaymentFailedError extends X402Error {}
```

**Usage example za user kod**:

```ts
import {
  X402PublishRequiredError,
  X402UnsupportedWalletError,
  X402AmountExceededError,
  X402Error,
} from "@agirails/sdk";

try {
  await client.pay({ to: "https://some-server.com/api" });
} catch (e) {
  if (e instanceof X402PublishRequiredError) {
    console.log("Need to run actp publish first");
  } else if (e instanceof X402UnsupportedWalletError) {
    console.log("This endpoint needs EOA wallet, not Smart Wallet");
  } else if (e instanceof X402AmountExceededError) {
    console.log("Price too high");
  } else if (e instanceof X402Error) {
    console.log("Other x402 error:", e.message);
  } else {
    throw e;  // non-x402 error, rethrow
  }
}
```

**Export**: svi se re-exportaju iz `src/index.ts` za javno korištenje. Migracija iz v4.0 sketch-a: zamijeniti `throw new Error(...)` s `throw new X402SomethingError(...)` na svih 6 mjesta.

---

## Gas cost model — tko plaća što (v4)

Jedno od najvažnijih svojstava x402 dizajna za naš biznis model: **naš paymaster je gotovo potpuno izvan x402 gas loop-a**. Ovo dokumentira gdje teku troškovi i zašto je to strukturalno usklađeno s "x402 funnel, ACTP monetization" strategijom.

### Dvije tranzakcije u x402 flow-u

**(1) Settlement tx** — glavna on-chain operacija koja miče USDC iz buyer-a u seller-a. Svako x402 plaćanje rezultira jednim settlement tx-om (bilo `USDC.transferWithAuthorization` za EIP-3009 put, bilo `x402ExactPermit2Proxy.settle` za Permit2 put).

**Tko submita i plaća**: **facilitator**, ne mi. Buyer potpiše authorization off-chain (čisti kripto, nula blockchain interakcije, free), HTTP request prenosi signed payload, facilitator submita on-chain iz svog vlastitog budžeta.

Tko je facilitator ovisi o seller-u:
- Coinbase demo endpoint → Coinbase public facilitator plaća
- Treći x402 seller → njihov facilitator plaća
- AGIRAILS seller (kroz `buildX402Server`) → default `facilitator.x402.org` (Coinbase plaća), opcionalno self-hosted (seller plaća). **Mi ne pokrećemo facilitator u Phase 1.**

**(2) One-time Permit2 approve** — samo relevantan za **Smart Wallet** buyere kad je endpoint Permit2. Jednokratno po (Smart Wallet × chain × token) paru.

**Tko plaća**: **naš paymaster**. Approve ide kroz `walletProvider.sendTransaction()` → `submitUserOp` → Pimlico/CDP paymaster. Trošak ~$0.50-$1.00 po Smart Wallet-u, jednom. Svi daljnji x402 payments na toj kombinaciji = nula naša trošak (settlement je facilitator-ov).

### Cost matrix po scenariju

| Scenarij | Buyer potpis | Settlement gas | One-time Permit2 approve | Naš paymaster trošak |
|---|---|---|---|---|
| **Tier 2 EOA + EIP-3009 endpoint** | off-chain EIP-3009 | facilitator plaća | nije potreban | **$0, ikad** |
| **Tier 2 EOA + Permit2 endpoint** | off-chain Permit2 witness | facilitator plaća | EOA plaća iz svojih sredstava | **$0, ikad** |
| **Tier 1 Smart Wallet + EIP-3009 endpoint** | neizvedivo | neizvedivo | neizvedivo | clear error, redirect na EOA |
| **Tier 1 Smart Wallet + Permit2 endpoint** | off-chain Permit2 witness (1271/6492) | facilitator plaća | **naš paymaster** | ~$0.50, jednom po (wallet × chain × token) |
| **Bilo koji AGIRAILS seller receiving x402** | — | facilitator plaća | — | **$0, ikad** |

### Poredba s ACTP gas model-om

Ovo je razlog zašto x402 i ACTP imaju različite monetizacijske strategije:

| Flow | Naš paymaster sponzorira | Učestalost | Naš cost per tx |
|---|---|---|---|
| **ACTP plaćanje** (Tier 1 Smart Wallet) | Cijeli `payACTPBatched` userOp (createTransaction + approve + linkEscrow) | **svaka transakcija** | ~$0.05-0.10 per tx |
| **x402 plaćanje** (Tier 1 Smart Wallet, Permit2) | Samo one-time approve | **jednom po (wallet × chain × token)** | ~$0.0001 amortizirano preko 10k plaćanja |
| **x402 plaćanje** (Tier 2 EOA) | Ništa | nikad | $0 |

**Za ACTP**: mi smo u gas loop-u, plaćamo svaki tx. To opravdava 1% GMV fee — dobijamo real infrastrukturu (escrow + gas + state machine + dispute).

**Za x402**: mi smo u gas loop-u **samo za jednokratni approve**. Kroz životni vijek agenta koji napravi tisuće x402 plaćanja, naš amortizirani trošak se približava nuli. Strukturalno savršeno za **free funnel** strategiju.

### Ekonomika u brojevima

**Pretpostavka**: AGIRAILS ima 10,000 agenata, svaki pola koristi Smart Wallet, svi rade x402.

- Smart Wallet approves: 5,000 agenata × 1 approve × $0.50 = **$2,500 total one-time paymaster expense**
- EOA users: 5,000 agenata × $0 = **$0**
- Ongoing x402 payments: 10,000 agenata × N transakcija × **$0 each**

**Kontrastirano s 1% fee model**: ako bismo naplaćivali 1% na svako x402 plaćanje po $0.10, na 10k agenata × 1000 plaćanja = 10M plaćanja × $0.001 fee = $10,000 revenue. Zvuči dobro, ali:
- Trebamo vlastiti facilitator + X402Relay kontrakt + facilitator gas sponsorstvo
- Lock-in za sellere
- Pada na AGIRAILS three tests
- Kompetitor može ponuditi free x402 i ukrasti ekosustav

**Zero-fee x402 cost**: $2,500 jednokratno preko 10k agenata = **$0.25 CAC per agent** za neograničenu x402 iskustvenu razinu. Super jeftino za brand value "AGIRAILS agenti plaćaju bilo gdje bez friction-a".

### Abuse vectors + zaštite

**Vector 1 — Spam agents dreniraju approve budget**: napadač kreira 10,000 fake Smart Walletova, svaki trigger-a Permit2 approve.
- **Zaštita**: paymaster gate `configHash != 0 || hasPendingPublish`. Fake agents moraju proći publish validaciju kroz AgentRegistry. Publish flow ima vlastite anti-spam mehanizme (slug uniqueness, optional signature verification). Spam agents ne mogu efikasno masovno proći.

**Vector 2 — Multi-chain explosion**: jedan agent koristi Smart Wallet na 50 mreža, trigger-a 50 approves.
- **Zaštita**: u praksi @x402/evm podržava šačicu EVM mreža (Base + par popularnih). Čak i u worst case, 50 × $0.50 = $25 po agentu — i dalje zanemarivo.

**Vector 3 — Multi-token explosion**: approve je per-token. Ako novi x402 endpoint koristi drugi stable (USDT, DAI) na istoj mreži, treba još jedan approve.
- **Zaštita**: Phase 1 allowed token = samo USDC. Maksimum 1 approve po (wallet × chain) paru. Nova token podrška je svjesna odluka za budući release.

**Vector 4 — Approve but never pay**: napadač trigger-a approve, onda ne plaća ništa. Approve je sunk cost za nas.
- **Zaštita**: ograničen eksposure (jedan approve = ~$0.50). Nema dodatnog napretka jer drugi approve za isti par se cache-a. Ekonomski neatraktivan napad.

**Vector 5 — Facilitator kompromis**: ako malicious facilitator dobije potpisani authorization, može ga submitati u bilo koje vrijeme prije `validBefore` deadline-a.
- **Zaštita**: to je **facilitator-ov problem za sellere**, ne naš za buyera. Buyer autorizira samo ono što je signirao — facilitator ne može izmijeniti iznose ni primatelja. Osim toga, USDC nonce se consumira jednom pa replay nije moguć. EIP-3009 + Permit2 su designed za ovaj threat model.

---

## SLO i compatibility matrix (v4)

Damirov cilj "nema nikakvih problema nikad" nije realan kao apsolutna tvrdnja — x402 ekosustav brzo mijenja verzije (`@x402/*` shippuje 12 verzija u 3 mjeseca), upstream servers mogu uvesti nove scheme-e, CDN-ovi mogu lagati. Umjesto toga, definiramo **konkretne SLO-e** koje garantiramo, i **compatibility matrix** koja je točan doseg.

### Service Level Objectives

**Što garantiramo (within supported matrix)**:

1. **Interop sa svakim serverom koji govori `@x402/*@~2.9.0` standard** — ako upstream lib validira, mi plaćamo. Conformance testovi protiv Coinbase referentnog endpointa + lokalnog mock-a na CI.
2. **Buyer-side works with both EOA and Smart Wallet** (Tier 1 + Tier 2). Smart Wallet put kroz Permit2, verified protiv deployed + counterfactual.
3. **Seller-side works with any of `@x402/express`, `@x402/hono`, `@x402/next`** upstream middleware-a, bez modifikacije našeg `buildX402Server` helper-a.
4. **Zero fee on x402 payments** — nikad ne ruta-mo kroz splitter. `payTo` = seller's direct address. Verified u testovima.
5. **Zero reputation write on x402 payments** — ERC-8004 registry never touched. Verified u testovima.
6. **HTTPS-only buyer flow** — `http://` URL-ovi su odbijeni na `canHandle` razini.
7. **Clear error messages** za predvidive failure modes: paymaster gate (publish required), Smart Wallet + EIP-3009 only endpoint, maxAmountPerTx exceeded, unsupported network.

**Što NE garantiramo** (realistični limiti):

1. **Compatibility s verzijama van matrixa** — `@x402/*@1.x` (legacy), `@x402/*@3.x` (buduća breaking major). Dokumentiramo minor upgrade cadence.
2. **Nema Solana podrške** u Phase 1 — `@x402/svm` scheme se može dodati u Phase 2. Dok Damir ne kaže drukčije, Phase 1 = samo EVM.
3. **Nije otporan na upstream facilitator downtime** — public `facilitator.x402.org` može imati outage. Dokumentiramo kako konfigurirati alternativni facilitator (self-hosted ili Coinbase CDP private).
4. **Nije otporan na contract upgrade-ove** (USDC, Permit2, Coinbase Smart Wallet). Ako bilo koji uvede breaking change u signing flow, mi trebamo update. SLA: patch release u 7 dana nakon upstream update-a.
5. **Nema podrške za exotic scheme-e** koje `@x402/evm` ne implementira (Uniswap V4 hooks, Blast yield-bearing USDC, itd.). Doseg = što upstream može.

### Compatibility matrix

| Dimension | Supported | Not supported (Phase 1) | Status |
|---|---|---|---|
| **x402 protocol version** | v2 (`@x402/*@~2.9.0`) | v1 (`x402-*@1.x` legacy, abandoned) | ✅ |
| **EVM networks** | Base, Ethereum, Optimism, Arbitrum, Polygon | Other EVM L2 (Blast, Scroll, zkSync) | ✅ default all, explicit allowlist option |
| **Non-EVM networks** | ❌ | Solana (`@x402/svm`) | Phase 2 |
| **Buyer wallet types** | EOA (Tier 2) + Coinbase Smart Wallet (Tier 1) | Safe, Argent, Gnosis other | ✅ |
| **Asset** | USDC | USDT, DAI, other stables | ❌ (server side) / inherit from upstream (buyer side) |
| **Scheme** | `exact` (EIP-3009 + Permit2) | `upto`, custom schemes | ✅ — we only register `exact`, upstream supports more |
| **Transfer method** | EIP-3009 (EOA) + Permit2 (Smart Wallet) | EIP-2612 permit, ERC-20 approve flow | Partial: EIP-2612 via `eip2612GasSponsoring` if server advertises |
| **Seller middleware** | `@x402/express`, `@x402/hono`, `@x402/next` | Custom frameworks | Covered by `buildX402Server` framework-agnostic output |
| **Facilitator** | `facilitator.x402.org` public, Coinbase CDP private, self-hosted | — | Configurable via `facilitatorUrl` |
| **Smart Wallet deployment** | Deployed + counterfactual (ERC-6492) | Non-Coinbase Smart Wallet | Phase 2 could add Safe/Argent adapters |
| **Node.js** | 18, 20, 22 | Older | CI matrix |
| **SDK runtime** | CJS (our SDK) + ESM (dynamic) | — | `viem` dual-published handles this |
| **Payment currency display** | USD cap via `maxAmountPerTx` | EUR, JPY, etc. | Out of scope |
| **Fee layer** | **Always zero** | — | Protocol design, not configurable |
| **Reputation writes** | **Always zero** on x402 | — | Protocol design, not configurable |

### Upgrade cadence policy

- **Patch (`~2.9.0`)** — automatic, tracked by tilde semver
- **Minor (`~2.10.0 → ~2.11.0`)** — review within 2 weeks of upstream release, release our patch within 4 weeks if passing tests
- **Major (`3.x`)** — evaluate breaking changes, schedule as a dedicated AGIRAILS SDK minor bump (`3.4.0 → 3.5.0`) with migration notes
- **Security patches** — same-day if within matrix

### Known incompatibilities (documented, not bugs)

1. **Tier 1 Smart Wallet + EIP-3009-only seller** — fails by design with clear error message. Workaround: use EOA for that specific endpoint, or ask seller to advertise Permit2.
2. **Unpublished agent + first x402 payment** — paymaster gate blocks approve tx. Workaround: run `actp publish` first. Error message guides user.
3. **Counterfactual Smart Wallet + facilitator without ERC-6492 support** — edge case; `@x402/*@~2.9.0` supports 6492 on facilitator side per our verified research, so this should not happen with matrix-supported versions.

---

## Explicitly NOT in scope za Phase 1

- ✅ Server-side helper (`@agirails/sdk/server`) — **IN Phase 1 v4** (framework-agnostic config builder, ne wrapper)
- ✅ Smart Wallet x402 podrška — **IN Phase 1 v4** preko Permit2 path-a
- ✅ Onboarding CLI update ("pay/receive/both" flow) — **IN Phase 1 v4**
- ❌ Reputation hooks na x402 — odbačeno trajno (odluka 3)
- ❌ Self-hosted facilitator — odbačeno ultra-thinkom
- ❌ X402Relay v2 kontrakt — odbačeno, trenutni je deprecated
- ❌ Custom x402 scheme (`agirails-exact`) — odbačeno
- ❌ Python SDK parity port — Phase 3, tracka se odvojeno, commit 2 tjedna post 3.3.0
- ❌ Hono / Next middleware — razmotriti u Phase 2
- ❌ Probe-based router logic — ne treba, nema legacy grananja
- ❌ Safety consent callback za interactive use cases — backlog, razmotriti kasnije
- ❌ Retry / error taxonomy — backlog, može pokriti u 3.4.0 zajedno s ostalim resilience hardening-om

---

## Pre-kod checklist (moram odraditi prije ijedne linije)

### Faza 0 — Istraživanje (prije ijedne linije koda)

- [x] **Verificirati `@x402/fetch`, `@x402/evm`, `@x402/core` real API** — verified protiv tarballa 2026-04-11
- [x] **Potvrditi Permit2 path za Smart Wallet** — verified, production-ready u v2.9.0
- [x] **Verificirati `IWalletProvider` shape** — nema signTypedData, treba proširenje
- [x] **Verificirati usage audit (X402Adapter real users)** — samo n8n factory, safe za overwrite
- [x] **Smart Wallet signTypedData deep spike** — done. Coinbase Smart Wallet + viem.toCoinbaseSmartAccount pokriva sve (1271 + 6492 + replay-safe hashing).
- [ ] **On-chain verify `x402ExactPermit2Proxy` postoji** na Base mainnet + Base Sepolia — `eth_getCode(0x402085c248EeA27D92E8b30b2C58ed07f9E20001)`. Canonical CREATE2 u source-u, ali verify prije ship-a.
- [ ] **Confirm `x402.org/protected` je i dalje LIVE** — provjeriti pred ship, kritično jer je integration test dependency
- [ ] **viem CJS compatibility quick test** — `require('viem/account-abstraction')` pod Node 18/20/22 prije feature coding. Budget 30 min.
- [ ] **Napisati skicu lokalnog Permit2 mock servera** (Q7) — ~50 linija u planu, onda u testovima

### Faza 0.5 — Odluke koje blokiraju kod

- [x] **Q1 Smart Wallet + x402** — Permit2 put, production-ready
- [x] **Q2 IWalletProvider surface** — dodati `signTypedData` kao optional metodu
- [x] **Q3 Config location** — runtime-only u 3.3.0
- [x] **Q4 `mapToPayResult` shape** — finalizirati tijekom impl
- [x] **Q6 Smart Wallet signTypedData strategija** — viem.toCoinbaseSmartAccount, Easy→Medium, ~1 dan
- [x] **Q7 Permit2 test setup** — A (lokalni mock u CI) + B (smoke script pre-release), nema C
- [x] **Q8 Permit2 + 1271 delegation** — verified kroz spike, facilitator verifyTypedData radi 1271+6492+simulation
- [x] **Q10 postojeći signTypedData silent bug** — flag za follow-up, NOT u scope-u Phase 1
- [x] **Q11 lazy publish race handling** — (C) helpful error X402PublishRequiredError za 3.3.0

**Sve blocking odluke su zatvorene. Plan je finaliziran. Faza 1 impl može startati čim Damir kaže "kreni".**

### Faza 1 — Implementacija (tek nakon Faza 0 + 0.5 gotovo)

- [ ] Install `@x402/fetch@~2.9.0`, `@x402/evm@~2.9.0`, `@x402/core@~2.9.0`
- [ ] Proširiti IWalletProvider
- [ ] Implementirati EOAWalletProvider.signTypedData
- [ ] Implementirati AutoWalletProvider.signTypedData (spike-guided)
- [ ] Overwrite X402Adapter.ts
- [ ] Update UnifiedPayParams
- [ ] Auto-registracija u ACTPClient
- [ ] Novi testovi
- [ ] Lokalni Permit2 mock server
- [ ] Integration testovi (EOA EIP-3009 + Smart Wallet Permit2)
- [ ] n8n factory update
- [ ] Docs + CHANGELOG
- [ ] X402Relay deprecation
- [ ] Release `@agirails/sdk@3.3.0`

---

## Second-order considerations (preneseno iz ultra-think audita)

### Što ostaje dead code nakon 3.3.0
- `X402Relay` kontrakt na obje mreže (deprecated, ne zove se iz SDK-a)
- Sav stari `x-payment-*` header handling kod (bio u prethodnom X402Adapter.ts, sad obrisan)
- Legacy `X402AdapterConfig` polja: `requesterAddress`, `transferFn`, `feeCollector`, `expectedNetwork` (zamijenjena s `wallet`, `allowedNetworks`, `maxAmountPerTx`)

### Što treba posebnu pažnju tijekom code review
- **Shim function `ethersToClientEvmSigner`** — type coerce-evi s `as any` su neophodni zbog razlike u ethers v6 API vs `ClientEvmSigner` structural shape. Komentirati zašto svaki `as any` postoji (EIP712Domain stripping, domain type namespace, etc.)
- **`parseUsdcAmount`** — string → bigint konverzija za USDC 6-decimal format. Izbjegavati `parseFloat` (precision loss). Jedan edge case: negative amounts, leading zeros, scientific notation — trebaju biti rejected.
- **`mapToPayResult`** — još nije implementirano u skici. Treba dizajnirati shape mappinga PAYMENT-RESPONSE → UnifiedPayResult. Moguće da `UnifiedPayResult` treba dodatna polja za x402-specific fields (settlement tx hash na strani facilitatora, ne naše).

### Što treba watchati post-release
- `@x402/*` ekosustav ships 12 verzija u 3 mjeseca (per earlier research). Pinati tilde (`~2.9.0`), ne caret. Upgrade cadence 2-4 tjedna sa CI job koji testira protiv latest.
- Public `x402.org/protected` dostupnost — external dependency za integration test. Backup: deploy naš test server ako padne. Nije hitno, monitoraj.

### Semantika `payment-response` header
Agent je potvrdio da response struktura uključuje `payment-response: <base64>` header nakon uspješnog plaćanja. Decoded sadrži settlement confirmation (tx hash, network, amount, etc.). Mi to mappamo u `UnifiedPayResult` tako da user dobije konzistentni return shape bez obzira kojim adapterom plaća.

---

## Glavne reference

- **Ultra-think dokument** — `CLAUDE.md` § Design Philosophy (Vitalik protocol simplicity, three tests)
- **MEMORY.md** — AGIRAILS architecture decisions, deployed addresses
- **Real `@x402/*` API** — verified via npm tarballs 2026-04-11 (hash: not pinned; tilde range)
- **Live test endpoint** — `https://x402.org/protected` (Base Sepolia USDC $0.01 + Solana)
- **X402-foundation monorepo** — `github.com/x402-foundation/x402` (ownership moved from Coinbase Dec 2025)
- **x402 v2 migration guide** — `docs.cdp.coinbase.com/x402/migration-guide` (Coinbase hosted, may be auth-gated)
- **N8n call site to update** — `SDK and Runtime/n8n-nodes-actp/nodes/ACTP/utils/client.factory.ts:160`
- **Prior X402Adapter (to be overwritten)** — `SDK and Runtime/sdk-js/src/adapters/X402Adapter.ts`

---

## Changelog of this plan

- **v1 (rano 2026-04-11)** — over-engineered s legacy rename, probe routing, self-hosted facilitator razmatranjem, 4-day timeline. Hallucinirao `wrapFetchWithPaymentFromConfig` signature. Predlagao Phase 2 reputation hooks.
- **v2 (2026-04-11)** — kristalizirano nakon Damirovih 5 fiksiranih odluka + stvarne API verifikacije + usage audita. Direktni overwrite, zero legacy dance, amount optional, X402Relay deprecated, nula reputation za x402, docs u odvojenim PR-ovima, minor bump. Timeline 3.5 dana realno, Phase 1 only. Pre-kod checklist dodan. **Propust**: EOA-only put, propustio Smart Wallet Permit2 mogućnost. Damirova gassless intuicija djelomično kriva a djelomično točna (unified UX argument vrijedi).
- **v3 (2026-04-11)** — Smart Wallet inclusive. Permit2 path production-ready u `@x402/evm@2.9.0` (verified upstream unit testovi). IWalletProvider verificiran, treba `signTypedData` proširenje. EOA implementacija trivijalna, AutoWalletProvider implementacija je Phase 1 task koji zahtijeva deep spike. Timeline povećan na 5-6 dana realno. Gassless semantika razjašnjena (x402 je već gassless za buyera bez obzira na wallet tip; Smart Wallet je potreban za unified UX, ne za gas). Pre-kod checklist razbijen na Faza 0 (istraživanje), 0.5 (odluke), 1 (impl). Spike-first strategija.
- **v3.1 (2026-04-11)** — Smart Wallet spike gotov. Rezultat: Coinbase Smart Wallet + `viem.toCoinbaseSmartAccount` pokriva sve (replay-safe hashing + 1271 + 6492 automatski). Impl verdict Easy→Medium, ~1 dan. Dodaje viem ~2.21.0 kao dependency (prvi viem import u SDK). Identificirana 2 nova finding-a: (Q10) silent bug u postojećem kodu — not in scope Phase 1, follow-up PR; (Q11) lazy-publish race za prvi Permit2 approve. Timeline updated s verified breakdown-om 5.25 dana.
- **v3.2 (2026-04-11)** — Q7 i Q11 finalno odlučeno. **Q7**: (A) lokalni mock Express u CI + (B) smoke script pred release. **Q11**: (C) helpful `X402PublishRequiredError`. Timeline 5.25 dana (propušteno: scope je realno duplo više zbog seller strane).
- **v4 (ovaj dokument, 2026-04-11, FINAL post Damirov audit)** — Damir proveo PR review i uhvatio 7 rupa. Svi P0/P1/P2 issues zatvoreni:
    - **P0-1 (scope ne pokriva cilj)**: Phase 1 sad uključuje BOTH buyer + seller u istom releaseu. Seller-side je framework-agnostic `buildX402Server` helper (`@agirails/sdk/server` subpath), ne wrap nad `@x402/express` — user direktno koristi upstream middleware po izboru.
    - **P0-2 (Smart Wallet kontradikcija)**: stale v2 linije obrisane. Smart Wallet je **IN Phase 1**, ne "vjerojatno 3.4.0". Ide kroz Permit2 path verified spike-om.
    - **P0-3 (API mismatch)**: n8n call site update skica sad koristi `walletProvider` (ne `wallet: ethersWallet`). `autoApprovePermit2` dodan u `ACTPClientConfig.x402` schema eksplicitno.
    - **P1-1 (network defaults preuski)**: `allowedNetworks` optional undefined = "allow all EVM networks @x402/evm supports" = maximal interop. User eksplicitno restriktira ako hoće.
    - **P1-2 (fire-and-forget race)**: `preflightPermit2Approve` metoda awaited u `pay()` prije `fetchWithPayment`. Plus in-flight promise coalescing da spriječi duplicate approves u concurrent requestima.
    - **P2-1 (mapToPayResult TODO)**: implementirano koristeći `decodePaymentResponseHeader` iz `@x402/fetch`. Mapa na `UnifiedPayResult` s txId, state: SETTLED, amount, to, network, raw passthrough.
    - **P2-2 (primaryType TODO)**: propagiran iz `@x402/evm` caller-a (`params.primaryType`), ne hardcoded empty string.
    - **P2-3 (HTTPS drift)**: `^https:\/\/` strict regex umjesto `^https?:\/\/`. `http://` odbijen na canHandle razini.
    - **NEW: SLO + compatibility matrix** sekcija zamjenjuje "nikad problema" vague claim. Konkretne garancije + known limits + upgrade cadence policy.
    - **NEW: Gas cost model** sekcija — dokumentira tko plaća što u x402 flow-u. Ključni insight: naš paymaster je gotovo potpuno izvan x402 gas loop-a (samo one-time Permit2 approve za Smart Wallet, ~$0.50 amortizirano na nulu preko životnog vijeka agenta). Strukturalno savršeno za "x402 funnel, ACTP monetization" strategiju. Uključuje abuse vector analysis + zaštite.
    - **Timeline update**: realno **~10 radnih dana = 2.5-3 tjedna** za Phase 1 (buyer + seller + onboarding + docs). Alternativa: razdvojiti u alpha (buyer) + beta (seller) ako hitnost.
    - **Nova odluka potrebna od Damira**: full Phase 1 u 2.5-3 tjedna, ili phased alpha/beta za brži buyer fix?
- **v4.1 (ovaj dokument, 2026-04-11, FINAL POST PRE-IMPL AUDIT)** — Damir potvrdio (A) full release. Arha proveo završnu analizu i našao 10 stvari za fixati prije impl-a. Sve zatvoreno:
    - **Fix 1**: `preflightPermit2Approve` double-roundtrip anti-pattern zamijenjen s `onBeforePaymentCreation` hook-om iz `@x402/core` (verified u stvarnom source-u `@x402/core@2.9.0`). Single HTTP roundtrip per payment.
    - **Fix 2**: Error class taxonomy definirana — `X402Error` base + 9 specifičnih subclass-ova (`X402PublishRequiredError`, `X402UnsupportedWalletError`, `X402NetworkNotAllowedError`, `X402AmountExceededError`, `X402ApprovalFailedError`, `X402SignatureFailedError`, `X402SettlementProofMissingError`, `X402PaymentFailedError`, `X402ConfigError`).
    - **Fix 3**: Hono/Next interop testiran kroz type-level assertion umjesto real integration. Ušteda 0.4 dana.
    - **Fix 4**: Lokalni mock Permit2 server pojednostavljen na raw `node:http` (20 linija) umjesto Express wrapper-a. Scaffold code dan u planu.
    - **Fix 5**: `mapToPayResult` missing header case sada throws `X402SettlementProofMissingError` umjesto silent "SETTLED" (reorg/pending tx/facilitator bug protection).
    - **Fix 6**: Hard MEV cap na signed authorization validity — `maxAuthorizationValidSec` config polje, default 300s. Regardless of what server requests, clamp na 5min max.
    - **Fix 7**: Framework-agnostic fallback napomena za seller — users s Fastify/Koa/Hapi/raw http mogu direktno koristiti `resourceServer.handleRequest(req, res)` pattern bez upstream adapter-a.
    - **Fix 8**: Debug telemetry task dodan — `debug` library s namespace `agirails:x402`, 0.25 dana u Blok C.
    - **Fix 9**: Timeline reorganiziran u 3 kohezivna bloka (A buyer, B seller, C integracija) umjesto 17 fragmentiranih mini-tasks. Manje context switching.
    - **Fix 10**: Loud release communication plan dokumentiran — CHANGELOG breaking marker, `UPGRADE_3.3.md` migration guide, npm release note, one-version console.warn, GitHub release checklist, post-release 48h monitoring.
    - **Timeline update**: Phase 1 sada **~9.6 dana work = 2-2.5 tjedna realno**, pad s ~10 dana zbog v4.1 fix-eva (type-level Hono/Next ušteda 0.4 dana, blok-based organizacija ušteda ~0.5 dana zbog manje context switchinga, +~0.5 dana error taxonomy + debug telemetry).
    - **Plan je sada spreman za Faza 1 impl start. Nema više otvorenih pitanja ili blokada.**
- **v4.2 (ovaj dokument, 2026-04-11, GREEN LIGHT post 2-sat hardening spike)** — Damir tražio pre-impl verifikaciju pod Opcijom B prije komitiranja na kod. Provedena 8 paralelnih checks-a, svi verified:
    - ✅ **`x402.org/protected` LIVE** — vraća HTTP 402 s `payment-required` header-om, Base Sepolia USDC $0.01 accept. Spreman za integration testove.
    - ✅ **`x402ExactPermit2Proxy` deployed na Base Mainnet** `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` — bytecode 5828 chars (~2.9KB), confirmed `YES` deployed.
    - ✅ **`x402ExactPermit2Proxy` deployed na Base Sepolia** — isti adress, identični 5828 bytes bytecode. CREATE2 canonical confirmed.
    - ✅ **`createPermit2ApprovalTx(tokenAddress: '0x${string}')`** postoji u `@x402/evm@2.9.0` — exported iz main index + exact/client. **Signature correction**: prima **positional `tokenAddress`** argument, ne `{ token }` object. Plan skica updated.
    - ✅ **`decodePaymentResponseHeader`** postoji — exported iz `@x402/fetch` (re-exports iz `@x402/core/http`).
    - ✅ **`decodePaymentRequiredHeader`** postoji — exported iz `@x402/core/http`. Verified `decodePaymentRequiredHeader(header: string): PaymentRequired` signature u `.d.ts`.
    - ✅ **`x402Client.fromConfig(config: x402ClientConfig): x402Client`** — static method confirmed u `client/index.d.ts:125`. Builder chain s `.register(network, scheme)` i `.onBeforePaymentCreation(hook)` verificiran.
    - ✅ **viem CJS pod current Node LIVE** — `require('viem')`, `require('viem/account-abstraction')`, `require('viem/accounts')`, `require('viem/chains')` **svi rade**. `createPublicClient`, `toCoinbaseSmartAccount`, `privateKeyToAccount`, `base` all callable. No CJS blocker.
    - ⚠️ **Network canonical list** — `type Network = \`${string}:${string}\`` je **structural u `@x402/core`**, ne hardcoded enum. Znači nema upstream single-source-of-truth za "which EVM networks are supported". Naš `ALL_EVM_NETWORKS_FROM_X402_EVM` fallback mora ostati **hand-maintained**. Plan update: dodati comment u plan da treba ručno pratiti upstream support changes.
    - ✅ **Q10 silent bug usage audit** — grep kroz cijeli monorepo pokazuje da `DeliveryProofBuilder`, `QuoteBuilder`, `MessageSigner` imaju **zero production callers izvan samog sdk-js-a**. Jedini external match je OpenClaw SKILL.md koji samo spominje ime u dokumentaciji. **Verdict**: Q10 NIJE urgent, follow-up PR je OK.
    - ✅ **Paymaster error pattern verified** — `PaymasterClient.ts:112` vraća error poruku `"Gas sponsorship unavailable: {upstream error}"` i `"Gas sponsorship temporarily unavailable — both Coinbase and Pimlico paymasters failed"`. Naš `isPaymasterGateError()` regex treba match-ati `/gas sponsorship|paymaster/i` — update pattern u planu.
    - **One taktički correction nakon spike-a**: u planu X402Adapter skici zamijeniti `createPermit2ApprovalTx({ token })` s `createPermit2ApprovalTx(token as '0x${string}')`.
    - **Confidence update**: od "80-85% točan blueprint" na **95%+ točan blueprint**. Preostalih 5% je stvar real-world integration debug-a koji se nikako ne može eliminirati pre-impl.
    - **PLAN JE GREEN LIGHT ZA IMPLEMENTACIJU.**
