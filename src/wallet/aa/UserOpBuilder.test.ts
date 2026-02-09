/**
 * UserOpBuilder Tests
 *
 * Tests cover:
 * - buildInitCode: correct factory+calldata encoding
 * - encodeExecuteBatch: correct ABI encoding of Call[]
 * - buildUserOp: correct struct with/without initCode
 * - getUserOpHash: deterministic hash
 * - signUserOp: CoinbaseSmartWallet SignatureWrapper format
 * - serializeUserOp: hex string conversion
 */

import { ethers } from 'ethers';
import {
  buildInitCode,
  encodeExecuteBatch,
  buildUserOp,
  getUserOpHash,
  signUserOp,
  serializeUserOp,
} from './UserOpBuilder';
import { SmartWalletCall, SMART_WALLET_FACTORY, ENTRYPOINT_V06 } from './constants';

const TEST_SIGNER = '0x' + '11'.repeat(20);
const TEST_SENDER = '0x' + '22'.repeat(20);
const TEST_TARGET = '0x' + '33'.repeat(20);
// Well-known Anvil test key
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('UserOpBuilder', () => {
  describe('buildInitCode()', () => {
    it('should start with factory address', () => {
      const initCode = buildInitCode(TEST_SIGNER);
      expect(initCode.toLowerCase().startsWith(SMART_WALLET_FACTORY.toLowerCase())).toBe(true);
    });

    it('should encode createAccount calldata after factory address', () => {
      const initCode = buildInitCode(TEST_SIGNER);
      // 42 chars for factory address (0x + 40 hex), rest is calldata
      expect(initCode.length).toBeGreaterThan(42);
      // Should contain createAccount selector
      const calldata = '0x' + initCode.slice(42);
      const iface = new ethers.Interface([
        'function createAccount(bytes[] owners, uint256 nonce)',
      ]);
      const decoded = iface.decodeFunctionData('createAccount', calldata);
      expect(decoded[1]).toBe(0n); // default nonce
    });

    it('should use custom nonce', () => {
      const initCode = buildInitCode(TEST_SIGNER, 42n);
      const calldata = '0x' + initCode.slice(42);
      const iface = new ethers.Interface([
        'function createAccount(bytes[] owners, uint256 nonce)',
      ]);
      const decoded = iface.decodeFunctionData('createAccount', calldata);
      expect(decoded[1]).toBe(42n);
    });
  });

  describe('encodeExecuteBatch()', () => {
    it('should encode a single call', () => {
      const calls: SmartWalletCall[] = [
        { target: TEST_TARGET, value: 0n, data: '0x1234' },
      ];
      const encoded = encodeExecuteBatch(calls);
      expect(encoded.startsWith('0x')).toBe(true);

      // Decode and verify
      const iface = new ethers.Interface([
        'function executeBatch((address target, uint256 value, bytes data)[] calls)',
      ]);
      const decoded = iface.decodeFunctionData('executeBatch', encoded);
      expect(decoded[0]).toHaveLength(1);
      expect(decoded[0][0].target.toLowerCase()).toBe(TEST_TARGET.toLowerCase());
    });

    it('should encode multiple calls', () => {
      const calls: SmartWalletCall[] = [
        { target: TEST_TARGET, value: 0n, data: '0x01' },
        { target: TEST_TARGET, value: 100n, data: '0x02' },
        { target: TEST_TARGET, value: 0n, data: '0x03' },
      ];
      const encoded = encodeExecuteBatch(calls);
      const iface = new ethers.Interface([
        'function executeBatch((address target, uint256 value, bytes data)[] calls)',
      ]);
      const decoded = iface.decodeFunctionData('executeBatch', encoded);
      expect(decoded[0]).toHaveLength(3);
    });
  });

  describe('buildUserOp()', () => {
    it('should include initCode for first deploy', () => {
      const userOp = buildUserOp({
        sender: TEST_SENDER,
        nonce: 0n,
        calls: [{ target: TEST_TARGET, value: 0n, data: '0x' }],
        isFirstDeploy: true,
        signerAddress: TEST_SIGNER,
      });

      expect(userOp.initCode).not.toBe('0x');
      expect(userOp.initCode.toLowerCase().startsWith(SMART_WALLET_FACTORY.toLowerCase())).toBe(true);
    });

    it('should have empty initCode for already-deployed wallet', () => {
      const userOp = buildUserOp({
        sender: TEST_SENDER,
        nonce: 5n,
        calls: [{ target: TEST_TARGET, value: 0n, data: '0x' }],
        isFirstDeploy: false,
        signerAddress: TEST_SIGNER,
      });

      expect(userOp.initCode).toBe('0x');
    });

    it('should have placeholder gas values', () => {
      const userOp = buildUserOp({
        sender: TEST_SENDER,
        nonce: 0n,
        calls: [{ target: TEST_TARGET, value: 0n, data: '0x' }],
        isFirstDeploy: false,
        signerAddress: TEST_SIGNER,
      });

      expect(userOp.callGasLimit).toBe(0n);
      expect(userOp.verificationGasLimit).toBe(0n);
      expect(userOp.preVerificationGas).toBe(0n);
      expect(userOp.paymasterAndData).toBe('0x');
      expect(userOp.signature).toBe('0x');
    });
  });

  describe('getUserOpHash()', () => {
    it('should produce deterministic hash', () => {
      const userOp = buildUserOp({
        sender: TEST_SENDER,
        nonce: 0n,
        calls: [{ target: TEST_TARGET, value: 0n, data: '0x1234' }],
        isFirstDeploy: false,
        signerAddress: TEST_SIGNER,
      });
      userOp.callGasLimit = 100000n;
      userOp.verificationGasLimit = 200000n;
      userOp.preVerificationGas = 50000n;
      userOp.maxFeePerGas = 2000000000n;
      userOp.maxPriorityFeePerGas = 1000000000n;

      const hash1 = getUserOpHash(userOp, 84532);
      const hash2 = getUserOpHash(userOp, 84532);

      expect(hash1).toBe(hash2);
      expect(hash1.startsWith('0x')).toBe(true);
      expect(hash1.length).toBe(66); // bytes32
    });

    it('should differ for different chain IDs', () => {
      const userOp = buildUserOp({
        sender: TEST_SENDER,
        nonce: 0n,
        calls: [{ target: TEST_TARGET, value: 0n, data: '0x' }],
        isFirstDeploy: false,
        signerAddress: TEST_SIGNER,
      });

      const hashSepolia = getUserOpHash(userOp, 84532);
      const hashMainnet = getUserOpHash(userOp, 8453);

      expect(hashSepolia).not.toBe(hashMainnet);
    });
  });

  describe('signUserOp()', () => {
    it('should produce a valid SignatureWrapper', async () => {
      const signer = new ethers.Wallet(TEST_KEY);
      const userOp = buildUserOp({
        sender: TEST_SENDER,
        nonce: 0n,
        calls: [{ target: TEST_TARGET, value: 0n, data: '0x' }],
        isFirstDeploy: false,
        signerAddress: signer.address,
      });
      userOp.callGasLimit = 100000n;
      userOp.verificationGasLimit = 200000n;
      userOp.preVerificationGas = 50000n;
      userOp.maxFeePerGas = 2000000000n;
      userOp.maxPriorityFeePerGas = 1000000000n;

      const sig = await signUserOp(userOp, signer, 84532);

      // Should be abi.encode(uint256, bytes)
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const decoded = abiCoder.decode(['uint256', 'bytes'], sig);
      expect(decoded[0]).toBe(0n); // ownerIndex = 0
      expect(ethers.getBytes(decoded[1])).toHaveLength(65); // r(32) + s(32) + v(1)
    });
  });

  describe('serializeUserOp()', () => {
    it('should convert bigints to hex strings', () => {
      const userOp = buildUserOp({
        sender: TEST_SENDER,
        nonce: 5n,
        calls: [{ target: TEST_TARGET, value: 0n, data: '0x' }],
        isFirstDeploy: false,
        signerAddress: TEST_SIGNER,
      });
      userOp.callGasLimit = 100000n;

      const serialized = serializeUserOp(userOp);

      expect(serialized.sender).toBe(TEST_SENDER);
      expect(serialized.nonce).toBe('0x5');
      expect(serialized.callGasLimit).toBe('0x186a0');
    });
  });
});
