import { ethers } from 'ethers';
import Groq from 'groq-sdk';
import axios from 'axios';

// 1. Load configuration from environment variables (injected by GitAgent backend).
const groqApiKey = process.env.GROQ_API_KEY;
const agentContractAddress = process.env.AGENT_CONTRACT_ADDRESS;
// Main branch: Conservative strategy - only buy on significant dips
const agentPrompt = process.env.AI_PROMPT || "You are a conservative risk-averse financial analyst. You only BUY when the price has dropped significantly (below $0.38) or shows strong upward momentum. Otherwise, you HOLD to preserve capital. Based on the current price, should I 'BUY' or 'HOLD'?";
const mantleRpcUrl = process.env.MANTLE_RPC_URL || 'https://rpc.sepolia.mantle.xyz';
const backendUrl = process.env.BACKEND_URL || 'http://localhost:3005';
const repoUrl = process.env.REPO_URL || '';
const branchName = process.env.BRANCH_NAME || 'main';
const agentPrivateKey = process.env.AGENT_PRIVATE_KEY || ''; // For signing transactions
// Optional: Token addresses for trading (defaults to tested tokens on Mantle Sepolia)
// TOKEN_IN_ADDRESS - Token to sell (default: 0xF4Ab10F0a84Cf504Dec2c1Aa5D250fd3F31EF84e)
// TOKEN_OUT_ADDRESS - Token to buy (default: 0xAcab8129E2cE587fD203FD770ec9ECAFA2C88080)
// POOL_FEE - Uniswap V3 pool fee in basis points (default: 500 = 0.05%)
// SLIPPAGE_TOLERANCE - Slippage tolerance percentage (default: 3%)

// Debug: Log all environment variables related to GitAgent
console.log('[Environment] === Environment Variables Check ===');
console.log(`[Environment] REPO_URL: ${repoUrl ? '✅ ' + repoUrl : '❌ NOT SET'}`);
console.log(`[Environment] BRANCH_NAME: ${branchName ? '✅ ' + branchName : '❌ NOT SET'}`);
console.log(`[Environment] AGENT_CONTRACT_ADDRESS: ${agentContractAddress ? '✅ ' + agentContractAddress : '❌ NOT SET'}`);
console.log(`[Environment] AGENT_PRIVATE_KEY: ${agentPrivateKey ? '✅ SET (hidden)' : '❌ NOT SET'}`);
console.log(`[Environment] BACKEND_URL: ${process.env.BACKEND_URL || 'NOT SET'}`);
console.log(`[Environment] MANTLE_RPC_URL: ${process.env.MANTLE_RPC_URL || 'NOT SET'}`);
console.log(`[Environment] Strategy: Conservative (Main Branch)`);
console.log(`[Environment] === End Environment Check ===`);

if (!groqApiKey || !agentContractAddress) {
  console.error('Error: GROQ_API_KEY or AGENT_CONTRACT_ADDRESS is not set.');
  process.exit(1);
}

// 2. Initialize clients
const groq = new Groq({ apiKey: groqApiKey });

// Connect to Mantle provider
const provider = new ethers.JsonRpcProvider(mantleRpcUrl);

// Verify network connection
provider.getNetwork().then((network) => {
  console.log(`🌐 Connected to Mantle Sepolia Testnet`);
  console.log(`   Chain ID: ${network.chainId}`);
  console.log(`   RPC URL: ${mantleRpcUrl}`);
  if (network.chainId !== 5003n) {
    console.warn(`⚠️  Warning: Expected chain ID 5003 (Mantle Sepolia), got ${network.chainId}`);
  }
}).catch((err) => {
  console.error(`❌ Failed to connect to network: ${err.message}`);
});

// Create wallet if private key is available
let agentWallet: ethers.Wallet | null = null;
if (agentPrivateKey) {
  agentWallet = new ethers.Wallet(agentPrivateKey, provider);
  console.log(`📝 Agent wallet connected: ${agentWallet.address}`);
} else {
  console.log(`⚠️  AGENT_PRIVATE_KEY not set - trades will be skipped`);
  console.log(`💡 Set secret: git mantle-agent secrets set AGENT_PRIVATE_KEY=0x...`);
}

console.log(`🤖 AI Agent ${agentContractAddress} starting...`);
console.log(`Prompt: "${agentPrompt}"`);

// Agent contract ABI (minimal for execute function)
const AGENT_ABI = [
  "function execute(address target, bytes calldata data) external returns (bytes memory)",
  "function owner() external view returns (address)"
];

// Initialize agent contract (will be connected with wallet signer when needed)
let agentContract: ethers.Contract;

// 3. Real Price Feed - Fetch from CoinGecko API
async function getTokenPrice(): Promise<number> {
  try {
    // Try CoinGecko API for token price
    // Note: Adjust token ID based on what you're trading on Mantle
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'ethereum', // Using ETH as default, adjust for your token
        vs_currencies: 'usd'
      },
      timeout: 5000
    });

    if (response.data && response.data.ethereum && response.data.ethereum.usd) {
      const price = response.data.ethereum.usd;
      console.log(`[PriceFeed] Real token price from CoinGecko: $${price.toFixed(4)}`);
      return price;
    }

    // Fallback: Try querying DEX on Mantle blockchain
    // TODO: Implement DEX contract call if CoinGecko doesn't have the token
    console.warn('[PriceFeed] CoinGecko API did not return token price, using fallback');
    
    // Fallback to a reasonable price
    const fallbackPrice = 2000 + (Math.random() - 0.5) * 100;
    console.log(`[PriceFeed] Using fallback price: $${fallbackPrice.toFixed(4)}`);
    return fallbackPrice;
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[PriceFeed] Error fetching price:', errorMessage);
    // Fallback price if API fails
    const fallbackPrice = 2000 + (Math.random() - 0.5) * 100;
    console.log(`[PriceFeed] Using fallback price (API error): $${fallbackPrice.toFixed(4)}`);
    return fallbackPrice;
  }
}

// 4. Send metrics to backend
async function sendMetric(decision: string, price: number, tradeExecuted: boolean = false, tradeTxHash: string | null = null, tradeAmount: number | null = null) {
  if (!repoUrl) {
    console.warn('[Metrics] REPO_URL not set, skipping metrics');
    return;
  }

  try {
    await axios.post(`${backendUrl}/api/metrics`, {
      repo_url: repoUrl,
      branch_name: branchName,
      decision: decision,
      price: price,
      trade_executed: tradeExecuted,
      trade_tx_hash: tradeTxHash,
      trade_amount: tradeAmount
    }, { timeout: 3000 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[Metrics] Failed to send metric: ${errorMessage}`);
  }
}

// 5. Execute a trade on Mantle using DEX Router
async function executeTradeOnMantle(): Promise<{ success: boolean; txHash: string | null }> {
  console.log('[Trade] 🔍 === Trade Execution Diagnostic ===');
  
  // Check 1: Agent Wallet
  if (!agentWallet) {
    console.warn('[Trade] ❌ AGENT_PRIVATE_KEY not set in environment');
    console.warn('[Trade] 💡 Fix: Set secret: git mantle-agent secrets set AGENT_PRIVATE_KEY=0x...');
    console.warn('[Trade] ⚠️  Skipping trade execution');
    return { success: false, txHash: null };
  }
  console.log(`[Trade] ✅ Agent wallet initialized: ${agentWallet.address}`);

  try {
    // Get contract balance
    const contractBalance = await provider.getBalance(agentContractAddress as string);
    const walletBalance = await provider.getBalance(agentWallet.address);
    console.log(`[Trade] 📊 Balance Check:`);
    console.log(`[Trade]    Agent Contract: ${ethers.formatEther(contractBalance)} ETH`);
    console.log(`[Trade]    Wallet:         ${ethers.formatEther(walletBalance)} ETH`);

    // Mantle DEX Router configuration (Uniswap V3 SwapRouter02 on Mantle Sepolia)
    // Router address from reference.js - verified working
    const MANTLE_ROUTER_ADDRESS = '0x738fD6d10bCc05c230388B4027CAd37f82fe2AF2';
    
    // Token addresses - configurable via environment variables or use defaults
    // Default tokens from user's successful test
    const TOKEN_IN_ADDRESS = process.env.TOKEN_IN_ADDRESS || '0xF4Ab10F0a84Cf504Dec2c1Aa5D250fd3F31EF84e';
    const TOKEN_OUT_ADDRESS = process.env.TOKEN_OUT_ADDRESS || '0xAcab8129E2cE587fD203FD770ec9ECAFA2C88080';
    const POOL_FEE = process.env.POOL_FEE ? parseInt(process.env.POOL_FEE) : 500; // 0.05% default fee (500 = 0.05%)
    const SLIPPAGE_TOLERANCE = process.env.SLIPPAGE_TOLERANCE ? parseFloat(process.env.SLIPPAGE_TOLERANCE) : 3; // 3% default
    
    console.log(`[Trade] 🔧 DEX Configuration (Mantle Sepolia Testnet):`);
    console.log(`[Trade]    Router: ✅ ${MANTLE_ROUTER_ADDRESS} (Uniswap V3)`);
    console.log(`[Trade]    Token In:  ✅ ${TOKEN_IN_ADDRESS}`);
    console.log(`[Trade]    Token Out: ✅ ${TOKEN_OUT_ADDRESS}`);
    console.log(`[Trade]    Pool Fee: ${POOL_FEE} (${POOL_FEE / 10000}%)`);
    console.log(`[Trade]    Slippage: ${SLIPPAGE_TOLERANCE}%`);
    console.log(`[Trade]    Network: Mantle Sepolia Testnet (Chain ID: 5003)`);

    // ERC20 ABI for token operations
    const ERC20_ABI = [
      "function balanceOf(address account) external view returns (uint256)",
      "function approve(address spender, uint256 amount) external returns (bool)",
      "function allowance(address owner, address spender) external view returns (uint256)",
      "function decimals() external view returns (uint8)",
      "function transfer(address to, uint256 amount) external returns (bool)"
    ];

    // Uniswap V3 Router ABI (exactInputSingle function)
    const UNISWAP_V3_ROUTER_ABI = [
      "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut)"
    ];

    console.log(`[Trade] ✅ DEX configured, proceeding with swap on Mantle Sepolia Testnet...`);
    console.log(`[Trade] 📋 Trade Details:`);
    console.log(`[Trade]    Selling: Token In (${TOKEN_IN_ADDRESS})`);
    console.log(`[Trade]    Buying: Token Out (${TOKEN_OUT_ADDRESS})`);
    console.log(`[Trade]    Executing via Agent Contract: ${agentContractAddress}`);
    
    const tokenIn = new ethers.Contract(TOKEN_IN_ADDRESS, ERC20_ABI, agentWallet);
    const tokenOut = new ethers.Contract(TOKEN_OUT_ADDRESS, ERC20_ABI, agentWallet);
    
    // Get token decimals
    let decimalsIn = 18;
    let decimalsOut = 18;
    try {
      decimalsIn = await tokenIn.decimals();
      decimalsOut = await tokenOut.decimals();
      console.log(`[Trade]    Token In decimals: ${decimalsIn}`);
      console.log(`[Trade]    Token Out decimals: ${decimalsOut}`);
    } catch (error) {
      console.warn(`[Trade] ⚠️  Could not fetch decimals, using default 18`);
    }
    
    // Check token balance in wallet (we'll transfer to contract)
    console.log(`[Trade] 🔍 Checking token balance for wallet ${agentWallet.address}...`);
    const walletTokenBalance = await tokenIn.balanceOf(agentWallet.address);
    console.log(`[Trade]    Wallet token balance: ${ethers.formatUnits(walletTokenBalance, decimalsIn)} tokens`);
    
    if (walletTokenBalance === 0n) {
      console.warn('[Trade] ❌ No tokens to swap');
      console.warn(`[Trade] 💡 Fix: Send tokens to wallet ${agentWallet.address}`);
      return { success: false, txHash: null };
    }

    // Use VERY small amount: 0.0001 tokens minimum, or 0.01% of balance (whichever is smaller)
    const minAmount = ethers.parseUnits("0.0001", decimalsIn); // Minimum 0.0001 tokens
    const onePercent = walletTokenBalance / 10000n; // 0.01% of balance (1/10000)
    const amountIn = onePercent < minAmount ? minAmount : onePercent; // Use smaller of the two
    
    console.log(`[Trade] 💰 Swap amount: ${ethers.formatUnits(amountIn, decimalsIn)} tokens (0.01% of ${ethers.formatUnits(walletTokenBalance, decimalsIn)} total balance, min 0.0001)`);

    // For Uniswap V3, we need to estimate output using a quote or calculate minimum output
    // Since we don't have a quoter contract, we'll use a conservative estimate
    // Calculate minimum output with slippage tolerance
    console.log(`[Trade] 🔍 Calculating minimum output with ${SLIPPAGE_TOLERANCE}% slippage tolerance...`);
    
    // Note: Without a quoter contract, we can't get exact output. 
    // We'll use a very conservative amountOutMin (50% of input as worst case)
    // In production, you'd want to use Uniswap's QuoterV2 contract for accurate quotes
    const amountOutMin = (amountIn * BigInt(Math.floor((100 - SLIPPAGE_TOLERANCE) * 100))) / 10000n;
    console.log(`[Trade]    Min output (${SLIPPAGE_TOLERANCE}% slippage): ${ethers.formatUnits(amountOutMin, decimalsOut)} tokens`);
    console.log(`[Trade]    ⚠️  Note: Using conservative estimate. For accurate quotes, use Uniswap QuoterV2 contract.`);

    // Step 1: Transfer tokens from wallet to agent contract
    console.log(`[Trade] 📤 Transferring tokens from wallet to agent contract...`);
    const contractTokenBalance = await tokenIn.balanceOf(agentContractAddress as string);
    console.log(`[Trade]    Contract current balance: ${ethers.formatUnits(contractTokenBalance, decimalsIn)} tokens`);
    
    if (contractTokenBalance < amountIn) {
      const transferAmount = amountIn - contractTokenBalance;
      console.log(`[Trade]    Transferring ${ethers.formatUnits(transferAmount, decimalsIn)} tokens to contract...`);
      const transferTx = await tokenIn.transfer(agentContractAddress as string, transferAmount);
      console.log(`[Trade]    Transfer tx: ${transferTx.hash}`);
      await transferTx.wait();
      console.log(`[Trade] ✅ Tokens transferred to contract`);
    } else {
      console.log(`[Trade] ✅ Contract already has sufficient tokens`);
    }

    // Step 2: Approve router to spend tokens from agent contract
    console.log(`[Trade] 🔍 Checking token allowance from contract to router...`);
    const contractTokenIn = new ethers.Contract(TOKEN_IN_ADDRESS, ERC20_ABI, provider);
    const allowance = await contractTokenIn.allowance(agentContractAddress as string, MANTLE_ROUTER_ADDRESS);
    console.log(`[Trade]    Current allowance: ${ethers.formatUnits(allowance, decimalsIn)} tokens`);
    
    if (allowance < amountIn) {
      console.log(`[Trade] 📝 Approving router to spend tokens from agent contract...`);
      // We need to call approve through the agent contract's execute function
      const approveInterface = new ethers.Interface(ERC20_ABI);
      const approveData = approveInterface.encodeFunctionData("approve", [MANTLE_ROUTER_ADDRESS, ethers.MaxUint256]);
      
      // Connect agent contract with wallet signer (wallet is the owner)
      agentContract = new ethers.Contract(agentContractAddress as string, AGENT_ABI, agentWallet);
      const approveTx = await agentContract.execute(TOKEN_IN_ADDRESS, approveData);
      console.log(`[Trade]    Approval tx (via contract): ${approveTx.hash}`);
      await approveTx.wait();
      console.log(`[Trade] ✅ Approval confirmed`);
    } else {
      console.log(`[Trade] ✅ Sufficient allowance already set`);
    }

    // Step 3: Execute swap via agent contract's execute() function
    console.log(`[Trade] 🚀 Executing swap via Agent Contract on Mantle Sepolia Testnet DEX (Uniswap V3)...`);
    console.log(`[Trade]    Swap: Token In → Token Out`);
    console.log(`[Trade]    Amount: ${ethers.formatUnits(amountIn, decimalsIn)} tokens`);
    console.log(`[Trade]    Min output: ${ethers.formatUnits(amountOutMin, decimalsOut)} tokens`);
    console.log(`[Trade]    Router: ${MANTLE_ROUTER_ADDRESS}`);
    console.log(`[Trade]    Pool Fee: ${POOL_FEE} (${POOL_FEE / 10000}%)`);
    console.log(`[Trade]    Recipient: ${agentContractAddress} (tokens will go to contract)`);
    
    // Uniswap V3 exactInputSingle parameters
    // IMPORTANT: recipient should be agent contract address so tokens go to contract
    const swapParams = {
      tokenIn: TOKEN_IN_ADDRESS,
      tokenOut: TOKEN_OUT_ADDRESS,
      fee: POOL_FEE,
      recipient: agentContractAddress as string, // Send output tokens to contract
      amountIn: amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0 // No price limit
    };
    
    // Encode the swap function call
    const routerInterface = new ethers.Interface(UNISWAP_V3_ROUTER_ABI);
    const swapData = routerInterface.encodeFunctionData("exactInputSingle", [swapParams]);
    
    // Execute swap through agent contract
    agentContract = new ethers.Contract(agentContractAddress as string, AGENT_ABI, agentWallet);
    const tx = await agentContract.execute(MANTLE_ROUTER_ADDRESS, swapData);

    console.log(`[Trade] 📤 Swap transaction sent via Agent Contract: ${tx.hash}`);
    console.log(`[Trade] ⏳ Waiting for confirmation...`);
    
    const receipt = await tx.wait();
    console.log(`[Trade] ✅ Swap confirmed in block ${receipt?.blockNumber}`);
    console.log(`[Trade] 🔗 Agent Contract Explorer: https://sepolia.mantlescan.xyz/address/${agentContractAddress}`);
    console.log(`[Trade] 🔗 Transaction Explorer: https://sepolia.mantlescan.xyz/tx/${tx.hash}`);
    console.log(`[Trade] ✨ === Trade Execution Complete (via Agent Contract) ===`);
    
    return { success: true, txHash: tx.hash };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error(`[Trade] ❌ === Trade Execution Failed ===`);
    console.error(`[Trade] ❌ Error: ${errorMessage}`);
    if (errorStack) {
      console.error(`[Trade] 📚 Stack trace: ${errorStack}`);
    }
    console.error(`[Trade] 💡 Check: Wallet balance, token balance, router address, network connection`);
    return { success: false, txHash: null };
  }
}

// 6. Main AI Decision Loop
async function runDecisionLoop() {
  try {
    const price = await getTokenPrice();

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: agentPrompt },
        { role: 'user', content: `The current price is $${price.toFixed(4)}. Should I BUY or HOLD?` }
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0.3, // Lower temperature for more conservative decisions (main branch)
      max_tokens: 50,
    });

    const decision = chatCompletion.choices[0]?.message?.content || 'HOLD';
    const isBuy = decision.toUpperCase().includes('BUY');

    if (isBuy) {
      console.log(`[AI Decision] AI decided: BUY.`);
      
      // Conservative strategy: Only execute trades if price is below threshold OR randomly (30% chance)
      // This makes main branch more selective than aggressive branch
      const priceBelowThreshold = price < 0.38; // Only buy if price dropped significantly
      const randomExecution = Math.random() < 0.30; // 30% chance to execute even above threshold
      const shouldExecuteTrade = priceBelowThreshold || randomExecution;
      
      if (shouldExecuteTrade) {
        console.log(`[Trade] ✅ Conservative filter passed (price: $${price.toFixed(4)}, below threshold: ${priceBelowThreshold}). Executing trade...`);
        
        // Execute actual trade on Mantle blockchain
        const tradeResult = await executeTradeOnMantle();
        
        if (tradeResult.success && tradeResult.txHash) {
          console.log(`[Trade] ✅ Trade executed successfully: ${tradeResult.txHash}`);
          await sendMetric(`BUY - ${decision}`, price, true, tradeResult.txHash, 0.0001);
        } else {
          console.log(`[Trade] ⚠️ Trade execution skipped (insufficient funds or key not set)`);
          await sendMetric(`BUY - ${decision}`, price, false, null, null);
        }
      } else {
        console.log(`[Trade] 🛡️ Conservative filter blocked trade execution (price: $${price.toFixed(4)} above $0.38 threshold). Holding instead.`);
        await sendMetric(`BUY (FILTERED) - ${decision}`, price, false, null, null);
      }
    } else {
      console.log(`[AI Decision] AI decided: HOLD.`);
      await sendMetric(`HOLD - ${decision}`, price, false, null, null);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error in decision loop:', errorMessage);
  }
}

// 7. Run the agent
// Run immediately on start, and then every 30 seconds
runDecisionLoop();
setInterval(runDecisionLoop, 30000);
// Trigger main restart
