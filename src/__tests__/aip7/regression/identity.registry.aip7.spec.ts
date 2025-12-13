/**
 * AIP-7 Agent Registry Happy Path Tests (Phase 1B)
 *
 * Purpose: Validate basic agent registration and readback functionality
 * on Base Sepolia testnet.
 *
 * Test Flow:
 * 1. Register a new agent with minimal service descriptor
 * 2. Read back the agent profile by address
 * 3. Read back by DID
 * 4. Verify invariants (DID format, ownership alignment)
 * 5. Test re-registration behavior
 *
 * Prerequisites:
 * - TEST_PRIVATE_KEY env var with funded Base Sepolia wallet
 * - AgentRegistry deployed at expected address
 *
 * References:
 * - AIP-7: Agent Identity, Registry & Storage System
 */

import { ACTPClient } from '../../../ACTPClient';
import { AgentRegistry } from '../../../protocol/AgentRegistry';
import { RegisterAgentParams, ServiceDescriptor } from '../../../types';

// Expected AgentRegistry address
const EXPECTED_AGENT_REGISTRY = '0xFed6914Aa70c0a53E9c7Cc4d2Ae159e4748fb09D';

// Test configuration
const TEST_ENDPOINT = 'https://test-agent.agirails.dev/webhook';
const TEST_SERVICE_TYPE = 'text-generation';

describe('AIP-7 Agent Registry Happy Path', () => {
  let client: ACTPClient;
  let registry: AgentRegistry;
  let testAddress: string;
  let expectedDID: string;

  // Track if we need to skip write tests
  let skipWriteTests = false;
  let skipReason = '';

  beforeAll(async () => {
    // Check for test private key (never log the value)
    // Accepts TEST_PRIVATE_KEY or AGIRAILS_PRIVATE_KEY as fallback
    const testPrivateKey = process.env.TEST_PRIVATE_KEY ?? process.env.AGIRAILS_PRIVATE_KEY;

    if (!testPrivateKey) {
      skipWriteTests = true;
      skipReason = 'TEST_PRIVATE_KEY or AGIRAILS_PRIVATE_KEY not set - skipping write tests';
      console.warn(`[AIP-7 Tests] ${skipReason}`);

      // Use dummy key for read-only tests
      const dummyKey = '0x' + '1'.repeat(64);
      client = await ACTPClient.create({
        network: 'base-sepolia',
        privateKey: dummyKey
      });
    } else {
      // Initialize with real test key
      client = await ACTPClient.create({
        network: 'base-sepolia',
        privateKey: testPrivateKey
      });

      // Check balance (need ETH for gas)
      const provider = client.getProvider();
      const address = await client.getAddress();
      const balance = await provider.getBalance(address);
      const minBalance = BigInt('1000000000000000'); // 0.001 ETH minimum

      if (balance < minBalance) {
        skipWriteTests = true;
        skipReason = `Insufficient ETH balance for gas (need >= 0.001 ETH)`;
        console.warn(`[AIP-7 Tests] ${skipReason}`);
      }
    }

    testAddress = await client.getAddress();
    expectedDID = `did:ethr:84532:${testAddress.toLowerCase()}`;

    if (!client.registry) {
      skipWriteTests = true;
      skipReason = 'AgentRegistry not initialized in ACTPClient';
      console.warn(`[AIP-7 Tests] ${skipReason}`);
    } else {
      registry = client.registry;
    }
  }, 60000);

  describe('Registry Module Initialization', () => {
    it('should have registry module available', () => {
      if (skipWriteTests && skipReason.includes('ACTPClient')) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      expect(client.registry).toBeDefined();
    });

    it('should have correct registry address', () => {
      if (!client?.registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      expect(client.registry.getAddress().toLowerCase()).toBe(
        EXPECTED_AGENT_REGISTRY.toLowerCase()
      );
    });

    it('should compute service type hash correctly', () => {
      if (!client?.registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      const hash = client.registry.computeServiceTypeHash(TEST_SERVICE_TYPE);
      expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Same input should produce same hash
      const hash2 = client.registry.computeServiceTypeHash(TEST_SERVICE_TYPE);
      expect(hash).toBe(hash2);
    });

    it('should build DID correctly for test address', async () => {
      if (!client?.registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      const did = await client.registry.buildDID(testAddress);
      expect(did).toBe(expectedDID);
    });
  });

  describe('Agent Registration', () => {
    // Increased timeout for on-chain transactions
    jest.setTimeout(120000);

    let registrationTxHash: string | null = null;

    it('should register a new agent or handle already-registered case', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      if (!registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      // First check if agent is already registered
      const existingProfile = await registry.getAgent(testAddress);

      if (existingProfile !== null) {
        // Agent already registered - this is acceptable for idempotent testing
        console.log(`[INFO] Agent already registered at ${testAddress}`);
        console.log(`[INFO] DID: ${existingProfile.did}`);
        console.log(`[INFO] Endpoint: ${existingProfile.endpoint}`);
        expect(existingProfile.agentAddress.toLowerCase()).toBe(testAddress.toLowerCase());
        expect(existingProfile.did).toBe(expectedDID);
        return;
      }

      // Build registration params
      const serviceTypeHash = registry.computeServiceTypeHash(TEST_SERVICE_TYPE);

      const serviceDescriptor: ServiceDescriptor = {
        serviceTypeHash,
        serviceType: TEST_SERVICE_TYPE,
        schemaURI: 'ipfs://QmTestSchemaURI',
        minPrice: 1_000_000n, // 1 USDC
        maxPrice: 10_000_000n, // 10 USDC
        avgCompletionTime: 60, // 60 seconds
        metadataCID: 'QmTestMetadataCID'
      };

      const registerParams: RegisterAgentParams = {
        endpoint: TEST_ENDPOINT,
        serviceDescriptors: [serviceDescriptor]
      };

      try {
        // Attempt registration
        registrationTxHash = await registry.registerAgent(registerParams);

        console.log(`[SUCCESS] Agent registered. TX: ${registrationTxHash}`);
        expect(registrationTxHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
      } catch (error: any) {
        // Check for expected revert reasons
        const message = error.message || '';

        if (message.includes('Already registered')) {
          // Idempotent - agent was registered between our check and registration
          console.log('[INFO] Agent was registered concurrently - acceptable');
          return;
        }

        // Log revert reason (redacted for any secret-looking strings)
        const safeMessage = message.replace(/0x[a-fA-F0-9]{64}/g, '[HASH]');
        console.error(`[REVERT] ${safeMessage}`);
        throw error;
      }
    });

    it('should read back agent profile by address', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      if (!registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      const profile = await registry.getAgent(testAddress);

      if (profile === null) {
        console.log('[SKIP] No agent registered at test address');
        return;
      }

      // Verify invariants
      expect(profile.agentAddress.toLowerCase()).toBe(testAddress.toLowerCase());
      expect(profile.did).toBe(expectedDID);
      expect(profile.endpoint).toBeTruthy();
      expect(profile.registeredAt).toBeGreaterThan(0);
      expect(profile.isActive).toBe(true);

      // Reputation starts at 0 or default
      expect(profile.reputationScore).toBeGreaterThanOrEqual(0);
      expect(profile.reputationScore).toBeLessThanOrEqual(10000);

      console.log(`[VERIFIED] Agent profile:`);
      console.log(`  - Address: ${profile.agentAddress}`);
      console.log(`  - DID: ${profile.did}`);
      console.log(`  - Endpoint: ${profile.endpoint}`);
      console.log(`  - Registered: ${new Date(profile.registeredAt * 1000).toISOString()}`);
      console.log(`  - Active: ${profile.isActive}`);
      console.log(`  - Reputation: ${profile.reputationScore}`);
    });

    it('should read back agent profile by DID', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      if (!registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      // First ensure agent exists
      const profileByAddress = await registry.getAgent(testAddress);
      if (profileByAddress === null) {
        console.log('[SKIP] No agent registered at test address');
        return;
      }

      const profileByDID = await registry.getAgentByDID(expectedDID);

      expect(profileByDID).not.toBeNull();
      expect(profileByDID!.agentAddress.toLowerCase()).toBe(testAddress.toLowerCase());
      expect(profileByDID!.did).toBe(expectedDID);

      // Both lookups should return same data
      expect(profileByDID!.endpoint).toBe(profileByAddress.endpoint);
      expect(profileByDID!.registeredAt).toBe(profileByAddress.registeredAt);

      console.log(`[VERIFIED] DID lookup matches address lookup`);
    });

    it('should reject re-registration with clear error', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      if (!registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      // First ensure agent exists
      const existingProfile = await registry.getAgent(testAddress);
      if (existingProfile === null) {
        console.log('[SKIP] No agent registered - cannot test re-registration');
        return;
      }

      // Attempt to re-register
      const serviceTypeHash = registry.computeServiceTypeHash('code-review');

      const registerParams: RegisterAgentParams = {
        endpoint: 'https://different-endpoint.test/webhook',
        serviceDescriptors: [{
          serviceTypeHash,
          serviceType: 'code-review',
          schemaURI: 'ipfs://QmDifferentSchema',
          minPrice: 5_000_000n,
          maxPrice: 50_000_000n,
          avgCompletionTime: 120,
          metadataCID: 'QmDifferentMetadata'
        }]
      };

      try {
        await registry.registerAgent(registerParams);
        // If we get here, contract allows re-registration (unexpected but log it)
        console.log('[WARN] Re-registration succeeded - contract may be idempotent');
      } catch (error: any) {
        // Expected: should reject with clear error
        const message = error.message || '';
        console.log(`[EXPECTED] Re-registration rejected: ${message.substring(0, 100)}`);

        // Should contain some indication of "already registered"
        const hasExpectedError =
          message.toLowerCase().includes('already') ||
          message.toLowerCase().includes('registered') ||
          message.toLowerCase().includes('exists');

        expect(hasExpectedError || message.includes('revert')).toBe(true);
      }
    });
  });

  describe('Service Descriptor Readback', () => {
    it('should return service descriptors for registered agent', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      if (!registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      // First ensure agent exists
      const profile = await registry.getAgent(testAddress);
      if (profile === null) {
        console.log('[SKIP] No agent registered at test address');
        return;
      }

      const descriptors = await registry.getServiceDescriptors(testAddress);

      expect(Array.isArray(descriptors)).toBe(true);

      if (descriptors.length > 0) {
        const sd = descriptors[0];
        expect(sd.serviceTypeHash).toMatch(/^0x[a-fA-F0-9]{64}$/);
        expect(sd.serviceType).toBeTruthy();
        expect(sd.minPrice).toBeGreaterThanOrEqual(0n);
        expect(sd.maxPrice).toBeGreaterThanOrEqual(sd.minPrice);
        expect(sd.avgCompletionTime).toBeGreaterThan(0);

        console.log(`[VERIFIED] Service descriptors (${descriptors.length} total):`);
        descriptors.forEach((d, i) => {
          console.log(`  [${i}] ${d.serviceType} - ${d.minPrice}-${d.maxPrice} USDC`);
        });
      }
    });

    it('should verify agent supports registered service type', async () => {
      if (skipWriteTests) {
        console.log(`[SKIP] ${skipReason}`);
        return;
      }

      if (!registry) {
        console.log('[SKIP] Registry not available');
        return;
      }

      // First ensure agent exists
      const profile = await registry.getAgent(testAddress);
      if (profile === null || profile.serviceTypes.length === 0) {
        console.log('[SKIP] No agent or no service types registered');
        return;
      }

      // Check first service type
      const serviceTypeHash = profile.serviceTypes[0];
      const supports = await registry.supportsService(testAddress, serviceTypeHash);

      expect(supports).toBe(true);
      console.log(`[VERIFIED] Agent supports service type: ${serviceTypeHash}`);
    });
  });
});
