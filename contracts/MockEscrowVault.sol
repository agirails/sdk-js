// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract MockEscrowVault {
    struct EscrowInfo {
        address kernel;
        bytes32 txId;
        address token;
        uint256 amount;
        address beneficiary;
        bool released;
    }

    mapping(bytes32 => EscrowInfo) public escrows;

    event EscrowCreated(bytes32 indexed escrowId, address indexed kernel, bytes32 indexed txId, address token, uint256 amount);
    event EscrowReleased(bytes32 indexed escrowId, address[] recipients, uint256[] amounts);

    function createEscrow(
        address kernel,
        bytes32 txId,
        address token,
        uint256 amount,
        address beneficiary
    ) external returns (bytes32) {
        require(kernel != address(0), "kernel");
        require(amount > 0, "amount");

        IERC20(token).transferFrom(msg.sender, address(this), amount);

        EscrowInfo storage info = escrows[txId];
        info.kernel = kernel;
        info.txId = txId;
        info.token = token;
        info.amount = amount;
        info.beneficiary = beneficiary;
        info.released = false;

        emit EscrowCreated(txId, kernel, txId, token, amount);
        return txId;
    }

    function disburse(bytes32 escrowId, address[] calldata recipients, uint256[] calldata amounts) external {
        EscrowInfo storage info = escrows[escrowId];
        require(info.kernel != address(0), "escrow");
        require(msg.sender == info.kernel, "only kernel");
        require(!info.released, "released");
        require(recipients.length == amounts.length, "length");

        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }
        require(total == info.amount, "total");

        info.released = true;
        for (uint256 i = 0; i < recipients.length; i++) {
            IERC20(info.token).transfer(recipients[i], amounts[i]);
        }

        emit EscrowReleased(escrowId, recipients, amounts);
    }
}
