/**
 * CLI Configuration Management
 *
 * Handles reading/writing CLI configuration stored in .actp/config.json.
 * Supports mock, testnet, and mainnet modes with mode-specific validation.
 *
 * @module cli/utils/config
 */
/**
 * CLI operating mode
 */
export type CLIMode = 'mock' | 'testnet' | 'mainnet';
/**
 * CLI configuration stored in .actp/config.json
 */
export interface CLIConfig {
    /** Operating mode */
    mode: CLIMode;
    /** User's Ethereum address */
    address: string;
    /** Optional: Private key for testnet/mainnet mode */
    privateKey?: string;
    /** Optional: RPC URL override */
    rpcUrl?: string;
    /** Configuration version for migrations */
    version: string;
}
/**
 * Default configuration values
 */
export declare const CONFIG_DEFAULTS: CLIConfig;
/**
 * Get the .actp directory path
 */
export declare function getActpDir(projectRoot?: string): string;
/**
 * Get the config.json path
 */
export declare function getConfigPath(projectRoot?: string): string;
/**
 * Check if ACTP is initialized in the current directory
 */
export declare function isInitialized(projectRoot?: string): boolean;
/**
 * Load configuration from disk
 *
 * SECURITY: Warns about private key storage in config file.
 *
 * @throws Error if config doesn't exist or is corrupted
 */
export declare function loadConfig(projectRoot?: string): CLIConfig;
/**
 * Save configuration to disk
 *
 * Creates .actp directory if it doesn't exist.
 * Uses atomic write (temp file + rename).
 */
export declare function saveConfig(config: CLIConfig, projectRoot?: string): void;
/**
 * Update specific config values
 *
 * Loads existing config, merges updates, and saves.
 */
export declare function updateConfig(updates: Partial<CLIConfig>, projectRoot?: string): CLIConfig;
/**
 * Get a specific config value
 */
export declare function getConfigValue<K extends keyof CLIConfig>(key: K, projectRoot?: string): CLIConfig[K];
/**
 * Set a specific config value
 */
export declare function setConfigValue<K extends keyof CLIConfig>(key: K, value: CLIConfig[K], projectRoot?: string): void;
/**
 * Validate Ethereum address format
 */
export declare function validateAddress(address: string): boolean;
/**
 * Validate private key format (64 hex chars, optionally with 0x prefix)
 */
export declare function validatePrivateKey(key: string): boolean;
/**
 * Validate config for the specified mode
 *
 * @throws Error if config is invalid for the mode
 */
export declare function validateConfigForMode(config: CLIConfig): void;
/**
 * Add .actp to .gitignore if not already present
 */
export declare function addToGitignore(projectRoot?: string): void;
//# sourceMappingURL=config.d.ts.map