# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records (ADRs) documenting key architectural choices for the AGIRAILS SDK.

## What is an ADR?

An Architecture Decision Record (ADR) captures an important architectural decision made along with its context and consequences. ADRs help us:

- **Understand why** decisions were made (not just what was decided)
- **Onboard new team members** by providing historical context
- **Avoid repeating mistakes** by documenting failed alternatives
- **Challenge assumptions** when requirements change

## ADR Format

Each ADR follows this structure:

```markdown
# ADR-XXX: Title

## Status
Accepted | Rejected | Superseded | Deprecated

## Context
[Describe the problem, requirements, constraints]

## Decision
[What we decided to do]

## Consequences
[Positive and negative outcomes]

## Alternatives Considered
[Other options and why they were rejected]
```

---

## ADR Index

### Core Architecture

#### ADR-001: Mock State Persistence Strategy
**Status**: Accepted (Dec 12, 2025)
**Summary**: File-based JSON persistence in `.actp/` directory for mock blockchain state
**Key Decision**: Use `proper-lockfile` for atomic operations, not Redis or SQLite (for MVP)
**Impact**: Zero dependencies, simple debugging, ~85ms per CLI command
**Related**: [Mock State Manager Specification](../MOCK_STATE_MANAGER_SPEC.md)

#### ADR-002: Three-Level API Adapter Layer Design
**Status**: Accepted (Dec 12, 2025)
**Summary**: Introduce adapter layer to bridge user-friendly API and protocol-level types
**Key Decision**: Separate adapters (BeginnerAdapter, IntermediateAdapter) instead of overloaded methods
**Impact**: Type transformation (~5ms overhead), smart defaults, consistent validation
**Related**: [Adapter Layer Specification](../ADAPTER_LAYER_SPEC.md)

#### ADR-003: CLI-SDK Binding Strategy
**Status**: Accepted (Dec 12, 2025)
**Summary**: File-based state sharing between CLI processes (not daemon, not embedded runtime)
**Key Decision**: Each CLI command loads SDK, reads `.actp/mock-state.json`, executes, saves
**Impact**: Zero setup, simple debugging, ~85ms latency (acceptable for dev tool)
**Future**: Optional daemon mode for <10ms latency (Phase 2)

#### ADR-004: Mock Blockchain Emulation Scope
**Status**: Accepted (Dec 12, 2025)
**Summary**: Simplified state machine (not full EVM emulator)
**Key Decision**: Emulate transaction lifecycle, time, balances only - no gas, no mempool, no EVM bytecode
**Impact**: Simple implementation (~500 LOC), fast, deterministic
**Limitation**: Cannot test gas optimization (use Foundry for that)

---

## Decision Timeline

```
2025-12-12  ADR-001  Mock State Persistence (file-based)
2025-12-12  ADR-002  Adapter Layer Design (type transformation)
2025-12-12  ADR-003  CLI-SDK Binding (file-based state sharing)
2025-12-12  ADR-004  Mock Blockchain Emulation (simplified state machine)
```

---

## How to Propose a New ADR

1. **Copy Template**:
   ```bash
   cp ADR-000-template.md ADR-XXX-your-title.md
   ```

2. **Fill in Sections**:
   - **Context**: Why are we making this decision? What constraints exist?
   - **Decision**: What did we decide to do?
   - **Consequences**: What are the trade-offs?
   - **Alternatives**: What else did we consider?

3. **Get Review**:
   - Post in `#engineering` Slack channel
   - Discuss in architecture review meeting
   - Get approval from Chief Architect

4. **Mark Status**:
   - Draft → Proposed → Accepted/Rejected
   - Update this README with new entry

---

## ADR Status Definitions

| Status | Meaning |
|--------|---------|
| **Draft** | Being written, not yet proposed |
| **Proposed** | Under review, awaiting decision |
| **Accepted** | Decision approved, implement this |
| **Rejected** | Decision rejected, do NOT implement |
| **Superseded** | Replaced by newer ADR (link to it) |
| **Deprecated** | No longer relevant, kept for history |

---

## Cross-References

### Related Documents

- **Technical Specifications**:
  - [Mock State Manager Specification](../MOCK_STATE_MANAGER_SPEC.md)
  - [Adapter Layer Specification](../ADAPTER_LAYER_SPEC.md)

- **High-Level Specs**:
  - [Mock Mode Specification](../../../../DX%20Playground/MOCK_MODE_SPECIFICATION.md)
  - [SDK Three-Level API Specification](../../../../DX%20Playground/SDK_THREE_LEVEL_API.md)
  - [CLI Specification](../../../../DX%20Playground/CLI_SPECIFICATION.md)

- **Implementation**:
  - [SDK Source Code](../../../src/)
  - [CLI Source Code](../../../cli/src/)

### Decision Dependencies

```
ADR-001 (State Persistence)
  └─> ADR-003 (CLI Binding)
       └─> ADR-004 (Blockchain Emulation)

ADR-002 (Adapter Layer)
  └─> Independent (no dependencies)
```

---

## Frequently Asked Questions

### Why ADRs instead of comments in code?

- **Searchability**: Easier to find all architecture decisions in one place
- **Visibility**: New team members read ADRs during onboarding
- **Longevity**: Code comments get lost during refactoring
- **Context**: ADRs explain "why", code explains "what"

### When should I create an ADR?

Create an ADR when:
- Decision has **long-term impact** (>6 months)
- Decision affects **multiple modules** or teams
- Decision has **significant trade-offs** (performance vs simplicity, etc.)
- Decision is **non-obvious** (team might question it later)

Do NOT create ADR for:
- Trivial choices (variable naming, file organization)
- Temporary hacks (document in code comments instead)
- Reversible decisions (can easily change without major refactor)

### Can ADRs be changed?

Yes, in two ways:

1. **Supersede**: Create new ADR that replaces old one
   - Example: ADR-001 (file-based) → ADR-020 (SQLite-based)
   - Mark ADR-001 as "Superseded by ADR-020"

2. **Amend**: Update existing ADR with new information
   - Add "Amendments" section at bottom
   - Note date and reason for change
   - Do NOT delete original reasoning

### What if we disagree with an ADR?

1. **Open Discussion**: Post in `#engineering` with concerns
2. **Propose Alternative**: Write counter-proposal ADR
3. **Architecture Review**: Discuss both options in meeting
4. **Vote**: Team votes on best approach
5. **Document**: Mark losing ADR as "Rejected" with reason

---

## Template

See [ADR-000-template.md](ADR-000-template.md) for the standard ADR template.

---

**Maintained by**: AGIRAILS Engineering Team
**Last Updated**: December 12, 2025
**Next Review**: After MVP Phase 1 implementation
