# Gamer Token rewards

## Player flow

1. Open Tap Rush from the main Telegram bot.
2. Start a reward round.
3. Every 5 server-accepted taps earns 100 $Gamer.
4. Open Wallet in the bot.
5. Tap Claim to linked wallet.

Earnings are stored in Postgres first. Claiming sends the earned amount from a dedicated SPL token treasury to the linked wallet associated token account.

## Safety limits

- Reward rounds last 20 seconds.
- Tap numbers must be ordered and cannot be replayed.
- Impossible tap timing is rejected.
- Default daily maximum is 10,000 $Gamer per player.
- The game token cannot call the wallet claim endpoint.
- A claim debits once before submitting, preventing duplicate payouts.
- The treasury automatically creates the destination ATA when needed.

This is MVP anti-cheat. Do not enable valuable mainnet rewards until gameplay validation and the token distribution design have been audited.

## Required Render settings

Keep claims disabled until all values are ready:

    REWARD_RPC_URL=https://api.devnet.solana.com
    GAMER_TOKEN_SYMBOL=SGA
    GAMER_TOKEN_MINT=<DEVNET_MINT_ADDRESS>
    GAMER_TREASURY_KEYPAIR=<BASE58_DEDICATED_KEYPAIR>
    REWARD_DAILY_CAP=10000
    REWARD_MIN_CLAIM=100
    REWARDS_CLAIMS_ENABLED=0

The treasury must:

- be a new dedicated keypair, never a personal wallet;
- have devnet SOL for transaction fees and recipient ATA rent;
- own a funded token account for GAMER_TOKEN_MINT.

After a devnet claim succeeds, change REWARDS_CLAIMS_ENABLED to 1 and redeploy Render.

## Deployment order

1. Push and deploy the backend so migration 0003_rewards runs.
2. Deploy the Mini App so the Wallet claim panel and SDK are updated.
3. Re-export Tap Rush from test-game/godot into test-game/godot-export.
4. Deploy the Tap Rush Vercel project.
5. Test on devnet before changing any RPC or mint to mainnet.

## Mainnet requirement

The current signer is stored as a Render secret and is acceptable only for an MVP treasury with a limited allocation. At scale, replace it with a managed signer or audited on-chain distributor so one application secret cannot control the full reward reserve.