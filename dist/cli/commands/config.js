"use strict";
/**
 * Config Command - View and modify CLI configuration
 *
 * Commands:
 * - config show: Display current configuration
 * - config set <key> <value>: Set a configuration value
 * - config get <key>: Get a specific configuration value
 *
 * @module cli/commands/config
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConfigCommand = createConfigCommand;
const commander_1 = require("commander");
const output_1 = require("../utils/output");
const config_1 = require("../utils/config");
const client_1 = require("../utils/client");
// ============================================================================
// Main config Command
// ============================================================================
function createConfigCommand() {
    const cmd = new commander_1.Command('config')
        .description('View and modify configuration');
    cmd.addCommand(createConfigShowCommand());
    cmd.addCommand(createConfigSetCommand());
    cmd.addCommand(createConfigGetCommand());
    return cmd;
}
// ============================================================================
// config show
// ============================================================================
function createConfigShowCommand() {
    return new commander_1.Command('show')
        .description('Display current configuration')
        .option('--json', 'Output as JSON')
        .action(async (options) => {
        const output = new output_1.Output(options.json ? 'json' : 'human');
        try {
            const config = (0, config_1.loadConfig)();
            // Mask private key if present
            const displayConfig = {
                ...config,
                privateKey: config.privateKey
                    ? config.privateKey.slice(0, 10) + '...' + config.privateKey.slice(-4)
                    : undefined,
            };
            if (options.json) {
                output.result(displayConfig);
            }
            else {
                output.section('ACTP Configuration');
                output.keyValue('Mode', config.mode);
                output.keyValue('Address', config.address);
                output.keyValue('Version', config.version);
                if (config.privateKey) {
                    output.keyValue('Private Key', '****' + config.privateKey.slice(-4));
                }
                if (config.rpcUrl) {
                    output.keyValue('RPC URL', config.rpcUrl);
                }
            }
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// config set
// ============================================================================
function createConfigSetCommand() {
    return new commander_1.Command('set')
        .description('Set a configuration value')
        .argument('<key>', 'Configuration key (mode, address, privateKey, rpcUrl)')
        .argument('<value>', 'Value to set')
        .option('--json', 'Output as JSON')
        .action(async (key, value, options) => {
        const output = new output_1.Output(options.json ? 'json' : 'human');
        try {
            // Validate key
            const validKeys = ['mode', 'address', 'privateKey', 'rpcUrl'];
            if (!validKeys.includes(key)) {
                throw new Error(`Invalid config key: "${key}"\n` +
                    `Valid keys: ${validKeys.join(', ')}`);
            }
            // Validate value based on key
            switch (key) {
                case 'mode': {
                    const validModes = ['mock', 'testnet', 'mainnet'];
                    if (!validModes.includes(value)) {
                        throw new Error(`Invalid mode: "${value}"\n` +
                            `Valid modes: ${validModes.join(', ')}`);
                    }
                    break;
                }
                case 'address':
                    if (!(0, config_1.validateAddress)(value)) {
                        throw new Error(`Invalid address: "${value}"\n` +
                            'Expected 0x-prefixed 40-character hex string.');
                    }
                    break;
                case 'privateKey':
                    if (!(0, config_1.validatePrivateKey)(value)) {
                        throw new Error(`Invalid private key format.\n` +
                            'Expected 64-character hex string (with or without 0x prefix).');
                    }
                    // Normalize: ensure no 0x prefix for storage
                    value = value.startsWith('0x') ? value.slice(2) : value;
                    break;
                case 'rpcUrl':
                    if (!value.startsWith('http://') && !value.startsWith('https://')) {
                        throw new Error(`Invalid RPC URL: "${value}"\n` +
                            'Expected URL starting with http:// or https://');
                    }
                    break;
            }
            // Update config
            const updates = { [key]: value };
            if (key === 'address') {
                updates.address = value.toLowerCase();
            }
            const newConfig = (0, config_1.updateConfig)(updates);
            output.result({
                [key]: key === 'privateKey' ? '****' + value.slice(-4) : value,
                updated: true,
            });
            output.success(`Configuration updated: ${key}`);
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
// ============================================================================
// config get
// ============================================================================
function createConfigGetCommand() {
    return new commander_1.Command('get')
        .description('Get a specific configuration value')
        .argument('<key>', 'Configuration key')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Output only the value')
        .action(async (key, options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            const config = (0, config_1.loadConfig)();
            const validKeys = ['mode', 'address', 'privateKey', 'rpcUrl', 'version'];
            if (!validKeys.includes(key)) {
                throw new Error(`Invalid config key: "${key}"\n` +
                    `Valid keys: ${validKeys.join(', ')}`);
            }
            const value = config[key];
            // Mask private key
            let displayValue = value;
            if (key === 'privateKey' && value) {
                displayValue = '****' + value.slice(-4);
            }
            if (options.quiet) {
                if (value !== undefined) {
                    console.log(key === 'privateKey' ? displayValue : value);
                }
            }
            else {
                output.result({
                    key,
                    value: displayValue ?? null,
                });
            }
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
}
//# sourceMappingURL=config.js.map