import { Wallet, providers, Signer, BigNumber } from 'ethers';
import { ACTPKernel } from './protocol/ACTPKernel';
import { EscrowVault } from './protocol/EscrowVault';
import { EventMonitor } from './protocol/EventMonitor';
import { ProofGenerator } from './protocol/ProofGenerator';
import { MessageSigner } from './protocol/MessageSigner';
import { NetworkConfig, getNetwork } from './config/networks';
import { NetworkError, ValidationError } from './errors';
import { EASHelper, EASConfig } from './protocol/EASHelper';

/**
 * ACTPClient configuration
 */
export interface ACTPClientConfig {
  network: 'base-sepolia' | 'base-mainnet';
  privateKey?: string;
  signer?: Signer;
  provider?: providers.Provider;
  rpcUrl?: string;
  contracts?: {
    actpKernel?: string;
    escrowVault?: string;
    usdc?: string;
  };
  gasSettings?: {
    maxFeePerGas?: BigNumber;
    maxPriorityFeePerGas?: BigNumber;
  };
  eas?: EASConfig;
}

/**
 * ACTPClient - Main entry point for ACTP SDK
 *
 * Example:
 * ```typescript
 * const client = await ACTPClient.create({
 *   network: 'base-sepolia',
 *   privateKey: process.env.PRIVATE_KEY
 * });
 *
 * const txId = await client.kernel.createTransaction({...});
 * ```
 */
export class ACTPClient {
  public readonly kernel: ACTPKernel;
  public readonly escrow: EscrowVault;
  public readonly events: EventMonitor;
  public readonly proofGenerator: ProofGenerator;
  public readonly messageSigner: MessageSigner;
  public readonly eas?: EASHelper;

  private readonly provider: providers.Provider;
  private readonly signer: Signer;
  private readonly networkConfig: NetworkConfig;

  /**
   * Private constructor - use ACTPClient.create() instead
   */
  private constructor(config: ACTPClientConfig) {
    // Validate config
    this.validateConfig(config);

    // Get network configuration (already cloned in getNetwork)
    this.networkConfig = getNetwork(config.network);

    // Apply overrides immutably (create new objects, don't mutate)
    if (config.contracts) {
      this.networkConfig = {
        ...this.networkConfig,
        contracts: {
          ...this.networkConfig.contracts,
          ...config.contracts
        }
      };
    }

    // Apply gas settings overrides
    if (config.gasSettings) {
      this.networkConfig = {
        ...this.networkConfig,
        gasSettings: {
          ...this.networkConfig.gasSettings,
          ...config.gasSettings
        }
      };
    }

    // Freeze config to prevent accidental mutation
    Object.freeze(this.networkConfig.contracts);
    Object.freeze(this.networkConfig.gasSettings);
    Object.freeze(this.networkConfig);

    // Setup provider
    if (config.provider) {
      this.provider = config.provider;
    } else {
      const rpcUrl = config.rpcUrl || this.networkConfig.rpcUrl;
      this.provider = new providers.JsonRpcProvider(rpcUrl, this.networkConfig.chainId);
    }

    // Setup signer
    if (config.signer) {
      this.signer = config.signer;
    } else if (config.privateKey) {
      this.signer = new Wallet(config.privateKey, this.provider);
    } else {
      // Attempt to derive signer from provider if possible
      const jsonRpcProvider = this.provider as providers.JsonRpcProvider;
      if (jsonRpcProvider.getSigner) {
        this.signer = jsonRpcProvider.getSigner();
      } else {
        throw new ValidationError('signer', 'Either privateKey or signer must be provided');
      }
    }

    // Initialize protocol modules
    this.kernel = new ACTPKernel(
      this.networkConfig.contracts.actpKernel,
      this.signer,
      this.networkConfig.gasSettings
    );

    this.escrow = new EscrowVault(
      this.networkConfig.contracts.escrowVault,
      this.signer,
      this.networkConfig.gasSettings
    );

    this.events = new EventMonitor(
      this.kernel['contract'], // Access private contract field
      this.escrow['contract']
    );

    this.proofGenerator = new ProofGenerator();

    this.messageSigner = new MessageSigner(this.signer);

    if (config.eas) {
      this.eas = new EASHelper(this.signer, config.eas);
    }
  }

  /**
   * Create and initialize ACTPClient (async factory pattern)
   * Ensures all async components (EIP-712 domain) are ready before returning
   */
  static async create(config: ACTPClientConfig): Promise<ACTPClient> {
    const client = new ACTPClient(config);
    
    // Initialize EIP-712 domain for message signing
    await client.messageSigner.initDomain(client.networkConfig.contracts.actpKernel);
    
    return client;
  }

  /**
   * @deprecated Use ACTPClient.create() instead
   * Initialize async components (must be called after construction)
   */
  async initialize(): Promise<void> {
    await this.messageSigner.initDomain(this.networkConfig.contracts.actpKernel);
  }

  /**
   * Get signer address
   */
  async getAddress(): Promise<string> {
    return await this.signer.getAddress();
  }

  /**
   * Get network configuration
   */
  getNetworkConfig(): NetworkConfig {
    return this.networkConfig;
  }

  /**
   * Get provider
   */
  getProvider(): providers.Provider {
    return this.provider;
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    try {
      return await this.provider.getBlockNumber();
    } catch (error: any) {
      throw new NetworkError(this.networkConfig.name, error.message);
    }
  }

  /**
   * Get gas price
   */
  async getGasPrice() {
    try {
      return await this.provider.getGasPrice();
    } catch (error: any) {
      throw new NetworkError(this.networkConfig.name, error.message);
    }
  }

  /**
   * Validate configuration
   */
  private validateConfig(config: ACTPClientConfig): void {
    if (!config.network) {
      throw new ValidationError('network', 'Network is required');
    }

    if (!config.privateKey && !config.signer && !config.provider) {
      throw new ValidationError('auth', 'Provide either privateKey, signer, or provider with signer access');
    }
  }
}
