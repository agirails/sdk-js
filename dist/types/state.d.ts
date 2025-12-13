/**
 * ACTP State Machine
 * Reference: Yellow Paper §3.2
 */
export declare enum State {
    INITIATED = 0,
    QUOTED = 1,
    COMMITTED = 2,
    IN_PROGRESS = 3,
    DELIVERED = 4,
    SETTLED = 5,
    DISPUTED = 6,
    CANCELLED = 7
}
export declare class StateMachine {
    /**
     * Valid state transitions per Yellow Paper §3.2.2
     *
     * SECURITY FIX (CRITICAL-1): State machine must match ACTPKernel contract exactly
     * Per CLAUDE.md §Architecture Overview - ACTP Protocol State Machine:
     * - COMMITTED can transition to IN_PROGRESS, DELIVERED, or CANCELLED
     * - IN_PROGRESS can transition to DELIVERED or CANCELLED (not DISPUTED)
     * - DISPUTED can only transition to SETTLED (not CANCELLED)
     */
    private static readonly TRANSITIONS;
    /**
     * Check if state transition is valid
     */
    static isValidTransition(from: State, to: State): boolean;
    /**
     * Check if state is terminal (no further transitions)
     */
    static isTerminalState(state: State): boolean;
    /**
     * Get human-readable state name
     */
    static getStateName(state: State): string;
    /**
     * Get all valid next states from current state
     */
    static getNextValidStates(currentState: State): State[];
    /**
     * Validate state transition or throw error
     */
    static validateTransition(from: State, to: State): void;
}
//# sourceMappingURL=state.d.ts.map