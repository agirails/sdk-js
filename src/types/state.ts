/**
 * ACTP State Machine
 * Reference: Yellow Paper §3.2
 */

export enum State {
  INITIATED = 0,
  QUOTED = 1,
  COMMITTED = 2,
  IN_PROGRESS = 3,
  DELIVERED = 4,
  SETTLED = 5,
  DISPUTED = 6,
  CANCELLED = 7
}

export class StateMachine {
  /**
   * Valid state transitions per Yellow Paper §3.2.2
   */
  private static readonly TRANSITIONS: Record<State, State[]> = {
    [State.INITIATED]: [State.QUOTED, State.COMMITTED, State.CANCELLED], // Allow direct INITIATED → COMMITTED (AIP-3)
    [State.QUOTED]: [State.COMMITTED, State.CANCELLED],
    [State.COMMITTED]: [State.IN_PROGRESS, State.CANCELLED],
    [State.IN_PROGRESS]: [State.DELIVERED, State.DISPUTED],
    [State.DELIVERED]: [State.SETTLED, State.DISPUTED],
    [State.DISPUTED]: [State.SETTLED, State.CANCELLED],
    [State.SETTLED]: [], // Terminal state
    [State.CANCELLED]: [] // Terminal state
  };

  /**
   * Check if state transition is valid
   */
  static isValidTransition(from: State, to: State): boolean {
    return this.TRANSITIONS[from]?.includes(to) ?? false;
  }

  /**
   * Check if state is terminal (no further transitions)
   */
  static isTerminalState(state: State): boolean {
    return state === State.SETTLED || state === State.CANCELLED;
  }

  /**
   * Get human-readable state name
   */
  static getStateName(state: State): string {
    return State[state];
  }

  /**
   * Get all valid next states from current state
   */
  static getNextValidStates(currentState: State): State[] {
    return this.TRANSITIONS[currentState] || [];
  }

  /**
   * Validate state transition or throw error
   */
  static validateTransition(from: State, to: State): void {
    if (!this.isValidTransition(from, to)) {
      const validStates = this.getNextValidStates(from)
        .map(s => State[s])
        .join(', ');

      throw new Error(
        `Invalid state transition: ${State[from]} → ${State[to]}. ` +
        `Valid transitions from ${State[from]}: ${validStates || 'none (terminal state)'}`
      );
    }
  }
}


