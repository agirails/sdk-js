"use strict";
/**
 * Init Command - Initialize ACTP in the current directory
 *
 * Creates .actp/ directory with configuration and initial state.
 * Supports interactive and non-interactive modes.
 *
 * @module cli/commands/init
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
exports.createInitCommand = createInitCommand;
exports.runInit = runInit;
const crypto = __importStar(require("crypto"));
const commander_1 = require("commander");
const config_1 = require("../utils/config");
const output_1 = require("../utils/output");
const MockStateManager_1 = require("../../runtime/MockStateManager");
// ============================================================================
// Command Definition
// ============================================================================
function createInitCommand() {
    const cmd = new commander_1.Command('init')
        .description('Initialize ACTP in the current directory')
        .option('-m, --mode <mode>', 'Operating mode: mock, testnet, mainnet', 'mock')
        .option('-a, --address <address>', 'Your Ethereum address')
        .option('-f, --force', 'Overwrite existing configuration')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Minimal output')
        .action(async (options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            await runInit(options, output);
        }
        catch (error) {
            output.errorResult({
                code: 'INIT_FAILED',
                message: error.message,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
    return cmd;
}
async function runInit(options, output) {
    const projectRoot = process.cwd();
    // Check if already initialized
    if ((0, config_1.isInitialized)(projectRoot) && !options.force) {
        throw new Error('ACTP already initialized in this directory.\n' +
            'Use --force to reinitialize.');
    }
    // Validate mode
    const validModes = ['mock', 'testnet', 'mainnet'];
    if (!validModes.includes(options.mode)) {
        throw new Error(`Invalid mode: "${options.mode}". Valid modes: ${validModes.join(', ')}`);
    }
    const mode = options.mode;
    // Get or generate address
    let address = options.address;
    if (!address) {
        if (mode === 'mock') {
            // Generate a random address for mock mode
            address = '0x' + crypto.randomBytes(20).toString('hex');
            output.info(`Generated mock address: ${address}`);
        }
        else {
            throw new Error(`Address required for ${mode} mode.\n` +
                'Use --address <your-address> to specify.');
        }
    }
    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        throw new Error(`Invalid address format: "${address}"\n` +
            'Expected 0x-prefixed 40-character hex string.');
    }
    // Create configuration
    const config = {
        mode,
        address: address.toLowerCase(),
        version: '1.0',
    };
    // Save configuration
    (0, config_1.saveConfig)(config, projectRoot);
    output.success('Configuration saved');
    // Initialize mock state if in mock mode
    if (mode === 'mock') {
        const stateManager = new MockStateManager_1.MockStateManager(projectRoot);
        if (!stateManager.exists() || options.force) {
            stateManager.reset();
            output.success('Mock state initialized');
        }
        // Mint initial tokens for the address
        const { MockRuntime } = await Promise.resolve().then(() => __importStar(require('../../runtime/MockRuntime')));
        const runtime = new MockRuntime(stateManager);
        await runtime.mintTokens(address.toLowerCase(), '10000000000'); // 10,000 USDC
        output.info('Minted 10,000 USDC to your address');
    }
    // Add to gitignore
    try {
        (0, config_1.addToGitignore)(projectRoot);
        output.success('Added .actp/ to .gitignore');
    }
    catch {
        output.warning('Could not update .gitignore (may not exist)');
    }
    // Output result
    output.blank();
    output.result({
        initialized: true,
        directory: (0, config_1.getActpDir)(projectRoot),
        mode,
        address,
    }, { quietKey: 'address' });
    output.blank();
    output.print('Next steps:');
    output.print('  1. Create a payment: actp pay <provider> <amount>');
    output.print('  2. Check your balance: actp balance');
    output.print('  3. List transactions: actp tx list');
}
//# sourceMappingURL=init.js.map