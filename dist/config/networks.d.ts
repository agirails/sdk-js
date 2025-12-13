/**
 * Network configuration
 */
export interface NetworkConfig {
    name: string;
    chainId: number;
    rpcUrl: string;
    blockExplorer: string;
    contracts: {
        actpKernel: string;
        escrowVault: string;
        usdc: string;
        eas: string;
        easSchemaRegistry: string;
        agentRegistry?: string;
    };
    eas: {
        deliverySchemaUID: string;
    };
    gasSettings: {
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
    };
}
/**
 * Base Sepolia Testnet Configuration
 */
export declare const BASE_SEPOLIA: NetworkConfig;
/**
 * Base Mainnet Configuration
 */
export declare const BASE_MAINNET: NetworkConfig;
/**
 * All supported networks
 */
export declare const NETWORKS: Record<string, NetworkConfig>;
/**
 * Get network configuration by name (returns deep clone to prevent mutation)
 */
export declare function getNetwork(network: string): NetworkConfig;
/**
 * Validate network name
 */
export declare function isValidNetwork(network: string): boolean;
/**
 * Validate that contract addresses are deployed (not zero addresses)
 *
 * @throws Error if any contract address is zero (0x000...000)
 */
export declare function validateNetworkConfig(config: NetworkConfig): void;
//# sourceMappingURL=networks.d.ts.map