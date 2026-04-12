# X402 v2 — Deep Dive Findings (2026-04-11)

Resume point after restart. Builds on `X402_V2_SESSION_STATE.md` and `X402_V2_IMPLEMENTATION_PLAN.md`.

## P1 — payment-response može proći kao "success" iako je semantički nevalidan

- Upstream dekoder radi samo base64 + JSON.parse, bez schema validacije:
  - `node_modules/@x402/core/dist/cjs/http/index.js:1176`
- Naš adapter fallbacka na prazne vrijednosti i svejedno vraća `success: true`:
  - `src/adapters/X402Adapter.ts:709`
  - `src/adapters/X402Adapter.ts:733`
- Efekt: moguć "settled" rezultat bez validnog tx hash-a / networka.
- Fix smjer: validirati `transaction`, `network`, `payer` prije nego se vrati success; inače `success: false` s jasnim errorom.

## P1 — Buyer path je hardcoded na GET (nije full x402 HTTP interop)

- Plaćeni request je uvijek GET + fiksni headeri:
  - `src/adapters/X402Adapter.ts:366`
- `UnifiedPayParams` nema `method` / `body` / request headers za x402:
  - `src/adapters/adapter.ts:131`
- Efekt: POST/PUT/PATCH paid endpointi nisu pokriveni kroz unified path.
- Fix smjer: proširi `UnifiedPayParams` (method, body, headers) i proslijedi u x402 fetch wrapper.

## P1 — Unified status API nije adapter-aware za x402

- `client.pay()` može vratiti x402 rezultat, ali `client.getStatus()` uvijek ide na Standard/ACTP:
  - `src/ACTPClient.ts:1385`
- Efekt: za x402 txId `getStatus` i lifecycle pozivi ne mapiraju.
- Fix smjer: tag rezultata adapter metadata, route `getStatus` prema pravom adapteru (ili no-op za x402 s jasnom porukom).

## P2 — Integration test kontradiktoran s novim opt-in guardom

- Guard traži `metadata.paymentMethod === 'x402'` ili allowlisted host:
  - `src/adapters/X402Adapter.ts:332`
- Integration test zove `adapter.pay({ to: X402_TEST_URL })` bez opt-in-a:
  - `src/adapters/__tests__/X402Adapter.integration.test.ts:58`
- Efekt: kad se stvarno pusti `INTEGRATION=1`, test će pasti prije mrežnog poziva.
- Fix smjer: dodati `metadata: { paymentMethod: 'x402' }` u test ili allowlistati test host.

## P2 — Dokumentacijski / config drift

- Komentari i poruke još govore $10, kod je prešao na $1:
  - `src/adapters/X402Adapter.ts:91`
  - `src/adapters/X402Adapter.ts:299`
  - `src/adapters/X402Adapter.ts:551`
- Error poruka referencira `ACTPClientConfig.x402.allowedHosts`, ali `ACTPClientConfig` nema `x402` field:
  - `src/adapters/X402Adapter.ts:353`
  - `src/ACTPClient.ts:244`
- Fix smjer: uskladiti komentare na $1; ili dodati `x402` field u `ACTPClientConfig` i provući ga kroz adapter konstruktor, ili promijeniti error poruku da referencira stvarnu konfiguracijsku površinu.

## Predloženi redoslijed nakon restarta

1. P1 payment-response validacija (najmanji blast radius, najveći security win).
2. P1 method/body proširenje `UnifiedPayParams` + x402 buyer path.
3. P1 adapter-aware `getStatus` routing.
4. P2 integration test opt-in fix.
5. P2 doc/config drift cleanup.
