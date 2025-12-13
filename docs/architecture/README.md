# AGIRAILS SDK Architecture Documentation

Welcome to the AGIRAILS SDK architecture documentation. This directory contains all technical specifications, architecture decision records, and implementation guides for the DX Playground MVP.

---

## 📋 Quick Navigation

### For Implementation Team

🚀 **Start Here**: [Implementation Guide](IMPLEMENTATION_GUIDE.md) - Complete roadmap from ADRs to working code (12-14 week timeline)

### For Architects & Tech Leads

🏛️ **Architecture Decisions**: [ADR Index](decisions/README.md) - All key architectural decisions with context and trade-offs

### For Engineers

📘 **Technical Specs**:
- [Mock State Manager Specification](MOCK_STATE_MANAGER_SPEC.md) - File-based state persistence implementation
- [Adapter Layer Specification](ADAPTER_LAYER_SPEC.md) - Three-Level API type transformation layer

---

## 📚 Document Hierarchy

```
architecture/
│
├── README.md (you are here)               ◄─── Start here for overview
├── IMPLEMENTATION_GUIDE.md                ◄─── Complete implementation roadmap
│
├── decisions/                             ◄─── Architecture Decision Records (ADRs)
│   ├── README.md                          ◄─── ADR index & guidelines
│   ├── ADR-000-template.md                ◄─── Template for new ADRs
│   ├── ADR-001-mock-state-persistence.md  ◄─── File-based state (vs Redis/SQLite)
│   ├── ADR-002-adapter-layer-design.md    ◄─── Type transformation layer
│   ├── ADR-003-cli-sdk-binding.md         ◄─── CLI-SDK integration pattern
│   └── ADR-004-mock-blockchain-emulation.md ◄─── Simplified state machine (vs full EVM)
│
├── MOCK_STATE_MANAGER_SPEC.md             ◄─── Detailed implementation spec
└── ADAPTER_LAYER_SPEC.md                  ◄─── Detailed implementation spec
```

---

## 🎯 What We're Building

### DX Playground MVP Components

1. **SDK with Three-Level API**
   - **Beginner**: Simple `pay()`, `checkStatus()` - for quick prototyping
   - **Intermediate**: Explicit transaction methods - for production use
   - **Advanced**: Direct protocol access - for power users

2. **Mock Mode**
   - Local development without blockchain
   - File-based state persistence (`.actp/mock-state.json`)
   - Time manipulation for testing deadlines
   - Deterministic for reproducible tests

3. **CLI Tool** (`actp`)
   - Zero-setup developer tool
   - Command-line workflows
   - JSON output for scripting

4. **Dashboard** (Phase 2)
   - Visual debugging
   - Event timeline
   - Network simulation controls

---

## 🏗️ Architecture Overview

### High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        USER LAYER                             │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│   │   CLI    │  │   SDK    │  │ Dashboard│                   │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘                   │
│        └─────────────┼─────────────┘                          │
│                      ▼                                        │
│   ┌──────────────────────────────────────────────┐           │
│   │           AGIRAILS SDK                        │           │
│   │  ┌──────────────┐  ┌──────────────┐          │           │
│   │  │ Adapter Layer│  │Protocol Layer│          │           │
│   │  │ (type trans) │  │(Kernel/Escrow)│          │           │
│   │  └──────┬───────┘  └──────┬───────┘          │           │
│   │         └─────────┬────────┘                  │           │
│   │                   ▼                           │           │
│   │  ┌─────────────────────────────────┐         │           │
│   │  │      Runtime Layer               │         │           │
│   │  │ ┌──────────┐  ┌──────────┐      │         │           │
│   │  │ │MockRuntime│  │Ethers RT │      │         │           │
│   │  │ └──────────┘  └──────────┘      │         │           │
│   │  └─────────────────────────────────┘         │           │
│   └──────────────────────────────────────────────┘           │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
            ┌────────────────────┐
            │  .actp/             │
            │  ├─ mock-state.json │  ◄─── Persistent State
            │  └─ config.json     │
            └────────────────────┘
```

### Key Design Decisions

| Decision | Rationale | Impact |
|----------|-----------|--------|
| **File-based state** (ADR-001) | Zero dependencies, simple debugging | ~85ms CLI latency (acceptable) |
| **Adapter layer** (ADR-002) | User-friendly API without changing protocol | ~5ms overhead (negligible) |
| **CLI loads SDK per call** (ADR-003) | No daemon required, simple architecture | ~50ms startup (acceptable for dev tool) |
| **Simplified state machine** (ADR-004) | Fast, deterministic, maintainable | Cannot test gas optimization (use Foundry) |

---

## 📖 Key Documents

### 1. Implementation Guide

**[IMPLEMENTATION_GUIDE.md](IMPLEMENTATION_GUIDE.md)**

**Purpose**: Complete roadmap from architecture decisions to working code

**Audience**: Engineering team implementing SDK, CLI, Dashboard

**Contents**:
- Phase-by-phase implementation plan (12-14 weeks)
- Task breakdowns with time estimates
- Acceptance criteria for each phase
- Risk management
- Team responsibilities
- Success criteria

**When to read**: Before starting implementation

---

### 2. Architecture Decision Records (ADRs)

**[decisions/](decisions/)**

**Purpose**: Document key architectural decisions with context, alternatives, and consequences

**Audience**: Architects, tech leads, senior engineers

**Documents**:
- [ADR-001: Mock State Persistence Strategy](decisions/ADR-001-mock-state-persistence.md)
- [ADR-002: Three-Level API Adapter Layer Design](decisions/ADR-002-adapter-layer-design.md)
- [ADR-003: CLI-SDK Binding Strategy](decisions/ADR-003-cli-sdk-binding.md)
- [ADR-004: Mock Blockchain Emulation Scope](decisions/ADR-004-mock-blockchain-emulation.md)

**When to read**:
- Before making similar decisions
- When challenging existing architecture
- During architecture reviews

---

### 3. Technical Specifications

#### Mock State Manager Specification

**[MOCK_STATE_MANAGER_SPEC.md](MOCK_STATE_MANAGER_SPEC.md)**

**Purpose**: Detailed implementation guide for file-based state persistence

**Audience**: Engineer implementing Phase 1 (Foundation)

**Contents**:
- State schema (JSON format)
- Class interface and implementation
- File locking strategy
- Error handling
- Performance characteristics
- Testing strategy

**When to read**: Before implementing `MockStateManager` class

---

#### Adapter Layer Specification

**[ADAPTER_LAYER_SPEC.md](ADAPTER_LAYER_SPEC.md)**

**Purpose**: Detailed implementation guide for Three-Level API

**Audience**: Engineer implementing Phase 2 (Adapter Layer)

**Contents**:
- Type mapping reference
- BaseAdapter class (parsing utilities)
- BeginnerAdapter class (simple API)
- IntermediateAdapter class (explicit API)
- Integration into ACTPClient
- Testing strategy

**When to read**: Before implementing adapter classes

---

## 🚀 Getting Started

### For New Team Members

1. **Understand the Vision** (30 min):
   - Read [AGIRAILS One Pager](../../../../Research/99.%20Final%20Public%20Papers/Core/AGIRAILS_One_Pager.md)
   - Read [DX Playground Overview](../../../../DX%20Playground/README.md)

2. **Learn the Architecture** (2 hours):
   - Read all 4 ADRs in [decisions/](decisions/)
   - Understand trade-offs and alternatives

3. **Dive into Implementation** (full day):
   - Read [Implementation Guide](IMPLEMENTATION_GUIDE.md)
   - Identify current phase
   - Read relevant technical specification

4. **Start Coding** (Day 2):
   - Set up dev environment
   - Pick a task from current phase
   - Write tests first, then implementation

---

### For Engineers Starting Phase 1 (Foundation)

**Timeline**: Week 1-2

**Prerequisites**:
- ✅ All ADRs approved
- ✅ Technical specs written
- ✅ Implementation guide ready

**Your Checklist**:

1. **Read Documents** (4 hours):
   - [ ] [ADR-001: Mock State Persistence](decisions/ADR-001-mock-state-persistence.md)
   - [ ] [ADR-004: Mock Blockchain Emulation](decisions/ADR-004-mock-blockchain-emulation.md)
   - [ ] [Mock State Manager Specification](MOCK_STATE_MANAGER_SPEC.md)
   - [ ] [Mock Mode Specification §19-20](../../../DX%20Playground/MOCK_MODE_SPECIFICATION.md#19-state-persistence-architecture)

2. **Set Up Environment** (30 min):
   ```bash
   cd "AGIRAILS/SDK and Runtime/sdk"
   npm install
   npm run build
   npm test
   ```

3. **Create Branch** (5 min):
   ```bash
   git checkout -b feature/phase-1-foundation
   ```

4. **Implement MockStateManager** (3-4 days):
   - [ ] Create `src/runtime/MockStateManager.ts`
   - [ ] Write tests: `test/runtime/MockStateManager.test.ts`
   - [ ] Implement methods: `loadState()`, `saveState()`, `withLock()`
   - [ ] Test concurrent access, error recovery
   - [ ] Get code review

5. **Implement MockRuntime** (5-6 days):
   - [ ] Create `src/runtime/MockRuntime.ts`
   - [ ] Write tests: `test/runtime/MockRuntime.test.ts`
   - [ ] Implement transaction handlers
   - [ ] Test full ACTP lifecycle
   - [ ] Get code review

6. **Implement RuntimeFactory** (1 day):
   - [ ] Create `src/runtime/factory.ts`
   - [ ] Write tests: `test/runtime/factory.test.ts`
   - [ ] Get code review

7. **Phase 1 Milestone** (Day 11):
   - [ ] Demo to team
   - [ ] Merge to main
   - [ ] Start Phase 2

---

### For Engineers Starting Phase 2 (Adapter Layer)

**Timeline**: Week 3-4

**Prerequisites**:
- ✅ Phase 1 complete (MockStateManager + MockRuntime working)

**Your Checklist**:

1. **Read Documents** (2 hours):
   - [ ] [ADR-002: Adapter Layer Design](decisions/ADR-002-adapter-layer-design.md)
   - [ ] [Adapter Layer Specification](ADAPTER_LAYER_SPEC.md)
   - [ ] [SDK Three-Level API Specification](../../../DX%20Playground/SDK_THREE_LEVEL_API.md)

2. **Implement BaseAdapter** (2-3 days):
   - [ ] Create `src/adapters/BaseAdapter.ts`
   - [ ] Write tests: `test/adapters/BaseAdapter.test.ts`
   - [ ] Implement parsing methods
   - [ ] Test all edge cases

3. **Implement BeginnerAdapter** (3-4 days):
   - [ ] Create `src/adapters/BeginnerAdapter.ts`
   - [ ] Write tests: `test/adapters/BeginnerAdapter.test.ts`
   - [ ] Implement `pay()` and `checkStatus()`
   - [ ] Test with MockRuntime

4. **Implement IntermediateAdapter** (2-3 days):
   - [ ] Create `src/adapters/IntermediateAdapter.ts`
   - [ ] Write tests: `test/adapters/IntermediateAdapter.test.ts`
   - [ ] Implement all intermediate methods

5. **Update ACTPClient** (2 days):
   - [ ] Update `src/ACTPClient.ts`
   - [ ] Add adapter properties
   - [ ] Write integration tests
   - [ ] Test all three API levels

6. **Phase 2 Milestone** (Day 14):
   - [ ] Demo to team
   - [ ] Merge to main
   - [ ] Start Phase 3

---

## 🔍 How to Use This Documentation

### Scenario: I'm implementing a new feature

1. **Check if ADR exists** for this decision area
   - If yes: Follow the approved approach
   - If no: Consider writing a new ADR

2. **Check if spec exists** for this component
   - If yes: Follow the specification
   - If no: Refer to related specs and extrapolate

3. **Write tests first** (TDD approach)
4. **Implement** until tests pass
5. **Get code review** before merging

---

### Scenario: I disagree with an ADR

1. **Read the ADR carefully** (understand context and alternatives)
2. **Identify specific issue** (what changed? new information?)
3. **Propose alternative** (write counter-ADR or amendment)
4. **Discuss in architecture review** meeting
5. **Update ADR** after decision

---

### Scenario: I found a bug in production

1. **Create bug report** (steps to reproduce, expected vs actual)
2. **Check if ADR assumption was wrong** (did we miss something?)
3. **Propose fix** (hotfix or long-term solution)
4. **Update documentation** (ADR amendment, spec clarification)
5. **Add regression test** (prevent future recurrence)

---

## 📅 Timeline

### Phase 0: Architecture Decisions ✅ COMPLETE
**Duration**: 3 days (Dec 12-14, 2025)
**Status**: All ADRs approved

### Phase 1: Foundation
**Duration**: 2 weeks (Week 1-2)
**Status**: Ready to start
**Deliverables**: MockStateManager, MockRuntime, RuntimeFactory

### Phase 2: Adapter Layer
**Duration**: 2 weeks (Week 3-4)
**Status**: Pending Phase 1 completion
**Deliverables**: BaseAdapter, BeginnerAdapter, IntermediateAdapter

### Phase 3: CLI
**Duration**: 4 weeks (Week 5-8)
**Status**: Pending Phase 2 completion
**Deliverables**: CLI tool with core commands

### Phase 4: Integration & Polish
**Duration**: 2 weeks (Week 9-10)
**Status**: Pending Phase 3 completion
**Deliverables**: End-to-end tests, documentation, bug fixes

### Phase 5: Dashboard (Optional)
**Duration**: 4 weeks (Week 11-14)
**Status**: Deferred to Phase 2 if timeline tight
**Deliverables**: Visual debugging tool

**Total**: 12-14 weeks (excludes Dashboard)

---

## 🎯 Success Criteria

### MVP Definition

The DX Playground MVP is **ready for internal use** when:

- [ ] **SDK with Three-Level API**: All three API levels work identically
- [ ] **Mock Mode**: Full ACTP lifecycle works without blockchain
- [ ] **State Persistence**: CLI commands share state across processes
- [ ] **CLI Tool**: Core commands functional (`init`, `tx`, `mock`, `wallet`)
- [ ] **Performance**: CLI commands complete in <100ms
- [ ] **Tests**: 90%+ coverage for SDK, 80%+ for CLI
- [ ] **Documentation**: Developer can get started in 15 minutes
- [ ] **Error Handling**: All errors have user-friendly messages

### Developer Experience Goals

- ✅ **Zero Setup**: `npm install -g @agirails/cli && actp init` is all you need
- ✅ **Fast Iteration**: Test full workflow in <10 seconds
- ✅ **Clear Errors**: Developer knows exactly what went wrong
- ✅ **Debuggable**: Inspect `.actp/mock-state.json` to understand state
- ✅ **Well-Documented**: Examples for all common use cases

---

## 🤝 Contributing

### Creating a New ADR

1. Copy [ADR-000-template.md](decisions/ADR-000-template.md)
2. Fill in all sections (Context, Decision, Consequences, Alternatives)
3. Post in `#engineering` for review
4. Get approval from Chief Architect
5. Mark as "Accepted" and update [ADR Index](decisions/README.md)

### Updating Documentation

1. Make changes to relevant files
2. Update version number and "Last Updated" date
3. Add entry to "Amendments" section (if ADR)
4. Submit PR with clear description
5. Get review before merging

---

## 📞 Contact

- **Architecture Questions**: Post in `#architecture` Slack channel
- **Implementation Questions**: Post in `#engineering` Slack channel
- **Chief Architect**: Glavni Arhitekta (via Damir)

---

**Maintained by**: AGIRAILS Engineering Team
**Last Updated**: December 12, 2025
**Status**: Ready for Phase 1 Implementation
**Next Review**: After Phase 1 completion (Week 2)
