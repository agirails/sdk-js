/**
 * Claim Command - Link agents to dashboard via wallet signature
 *
 * Proves wallet ownership by signing a challenge message.
 * The dashboard verifies ownerOf(agentId) on-chain.
 *
 * @module cli/commands/claim
 */

import { Command } from 'commander';
import { ethers } from 'ethers';
import { Output, ExitCode } from '../utils/output';
import { mapError } from '../utils/client';
import { loadConfig } from '../utils/config';
import { resolvePrivateKey } from '../../wallet/keystore';
import { getClaimChallenge, claimAgent } from '../../api/agirailsApp';

// ============================================================================
// Command Definition
// ============================================================================

export function createClaimCommand(): Command {
  const cmd = new Command('claim')
    .description('Claim agent ownership on agirails.app dashboard')
    .argument('[agent-id]', 'Agent ID to claim (reads from config if omitted)')
    .option('--all', 'Claim all agents owned by this wallet')
    .option('--json', 'Output as JSON')
    .option('-q, --quiet', 'Minimal output')
    .action(async (agentId, options) => {
      const output = new Output(
        options.json ? 'json' : options.quiet ? 'quiet' : 'human'
      );

      try {
        await runClaim(agentId, options, output);
      } catch (error) {
        const structuredError = mapError(error);
        output.errorResult({
          code: structuredError.code,
          message: structuredError.message,
          details: structuredError.details,
        });
        process.exit(ExitCode.ERROR);
      }
    });

  return cmd;
}

// ============================================================================
// Implementation
// ============================================================================

interface ClaimOptions {
  all?: boolean;
}

async function runClaim(
  agentIdArg: string | undefined,
  options: ClaimOptions,
  output: Output
): Promise<void> {
  const config = loadConfig();
  const spinner = output.spinner('Preparing claim...');

  try {
    // Resolve wallet credentials
    const network = config.mode === 'mainnet' ? 'mainnet' : 'testnet';
    const privateKey = await resolvePrivateKey(undefined, { network });
    if (!privateKey) {
      throw new Error(
        'No wallet credentials found.\n' +
        'Claiming requires a wallet key to sign the ownership proof.\n' +
        'Set ACTP_KEY_PASSWORD or ACTP_PRIVATE_KEY environment variable.'
      );
    }

    const wallet = new ethers.Wallet(privateKey);
    const walletAddress = wallet.address;

    // Determine agent ID
    if (options.all) {
      throw new Error(
        '--all is not yet implemented.\n' +
        'Provide an explicit agent-id: actp claim <agent-id>'
      );
    }

    // agent-id is required — it's an ERC-8004 token ID, not an agent name.
    // config.agentName is a human-readable string, NOT a valid token ID.
    if (!agentIdArg) {
      throw new Error(
        'Agent ID required.\n' +
        'The agent-id is the ERC-8004 token ID (numeric), not the agent name.\n' +
        'Find it in your {slug}.md under agent_id, or on-chain via ownerOf.\n' +
        'Usage: actp claim <agent-id>'
      );
    }

    // NOTE: agirails.app claim API routes (/api/v1/agents/claim/challenge,
    // /api/v1/agents/claim) are not yet deployed. This code is forward-
    // compatible — will work once the routes exist.

    // Step 1: Get challenge from dashboard
    const { challenge } = await getClaimChallenge(walletAddress);

    // Step 2: Sign challenge with wallet
    const signature = await wallet.signMessage(challenge);

    // Step 3: Submit claim
    const result = await claimAgent({
      agentId: agentIdArg,
      wallet: walletAddress,
      signature,
      challenge,
    });

    spinner.stop(true);

    output.result(
      {
        status: 'claimed',
        agentId: result.agentId,
        wallet: walletAddress,
        profileUrl: result.profileUrl,
      },
      { quietKey: 'profileUrl' }
    );

    output.blank();
    output.success(`Agent claimed! View at: ${result.profileUrl}`);
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
}

export { runClaim };
