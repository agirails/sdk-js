/**
 * AIP-16 Delivery Surface — Type Definitions (Phase 2a Foundation)
 * =================================================================
 *
 * Type-level contract for the AGIRAILS delivery layer (AIP-16 Rev 5).
 *
 * The delivery surface is the post-COMMITTED / pre-DELIVERED protocol
 * step in which the provider hands the requester the *actual* deliverable
 * (the bytes the requester paid for), with cryptographic guarantees of
 * authenticity, integrity, and (optionally) confidentiality.
 *
 * Two privacy modes are supported in v1:
 *
 *  - `public-v1`        — body is plaintext UTF-8 JSON. Anyone observing
 *                         the channel can read it. Useful for public
 *                         deliverables (open data, public model outputs).
 *  - `x25519-aes256gcm-v1` — body is AES-256-GCM ciphertext, key derived
 *                         via X25519 ECDH + HKDF-SHA256 between provider
 *                         and requester ephemeral keys. End-to-end
 *                         confidential.
 *
 * The delivery surface is composed of two signed objects:
 *
 *  1. **DeliverySetup** — signed by the *requester* (buyer). Posted to the
 *     channel after COMMITTED. Declares the buyer's ephemeral pubkey,
 *     accepted channels, and expected privacy mode.
 *
 *  2. **DeliveryEnvelope** — signed by the *provider* (seller). Carries
 *     the body bytes (plaintext or ciphertext), AEAD nonce + tag, and
 *     `payloadHash = keccak256(bodyBytes)` for on-chain anchoring.
 *
 * Both objects use a *signed projection* + *wire envelope* split:
 *   - The *signed* object is the canonical EIP-712 payload — exact byte
 *     ordering and field layout matter for cross-SDK interoperability.
 *   - The *wire* object wraps it with the signature and optional relay
 *     server metadata for transport.
 *
 * ## Critical conventions
 *
 * - **EIP-712 domain**: ALWAYS `{name: "AGIRAILS Delivery", version: "1",
 *   chainId, verifyingContract: kernelAddress}`. Domain reuse across
 *   AIP features (negotiation, receipts) would enable cross-feature
 *   signature replay.
 *
 * - **Canonical empty values**: For `scheme: "public-v1"`, the encryption
 *   fields (`providerEphemeralPubkey`, `nonce`, `tag`) MUST be canonical
 *   empty (zero-filled bytes of the correct length), NOT omitted. EIP-712
 *   has no concept of an "absent" field — the type schema is fixed and
 *   every field has a value.
 *
 * - **Smart wallet two-step auth**: `signerAddress` is the EOA that
 *   produced the signature; `requesterAddress` / `providerAddress` is the
 *   on-chain participant (which may be a Smart Wallet — a contract that
 *   does not itself sign). Verification recovers the EOA from the
 *   signature, then checks either equality with the participant OR that
 *   the participant is the Smart Wallet derived from the EOA.
 *
 * - **Address comparisons** are always case-insensitive (.toLowerCase()).
 *
 * - **Field order in EIP-712 types is IMMUTABLE.** Any reordering of
 *   fields in `DeliverySetupSignedV1` or `DeliveryEnvelopeSignedV1`
 *   constitutes a breaking SDK change because both client and server
 *   must encode byte-for-byte identical typed-data structures.
 *
 * @module delivery/types
 * @see {@link https://eips.ethereum.org/EIPS/eip-712 EIP-712 Typed Structured Data}
 * @see {@link https://www.rfc-editor.org/rfc/rfc5869 RFC 5869 — HKDF}
 * @see {@link https://datatracker.ietf.org/doc/html/rfc7748 RFC 7748 — X25519}
 */

// ============================================================================
// Discriminator Unions
// ============================================================================

/**
 * Cryptographic scheme used to protect (or not protect) the envelope body.
 *
 * - `"x25519-aes256gcm-v1"` — End-to-end encrypted. The provider derives
 *   a shared secret with the buyer's ephemeral X25519 pubkey, runs
 *   HKDF-SHA256 to produce a 32-byte symmetric key, then encrypts the
 *   plaintext body with AES-256-GCM using a 12-byte nonce. The 16-byte
 *   GCM authentication tag is carried separately in the signed
 *   projection so it is bound to the EIP-712 signature.
 *
 * - `"public-v1"` — No confidentiality. The envelope body is plaintext
 *   UTF-8 JSON. The encryption fields in the signed projection are set
 *   to canonical empty values (zero bytes of the appropriate length).
 *   Used for deliverables that are intentionally public or where the
 *   sensitivity does not warrant encryption overhead.
 *
 * Future versions of AIP-16 may add additional schemes (e.g. an XChaCha20
 * variant) — those will be `*-v2` discriminants. The v1 spec is locked.
 */
export type DeliveryScheme = 'x25519-aes256gcm-v1' | 'public-v1';

/**
 * Transport / placement mode for the envelope.
 *
 * - `"channel"` — Envelope is posted to a delivery channel (e.g. the
 *   AGIRAILS relay) and pulled by the requester. The channel id is
 *   declared in `acceptedChannels` of the setup.
 *
 * - `"none"` — No envelope is delivered through this surface. Typically
 *   used for sentinel / smoke-test flows where settlement is the only
 *   outcome being exercised.
 *
 * NOTE: AIP-17 introduces a `"reference"` mode (envelope carries a CID
 * pointer to externally-stored bytes); that mode is not part of the v1
 * AIP-16 surface and is intentionally omitted here.
 */
export type DeliveryMode = 'channel' | 'none';

/**
 * High-level privacy posture the requester *expects* in the buyer setup.
 *
 * - `"encrypted"` — Requester expects an `x25519-aes256gcm-v1` envelope.
 *   If the provider sends `public-v1`, the requester SHOULD reject with
 *   `setup_signer_role_mismatch` / privacy-policy violation.
 *
 * - `"public"` — Requester accepts (or requires) a `public-v1` envelope.
 *
 * `expectedPrivacy` is an out-of-band hint the requester signs into the
 * setup; the provider is responsible for honoring it when selecting a
 * `DeliveryScheme`. The two enums are intentionally separate so that
 * future scheme additions do not require reshaping the setup contract.
 */
export type DeliveryPrivacy = 'encrypted' | 'public';

/**
 * Role of a participant within a single delivery exchange.
 *
 * - `"provider"` — The agent producing and signing the envelope.
 * - `"requester"` — The agent producing and signing the setup.
 *
 * Used in verification routines to disambiguate which signer-role check
 * applies (the signer must be acting in the role declared in the
 * surrounding payload).
 */
export type ParticipantRole = 'provider' | 'requester';

/**
 * Networks on which the delivery surface is exercised.
 *
 * - `"base-sepolia"` — Base L2 Sepolia testnet (chainId 84532).
 * - `"base-mainnet"` — Base L2 mainnet (chainId 8453).
 * - `"mock"` — In-process MockRuntime; no real on-chain anchoring.
 *
 * The network is used to look up the correct kernel address and chainId
 * when constructing the EIP-712 domain. Builders MUST validate that
 * `chainId` in the signed payload matches the expected chain for the
 * network in use; mismatches produce `envelope_chain_mismatch` /
 * `setup_chain_mismatch` errors.
 */
export type DeliveryNetwork = 'base-sepolia' | 'base-mainnet' | 'mock';

// ============================================================================
// Buyer Setup
// ============================================================================

/**
 * Canonical EIP-712 payload signed by the *requester* (buyer) at the
 * start of the delivery exchange.
 *
 * The setup is posted to the delivery channel (or otherwise made
 * available to the provider) after the transaction reaches `COMMITTED`.
 * It tells the provider:
 *
 *  - Which kernel + chain the delivery is bound to (`chainId`,
 *    `kernelAddress`, `txId`).
 *  - Which on-chain identity is acting as the requester
 *    (`requesterAddress`) and which EOA will sign on its behalf
 *    (`signerAddress`).
 *  - The buyer's ephemeral X25519 pubkey (for encrypted schemes), or a
 *    canonical-empty value for `public-v1`.
 *  - Which channels the buyer accepts for envelope delivery.
 *  - The privacy posture the buyer expects.
 *  - A creation timestamp and an expiry timestamp for replay / staleness
 *    bounds.
 *
 * ## EIP-712 schema (signed)
 *
 * ```
 * DeliverySetupV1 (
 *   uint8  version,
 *   bytes32 txId,
 *   uint256 chainId,
 *   address kernelAddress,
 *   address requesterAddress,
 *   address signerAddress,
 *   bytes32 buyerEphemeralPubkey,
 *   string[] acceptedChannels,
 *   string  expectedPrivacy,
 *   uint64  createdAt,
 *   uint64  expiresAt
 * )
 * ```
 *
 * The field order shown above is IMMUTABLE — changing it is a breaking
 * SDK and Platform change.
 *
 * @example
 * ```typescript
 * const signed: DeliverySetupSignedV1 = {
 *   version: 1,
 *   txId: '0xabc…',
 *   chainId: 84532,
 *   kernelAddress: '0x469C…',
 *   requesterAddress: '0xRequesterSmartWallet…',
 *   signerAddress: '0xRequesterEOA…',
 *   buyerEphemeralPubkey: '0x' + 'aa'.repeat(32),
 *   acceptedChannels: ['agirails-relay-v1'],
 *   expectedPrivacy: 'encrypted',
 *   createdAt: 1730000000,
 *   expiresAt: 1730000600,
 * };
 * ```
 */
export interface DeliverySetupSignedV1 {
  /** Protocol version literal. Always `1` for the v1 setup schema. */
  version: 1;

  /**
   * On-chain transaction id this delivery setup is bound to.
   * `bytes32` hex-encoded. Used as the HKDF salt when deriving the
   * symmetric key for encrypted schemes (binds the key to a specific tx).
   */
  txId: `0x${string}`;

  /**
   * EVM chain id (e.g. 8453 for Base mainnet, 84532 for Base Sepolia).
   * Encoded into the EIP-712 domain and ALSO into the signed payload —
   * defense-in-depth against cross-chain replay if a wallet signs without
   * properly enforcing domain chainId.
   */
  chainId: number;

  /**
   * Address of the ACTP kernel contract on `chainId`. Also the EIP-712
   * `verifyingContract`. Relays validate this against an allowlist to
   * reject setups bound to unknown kernels.
   */
  kernelAddress: `0x${string}`;

  /**
   * On-chain identity acting as the requester. When AutoWallet (AIP-12
   * Tier 1) is active this is a Smart Wallet contract address — the
   * contract itself cannot sign EIP-712 messages, so signature recovery
   * yields the controlling EOA (`signerAddress`).
   */
  requesterAddress: `0x${string}`;

  /**
   * EOA that produced the signature on this payload. For non-smart-wallet
   * flows this equals `requesterAddress`. For smart-wallet flows it is
   * the controlling EOA; verification then checks that
   * `computeSmartWalletFromSigner(signerAddress) === requesterAddress`.
   */
  signerAddress: `0x${string}`;

  /**
   * Buyer-side ephemeral X25519 public key, 32 bytes hex-encoded.
   *
   * For `expectedPrivacy: "encrypted"` this is a freshly generated
   * X25519 pubkey whose corresponding private key is held only in
   * memory by the requester. For `expectedPrivacy: "public"` (and
   * therefore `scheme: "public-v1"`) this MUST be `CANONICAL_EMPTY_BYTES32`
   * — NOT omitted. EIP-712 has no "absent field" concept.
   */
  buyerEphemeralPubkey: `0x${string}`;

  /**
   * Ordered list of delivery channels the buyer is willing to accept the
   * envelope on. In v1 the only registered channel is `"agirails-relay-v1"`.
   * Future channels (e.g. self-hosted relays, libp2p) will declare their
   * own identifiers.
   */
  acceptedChannels: string[];

  /**
   * Privacy posture the buyer expects the provider to use. The provider
   * MUST select a `DeliveryScheme` consistent with this value:
   *  - `"encrypted"` → `x25519-aes256gcm-v1`
   *  - `"public"` → `public-v1`
   */
  expectedPrivacy: DeliveryPrivacy;

  /**
   * Unix seconds at which the setup was created (NOT signed). Encoded
   * into the EIP-712 payload so the provider can detect clock skew or
   * stale setups.
   */
  createdAt: number;

  /**
   * Unix seconds after which this setup is no longer valid. The provider
   * MUST reject setups where `now > expiresAt`. Typical values are
   * `createdAt + 600` (10 min) to bound replay windows.
   */
  expiresAt: number;

  /**
   * CoinbaseSmartWallet factory nonce used to derive `requesterAddress`
   * from `signerAddress`. Defaults to `0` (the first wallet per owner),
   * matching the SDK's auto-wallet behavior.
   *
   * H4 fix (AIP-16 Phase 3 HIGH): users whose Smart Wallet was deployed
   * at a non-zero factory nonce (e.g. they redeployed at nonce=1 after
   * losing access to their nonce=0 keys) previously got permanently
   * locked out with `signer_role_mismatch`. By signing the nonce into
   * the payload, the server can derive the correct Smart Wallet address
   * via `getAddress(owners, smartWalletNonce)` instead of always
   * assuming `0`.
   *
   * Appended to the EIP-712 field list (NOT inserted) so existing
   * positional encodings remain stable across SDK/Platform mirrors.
   *
   * Static field is OPTIONAL on the TypeScript interface for backwards
   * compatibility with pre-H4 fixtures: when present the value MUST be
   * a non-negative integer; when absent the verifier treats it as `0`
   * and signs/recovers under `smartWalletNonce: 0`. Newly built
   * payloads from `DeliverySetupBuilder.build()` always include the
   * field explicitly (defaulting to `0` from `BuildSetupParams`).
   */
  smartWalletNonce?: number;
}

/**
 * Wire envelope wrapping a {@link DeliverySetupSignedV1} for transport
 * over the delivery channel.
 *
 * The wire form is what is POSTed to the channel; the relay may decorate
 * it with `serverMeta` (received timestamp + relay id) when serving it
 * back to the provider.
 *
 * The signed projection is preserved verbatim — clients MUST NOT
 * re-serialize or normalize it after signing, since EIP-712 signatures
 * are over the structured data, not its JSON encoding, but tampering
 * with the projection invalidates the contract between signed bytes and
 * the cleartext the relay/provider can read.
 */
export interface DeliverySetupWireV1 {
  /** Canonical signed projection. */
  signed: DeliverySetupSignedV1;

  /**
   * Requester EIP-712 signature over `signed` using the
   * `AGIRAILS Delivery` domain, type `DeliverySetupV1`.
   *
   * Recovers to `signed.signerAddress` (which is then matched against
   * `signed.requesterAddress` via direct or smart-wallet equality).
   */
  requesterSig: `0x${string}`;

  /**
   * Optional server-added metadata (set by the relay on read, not by the
   * signer). Never part of the signed payload — informational only.
   */
  serverMeta?: {
    /** ISO 8601 timestamp at which the relay received the setup. */
    receivedAt: string;
    /** Identifier of the relay that received and is now serving the setup. */
    relayId: string;
  };
}

// ============================================================================
// Provider Envelope
// ============================================================================

/**
 * Canonical EIP-712 payload signed by the *provider* when delivering
 * the actual bytes (or ciphertext) the requester paid for.
 *
 * The envelope is the load-bearing artifact of the entire delivery
 * surface: it binds, in a single signed structure, the on-chain
 * transaction id, the chosen cryptographic scheme, the AEAD parameters
 * (when applicable), and a hash of the exact body bytes the requester
 * will receive. Verification on the receiving side reconstructs
 * `payloadHash = keccak256(bodyBytes)` from the wire body and compares.
 *
 * ## EIP-712 schema (signed)
 *
 * ```
 * DeliveryEnvelopeV1 (
 *   uint8  version,
 *   bytes32 txId,
 *   uint256 chainId,
 *   address kernelAddress,
 *   address providerAddress,
 *   address signerAddress,
 *   string  scheme,
 *   bytes32 providerEphemeralPubkey,
 *   bytes12 nonce,
 *   bytes32 payloadHash,
 *   bytes16 tag,
 *   uint64  createdAt
 * )
 * ```
 *
 * Field order is IMMUTABLE.
 *
 * ## Canonical-empty values
 *
 * For `scheme: "public-v1"` the following fields MUST be canonical empty:
 *  - `providerEphemeralPubkey` → {@link CANONICAL_EMPTY_BYTES32}
 *  - `nonce` → {@link CANONICAL_EMPTY_BYTES12}
 *  - `tag` → {@link CANONICAL_EMPTY_BYTES16}
 *
 * Verifiers MUST reject envelopes where the scheme/empty-value invariant
 * is violated (e.g. `public-v1` with a non-zero `nonce`).
 */
export interface DeliveryEnvelopeSignedV1 {
  /** Protocol version literal. Always `1` for the v1 envelope schema. */
  version: 1;

  /**
   * On-chain transaction id this envelope is bound to. Must equal the
   * `txId` in the corresponding setup. `bytes32` hex-encoded.
   */
  txId: `0x${string}`;

  /**
   * EVM chain id. Must equal the chainId on which the kernel contract
   * lives and match the EIP-712 domain.
   */
  chainId: number;

  /** Address of the ACTP kernel contract; also EIP-712 `verifyingContract`. */
  kernelAddress: `0x${string}`;

  /**
   * On-chain identity acting as the provider. When AutoWallet is active
   * this is a Smart Wallet contract — see `signerAddress` below.
   */
  providerAddress: `0x${string}`;

  /**
   * EOA that produced the signature. For non-smart-wallet flows this
   * equals `providerAddress`. For smart-wallet flows verification
   * checks `computeSmartWalletFromSigner(signerAddress) === providerAddress`.
   */
  signerAddress: `0x${string}`;

  /** Cryptographic scheme used for the body. See {@link DeliveryScheme}. */
  scheme: DeliveryScheme;

  /**
   * Provider-side ephemeral X25519 public key, 32 bytes hex-encoded.
   *
   * For `scheme: "x25519-aes256gcm-v1"`: a freshly generated X25519
   * pubkey; the receiver runs ECDH with their own ephemeral secret
   * to derive the shared secret. Provider's ephemeral private key is
   * discarded after sealing (forward secrecy w.r.t. provider long-term keys).
   *
   * For `scheme: "public-v1"`: MUST be {@link CANONICAL_EMPTY_BYTES32}.
   */
  providerEphemeralPubkey: `0x${string}`;

  /**
   * AES-GCM nonce (a.k.a. IV), 12 bytes hex-encoded.
   *
   * For `scheme: "x25519-aes256gcm-v1"`: 12 random bytes, unique per
   * envelope (re-using a nonce under the same key destroys AES-GCM's
   * security). The 12-byte length is the GCM standard.
   *
   * For `scheme: "public-v1"`: MUST be {@link CANONICAL_EMPTY_BYTES12}.
   */
  nonce: `0x${string}`;

  /**
   * `keccak256` hash of the exact bytes carried in the wire envelope's
   * `body` field, 32 bytes hex-encoded.
   *
   *  - For `public-v1`: hash of the UTF-8 plaintext bytes.
   *  - For `x25519-aes256gcm-v1`: hash of the raw ciphertext bytes
   *    (i.e. the bytes decoded from the base64 `body`).
   *
   * Verifiers MUST recompute and compare; mismatch → `envelope_payload_hash_mismatch`.
   * This hash is also what is anchored on-chain (in AIP-3 receipts) so
   * the entire chain of trust is body-hash → envelope sig → kernel.
   */
  payloadHash: `0x${string}`;

  /**
   * AES-GCM authentication tag, 16 bytes hex-encoded.
   *
   * For `scheme: "x25519-aes256gcm-v1"`: the GCM tag produced by the
   * encryption. It is carried separately (rather than appended to the
   * ciphertext) so that it is bound to the EIP-712 signature directly —
   * tampering with the tag without also producing a fresh signature is
   * detectable on signature recovery.
   *
   * For `scheme: "public-v1"`: MUST be {@link CANONICAL_EMPTY_BYTES16}.
   */
  tag: `0x${string}`;

  /**
   * Unix seconds at which the envelope was created. The receiver MAY
   * enforce a max skew between this and their wall clock to bound
   * replay windows; out-of-bounds → `envelope_timestamp_skew`.
   */
  createdAt: number;

  /**
   * CoinbaseSmartWallet factory nonce used to derive `providerAddress`
   * from `signerAddress`. Defaults to `0` (the first wallet per owner).
   *
   * H4 fix (AIP-16 Phase 3 HIGH): symmetric to `DeliverySetupSignedV1.smartWalletNonce`
   * — providers whose Smart Wallet was deployed at a non-zero factory
   * nonce can declare it here so the server's smart-wallet derivation
   * lands on the correct address.
   *
   * Appended to the EIP-712 field list (NOT inserted) so existing
   * positional encodings remain stable across SDK/Platform mirrors.
   *
   * Optional on the TypeScript interface for backwards compatibility
   * with pre-H4 fixtures; absent → treated as `0` by the verifier.
   * Newly built envelopes always include the field explicitly.
   */
  smartWalletNonce?: number;
}

/**
 * Wire envelope around a {@link DeliveryEnvelopeSignedV1} for transport.
 *
 * Contains:
 *  - the signed projection (verbatim),
 *  - the body (plaintext UTF-8 JSON for `public-v1`, 0x-prefixed
 *    lowercase hex of ciphertext for `x25519-aes256gcm-v1`),
 *  - the provider's EIP-712 signature,
 *  - optional relay server metadata.
 *
 * The body encoding is scheme-dependent (FIX-1, AIP-16 Phase 3.5):
 *
 *  - `public-v1`: `body` is the plaintext UTF-8 JSON string itself —
 *    `JSON.stringify(payload)`, NOT hex. Hash to verify =
 *    `keccak256(utf8Bytes(body))`. The Platform verifier
 *    (`lib/delivery/auth.ts`) computes the same digest directly on
 *    the wire body. Hex-wrapping the plaintext would make the verifier
 *    hash the hex string as UTF-8 — a different digest — and every
 *    public envelope would be rejected with `payload_hash_mismatch`.
 *  - `x25519-aes256gcm-v1`: `body` is 0x-prefixed lowercase HEX of the
 *    raw ciphertext bytes (NOT base64 — AIP-16 standardizes on hex
 *    for binary byte-bearing fields). Hash to verify is
 *    `keccak256(hexDecode(body))`; decode hex → raw ciphertext bytes,
 *    then hash & decrypt.
 *
 * The receiver MUST:
 *  1. Verify the EIP-712 signature recovers to `signed.signerAddress`.
 *  2. Verify smart-wallet equality between `signerAddress` and
 *     `signed.providerAddress`.
 *  3. Recompute `payloadHash` per the scheme rule above and compare
 *     to `signed.payloadHash`.
 *  4. For encrypted schemes, derive the symmetric key via X25519+HKDF
 *     and decrypt; tag mismatch on GCM → `envelope_decrypt_failed`.
 */
export interface DeliveryEnvelopeWireV1 {
  /** Canonical signed projection. */
  signed: DeliveryEnvelopeSignedV1;

  /**
   * Envelope body. Encoding depends on `signed.scheme`:
   *
   *  - `public-v1`: plaintext UTF-8 JSON string. The body IS
   *    `JSON.stringify(payload)` verbatim — NOT hex-encoded. The
   *    Platform verifier computes `keccak256(utf8Bytes(body))` and
   *    the SDK signs over the same digest. Any encoding wrapper
   *    (hex, base64) here would force the verifier to hash a
   *    different byte sequence than the SDK signed over.
   *
   *  - `x25519-aes256gcm-v1`: 0x-prefixed lowercase hex of the raw
   *    ciphertext bytes (NOT base64). `payloadHash =
   *    keccak256(hexDecode(body))`. The hex encoding is required
   *    because ciphertext is arbitrary binary (incl. 0x00, high-bit
   *    bytes) and cannot travel naked in a JSON string. The
   *    `bytesFromHex` decoder is the single shared hex-decoder used
   *    by every other byte-bearing field (nonce, tag, payloadHash,
   *    ephemeral pubkey).
   *
   * The exact bytes used to compute `signed.payloadHash` are
   * `utf8Bytes(body)` for public-v1 and `hexDecode(body)` for the
   * encrypted scheme — NOT the JSON-string or hex-string form
   * uninterpreted.
   */
  body: string;

  /**
   * Provider EIP-712 signature over `signed` using the
   * `AGIRAILS Delivery` domain, type `DeliveryEnvelopeV1`.
   */
  providerSig: `0x${string}`;

  /**
   * Optional server-added metadata (set by the relay on read).
   * Never part of the signed payload — informational only.
   */
  serverMeta?: {
    /** ISO 8601 timestamp at which the relay received the envelope. */
    receivedAt: string;
    /** Identifier of the relay that received and is now serving the envelope. */
    relayId: string;
  };
}

// ============================================================================
// Builder Result Types
// ============================================================================

/**
 * Result of building a delivery setup via the buyer setup builder.
 *
 * Carries the wire envelope (ready to POST to the relay) plus a
 * nonce-manager key the caller uses to track this setup in a
 * {@link NonceManager} instance, ensuring the same buyer cannot
 * accidentally produce two setups bound to the same txId.
 */
export interface BuildSetupResult {
  /** Fully signed wire envelope, ready to post to a delivery channel. */
  wire: DeliverySetupWireV1;

  /**
   * The NonceManager key under which this setup's anti-replay nonce was
   * tracked. For delivery setups this key is namespaced under
   * `agirails.delivery.setup.v1` and is *distinct* from the envelope
   * nonce key (`agirails.delivery.envelope.v1`) and the older AIP-4
   * delivery key (`agirails.delivery.v1`).
   */
  nonceManagerKey: string;
}

/**
 * Result of building a delivery envelope via the provider envelope builder.
 *
 * Carries:
 *  - the wire envelope (ready to POST),
 *  - for encrypted schemes only, the symmetric `blobKey` that was used —
 *    returned so the provider can optionally persist it (e.g. for
 *    debugging or to seed an AIP-17 reference-mode flow). Receivers
 *    derive the key themselves from the ECDH exchange and do NOT use
 *    this field.
 *  - the exact body bytes the `payloadHash` was computed over (so
 *    callers can re-verify or anchor the hash without re-deriving the
 *    bytes themselves).
 */
export interface BuildEnvelopeResult {
  /** Fully signed wire envelope, ready to post to a delivery channel. */
  wire: DeliveryEnvelopeWireV1;

  /**
   * Symmetric AES-256 key used to encrypt the body, 32 bytes.
   * Present ONLY for `scheme: "x25519-aes256gcm-v1"`; `undefined` for
   * `public-v1`. Receivers do not use this — it is returned solely
   * for provider-side observability / future reference-mode flows.
   */
  blobKey?: Uint8Array;

  /**
   * Exact bytes over which `wire.signed.payloadHash` was computed.
   *
   *  - For `public-v1`: UTF-8 encoded plaintext bytes.
   *  - For `x25519-aes256gcm-v1`: raw ciphertext bytes (NOT base64).
   */
  bodyBytes: Uint8Array;
}

// ============================================================================
// Structured Errors
// ============================================================================

/**
 * Structured error codes for the delivery flow.
 *
 * Codes are grouped by stage:
 *
 *  - `envelope_*` — Problems detected when verifying or processing
 *    an envelope received from the provider.
 *  - `setup_*` — Problems detected when verifying or processing a
 *    setup received from the requester.
 *  - `crypto_*` — Lower-level cryptographic primitive failures
 *    (keygen, ECDH, HKDF, AES-GCM).
 *  - `channel_*` — Transport-level failures (HTTP errors talking to
 *    the relay).
 *
 * Codes are stable identifiers — once shipped, semantics must not
 * change. New failure modes should add a new code rather than overload
 * an existing one. Codes are intended to be machine-actionable: SDK
 * consumers and operators should be able to wire metrics and alerts
 * directly to them.
 */
export type DeliveryErrorCode =
  // Envelope verification failures
  | 'envelope_signature_invalid'
  | 'envelope_decrypt_failed'
  | 'envelope_payload_hash_mismatch'
  | 'envelope_participant_mismatch'
  | 'envelope_signer_role_mismatch'
  | 'envelope_chain_mismatch'
  | 'envelope_kernel_mismatch'
  | 'envelope_timestamp_skew'
  | 'envelope_no_envelope_at_relay'
  // Setup verification failures
  | 'setup_post_failed'
  | 'setup_signature_invalid'
  | 'setup_participant_mismatch'
  | 'setup_signer_role_mismatch'
  | 'setup_chain_mismatch'
  | 'setup_kernel_mismatch'
  | 'setup_timestamp_skew'
  | 'setup_expired'
  // Cryptographic primitive failures
  | 'crypto_keygen_failed'
  | 'crypto_shared_secret_failed'
  | 'crypto_hkdf_failed'
  | 'crypto_encrypt_failed'
  | 'crypto_decrypt_failed'
  // Channel / transport failures
  | 'channel_post_failed'
  | 'channel_get_failed'
  | 'channel_unreachable'
  | 'envelope_missing'
  | 'envelope_late';

/**
 * Structured error payload returned by delivery surface verification
 * routines and builder failure paths.
 *
 * Carries the stable {@link DeliveryErrorCode}, a human-readable
 * `message`, and optional structured `details` (e.g. expected vs actual
 * values). Callers should branch on `code`, log `message`, and surface
 * `details` for debugging.
 *
 * This is the *value* shape; the matching error *class* (extending
 * `ACTPError`) is defined elsewhere in this module so consumers can
 * `throw` and `catch` consistently with the rest of the SDK.
 *
 * @example
 * ```typescript
 * const err: DeliveryError = {
 *   code: 'envelope_payload_hash_mismatch',
 *   message: 'Recomputed hash does not match signed payloadHash',
 *   details: {
 *     expected: '0xabc…',
 *     actual: '0xdef…',
 *   },
 * };
 * ```
 */
export interface DeliveryError {
  /** Stable machine-actionable code from {@link DeliveryErrorCode}. */
  code: DeliveryErrorCode;
  /** Human-readable description of the failure. */
  message: string;
  /** Optional structured details (expected/actual values, txId, etc.). */
  details?: Record<string, unknown>;
}

// ============================================================================
// Canonical Empty Value Constants
// ============================================================================

/**
 * Canonical empty `bytes32` value: 32 zero bytes, hex-encoded.
 *
 * Used as the value of `buyerEphemeralPubkey` (in setups) and
 * `providerEphemeralPubkey` / `payloadHash` slots whenever the field is
 * scheme-irrelevant. EIP-712 has no concept of an absent field; every
 * field in the typed schema has a value, so we use a canonical
 * "no-data" sentinel that hashes to a known, predictable value.
 *
 * Specifically for `public-v1` envelopes:
 *  - `providerEphemeralPubkey` MUST equal this constant.
 *
 * For setups with `expectedPrivacy: "public"`:
 *  - `buyerEphemeralPubkey` MUST equal this constant.
 *
 * NOTE: `payloadHash` is NEVER canonical-empty in practice — even an
 * empty body produces `keccak256("") = 0xc5d2…`. The constant is
 * exported for type-level uniformity, not because `payloadHash` is
 * ever zero.
 *
 * @example
 * ```typescript
 * // 0x0000000000000000000000000000000000000000000000000000000000000000
 * console.log(CANONICAL_EMPTY_BYTES32);
 * ```
 */
export const CANONICAL_EMPTY_BYTES32 = ('0x' + '00'.repeat(32)) as `0x${string}`;

/**
 * Canonical empty `bytes12` value: 12 zero bytes, hex-encoded.
 *
 * Used for the AES-GCM `nonce` field when `scheme: "public-v1"` (the
 * envelope is not encrypted, so there is no real nonce). Receivers
 * MUST reject envelopes whose scheme is `public-v1` but whose `nonce`
 * is NOT this constant.
 *
 * For `x25519-aes256gcm-v1`, `nonce` MUST be 12 random bytes — never
 * this constant; a zero nonce under a real key catastrophically breaks
 * AES-GCM (key recovery via tag forgery).
 *
 * @example
 * ```typescript
 * // 0x000000000000000000000000
 * console.log(CANONICAL_EMPTY_BYTES12);
 * ```
 */
export const CANONICAL_EMPTY_BYTES12 = ('0x' + '00'.repeat(12)) as `0x${string}`;

/**
 * Canonical empty `bytes16` value: 16 zero bytes, hex-encoded.
 *
 * Used for the AES-GCM authentication `tag` field when
 * `scheme: "public-v1"` (no encryption, no tag). Receivers MUST
 * reject envelopes whose scheme is `public-v1` but whose `tag` is
 * NOT this constant.
 *
 * @example
 * ```typescript
 * // 0x00000000000000000000000000000000
 * console.log(CANONICAL_EMPTY_BYTES16);
 * ```
 */
export const CANONICAL_EMPTY_BYTES16 = ('0x' + '00'.repeat(16)) as `0x${string}`;

// ============================================================================
// Domain Constants
// ============================================================================
//
// The EIP-712 domain ("AGIRAILS Delivery") and the typed-data schemas
// (DeliverySetupV1, DeliveryEnvelopeV1) are intentionally defined in
// `src/delivery/eip712.ts` — they are the contract surface between
// signer, verifier, and Platform server, and live with the helpers that
// build and verify the signatures. Importing them from a single
// location keeps domain-string discipline tight.
//
// (No domain constants are re-exported here; consumers should import
// directly from `src/delivery/eip712`.)
