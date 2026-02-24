import { TestJob } from '../types';

export const securityAuditJob: TestJob = {
  serviceType: 'security-audit',
  title: 'Solidity contract with 1 obvious vulnerability',
  input: {
    code: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SimpleVault {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    // VULNERABILITY: Reentrancy — external call before state update
    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
        balances[msg.sender] -= amount;
    }
}`,
    language: 'solidity',
  },
  expectedDeliverable: 'Security audit report with vulnerability classification',
};
