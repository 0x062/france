import chalk from "chalk";
import { ethers } from "ethers";
import axios from "axios";
import 'dotenv/config';

// ===================================================================================
// KONFIGURASI DARI .ENV
// ===================================================================================
const {
    PRIVATE_KEY, RPC_URL, GAS_PRICE_MULTIPLIER_ON_RETRY, SWAP_REPETITIONS, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS,
    PHRS_SWAP_MIN, PHRS_SWAP_MAX, USDT_SWAP_MIN, USDT_SWAP_MAX,
    ADD_LIQUIDITY_REPETITIONS, LP_WPHRS_AMOUNT, LP_USDT_AMOUNT
} = process.env;

if (!PRIVATE_KEY || !RPC_URL) {
    console.error(chalk.red("Error: Harap isi PRIVATE_KEY dan RPC_URL di file .env"));
    process.exit(1);
}

const config = {
    swapRepetitions: parseInt(SWAP_REPETITIONS, 10) || 4,
    addLiquidityRepetitions: parseInt(ADD_LIQUIDITY_REPETITIONS, 10) || 1,
    minDelay: (parseInt(MIN_DELAY_SECONDS, 10) || 30) * 1000,
    maxDelay: (parseInt(MAX_DELAY_SECONDS, 10) || 60) * 1000,
    // DIHAPUS: gasBuffer tidak lagi digunakan
    phrs: { min: parseFloat(PHRS_SWAP_MIN) || 0.01, max: parseFloat(PHRS_SWAP_MAX) || 0.05 },
    usdt: { min: parseFloat(USDT_SWAP_MIN) || 0.1, max: parseFloat(USDT_SWAP_MAX) || 1 },
    lp: {
        wphrs: ethers.parseEther(LP_WPHRS_AMOUNT || "0.02"),
        usdt: ethers.parseUnits(LP_USDT_AMOUNT || "0.5", 6)
    },
    retry: {
        maxAttempts: 3,
        slippageTiers: [0.5, 2, 5],
        gasMultiplier: parseFloat(GAS_PRICE_MULTIPLIER_ON_RETRY) || 1.2,
    }
};

// ===================================================================================
// KONSTANTA & ALAMAT KONTRAK
// ===================================================================================
const PHRS_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WPHRS_ADDRESS = "0x3019b247381c850ab53dc0ee53bce7a07ea9155f";
const USDT_ADDRESS = "0xd4071393f8716661958f766df660033b3d35fd29";
const ROUTER_ADDRESS = "0x3541423f25a1ca5c98fdbcf478405d3f0aad1164";
const LP_ADDRESS = "0x4b177aded3b8bd1d5d747f91b9e853513838cd49";
const DVM_POOL_ADDRESS = "0x034c1f84eb9d56be15fbd003e4db18a988c0d4c6";
const API_BASE_URL = "https://api.pharosnetwork.xyz";
let nonceTracker = {};
let jwtToken = null;

// ===================================================================================
// ABI KONTRAK
// ===================================================================================
const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)"];
const WPHRS_ABI = [...ERC20_ABI, "function deposit() payable", "function withdraw(uint256 wad)"];
const LP_ABI = ["function addDVMLiquidity(address dvmAddress, uint256 baseInAmount, uint256 quoteInAmount, uint256 baseMinAmount, uint256 quoteMinAmount, uint8 flag, uint256 deadLine) external payable returns (uint256, uint256, uint256)"];

// ===================================================================================
// FUNGSI UTILITAS
// ===================================================================================
function addLog(message, type = "info") { const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" }); let coloredMessage; switch (type) { case "error": coloredMessage = chalk.red(message); break; case "success": coloredMessage = chalk.green(message); break; case "wait": coloredMessage = chalk.yellow(message); break; case "warn": coloredMessage = chalk.yellow(message); break; default: coloredMessage = chalk.white(message); } console.log(`[${timestamp}] ${coloredMessage}`); }
function getShortAddress(address) { return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "N/A"; }
async function sleep(ms) { addLog(`Menunggu selama ${ms / 1000} detik...`, "wait"); return new Promise(resolve => setTimeout(resolve, ms)); }
function randomDelay() { return Math.floor(Math.random() * (config.maxDelay - config.minDelay + 1)) + config.minDelay; }
function getRandomAmount(min, max) { return Math.random() * (max - min) + min; }

// ===================================================================================
// INISIALISASI
// ===================================================================================
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ===================================================================================
// FUNGSI INTI
// ===================================================================================
const getApiHeaders = (customHeaders = {}) => ({ "Accept": "application/json, text/plain, */*", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36", "Origin": "https://testnet.pharosnetwork.xyz", "Referer": "https://testnet.pharosnetwork.xyz/", ...customHeaders });
async function makeApiRequest(method, url, data, customHeaders = {}, maxRetries = 3) { let lastError = null; for (let attempt = 1; attempt <= maxRetries; attempt++) { try { const headers = getApiHeaders(customHeaders); const config = { method, url, data, headers, timeout: 15000 }; const response = await axios(config); return response.data; } catch (error) { lastError = error; let errorMessage = `API request ke ${url} gagal (percobaan ${attempt}/${maxRetries}): `; if (error.response) { errorMessage += `Status code ${error.response.status} - ${JSON.stringify(error.response.data)}`; } else { errorMessage += error.message; } addLog(errorMessage, "error"); if (attempt < maxRetries) await sleep(2000); } } throw new Error(`Gagal membuat request API ke ${url} setelah ${maxRetries} percobaan.`); }
async function getNextNonce() { try { const pendingNonce = await provider.getTransactionCount(wallet.address, "pending"); const lastUsedNonce = nonceTracker[wallet.address] || pendingNonce - 1; const nextNonce = Math.max(pendingNonce, lastUsedNonce + 1); nonceTracker[wallet.address] = nextNonce; return nextNonce; } catch (error) { addLog(`Gagal mendapatkan nonce: ${error.message}`, "error"); throw error; } }
async function checkAndApproveToken(tokenContract, amount, tokenName, spenderAddress, txOptions) { try { const allowance = await tokenContract.allowance(wallet.address, spenderAddress); if (allowance < amount) { addLog(`Melakukan approve untuk ${ethers.formatUnits(amount, tokenName === 'USDT' ? 6 : 18)} ${tokenName}...`, "info"); const nonce = await getNextNonce(); const tx = await tokenContract.approve(spenderAddress, ethers.MaxUint256, { ...txOptions, nonce }); addLog(`Approval terkirim. Hash: ${tx.hash.slice(0,12)}...`, "success"); await tx.wait(); addLog(`Approval untuk ${tokenName} berhasil.`, "success"); } return true; } catch (error) { addLog(`Gagal approve ${tokenName}: ${error.message}`, "error"); return false; } }
async function loginAndGetJwt() { addLog("Mencoba login untuk mendapatkan JWT...", "info"); try { const message = "pharos"; const signature = await wallet.signMessage(message); const loginUrl = `${API_BASE_URL}/user/login?address=${wallet.address}&signature=${signature}`; const loginResponse = await makeApiRequest("post", loginUrl); if (loginResponse.code === 0 && loginResponse.data.jwt) { jwtToken = loginResponse.data.jwt; addLog("Login berhasil, JWT diterima.", "success"); return true; } else { addLog(`Login gagal: ${loginResponse.msg}`, "error"); return false; } } catch (error) { addLog(`Error saat login: ${error.message}`, "error"); return false; } }
async function checkBalances() { addLog("Mengecek saldo wallet...", "info"); try { const [phrsBalance, usdtBalance, wphrsBalance] = await Promise.all([provider.getBalance(wallet.address), new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider).balanceOf(wallet.address), new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, provider).balanceOf(wallet.address)]); addLog(`PHRS: ${chalk.yellow(parseFloat(ethers.formatEther(phrsBalance)).toFixed(4))}`, "info"); addLog(`USDT: ${chalk.yellow(parseFloat(ethers.formatUnits(usdtBalance, 6)).toFixed(4))}`, "info"); addLog(`WPHRS: ${chalk.yellow(parseFloat(ethers.formatEther(wphrsBalance)).toFixed(4))}`, "info"); return { phrsBalance, usdtBalance, wphrsBalance }; } catch (error) { addLog(`Gagal mengecek saldo: ${error.message}`, "error"); throw new Error(`Tidak bisa melanjutkan karena gagal mengecek saldo awal.`); } }

async function performAdvancedTaskWithRetry(taskFunction, taskName) {
    let lastFeeData;
    for (let attempt = 0; attempt < config.retry.maxAttempts; attempt++) {
        addLog(`Menjalankan ${taskName}, percobaan ke-${attempt + 1}...`, "info");
        try {
            lastFeeData = await provider.getFeeData();
            if (!lastFeeData || !lastFeeData.maxFeePerGas) {
                throw new Error("Data gas yang diterima tidak valid.");
            }
        } catch (e) {
            addLog(`Gagal mendapatkan data gas dari RPC: ${e.message}`, "error");
            addLog(`Membatalkan tugas ${taskName} karena masalah RPC.`, "warn");
            return false;
        }

        if (attempt > 0) {
            const multiplier = BigInt(Math.round(config.retry.gasMultiplier ** attempt * 100));
            lastFeeData.maxFeePerGas = (lastFeeData.maxFeePerGas * multiplier) / 100n;
            lastFeeData.maxPriorityFeePerGas = (lastFeeData.maxPriorityFeePerGas * multiplier) / 100n;
            addLog(`Menaikkan gas fee untuk percobaan ulang...`, "wait");
        }

        const slippage = config.retry.slippageTiers[attempt] || config.retry.slippageTiers.at(-1);
        const txOptions = { maxFeePerGas: lastFeeData.maxFeePerGas, maxPriorityFeePerGas: lastFeeData.maxPriorityFeePerGas };
        
        const success = await taskFunction({ slippage, txOptions });
        if (success) return true;
        
        addLog(`${taskName} gagal pada percobaan ke-${attempt + 1}.`, "warn");
        if (attempt < config.retry.maxAttempts - 1) await sleep(5000);
    }
    addLog(`${taskName} gagal setelah semua percobaan.`, "error");
    return false;
}

// ===================================================================================
// FUNGSI MODUL STRATEGI
// ===================================================================================

async function executeSwap(options) {
    const { slippage, txOptions, fromToken, toToken } = options;
    const fromTokenName = fromToken === PHRS_ADDRESS ? "PHRS" : "USDT";
    try {
        let amountToSwap, balance, decimals;
        if (fromToken === USDT_ADDRESS) {
            decimals = 6;
            balance = await new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider).balanceOf(wallet.address);
            amountToSwap = getRandomAmount(config.usdt.min, config.usdt.max);
        } else {
            decimals = 18;
            balance = await provider.getBalance(wallet.address);
            amountToSwap = getRandomAmount(config.phrs.min, config.phrs.max);
        }
        const fromAmountInWei = ethers.parseUnits(amountToSwap.toFixed(decimals), decimals);
        // PERUBAHAN: Pengecekan gasBuffer dihapus
        if (balance < fromAmountInWei) { addLog(`Saldo ${fromTokenName} tidak cukup. Melewati.`, "warn"); return true; }
        
        addLog(`Mempersiapkan swap ${amountToSwap.toFixed(4)} ${fromTokenName} dengan slippage ${slippage}%...`, "info");
        if (fromToken !== PHRS_ADDRESS) { if (!await checkAndApproveToken(new ethers.Contract(fromToken, ERC20_ABI, wallet), fromAmountInWei, fromTokenName, ROUTER_ADDRESS, txOptions)) return false; }
        
        const url = `https://api.dodoex.io/route-service/v2/widget/getdodoroute?chainId=688688&deadLine=${Math.floor(Date.now() / 1000) + 600}&apikey=a37546505892e1a952&slippage=${slippage}&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&userAddr=${wallet.address}&fromAmount=${fromAmountInWei}`;
        const routeResponse = await makeApiRequest("get", url);
        if (!routeResponse || routeResponse.status !== 200 || !routeResponse.data) { addLog(`Gagal rute Dodo.`, "error"); return false; }
        
        const { to, data, value } = routeResponse.data;
        const tx = { to, data, value: value ? ethers.parseUnits(value, "wei") : 0, nonce: await getNextNonce(), gasLimit: 500000, ...txOptions };
        const sentTx = await wallet.sendTransaction(tx);
        addLog(`Swap terkirim. Hash: ${sentTx.hash.slice(0,12)}...`, "success");
        const receipt = await sentTx.wait();
        if (receipt.status === 0) { addLog(`Swap Gagal dieksekusi (reverted).`, "error"); return false; }
        addLog(`Swap ${fromTokenName} ➯ ${toToken === PHRS_ADDRESS ? "PHRS" : "USDT"} berhasil.`, "success");
        return true;
    } catch (error) {
        if (error.code === 'CALL_EXCEPTION') { addLog(`Swap Gagal dieksekusi (reverted).`, "error"); } else { addLog(`Swap Gagal - ${error.message}`, "error"); }
        return false;
    }
}

async function wrapPhrs(options) {
    const { amountToWrap, txOptions } = options;
    addLog(`Mempersiapkan wrap ${ethers.formatEther(amountToWrap)} PHRS ke WPHRS...`, "info");
    try {
        const wphrsContract = new ethers.Contract(WPHRS_ADDRESS, WPHRS_ABI, wallet);
        const tx = await wphrsContract.deposit({ value: amountToWrap, nonce: await getNextNonce(), ...txOptions });
        addLog(`Wrap terkirim. Hash: ${tx.hash.slice(0,12)}...`, "success");
        await tx.wait();
        addLog(`Wrap ${ethers.formatEther(amountToWrap)} PHRS berhasil.`, "success");
        return true;
    } catch (error) { addLog(`Gagal wrap PHRS: ${error.message}`, "error"); return false; }
}

async function performLiquidityAddition(options) {
    const { slippage, txOptions } = options;
    addLog(`Mempersiapkan tambah likuiditas...`, "info");
    try {
        const { phrsBalance, usdtBalance, wphrsBalance } = await checkBalances();
        const wphrsNeeded = config.lp.wphrs;
        const usdtNeeded = config.lp.usdt;
        if (usdtBalance < usdtNeeded) { addLog(`Saldo USDT tidak cukup untuk LP. Melewati.`, "warn"); return true; }
        if (wphrsBalance < wphrsNeeded) {
            addLog(`Saldo WPHRS tidak cukup. Mencoba wrap PHRS...`, "warn");
            const phrsToWrap = wphrsNeeded - wphrsBalance;
            // PERUBAHAN: Pengecekan gasBuffer dihapus
            if (phrsBalance < phrsToWrap) { addLog(`Saldo PHRS tidak cukup untuk di-wrap. Melewati.`, "error"); return true; }
            if (!(await wrapPhrs({amountToWrap: phrsToWrap, txOptions}))) return false;
        }
        const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);
        if (!await checkAndApproveToken(usdtContract, usdtNeeded, "USDT", LP_ADDRESS, txOptions)) return false;
        
        const wphrsContract = new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, wallet);
        if (!await checkAndApproveToken(wphrsContract, wphrsNeeded, "WPHRS", LP_ADDRESS, txOptions)) return false;
        
        const slippageMultiplier = BigInt(10000 - (slippage * 100));
        const baseMinAmount = (wphrsNeeded * slippageMultiplier) / 10000n;
        const quoteMinAmount = (usdtNeeded * slippageMultiplier) / 10000n;
        
        const lpContract = new ethers.Contract(LP_ADDRESS, LP_ABI, wallet);
        const tx = await lpContract.addDVMLiquidity(DVM_POOL_ADDRESS, wphrsNeeded, usdtNeeded, baseMinAmount, quoteMinAmount, 0, Math.floor(Date.now() / 1000) + 600, { nonce: await getNextNonce(), gasLimit: 600000, ...txOptions });
        
        addLog(`Add LP terkirim. Hash: ${tx.hash.slice(0,12)}...`, "success");
        const receipt = await tx.wait();
        if (receipt.status === 0) { addLog("Add LP gagal dieksekusi (reverted).", "error"); return false; }
        addLog(`Add LP berhasil.`, "success");
        return true;
    } catch (error) { addLog(`Add LP Gagal - ${error.message}`, "error"); return false; }
}

async function swapAllUsdtToPhrs(options) {
    const { slippage, txOptions } = options;
    addLog(chalk.bold.magenta("--- Memulai Cleanup: Swap semua USDT ke PHRS ---"), "info");
    try {
        // PERUBAHAN: Pengecekan gasBuffer dihapus
        const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);
        const usdtBalance = await usdtContract.balanceOf(wallet.address);
        if (usdtBalance < ethers.parseUnits("0.01", 6)) { addLog("Saldo USDT terlalu kecil untuk cleanup.", "info"); return true; }

        addLog(`Menukar semua ${ethers.formatUnits(usdtBalance, 6)} USDT...`, "info");
        if (!await checkAndApproveToken(usdtContract, usdtBalance, "USDT", ROUTER_ADDRESS, txOptions)) return false;
        
        const url = `https://api.dodoex.io/route-service/v2/widget/getdodoroute?chainId=688688&deadLine=${Math.floor(Date.now() / 1000) + 600}&apikey=a37546505892e1a952&slippage=${slippage}&fromTokenAddress=${USDT_ADDRESS}&toTokenAddress=${PHRS_ADDRESS}&userAddr=${wallet.address}&fromAmount=${usdtBalance}`;
        const routeResponse = await makeApiRequest("get", url);
        if (!routeResponse || routeResponse.status !== 200 || !routeResponse.data) { addLog(`Gagal mendapatkan rute Dodo untuk cleanup.`, "error"); return false; }
        
        const { to, data, value } = routeResponse.data;
        const tx = { to, data, value: value ? ethers.parseUnits(value, "wei") : 0, nonce: await getNextNonce(), gasLimit: 500000, ...txOptions };
        const sentTx = await wallet.sendTransaction(tx);
        addLog(`Cleanup Swap terkirim. Hash: ${sentTx.hash.slice(0,12)}...`, "success");
        const receipt = await sentTx.wait();
        if (receipt.status === 0) { addLog("Cleanup USDT gagal (reverted).", "error"); return false; }
        addLog("Cleanup USDT ke PHRS berhasil.", "success");
        return true;
    } catch (error) { addLog(`Gagal cleanup USDT: ${error.message}`, "error"); return false; }
}

async function unwrapAllWphrs(options) {
    const { txOptions } = options;
    addLog(chalk.bold.magenta("--- Memulai Cleanup: Unwrap semua WPHRS ke PHRS ---"), "info");
    try {
        // PERUBAHAN: Pengecekan gasBuffer dihapus
        const wphrsContract = new ethers.Contract(WPHRS_ADDRESS, WPHRS_ABI, wallet);
        const wphrsBalance = await wphrsContract.balanceOf(wallet.address);
        if (wphrsBalance <= 0) { addLog("Tidak ada saldo WPHRS untuk di-unwrap.", "info"); return true; }

        addLog(`Unwrapping semua ${ethers.formatEther(wphrsBalance)} WPHRS...`, "info");
        const tx = await wphrsContract.withdraw(wphrsBalance, { nonce: await getNextNonce(), ...txOptions });
        addLog(`Unwrap terkirim. Hash: ${tx.hash.slice(0,12)}...`, "success");
        const receipt = await tx.wait();
        if (receipt.status === 0) { addLog("Unwrap WPHRS gagal (reverted).", "error"); return false; }
        addLog("Unwrap WPHRS ke PHRS berhasil.", "success");
        return true;
    } catch (error) { addLog(`Gagal unwrap WPHRS: ${error.message}`, "error"); return false; }
}

// ===================================================================================
// FUNGSI UTAMA (MAIN EXECUTION)
// ===================================================================================
async function main() {
    console.log(chalk.blue.bold('\n--- Memulai Bot dengan Strategi Lengkap ---'));
    addLog(`Wallet: ${getShortAddress(wallet.address)}`, "info");
    
    // PERUBAHAN: Pengecekan gasBuffer awal dihapus
    await checkBalances();

    if (!await loginAndGetJwt()) { addLog("Proses dihentikan karena login gagal.", "error"); return; }

    // FASE 1: MODUL SWAP
    addLog(chalk.blue.bold("--- Memulai Modul Swap ---"), "info");
    for (let i = 1; i <= config.swapRepetitions; i++) {
        const isPHRSToUSDT = i % 2 === 1;
        await performAdvancedTaskWithRetry(async (options) => {
            const taskOptions = { ...options, fromToken: isPHRSToUSDT ? PHRS_ADDRESS : USDT_ADDRESS, toToken: isPHRSToUSDT ? USDT_ADDRESS : PHRS_ADDRESS };
            return await executeSwap(taskOptions);
        }, `Swap #${i}`);
        if (i < config.swapRepetitions) await sleep(randomDelay());
    }

    // FASE 2: MODUL ADD LIQUIDITY
    addLog(chalk.blue.bold("--- Memulai Modul Add Liquidity ---"), "info");
    for (let i = 1; i <= config.addLiquidityRepetitions; i++) {
        await performAdvancedTaskWithRetry(async (options) => await performLiquidityAddition(options), `Add LP #${i}`);
        if (i < config.addLiquidityRepetitions) await sleep(randomDelay());
    }

    // FASE 3: CLEANUP
    addLog(chalk.blue.bold("--- Memulai Fase Cleanup ---"), "info");
    await sleep(randomDelay());
    await performAdvancedTaskWithRetry(async (options) => await swapAllUsdtToPhrs(options), "Cleanup USDT");
    await sleep(randomDelay());
    await performAdvancedTaskWithRetry(async (options) => await unwrapAllWphrs(options), "Cleanup WPHRS");

    // SELESAI
    await sleep(5000);
    await checkBalances();
    console.log(chalk.green.bold('--- Siklus Strategi Telah Selesai ---\n'));
}

main().catch(error => {
    addLog(`Terjadi kesalahan fatal: ${error.message}`, "error");
    process.exit(1);
});
