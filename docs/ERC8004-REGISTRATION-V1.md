# ERC-8004 registration-v1 publishing and migration

AGIRAILS uses two separate artifacts:

- AGIRAILS Markdown remains the authored AGIRAILS configuration and is
  referenced by the `AGIRAILS` service entry.
- ERC-8004 `agentURI` points to a deterministic `registration-v1` JSON
  projection.

The projection is intentionally conservative. It does not infer A2A, MCP,
x402, or trust support from generic AGIRAILS fields. New identities initially
use an empty `registrations` array because the token ID does not exist until
`register(agentURI)` completes. Binding that identity, and updating existing
identities, require a later evidence-reviewed `setAgentURI` operation.

## Compatibility boundaries

- Version-2 pending-publish state contains both the Markdown CID and the
  registration-v1 CID.
- A legacy version-1 pending file can still activate the AGIRAILS registry,
  but ERC-8004 minting is skipped. It is never allowed to register Markdown as
  ERC-8004 metadata.
- Republish does not guess whether a bare AGIRAILS `agent_id` belongs to a
  particular ERC-8004 registry. Existing ERC-8004 URI updates therefore use
  the explicit registry-scoped migration workflow below.
- None of the migration commands changes the registry `agentWallet` value.
  A zero or malformed wallet must not be treated as a payment destination.

## 1. Collect observed identities

Pass only explicit, already identified ERC-8004 token IDs. The command does
not scan a chain and does not request a private key.

```bash
actp erc8004 inventory \
  --network base-sepolia \
  --agent-id 6732 \
  --agent-id 6747 \
  --output erc8004-inventory.json
```

The output records the registry owner, registry `agentWallet`, current
`agentURI`, resolved content, and any per-agent failures. It also records zero
signatures and zero generated transactions. Only the RPC origin is retained;
credential-bearing paths and query parameters are never written.

`ipfs://` artifacts resolve through the configured public IPFS gateway. A
plain HTTPS artifact host is untrusted on-chain input and is not fetched until
the operator names it explicitly with `--allow-host example.com`. Redirects
are checked under the same policy, and local/private/reserved targets remain
blocked.

For a private RPC, pass `--rpc-url`. This changes only the read endpoint:

```bash
actp erc8004 inventory --network base-sepolia --agent-id 6732 \
  --rpc-url "$BASE_SEPOLIA_RPC" --output erc8004-inventory.json
```

## 2. Generate the dry-run ledger

```bash
actp erc8004 migration-plan \
  --input erc8004-inventory.json \
  --output erc8004-migration-plan.json
```

Each record includes content hashes, artifact classification, the proposed
registration JSON, the unchanged observed registry wallet, whether that
wallet is currently payment-usable, target verification state, and a human
review field. A zero registry wallet is preserved as evidence but is never
described as a verified payment destination. Status meanings:

- `needs-upload`: the proposed JSON exists only in the ledger;
- `ready`: a supplied target URI resolved to the exact canonical projection;
- `already-registration-v1`: the current artifact is valid and contains the
  exact registry-scoped identity binding;
- `blocked`: input, current content, or target evidence is invalid.

To verify an uploaded target, add `targetAgentURI` and the independently
fetched `targetContent` to that agent's inventory entry, then rerun the plan.
Any changed URI, content hash, wallet, status, or blocker resets review to
`pending`. An `approved` or `rejected` review survives reruns only while all
evidence is unchanged.

## 3. Execution gate

This SDK intentionally has no migration executor. A separate on-chain
operation may be prepared only for records that are `ready`, have a current
human `approved` review, still resolve to the recorded target hash, and still
show the same registry owner and `agentWallet`. Re-read those values
immediately before signing. Each identity requires its own explicit approval;
never infer authorization from another token or registry.
