"use strict";
/**
 * ACTP State Machine
 * Reference: Yellow Paper §3.2
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateMachine = exports.State = void 0;
var State;
(function (State) {
    State[State["INITIATED"] = 0] = "INITIATED";
    State[State["QUOTED"] = 1] = "QUOTED";
    State[State["COMMITTED"] = 2] = "COMMITTED";
    State[State["IN_PROGRESS"] = 3] = "IN_PROGRESS";
    State[State["DELIVERED"] = 4] = "DELIVERED";
    State[State["SETTLED"] = 5] = "SETTLED";
    State[State["DISPUTED"] = 6] = "DISPUTED";
    State[State["CANCELLED"] = 7] = "CANCELLED";
})(State || (exports.State = State = {}));
class StateMachine {
    /**
     * Check if state transition is valid
     */
    static isValidTransition(from, to) {
        return this.TRANSITIONS[from]?.includes(to) ?? false;
    }
    /**
     * Check if state is terminal (no further transitions)
     */
    static isTerminalState(state) {
        return state === State.SETTLED || state === State.CANCELLED;
    }
    /**
     * Get human-readable state name
     */
    static getStateName(state) {
        return State[state];
    }
    /**
     * Get all valid next states from current state
     */
    static getNextValidStates(currentState) {
        return this.TRANSITIONS[currentState] || [];
    }
    /**
     * Validate state transition or throw error
     */
    static validateTransition(from, to) {
        if (!this.isValidTransition(from, to)) {
            const validStates = this.getNextValidStates(from)
                .map(s => State[s])
                .join(', ');
            throw new Error(`Invalid state transition: ${State[from]} → ${State[to]}. ` +
                `Valid transitions from ${State[from]}: ${validStates || 'none (terminal state)'}`);
        }
    }
}
exports.StateMachine = StateMachine;
/**
 * Valid state transitions per Yellow Paper §3.2.2
 *
 * SECURITY FIX (CRITICAL-1): State machine must match ACTPKernel contract exactly
 * Per CLAUDE.md §Architecture Overview - ACTP Protocol State Machine:
 * - COMMITTED can transition to IN_PROGRESS, DELIVERED, or CANCELLED
 * - IN_PROGRESS can transition to DELIVERED or CANCELLED (not DISPUTED)
 * - DISPUTED can only transition to SETTLED (not CANCELLED)
 */
StateMachine.TRANSITIONS = {
    [State.INITIATED]: [State.QUOTED, State.COMMITTED, State.CANCELLED], // Allow direct INITIATED → COMMITTED (AIP-3)
    [State.QUOTED]: [State.COMMITTED, State.CANCELLED],
    // SECURITY FIX (CRITICAL-1): Add DELIVERED (can skip IN_PROGRESS)
    [State.COMMITTED]: [State.IN_PROGRESS, State.DELIVERED, State.CANCELLED],
    // SECURITY FIX (CRITICAL-1): Remove DISPUTED, add CANCELLED
    [State.IN_PROGRESS]: [State.DELIVERED, State.CANCELLED],
    [State.DELIVERED]: [State.SETTLED, State.DISPUTED],
    // SECURITY FIX (CRITICAL-1): Remove CANCELLED (disputes resolve to SETTLED only)
    [State.DISPUTED]: [State.SETTLED],
    [State.SETTLED]: [], // Terminal state
    [State.CANCELLED]: [] // Terminal state
};
//# sourceMappingURL=state.js.map