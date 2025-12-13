"use strict";
/**
 * Balance Command - Check USDC balance
 *
 * Shows the USDC balance for the current user or a specified address.
 *
 * @module cli/commands/balance
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBalanceCommand = createBalanceCommand;
exports.runBalance = runBalance;
const commander_1 = require("commander");
const output_1 = require("../utils/output");
const client_1 = require("../utils/client");
const config_1 = require("../utils/config");
// ============================================================================
// Command Definition
// ============================================================================
function createBalanceCommand() {
    const cmd = new commander_1.Command('balance')
        .description('Check USDC balance')
        .argument('[address]', 'Address to check (defaults to your address)')
        .option('--json', 'Output as JSON')
        .option('-q, --quiet', 'Output only the balance amount')
        .action(async (address, options) => {
        const output = new output_1.Output(options.json ? 'json' : options.quiet ? 'quiet' : 'human');
        try {
            await runBalance(address, output);
        }
        catch (error) {
            const structuredError = (0, client_1.mapError)(error);
            output.errorResult({
                code: structuredError.code,
                message: structuredError.message,
                details: structuredError.details,
            });
            process.exit(output_1.ExitCode.ERROR);
        }
    });
    return cmd;
}
// ============================================================================
// Implementation
// ============================================================================
async function runBalance(address, output) {
    // Load config to get default address
    const config = (0, config_1.loadConfig)();
    // Use specified address or default to config address
    const targetAddress = address || config.address;
    // Validate address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(targetAddress)) {
        throw new Error(`Invalid address format: "${targetAddress}"\n` +
            'Expected 0x-prefixed 40-character hex string.');
    }
    // Create client and get balance
    const client = await (0, client_1.createClient)();
    const balanceWei = await client.getBalance(targetAddress.toLowerCase());
    // Format balance
    const balanceFormatted = formatUsdc(balanceWei);
    const isOwnAddress = targetAddress.toLowerCase() === config.address.toLowerCase();
    output.result({
        address: targetAddress,
        balance: `${balanceFormatted} USDC`,
        balanceWei,
        isYou: isOwnAddress,
    }, { quietKey: 'balance' });
    // Additional info in human mode
    if (balanceWei === '0') {
        output.blank();
        output.warning('Balance is zero.');
        if (config.mode === 'mock') {
            output.print('  Mint tokens: actp mint ' + targetAddress + ' 1000');
        }
    }
}
/**
 * Format USDC amount from wei to decimal with commas
 */
function formatUsdc(weiAmount) {
    const amount = BigInt(weiAmount);
    const whole = amount / 1000000n;
    const decimal = amount % 1000000n;
    const decimalStr = decimal.toString().padStart(6, '0').slice(0, 2);
    // Add thousands separators
    const wholeFormatted = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${wholeFormatted}.${decimalStr}`;
}
//# sourceMappingURL=balance.js.map