// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IEscrowVault {
    function disburse(bytes32 escrowId, address[] calldata recipients, uint256[] calldata amounts) external;
}

contract MockACTPKernel {
    enum State {
        INITIATED,
        QUOTED,
        COMMITTED,
        IN_PROGRESS,
        DELIVERED,
        SETTLED,
        DISPUTED,
        CANCELLED
    }

    struct TransactionData {
        bytes32 transactionId;
        address requester;
        address provider;
        uint256 amount;
        State state;
        uint256 deadline;
        uint256 disputeWindow;
        address escrowContract;
        bytes32 escrowId;
        bytes32 serviceHash;
    }

    mapping(bytes32 => TransactionData) public transactions;
    uint256 private counter;

    event TransactionCreated(bytes32 indexed transactionId, address indexed provider, address indexed requester, uint256 amount);
    event StateTransitioned(bytes32 indexed transactionId, uint8 fromState, uint8 toState);
    event EscrowLinked(bytes32 indexed transactionId, address escrowContract, bytes32 escrowId);
    event EscrowReleased(bytes32 indexed transactionId, uint256 amount);

    function createTransaction(
        address provider,
        address requester,
        uint256 amount,
        uint256 deadline,
        uint256 disputeWindow,
        bytes32 metadata
    ) external returns (bytes32) {
        bytes32 txId = keccak256(abi.encodePacked(block.timestamp, requester, provider, amount, counter++));
        TransactionData storage txData = transactions[txId];
        txData.transactionId = txId;
        txData.requester = requester;
        txData.provider = provider;
        txData.amount = amount;
        txData.state = State.INITIATED;
        txData.deadline = deadline;
        txData.disputeWindow = disputeWindow;
        txData.serviceHash = metadata;

        emit TransactionCreated(txId, provider, requester, amount);
        return txId;
    }

    function transitionState(bytes32 txId, State newState, bytes calldata) external {
        TransactionData storage txData = transactions[txId];
        require(txData.transactionId != bytes32(0), "missing");
        require(_isValidTransition(txData.state, newState), "transition");
        State previous = txData.state;
        txData.state = newState;
        emit StateTransitioned(txId, uint8(previous), uint8(newState));
    }

    function linkEscrow(bytes32 txId, address escrowContract, bytes32 escrowId) external {
        TransactionData storage txData = transactions[txId];
        require(txData.transactionId != bytes32(0), "missing");
        txData.escrowContract = escrowContract;
        txData.escrowId = escrowId;
        emit EscrowLinked(txId, escrowContract, escrowId);
    }

    function releaseEscrow(bytes32 txId) external {
        TransactionData storage txData = transactions[txId];
        require(txData.transactionId != bytes32(0), "missing");
        require(txData.state == State.DELIVERED || txData.state == State.DISPUTED, "not ready");
        txData.state = State.SETTLED;
        emit StateTransitioned(txId, uint8(State.DELIVERED), uint8(State.SETTLED));
        emit EscrowReleased(txId, txData.amount);
    }

    function getEconomicParams() external pure returns (uint16 platformFeeBps, uint16 requesterPenaltyBps, address feeRecipient) {
        return (100, 50, address(0));
    }

    function _isValidTransition(State fromState, State toState) private pure returns (bool) {
        if (fromState == State.INITIATED) return toState == State.QUOTED || toState == State.CANCELLED;
        if (fromState == State.QUOTED) return toState == State.COMMITTED || toState == State.CANCELLED;
        if (fromState == State.COMMITTED) return toState == State.IN_PROGRESS || toState == State.CANCELLED;
        if (fromState == State.IN_PROGRESS) return toState == State.DELIVERED || toState == State.DISPUTED;
        if (fromState == State.DELIVERED) return toState == State.SETTLED || toState == State.DISPUTED;
        if (fromState == State.DISPUTED) return toState == State.SETTLED || toState == State.CANCELLED;
        return false;
    }
}
