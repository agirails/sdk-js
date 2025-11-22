import { State, StateMachine } from '../types/state';

describe('StateMachine', () => {
  describe('isValidTransition', () => {
    it('should allow INITIATED → QUOTED', () => {
      expect(StateMachine.isValidTransition(State.INITIATED, State.QUOTED)).toBe(true);
    });

    it('should allow INITIATED → CANCELLED', () => {
      expect(StateMachine.isValidTransition(State.INITIATED, State.CANCELLED)).toBe(true);
    });

    it('should reject INITIATED → SETTLED', () => {
      expect(StateMachine.isValidTransition(State.INITIATED, State.SETTLED)).toBe(false);
    });

    it('should allow DELIVERED → SETTLED', () => {
      expect(StateMachine.isValidTransition(State.DELIVERED, State.SETTLED)).toBe(true);
    });

    it('should allow DELIVERED → DISPUTED', () => {
      expect(StateMachine.isValidTransition(State.DELIVERED, State.DISPUTED)).toBe(true);
    });

    it('should reject SETTLED → any state (terminal)', () => {
      expect(StateMachine.isValidTransition(State.SETTLED, State.INITIATED)).toBe(false);
      expect(StateMachine.isValidTransition(State.SETTLED, State.DISPUTED)).toBe(false);
    });
  });

  describe('isTerminalState', () => {
    it('should identify SETTLED as terminal', () => {
      expect(StateMachine.isTerminalState(State.SETTLED)).toBe(true);
    });

    it('should identify CANCELLED as terminal', () => {
      expect(StateMachine.isTerminalState(State.CANCELLED)).toBe(true);
    });

    it('should identify IN_PROGRESS as not terminal', () => {
      expect(StateMachine.isTerminalState(State.IN_PROGRESS)).toBe(false);
    });
  });

  describe('getStateName', () => {
    it('should return correct state names', () => {
      expect(StateMachine.getStateName(State.INITIATED)).toBe('INITIATED');
      expect(StateMachine.getStateName(State.SETTLED)).toBe('SETTLED');
    });
  });

  describe('getNextValidStates', () => {
    it('should return valid next states for INITIATED', () => {
      const next = StateMachine.getNextValidStates(State.INITIATED);
      expect(next).toContain(State.QUOTED);
      expect(next).toContain(State.CANCELLED);
      expect(next).toHaveLength(2);
    });

    it('should return empty array for terminal states', () => {
      expect(StateMachine.getNextValidStates(State.SETTLED)).toEqual([]);
      expect(StateMachine.getNextValidStates(State.CANCELLED)).toEqual([]);
    });
  });

  describe('validateTransition', () => {
    it('should not throw for valid transitions', () => {
      expect(() => {
        StateMachine.validateTransition(State.INITIATED, State.QUOTED);
      }).not.toThrow();
    });

    it('should throw for invalid transitions', () => {
      expect(() => {
        StateMachine.validateTransition(State.INITIATED, State.SETTLED);
      }).toThrow('Invalid state transition');
    });
  });
});


