"use strict";
/**
 * CLI Configuration Management
 *
 * Handles reading/writing CLI configuration stored in .actp/config.json.
 * Supports mock, testnet, and mainnet modes with mode-specific validation.
 *
 * @module cli/utils/config
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG_DEFAULTS = void 0;
exports.getActpDir = getActpDir;
exports.getConfigPath = getConfigPath;
exports.isInitialized = isInitialized;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.updateConfig = updateConfig;
exports.getConfigValue = getConfigValue;
exports.setConfigValue = setConfigValue;
exports.validateAddress = validateAddress;
exports.validatePrivateKey = validatePrivateKey;
exports.validateConfigForMode = validateConfigForMode;
exports.addToGitignore = addToGitignore;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Default configuration values
 */
exports.CONFIG_DEFAULTS = {
    mode: 'mock',
    address: '',
    version: '1.0',
};
// ============================================================================
// Paths
// ============================================================================
/**
 * Get the .actp directory path
 */
function getActpDir(projectRoot = process.cwd()) {
    return path.join(projectRoot, '.actp');
}
/**
 * Get the config.json path
 */
function getConfigPath(projectRoot = process.cwd()) {
    return path.join(getActpDir(projectRoot), 'config.json');
}
// ============================================================================
// Config Operations
// ============================================================================
/**
 * Check if ACTP is initialized in the current directory
 */
function isInitialized(projectRoot = process.cwd()) {
    return fs.existsSync(getConfigPath(projectRoot));
}
/**
 * Load configuration from disk
 *
 * SECURITY: Warns about private key storage in config file.
 *
 * @throws Error if config doesn't exist or is corrupted
 */
function loadConfig(projectRoot = process.cwd()) {
    const configPath = getConfigPath(projectRoot);
    if (!fs.existsSync(configPath)) {
        throw new Error('ACTP not initialized in this directory.\n' +
            'Run "actp init" to initialize.');
    }
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        // Validate required fields
        if (!config.mode) {
            throw new Error('Config missing required field: mode');
        }
        if (!config.address) {
            throw new Error('Config missing required field: address');
        }
        // SECURITY FIX (L-2): Warn about private key storage in config file
        if (config.privateKey) {
            console.warn('\x1b[33m%s\x1b[0m', 'WARNING: Private key stored in config file.');
            console.warn('\x1b[33m%s\x1b[0m', '         Consider using ACTP_PRIVATE_KEY environment variable instead.');
            console.warn('\x1b[33m%s\x1b[0m', '         Run: export ACTP_PRIVATE_KEY=<your-key>');
        }
        return config;
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`Config file corrupted: ${configPath}\n` +
                'Delete it manually or run "actp init --force"');
        }
        throw error;
    }
}
/**
 * Save configuration to disk
 *
 * Creates .actp directory if it doesn't exist.
 * Uses atomic write (temp file + rename).
 */
function saveConfig(config, projectRoot = process.cwd()) {
    const actpDir = getActpDir(projectRoot);
    const configPath = getConfigPath(projectRoot);
    const tempPath = `${configPath}.tmp`;
    // Ensure .actp directory exists
    if (!fs.existsSync(actpDir)) {
        fs.mkdirSync(actpDir, { recursive: true, mode: 0o755 });
    }
    try {
        // Atomic write: write to temp, then rename
        const json = JSON.stringify(config, null, 2);
        fs.writeFileSync(tempPath, json, { encoding: 'utf-8', mode: 0o600 }); // Secure permissions
        fs.renameSync(tempPath, configPath);
    }
    catch (error) {
        // Clean up temp file on error
        if (fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
            }
            catch {
                // Ignore cleanup errors
            }
        }
        throw error;
    }
}
/**
 * Update specific config values
 *
 * Loads existing config, merges updates, and saves.
 */
function updateConfig(updates, projectRoot = process.cwd()) {
    const config = loadConfig(projectRoot);
    const updated = { ...config, ...updates };
    saveConfig(updated, projectRoot);
    return updated;
}
/**
 * Get a specific config value
 */
function getConfigValue(key, projectRoot = process.cwd()) {
    const config = loadConfig(projectRoot);
    return config[key];
}
/**
 * Set a specific config value
 */
function setConfigValue(key, value, projectRoot = process.cwd()) {
    updateConfig({ [key]: value }, projectRoot);
}
// ============================================================================
// Validation
// ============================================================================
/**
 * Validate Ethereum address format
 */
function validateAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}
/**
 * Validate private key format (64 hex chars, optionally with 0x prefix)
 */
function validatePrivateKey(key) {
    // Remove 0x prefix if present
    const normalized = key.startsWith('0x') ? key.slice(2) : key;
    return /^[a-fA-F0-9]{64}$/.test(normalized);
}
/**
 * Validate config for the specified mode
 *
 * @throws Error if config is invalid for the mode
 */
function validateConfigForMode(config) {
    // All modes require a valid address
    if (!validateAddress(config.address)) {
        throw new Error(`Invalid address: "${config.address}"\n` +
            'Expected 0x-prefixed 40-character hex string.');
    }
    // Testnet and mainnet require private key
    if (config.mode !== 'mock') {
        if (!config.privateKey) {
            throw new Error(`Private key required for ${config.mode} mode.\n` +
                'Run: actp config set privateKey <your-private-key>');
        }
        if (!validatePrivateKey(config.privateKey)) {
            throw new Error('Invalid private key format.\n' +
                'Expected 64-character hex string (with or without 0x prefix).');
        }
    }
}
// ============================================================================
// Gitignore Management
// ============================================================================
/**
 * Add .actp to .gitignore if not already present
 */
function addToGitignore(projectRoot = process.cwd()) {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    let content = '';
    if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, 'utf-8');
    }
    // Check if .actp is already in gitignore
    if (content.includes('.actp')) {
        return;
    }
    // Add .actp to gitignore
    const newContent = content +
        (content.endsWith('\n') ? '' : '\n') +
        '# ACTP local state (contains mock blockchain state)\n' +
        '.actp/\n';
    fs.writeFileSync(gitignorePath, newContent, 'utf-8');
}
//# sourceMappingURL=config.js.map