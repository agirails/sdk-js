# DX Playground Implementation Guide

**Version:** 1.0
**Date:** December 12, 2025
**Status:** Final - Ready for Implementation
**Target Audience:** Engineering team implementing SDK, CLI, and Dashboard

---

## 1. Overview

This guide provides a complete implementation roadmap for the AGIRAILS DX Playground, based on architectural decisions captured in ADRs and technical specifications.

**What we're building**:
- **SDK** with Three-Level API (Beginner, Intermediate, Advanced)
- **Mock Mode** for local development (file-based state persistence)
- **CLI** for command-line workflows (`actp` commands)
- **Dashboard** for visual debugging (optional Phase 2)

**Timeline**: 12-14 weeks to MVP

---

## 2. Architecture Overview

### 2.1 Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                        USER LAYER                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │     CLI      │  │     SDK      │  │  Dashboard   │      │
│  │   (actp)     │  │   (import)   │  │   (webapp)   │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │                │
│         └─────────────────┼─────────────────┘                │
│                           ▼                                  │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              AGIRAILS SDK Core                       │    │
│  │  ┌────────────────┐  ┌────────────────┐             │    │
│  │  │  Adapter Layer │  │ Protocol Layer │             │    │
│  │  │  - Beginner    │  │  - Kernel      │             │    │
│  │  │  - Intermediate│  │  - Escrow      │             │    │
│  │  └────────┬───────┘  └────────┬───────┘             │    │
│  │           └──────────┬─────────┘                     │    │
│  │                      ▼                               │    │
│  │  ┌─────────────────────────────────────────────┐    │    │
│  │  │         Runtime Layer                        │    │    │
│  │  │  ┌──────────────┐  ┌──────────────┐         │    │    │
│  │  │  │ MockRuntime  │  │ EthersRuntime│         │    │    │
│  │  │  │ (file-based) │  │ (blockchain) │         │    │    │
│  │  │  └──────────────┘  └──────────────┘         │    │    │
│  │  └─────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
               ┌───────────────────────┐
               │   .actp/ Directory    │
               │  ┌─────────────────┐  │
               │  │ mock-state.json │  │  ◄─── Persistent State
               │  │ config.json     │  │
               │  └─────────────────┘  │
               └───────────────────────┘
```

### 2.2 Key Architectural Decisions

All decisions documented in **Architecture Decision Records (ADRs)**:

| ADR | Decision | Impact |
|-----|----------|--------|
| [ADR-001](decisions/ADR-001-mock-state-persistence.md) | File-based state persistence | Zero setup, ~85ms CLI latency |
| [ADR-002](decisions/ADR-002-adapter-layer-design.md) | Adapter layer for type transformation | User-friendly API, ~5ms overhead |
| [ADR-003](decisions/ADR-003-cli-sdk-binding.md) | CLI loads SDK per invocation | No daemon required, simple debugging |
| [ADR-004](decisions/ADR-004-mock-blockchain-emulation.md) | Simplified state machine (not full EVM) | Fast, deterministic, ~500 LOC |

### 2.3 Technical Specifications

Detailed implementation specs:

- [Mock State Manager Specification](MOCK_STATE_MANAGER_SPEC.md)
- [Adapter Layer Specification](ADAPTER_LAYER_SPEC.md)
- [Mock Mode Specification](../../../DX%20Playground/MOCK_MODE_SPECIFICATION.md) (v1.2)

---

## 3. Implementation Phases

### Phase 0: Architecture Decisions ✅ COMPLETE

**Duration**: 3 days (Dec 12-14, 2025)
**Status**: All ADRs approved

**Deliverables**:
- ✅ ADR-001: Mock State Persistence
- ✅ ADR-002: Adapter Layer Design
- ✅ ADR-003: CLI-SDK Binding
- ✅ ADR-004: Mock Blockchain Emulation
- ✅ Technical specifications written
- ✅ Implementation guide created (this document)

**Next Step**: Begin Phase 1 implementation

---

### Phase 1: Foundation (Weeks 1-2)

**Goal**: Build core runtime and state management

#### 1.1 MockStateManager

**Location**: `src/runtime/MockStateManager.ts`

**Tasks**:
- [ ] Create `MockStateManager` class
- [ ] Implement `loadState()` with default state
- [ ] Implement `saveState()` with atomic write (temp file + rename)
- [ ] Implement `withLock()` using `proper-lockfile`
- [ ] Implement `reset()`, `exists()` methods
- [ ] Add dependency: `proper-lockfile@^4.1.2`
- [ ] Write unit tests (load, save, lock, concurrent access)
- [ ] Test error recovery (corrupted state, lock timeout)

**Acceptance Criteria**:
- [ ] State loads/saves correctly to `.actp/mock-state.json`
- [ ] File locking prevents concurrent access corruption
- [ ] Stale locks auto-release after 10 seconds
- [ ] Corrupted state throws helpful error message
- [ ] 90%+ test coverage

**Time Estimate**: 3-4 days

**Reference**: [Mock State Manager Specification](MOCK_STATE_MANAGER_SPEC.md), [ADR-001](decisions/ADR-001-mock-state-persistence.md)

---

#### 1.2 MockRuntime

**Location**: `src/runtime/MockRuntime.ts`

**Tasks**:
- [ ] Create `MockRuntime` class implementing `BlockchainRuntime` interface
- [ ] Implement `sendTransaction()` router (create, accept, transition, link, release)
- [ ] Implement `call()` for read-only operations (getTransaction, getBalance)
- [ ] Implement transaction handlers:
  - [ ] `handleCreateTransaction()`
  - [ ] `handleAcceptTransaction()`
  - [ ] `handleTransitionState()`
  - [ ] `handleLinkEscrow()`
  - [ ] `handleReleaseEscrow()`
- [ ] Implement balance tracking (accounts, escrows)
- [ ] Implement event emission
- [ ] Implement time control (`getCurrentTime()`, `advanceTime()`)
- [ ] Write unit tests for each handler
- [ ] Test full transaction lifecycle (happy path)

**Acceptance Criteria**:
- [ ] All 8 ACTP states implemented (INITIATED → SETTLED)
- [ ] State transitions validated (no backwards movement)
- [ ] Balance tracking works (deduct from requester, add to escrow, release to provider)
- [ ] Events emitted for each state change
- [ ] Time manipulation works (`advanceTime()` affects deadlines)
- [ ] 90%+ test coverage

**Time Estimate**: 5-6 days

**Reference**: [ADR-004](decisions/ADR-004-mock-blockchain-emulation.md), [Mock Mode Specification §9](../../../DX%20Playground/MOCK_MODE_SPECIFICATION.md#9-contract-simulation)

---

#### 1.3 RuntimeFactory

**Location**: `src/runtime/factory.ts`

**Tasks**:
- [ ] Create `RuntimeFactory` class
- [ ] Implement `create(mode: 'mock' | 'testnet' | 'mainnet')` factory method
- [ ] Return `MockRuntime` for mock mode
- [ ] Return `EthersRuntime` for testnet/mainnet (placeholder for Phase 2)
- [ ] Write unit tests

**Acceptance Criteria**:
- [ ] Factory returns correct runtime based on mode
- [ ] MockRuntime initialized with MockStateManager

**Time Estimate**: 1 day

---

**Phase 1 Total**: 9-11 days (~2 weeks)

**Phase 1 Milestone**: Core mock runtime working, state persists across invocations

---

### Phase 2: Adapter Layer (Weeks 3-4)

**Goal**: Build user-friendly Three-Level API

#### 2.1 BaseAdapter

**Location**: `src/adapters/BaseAdapter.ts`

**Tasks**:
- [ ] Create `BaseAdapter` abstract class
- [ ] Implement `parseAmount()`:
  - [ ] Parse integers ("100")
  - [ ] Parse decimals ("100.50")
  - [ ] Strip currency suffix ("100 USDC")
  - [ ] Strip $ prefix ("$100")
  - [ ] Reject invalid formats ("abc", "-100")
- [ ] Implement `validateAddress()`:
  - [ ] Use `ethers.utils.isAddress()`
  - [ ] Return clear error messages
- [ ] Implement `parseDeadline()`:
  - [ ] Support Unix timestamps (pass-through)
  - [ ] Support relative time ("+24h", "+7d")
  - [ ] Default to +24h if undefined
- [ ] Implement `getSignerAddress()`
- [ ] Implement `formatAmount()` (BigNumber → "100.00 USDC")
- [ ] Create `ValidationError` class
- [ ] Write unit tests for each method

**Acceptance Criteria**:
- [ ] All parsing methods work with valid inputs
- [ ] Invalid inputs throw `ValidationError` with helpful messages
- [ ] 100% test coverage (small utility functions)

**Time Estimate**: 2-3 days

**Reference**: [Adapter Layer Specification §4](ADAPTER_LAYER_SPEC.md#4-baseadapter-class), [ADR-002](decisions/ADR-002-adapter-layer-design.md)

---

#### 2.2 BeginnerAdapter

**Location**: `src/adapters/BeginnerAdapter.ts`

**Tasks**:
- [ ] Create `BeginnerAdapter` class extending `BaseAdapter`
- [ ] Implement `pay()`:
  - [ ] Validate inputs (address, amount)
  - [ ] Apply smart defaults (deadline, disputeWindow)
  - [ ] Infer requester from signer
  - [ ] Validate not paying self
  - [ ] Validate deadline in future
  - [ ] Call `kernel.createTransaction()`
  - [ ] Return user-friendly result (formatted amounts, ISO dates)
- [ ] Implement `checkStatus()`:
  - [ ] Return current state
  - [ ] Calculate `canAccept`, `canComplete`, `canDispute` flags
- [ ] Write unit tests (mocked kernel)
- [ ] Write integration tests (mock runtime)

**Acceptance Criteria**:
- [ ] `pay()` creates transaction with correct defaults
- [ ] User can pass amount as string or number
- [ ] User can pass deadline as relative time or timestamp
- [ ] Errors have user-friendly messages
- [ ] Integration test covers full happy path

**Time Estimate**: 3-4 days

**Reference**: [Adapter Layer Specification §5](ADAPTER_LAYER_SPEC.md#5-beginneradapter)

---

#### 2.3 IntermediateAdapter

**Location**: `src/adapters/IntermediateAdapter.ts`

**Tasks**:
- [ ] Create `IntermediateAdapter` class extending `BaseAdapter`
- [ ] Implement `createTransaction()` (more explicit than `pay()`)
- [ ] Implement `acceptTransaction()`
- [ ] Implement `completeTransaction()`
- [ ] Implement `releaseEscrow()`
- [ ] Implement `getEscrowBalance()`
- [ ] Write unit tests
- [ ] Write integration tests

**Acceptance Criteria**:
- [ ] All methods work with mock runtime
- [ ] Methods accept both string and BigNumber for amounts
- [ ] Methods support relative deadlines

**Time Estimate**: 2-3 days

**Reference**: [Adapter Layer Specification §6](ADAPTER_LAYER_SPEC.md#6-intermediateadapter)

---

#### 2.4 ACTPClient Integration

**Location**: `src/ACTPClient.ts`

**Tasks**:
- [ ] Update `ACTPClient` class
- [ ] Add `beginner: BeginnerAdapter` property
- [ ] Add `intermediate: IntermediateAdapter` property
- [ ] Initialize adapters in constructor
- [ ] Add `advanced` getter (alias for kernel/escrow/events)
- [ ] Update `create()` factory to instantiate adapters
- [ ] Write integration tests (all three API levels)

**Acceptance Criteria**:
- [ ] `client.beginner.pay()` works
- [ ] `client.intermediate.createTransaction()` works
- [ ] `client.advanced.kernel.createTransaction()` works (unchanged)
- [ ] All three APIs create identical transactions

**Time Estimate**: 2 days

---

**Phase 2 Total**: 9-12 days (~2 weeks)

**Phase 2 Milestone**: Three-Level API fully functional, user-friendly error messages

---

### Phase 3: CLI (Weeks 5-8)

**Goal**: Build command-line interface with SDK integration

#### 3.1 CLI Package Structure

**Location**: `cli/`

**Tasks**:
- [ ] Create `@agirails/cli` package
- [ ] Set up TypeScript build (tsconfig.json)
- [ ] Add dependencies:
  - [ ] `@agirails/sdk` (local link during dev)
  - [ ] `commander@^11.0.0`
  - [ ] `chalk@^5.0.0`
  - [ ] `ora@^6.0.0`
  - [ ] `enquirer@^2.4.0`
- [ ] Set up bin entry point (`bin: { "actp": "./dist/index.js" }`)
- [ ] Create directory structure (commands/, utils/)

**Time Estimate**: 1 day

---

#### 3.2 SDK Client Factory

**Location**: `cli/src/utils/sdk-client.ts`

**Tasks**:
- [ ] Create `loadConfig()` function (read `.actp/config.json`)
- [ ] Create `createSDKClient()` function:
  - [ ] Load config
  - [ ] Validate mode-specific requirements (privateKey for testnet)
  - [ ] Initialize SDK client
  - [ ] Return client
- [ ] Create `formatSDKError()` function:
  - [ ] Map SDK errors to user-friendly CLI messages
  - [ ] Use chalk for colored output
- [ ] Write unit tests

**Acceptance Criteria**:
- [ ] `createSDKClient()` works with mock mode
- [ ] `createSDKClient()` throws helpful error if `.actp/config.json` missing
- [ ] Errors formatted with colors

**Time Estimate**: 2 days

**Reference**: [ADR-003](decisions/ADR-003-cli-sdk-binding.md), [Mock Mode Specification §20](../../../DX%20Playground/MOCK_MODE_SPECIFICATION.md#20-cli-integration-pattern)

---

#### 3.3 Core Commands

**Commands to implement**:

1. **`actp init`** (`cli/src/commands/init.ts`)
   - [ ] Interactive prompts (network, mode)
   - [ ] Create `.actp/` directory
   - [ ] Write `config.json`
   - [ ] Write initial `mock-state.json`
   - [ ] Add `.actp/` to `.gitignore`

2. **`actp tx create`** (`cli/src/commands/tx/create.ts`)
   - [ ] Parse options (--to, --amount, --deadline)
   - [ ] Call `client.beginner.pay()`
   - [ ] Output result (table or JSON)
   - [ ] Handle errors gracefully

3. **`actp tx show <id>`** (`cli/src/commands/tx/show.ts`)
   - [ ] Load state
   - [ ] Fetch transaction
   - [ ] Display formatted output

4. **`actp tx list`** (`cli/src/commands/tx/list.ts`)
   - [ ] Load state
   - [ ] List all transactions
   - [ ] Filter by state (optional --state flag)

5. **`actp mock start`** (`cli/src/commands/mock/start.ts`)
   - [ ] Initialize mock mode
   - [ ] Set initial balance
   - [ ] Output success message

6. **`actp mock time <delta>`** (`cli/src/commands/mock/time.ts`)
   - [ ] Parse delta ("+1h", "+7d")
   - [ ] Advance time in state
   - [ ] Output new time

7. **`actp mock reset`** (`cli/src/commands/mock/reset.ts`)
   - [ ] Confirm with user
   - [ ] Call `stateManager.reset()`

8. **`actp wallet status`** (`cli/src/commands/wallet/status.ts`)
   - [ ] Show current address
   - [ ] Show USDC balance
   - [ ] Show locked in escrow

**Time Estimate**: 10-12 days (1-2 days per command)

**Acceptance Criteria**:
- [ ] All commands work with mock mode
- [ ] Commands output formatted text (not raw JSON by default)
- [ ] Commands support `--json` flag for scripting
- [ ] Errors show helpful messages
- [ ] Spinners for async operations

---

#### 3.4 CLI Testing

**Tasks**:
- [ ] Write integration tests (spawn CLI process, check output)
- [ ] Test state persistence across commands
- [ ] Test concurrent access (two CLI calls simultaneously)
- [ ] Test error scenarios (corrupted state, invalid input)

**Time Estimate**: 3 days

---

**Phase 3 Total**: 16-18 days (~4 weeks)

**Phase 3 Milestone**: CLI fully functional, developers can use `actp` for workflows

---

### Phase 4: Integration & Polish (Weeks 9-10)

**Goal**: End-to-end testing, documentation, bug fixes

#### 4.1 Integration Testing

**Tasks**:
- [ ] Write end-to-end tests (CLI → SDK → MockRuntime → State)
- [ ] Test full transaction lifecycle via CLI
- [ ] Test time manipulation via CLI
- [ ] Test concurrent CLI usage (file locking)
- [ ] Test error recovery (corrupted state, disk full)
- [ ] Performance benchmarks (measure ~85ms target)

**Time Estimate**: 4 days

---

#### 4.2 Documentation

**Tasks**:
- [ ] Write SDK README (Quick Start, API Reference, Examples)
- [ ] Write CLI README (Installation, Commands, Workflows)
- [ ] Write "Choosing Your API Level" guide
- [ ] Write "Testing with Mock Mode" guide
- [ ] Add JSDoc comments to all public APIs
- [ ] Generate API docs (TypeDoc or similar)
- [ ] Create video tutorial (3-5 minutes)

**Time Estimate**: 3 days

---

#### 4.3 Developer Experience

**Tasks**:
- [ ] Add `--help` text to all CLI commands
- [ ] Add examples in `--help` output
- [ ] Improve error messages based on user feedback
- [ ] Add `actp doctor` command (check for common issues)
- [ ] Add shell completion (bash, zsh)

**Time Estimate**: 2 days

---

#### 4.4 Bug Fixes & Refinement

**Tasks**:
- [ ] Fix bugs found during integration testing
- [ ] Optimize performance (if >100ms CLI latency)
- [ ] Refactor code for clarity
- [ ] Add missing edge case tests

**Time Estimate**: 3 days

---

**Phase 4 Total**: 12 days (~2 weeks)

**Phase 4 Milestone**: MVP ready for internal use by engineering team

---

### Phase 5: Dashboard (Optional, Weeks 11-14)

**Goal**: Visual debugging tool (web app)

**Status**: Optional for MVP, defer to Phase 2 if timeline tight

**Tasks**:
- [ ] Next.js app setup
- [ ] File watcher for `.actp/mock-state.json`
- [ ] Transaction list view
- [ ] Transaction detail view
- [ ] Time control UI (play, pause, advance)
- [ ] Network simulation controls
- [ ] Event timeline visualization

**Time Estimate**: 4 weeks (full Phase 2 feature)

**Reference**: [Mock Mode Specification §12](../../../DX%20Playground/MOCK_MODE_SPECIFICATION.md#12-integration-with-playground)

---

## 4. Implementation Checklist

### 4.1 Phase 1: Foundation ✅ COMPLETE

- [x] ADR-001: Mock State Persistence
- [x] ADR-002: Adapter Layer Design
- [x] ADR-003: CLI-SDK Binding
- [x] ADR-004: Mock Blockchain Emulation
- [x] Technical specifications written
- [ ] MockStateManager implemented
- [ ] MockRuntime implemented
- [ ] RuntimeFactory implemented

### 4.2 Phase 2: Adapter Layer

- [ ] BaseAdapter implemented
- [ ] BeginnerAdapter implemented
- [ ] IntermediateAdapter implemented
- [ ] ACTPClient updated

### 4.3 Phase 3: CLI

- [ ] CLI package structure
- [ ] SDK client factory
- [ ] Core commands (init, tx, mock, wallet)
- [ ] CLI testing

### 4.4 Phase 4: Integration

- [ ] End-to-end tests
- [ ] Documentation
- [ ] Developer experience improvements
- [ ] Bug fixes

### 4.5 Phase 5: Dashboard (Optional)

- [ ] Dashboard MVP

---

## 5. Success Criteria

### 5.1 Technical

- [ ] **State Persistence**: CLI commands share state across processes
- [ ] **Three-Level API**: All three API levels work identically
- [ ] **Mock Runtime**: Full ACTP lifecycle works in mock mode
- [ ] **Performance**: CLI commands complete in <100ms
- [ ] **Test Coverage**: 90%+ for SDK, 80%+ for CLI
- [ ] **Error Handling**: All errors have user-friendly messages

### 5.2 Developer Experience

- [ ] **Zero Setup**: `npm install -g @agirails/cli && actp init` is all you need
- [ ] **Fast Iteration**: Developer can test full workflow in <10 seconds
- [ ] **Clear Errors**: Developer knows exactly what went wrong
- [ ] **Documentation**: Developer can get started in 15 minutes
- [ ] **Debuggable**: Developer can inspect `.actp/mock-state.json` to understand state

### 5.3 Deliverables

- [ ] `@agirails/sdk` package (published to npm)
- [ ] `@agirails/cli` package (published to npm)
- [ ] Documentation website (docs.agirails.io)
- [ ] Video tutorial (YouTube)
- [ ] Sample projects (GitHub)

---

## 6. Risk Management

### 6.1 Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **File locking issues on Windows** | Medium | High | Test on Windows early, use `proper-lockfile` (cross-platform) |
| **State file corruption** | Low | High | Atomic writes (temp file + rename), error recovery guide |
| **Performance <100ms target** | Medium | Medium | Benchmark early, optimize state load/save if needed |
| **Adapter layer too complex** | Low | Medium | Keep adapters thin (just type transformation) |

### 6.2 Schedule Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Phase 1 takes longer than 2 weeks** | Medium | High | Start Phase 1 immediately, have clear acceptance criteria |
| **CLI testing uncovers major bugs** | Medium | Medium | Test CLI early (Week 5), leave buffer in Phase 4 |
| **Documentation takes longer than expected** | High | Low | Start documentation in parallel with implementation |

### 6.3 Dependency Risks

| Dependency | Risk | Mitigation |
|------------|------|------------|
| `proper-lockfile` | Unmaintained library | Battle-tested (used by npm), fork if needed |
| `ethers.js` | Breaking changes in v6 | Pin to v5.7.2, delay v6 upgrade |
| Node.js | Version compatibility | Support Node >=16.0.0, test on multiple versions |

---

## 7. Team Responsibilities

### 7.1 Roles

| Role | Responsible For | Time Commitment |
|------|-----------------|-----------------|
| **Chief Architect** | ADR approval, architecture review | 4-8 hours/week |
| **SDK Engineer** | Phase 1 + Phase 2 implementation | Full-time (8 weeks) |
| **CLI Engineer** | Phase 3 implementation | Full-time (4 weeks) |
| **QA Engineer** | Phase 4 testing | Full-time (2 weeks) |
| **Tech Writer** | Phase 4 documentation | Part-time (1 week) |

### 7.2 Communication

- **Daily standups**: 15 minutes, async in Slack
- **Weekly architecture review**: 1 hour, Zoom
- **Phase milestones**: Demo to team, collect feedback

---

## 8. Getting Started

### 8.1 For SDK Engineer (Phase 1)

1. **Read ADRs** (1 hour):
   - [ADR-001](decisions/ADR-001-mock-state-persistence.md)
   - [ADR-004](decisions/ADR-004-mock-blockchain-emulation.md)

2. **Read Specs** (2 hours):
   - [Mock State Manager Specification](MOCK_STATE_MANAGER_SPEC.md)
   - [Mock Mode Specification §9](../../../DX%20Playground/MOCK_MODE_SPECIFICATION.md#9-contract-simulation)

3. **Set Up Dev Environment** (30 minutes):
   ```bash
   cd "AGIRAILS/SDK and Runtime/sdk"
   npm install
   npm run build
   npm test
   ```

4. **Create Branch** (5 minutes):
   ```bash
   git checkout -b feature/phase-1-foundation
   ```

5. **Start Coding** (Day 1):
   - Create `src/runtime/MockStateManager.ts`
   - Write first test: "loadState() returns default state if file does not exist"
   - Implement until test passes

### 8.2 For CLI Engineer (Phase 3)

1. **Wait for Phase 2 completion** (SDK must be ready first)

2. **Read ADR-003** (30 minutes):
   - [ADR-003](decisions/ADR-003-cli-sdk-binding.md)

3. **Set Up Dev Environment** (30 minutes):
   ```bash
   cd "AGIRAILS/SDK and Runtime/sdk"
   mkdir -p cli/src
   cd cli
   npm init -y
   npm install @agirails/sdk commander chalk ora enquirer
   npm install -D @types/node typescript
   ```

4. **Create First Command** (Day 1):
   - Implement `actp init`
   - Test locally: `node dist/index.js init`

---

## 9. Resources

### 9.1 Documentation

- [Mock Mode Specification v1.2](../../../DX%20Playground/MOCK_MODE_SPECIFICATION.md)
- [SDK Three-Level API Specification](../../../DX%20Playground/SDK_THREE_LEVEL_API.md)
- [CLI Specification](../../../DX%20Playground/CLI_SPECIFICATION.md)
- [Mock State Manager Specification](MOCK_STATE_MANAGER_SPEC.md)
- [Adapter Layer Specification](ADAPTER_LAYER_SPEC.md)

### 9.2 ADRs

- [ADR-001: Mock State Persistence](decisions/ADR-001-mock-state-persistence.md)
- [ADR-002: Adapter Layer Design](decisions/ADR-002-adapter-layer-design.md)
- [ADR-003: CLI-SDK Binding](decisions/ADR-003-cli-sdk-binding.md)
- [ADR-004: Mock Blockchain Emulation](decisions/ADR-004-mock-blockchain-emulation.md)

### 9.3 External References

- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) - File locking library
- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [Chalk](https://github.com/chalk/chalk) - Terminal styling
- [ethers.js v5 Docs](https://docs.ethers.org/v5/) - Ethereum library

---

## 10. Summary

**Total Timeline**: 12-14 weeks (excludes Dashboard)

**Critical Path**:
1. Phase 1: MockStateManager + MockRuntime (2 weeks)
2. Phase 2: Adapter Layer (2 weeks)
3. Phase 3: CLI (4 weeks)
4. Phase 4: Integration & Polish (2 weeks)

**MVP Definition**:
- SDK with Three-Level API ✅
- Mock Mode with file-based state ✅
- CLI with core commands ✅
- Documentation ✅
- Tests (90%+ coverage) ✅

**Next Steps**:
1. ✅ Architecture decisions approved (Phase 0 complete)
2. → Start Phase 1: Implement MockStateManager (Week 1, Day 1)

---

**Maintained by**: AGIRAILS Engineering Team
**Last Updated**: December 12, 2025
**Status**: Ready for Implementation
