import chalk from "chalk";
import { ethers } from "ethers";
import fs from "fs";
import axios from "axios";
import 'dotenv/config';

// ===================================================================================
// VALIDASI DAN MEMUAT KONFIGURASI DARI .ENV
// ===================================================================================

const {
    PRIVATE_KEY,
    RPC_URL,
    SWAP_REPETITIONS,
    // Variabel lain yang mungkin Anda tambahkan nanti
} = process.env;

if (!PRIVATE_KEY || !RPC_URL) {
    console.error(chalk.red("Error: PRIVATE_KEY dan RPC_URL harus ada di file .env"));
    process.exit(1);
}

const config = {
    swapRepetitions: parseInt(SWAP_REPETITIONS, 10) || 5,
    minDelay: 30 * 1000,
    maxDelay: 60 * 1000,
    // Cadangan gas fee dalam PHRS
    gasBuffer: ethers.parseEther("0.0005")
};

// ===================================================================================
// KONSTANTA & ALAMAT KONTRAK
// ===================================================================================

const PHRS_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WPHRS_ADDRESS = "0x3019b247381c850ab53dc0ee53bce7a07ea9155f";
const USDT_ADDRESS = "0xd4071393f8716661958f766df660033b3d35fd29";
const ROUTER_ADDRESS = "0x3541423f25a1ca5c98fdbcf478405d3f0aad1164";
const LP_ADDRESS = "0x4b177aded3b8bd1d5d747f91b9e853513838cd49";
const API_BASE_URL = "https://api.pharosnetwork.xyz";
const isDebug = false;
let nonceTracker = {};
let jwtToken = null;

// ===================================================================================
// ABI KONTRAK
// ===================================================================================

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)"];
const ROUTER_ABI = ["function mixSwap(address fromToken, address toToken, uint256 fromAmount, uint256 resAmount, uint256 minReturnAmount, address[] memory proxyList, address[] memory poolList, address[] memory routeList, uint256 direction, bytes[] memory moreInfos, uint256 deadLine) external payable returns (uint256)"];
const LP_ABI = ["function addDVMLiquidity(address dvmAddress, uint256 baseInAmount, uint256 quoteInAmount, uint256 baseMinAmount, uint256 quoteMinAmount, uint8 flag, uint256 deadLine) external payable returns (uint256, uint256, uint256)"];

// ===================================================================================
// FUNGSI UTILITAS
// ===================================================================================

function addLog(message, type = "info") {
    const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
    let coloredMessage;
    switch (type) {
        case "error": coloredMessage = chalk.red(message); break;
        case "success": coloredMessage = chalk.green(message); break;
        case "wait": coloredMessage = chalk.yellow(message); break;
        case "warn": coloredMessage = chalk.yellow(message); break;
        default: coloredMessage = chalk.white(message);
    }
    console.log(`[${timestamp}] ${coloredMessage}`);
}

function getShortAddress(address) { return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "N/A"; }
function getShortHash(hash) { return hash ? `${hash.slice(0, 10)}...${hash.slice(-8)}` : "N/A"; }
async function sleep(ms) {
    addLog(`Menunggu selama ${ms / 1000} detik...`, "wait");
    return new Promise(resolve => setTimeout(resolve, ms));
}
function randomDelay() { return Math.floor(Math.random() * (config.maxDelay - config.minDelay + 1)) + config.minDelay; }

// ===================================================================================
// INISIALISASI PROVIDER & WALLET
// ===================================================================================

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ===================================================================================
// FUNGSI INTI (DENGAN KECERDASAN SALDO)
// ===================================================================================

const getApiHeaders = (customHeaders = {}) => ({
    "Accept": "application/json, text/plain, */*", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36", "Origin": "https://testnet.pharosnetwork.xyz", "Referer": "https://testnet.pharosnetwork.xyz/", ...customHeaders
});

async function makeApiRequest(method, url, data, customHeaders = {}, maxRetries = 3) { /* ... (fungsi ini tidak berubah) ... */ 
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const headers = getApiHeaders(customHeaders);
            const config = { method, url, data, headers, timeout: 15000 };
            const response = await axios(config);
            return response.data;
        } catch (error) {
            lastError = error;
            let errorMessage = `API request ke ${url} gagal (percobaan ${attempt}/${maxRetries}): `;
            if (error.response) { errorMessage += `Status code ${error.response.status} - ${JSON.stringify(error.response.data)}`; } else { errorMessage += error.message; }
            addLog(errorMessage, "error");
            if (attempt < maxRetries) await sleep(2000);
        }
    }
    throw new Error(`Gagal membuat request API ke ${url} setelah ${maxRetries} percobaan.`);
}

async function getNextNonce() { /* ... (fungsi ini tidak berubah) ... */ 
    try {
        const pendingNonce = await provider.getTransactionCount(wallet.address, "pending");
        const lastUsedNonce = nonceTracker[wallet.address] || pendingNonce - 1;
        const nextNonce = Math.max(pendingNonce, lastUsedNonce + 1);
        nonceTracker[wallet.address] = nextNonce;
        return nextNonce;
    } catch (error) { addLog(`Gagal mendapatkan nonce: ${error.message}`, "error"); throw error; }
}

async function checkAndApproveToken(tokenContract, amount, tokenName, spenderAddress) {
    try {
        const allowance = await tokenContract.allowance(wallet.address, spenderAddress);
        if (allowance < amount) {
            addLog(`Melakukan approve untuk ${ethers.formatUnits(amount, tokenName === 'USDT' ? 6 : 18)} ${tokenName}...`, "info");
            const nonce = await getNextNonce();
            const tx = await tokenContract.approve(spenderAddress, ethers.MaxUint256, { nonce });
            addLog(`Approval terkirim. Hash: ${getShortHash(tx.hash)}`, "success");
            await tx.wait();
            addLog(`Approval untuk ${tokenName} berhasil.`, "success");
        }
        return true;
    } catch (error) {
        addLog(`Gagal approve ${tokenName}: ${error.message}`, "error");
        return false;
    }
}

async function executeSwap(swapCount, fromToken, toToken) {
    const fromTokenName = fromToken === PHRS_ADDRESS ? "PHRS" : "USDT";
    const toTokenName = toToken === PHRS_ADDRESS ? "PHRS" : "USDT";

    try {
        let fromAmount;
        let balance;

        // --- PERBAIKAN: Logika Cerdas untuk menentukan jumlah dan memeriksa saldo ---
        if (fromToken === USDT_ADDRESS) {
            const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);
            balance = await usdtContract.balanceOf(wallet.address);
            // Ambil 25% - 50% dari saldo USDT yang ada
            const percentageToSwap = (Math.random() * (0.50 - 0.25) + 0.25);
            fromAmount = balance * BigInt(Math.floor(percentageToSwap * 100)) / 100n;
            
            if (fromAmount < ethers.parseUnits("0.1", 6)) { // Jangan swap jika hasilnya terlalu kecil
                addLog(`Saldo USDT terlalu kecil untuk di-swap, melewati.`, "warn");
                return false;
            }

        } else { // fromToken adalah PHRS
            balance = await provider.getBalance(wallet.address);
            // Sisa saldo setelah dikurangi cadangan gas
            const swappableBalance = balance - config.gasBuffer;
            if (swappableBalance <= 0) {
                addLog(`Saldo PHRS tidak cukup untuk swap + gas, melewati.`, "warn");
                return false;
            }
            // Ambil 5% - 10% dari saldo PHRS yang bisa di-swap
            const percentageToSwap = (Math.random() * (0.10 - 0.05) + 0.05);
            fromAmount = swappableBalance * BigInt(Math.floor(percentageToSwap * 100)) / 100n;
        }
        
        const decimals = fromToken === PHRS_ADDRESS ? 18 : 6;
        addLog(`Swap #${swapCount}: Mempersiapkan swap ${parseFloat(ethers.formatUnits(fromAmount, decimals)).toFixed(4)} ${fromTokenName} ke ${toTokenName}`, "info");

        if (fromToken !== PHRS_ADDRESS) {
            const tokenContract = new ethers.Contract(fromToken, ERC20_ABI, wallet);
            if (!await checkAndApproveToken(tokenContract, fromAmount, fromTokenName, ROUTER_ADDRESS)) return false;
        }

        const url = `https://api.dodoex.io/route-service/v2/widget/getdodoroute?chainId=688688&deadLine=${Math.floor(Date.now() / 1000) + 600}&apikey=a37546505892e1a952&slippage=10.401&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&userAddr=${wallet.address}&fromAmount=${fromAmount}`;
        const routeResponse = await makeApiRequest("get", url);
        if (!routeResponse || routeResponse.status !== 200 || !routeResponse.data) {
            addLog(`Gagal mendapatkan rute dari Dodo: ${routeResponse?.message || 'No response'}`, "error");
            return false;
        }

        const { to, data, value } = routeResponse.data;
        const tx = { to, data, value: value ? ethers.parseUnits(value, "wei") : 0, nonce: await getNextNonce(), gasLimit: 500000 };

        const sentTx = await wallet.sendTransaction(tx);
        addLog(`Swap #${swapCount}: Transaksi terkirim. Hash: ${getShortHash(sentTx.hash)}`, "success");
        await sentTx.wait();
        addLog(`Swap #${swapCount}: Swap ${fromTokenName} ➯ ${toTokenName} berhasil dikonfirmasi.`, "success");
        return true;
    } catch (error) {
        addLog(`Swap #${swapCount}: Gagal - ${error.message}`, "error");
        return false;
    }
}

async function loginAndGetJwt() { /* ... (fungsi ini tidak berubah) ... */ 
    addLog("Mencoba login untuk mendapatkan JWT...", "info");
    try {
        const message = "pharos";
        const signature = await wallet.signMessage(message);
        const loginUrl = `${API_BASE_URL}/user/login?address=${wallet.address}&signature=${signature}`;
        const loginResponse = await makeApiRequest("post", loginUrl);
        if (loginResponse.code === 0 && loginResponse.data.jwt) {
            jwtToken = loginResponse.data.jwt;
            addLog("Login berhasil, JWT diterima.", "success");
            return true;
        } else { addLog(`Login gagal: ${loginResponse.msg}`, "error"); return false; }
    } catch (error) { addLog(`Error saat login: ${error.message}`, "error"); return false; }
}

async function dailyCheckIn() { /* ... (fungsi ini tidak berubah) ... */ 
    if (!jwtToken) { addLog("Tidak ada JWT, check-in dilewati.", "warn"); return; }
    addLog("Melakukan daily check-in...", "info");
    try {
        const checkinUrl = `${API_BASE_URL}/sign/in?address=${wallet.address}`;
        const headers = { "Authorization": `Bearer ${jwtToken}` };
        const response = await makeApiRequest("post", checkinUrl, {}, headers);
        if (response.code === 0) { addLog("Daily check-in berhasil.", "success"); } else { addLog(`Check-in gagal: ${response.msg}`, "error"); }
    } catch (error) { addLog(`Error saat check-in: ${error.message}`, "error"); }
}

async function checkBalances() { /* ... (fungsi ini tidak berubah) ... */
    addLog("Mengecek saldo wallet...", "info");
    try {
        const phrsBalance = await provider.getBalance(wallet.address);
        const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
        const usdtBalance = await usdtContract.balanceOf(wallet.address);
        const wphrsContract = new ethers.Contract(WPHRS_ADDRESS, ERC20_ABI, provider);
        const wphrsBalance = await wphrsContract.balanceOf(wallet.address);

        addLog(`PHRS: ${chalk.cyan(parseFloat(ethers.formatEther(phrsBalance)).toFixed(4))}`, "info");
        addLog(`USDT: ${chalk.cyan(parseFloat(ethers.formatUnits(usdtBalance, 6)).toFixed(4))}`, "info");
        addLog(`WPHRS: ${chalk.cyan(parseFloat(ethers.formatEther(wphrsBalance)).toFixed(4))}`, "info");
        // PERBAIKAN: Kembalikan nilai saldo agar bisa digunakan fungsi lain
        return { phrsBalance, usdtBalance, wphrsBalance };
    } catch (error) {
        addLog(`Gagal mengecek saldo: ${error.message}`, "error");
        throw new Error(`Tidak bisa melanjutkan karena gagal mengecek saldo awal. Pastikan RPC benar.`);
    }
}

// ===================================================================================
// FUNGSI UTAMA (MAIN EXECUTION)
// ===================================================================================

async function main() {
    addLog(chalk.bold.yellow("================================================="));
    addLog(chalk.bold.yellow("         MEMULAI PROSES OTOMATISASI          "));
    addLog(chalk.bold.yellow("================================================="));
    addLog(`Wallet: ${getShortAddress(wallet.address)}`);

    const initialBalances = await checkBalances();

    // --- PERBAIKAN: Cek saldo gas utama di awal ---
    if (initialBalances.phrsBalance < config.gasBuffer) {
        addLog("SALDO PHRS TIDAK CUKUP UNTUK BIAYA GAS. Proses dihentikan.", "error");
        return;
    }

    if (!await loginAndGetJwt()) {
        addLog("Proses dihentikan karena login gagal.", "error");
        return;
    }

    // --- Modul Swap ---
    try {
        addLog(chalk.bold.blue("--- Memulai Modul Swap ---"), "info");
        for (let i = 1; i <= config.swapRepetitions; i++) {
            const isPHRSToUSDT = i % 2 === 1;
            const fromToken = isPHRSToUSDT ? PHRS_ADDRESS : USDT_ADDRESS;
            const toToken = isPHRSToUSDT ? USDT_ADDRESS : PHRS_ADDRESS;

            await executeSwap(i, fromToken, toToken);
            if (i < config.swapRepetitions) await sleep(randomDelay());
        }
    } catch (error) {
        addLog(`Terjadi error pada Modul Swap: ${error.message}`, "error");
    }

    // --- Modul Add Liquidity (Contoh implementasi cerdas di masa depan) ---
    // Untuk saat ini, kita bisa lewati dulu karena kompleksitasnya
    addLog(chalk.bold.blue("--- Modul Add Liquidity (Dilewati) ---"), "info");

    // --- Modul Daily Check-in ---
    try {
        await dailyCheckIn();
    } catch(error) {
        addLog(`Terjadi error pada Modul Check-in: ${error.message}`, "error");
    }

    await sleep(5000);
    await checkBalances();

    addLog(chalk.bold.green("================================================="));
    addLog(chalk.bold.green("        SIKLUS TUGAS TELAH SELESAI          "));
    addLog(chalk.bold.green("================================================="));
}

main().catch(error => {
    addLog(`Terjadi kesalahan fatal yang tidak tertangani: ${error.message}`, "error");
    process.exit(1);
});
