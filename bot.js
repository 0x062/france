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
    MIN_DELAY_SECONDS,
    MAX_DELAY_SECONDS,
    // PERUBAHAN: Membaca variabel range swap dari .env
    PHRS_SWAP_MIN,
    PHRS_SWAP_MAX,
    USDT_SWAP_MIN,
    USDT_SWAP_MAX,
} = process.env;

if (!PRIVATE_KEY || !RPC_URL) {
    console.error(chalk.red("Error: PRIVATE_KEY dan RPC_URL harus ada di file .env"));
    process.exit(1);
}

const config = {
    swapRepetitions: parseInt(SWAP_REPETITIONS, 10) || 4,
    minDelay: (parseInt(MIN_DELAY_SECONDS, 10) || 30) * 1000,
    maxDelay: (parseInt(MAX_DELAY_SECONDS, 10) || 60) * 1000,
    gasBuffer: ethers.parseEther("0.0005"),

    // PERUBAHAN: Menyimpan konfigurasi range swap
    phrs: {
        min: parseFloat(PHRS_SWAP_MIN) || 0.01,
        max: parseFloat(PHRS_SWAP_MAX) || 0.1,
    },
    usdt: {
        min: parseFloat(USDT_SWAP_MIN) || 0.1,
        max: parseFloat(USDT_SWAP_MAX) || 1,
    },
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
let nonceTracker = {};
let jwtToken = null;

// ===================================================================================
// ABI KONTRAK
// ===================================================================================

const ERC20_ABI = ["function balanceOf(address owner) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)"];

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
// PERUBAHAN: Fungsi helper untuk mendapatkan jumlah acak dalam range
function getRandomAmount(min, max) { return Math.random() * (max - min) + min; }

// ===================================================================================
// INISIALISASI PROVIDER & WALLET
// ===================================================================================

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ===================================================================================
// FUNGSI INTI
// ===================================================================================

const getApiHeaders = (customHeaders = {}) => ({
    "Accept": "application/json, text/plain, */*", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36", "Origin": "https://testnet.pharosnetwork.xyz", "Referer": "https://testnet.pharosnetwork.xyz/", ...customHeaders
});

async function makeApiRequest(method, url, data, customHeaders = {}, maxRetries = 3) {
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

async function getNextNonce() {
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
        let amountToSwap;
        let balance;
        let decimals;

        // --- PERUBAHAN: Logika Cerdas untuk menentukan jumlah berdasarkan range manual ---
        if (fromToken === USDT_ADDRESS) {
            decimals = 6;
            const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, wallet);
            balance = await usdtContract.balanceOf(wallet.address);
            amountToSwap = getRandomAmount(config.usdt.min, config.usdt.max);
        } else { // fromToken adalah PHRS
            decimals = 18;
            balance = await provider.getBalance(wallet.address);
            amountToSwap = getRandomAmount(config.phrs.min, config.phrs.max);
        }

        const fromAmountInWei = ethers.parseUnits(amountToSwap.toFixed(decimals), decimals);

        // --- KECERDASAN LAMA YANG DIpertahankan: Cek Saldo ---
        const requiredBalance = fromToken === PHRS_ADDRESS ? fromAmountInWei + config.gasBuffer : fromAmountInWei;
        if (balance < requiredBalance) {
            addLog(`Saldo ${fromTokenName} tidak cukup untuk swap. Dibutuhkan: ~${parseFloat(ethers.formatUnits(requiredBalance, decimals)).toFixed(4)}, Tersedia: ${parseFloat(ethers.formatUnits(balance, decimals)).toFixed(4)}. Melewati swap.`, "warn");
            return false;
        }

        addLog(`Swap #${swapCount}: Mempersiapkan swap ${amountToSwap.toFixed(4)} ${fromTokenName} ke ${toTokenName}`, "info");

        if (fromToken !== PHRS_ADDRESS) {
            const tokenContract = new ethers.Contract(fromToken, ERC20_ABI, wallet);
            if (!await checkAndApproveToken(tokenContract, fromAmountInWei, fromTokenName, ROUTER_ADDRESS)) return false;
        }
        
        const url = `https://api.dodoex.io/route-service/v2/widget/getdodoroute?chainId=688688&deadLine=${Math.floor(Date.now() / 1000) + 600}&apikey=a37546505892e1a952&slippage=10.401&fromTokenAddress=${fromToken}&toTokenAddress=${toToken}&userAddr=${wallet.address}&fromAmount=${fromAmountInWei}`;
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

async function loginAndGetJwt() {
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

async function dailyCheckIn() {
    if (!jwtToken) { addLog("Tidak ada JWT, check-in dilewati.", "warn"); return; }
    addLog("Melakukan daily check-in...", "info");
    try {
        const checkinUrl = `${API_BASE_URL}/sign/in?address=${wallet.address}`;
        const headers = { "Authorization": `Bearer ${jwtToken}` };
        const response = await makeApiRequest("post", checkinUrl, {}, headers);
        if (response.code === 0) { addLog("Daily check-in berhasil.", "success"); } else { addLog(`Check-in gagal: ${response.msg}`, "error"); }
    } catch (error) { addLog(`Error saat check-in: ${error.message}`, "error"); }
}

async function checkBalances() {
    addLog("Mengecek saldo wallet...", "info");
    try {
        const phrsBalance = await provider.getBalance(wallet.address);
        const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, provider);
        const usdtBalance = await usdtContract.balanceOf(wallet.address);

        addLog(`PHRS: ${chalk.cyan(parseFloat(ethers.formatEther(phrsBalance)).toFixed(4))}`, "info");
        addLog(`USDT: ${chalk.cyan(parseFloat(ethers.formatUnits(usdtBalance, 6)).toFixed(4))}`, "info");
        return { phrsBalance };
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

    if (initialBalances.phrsBalance < config.gasBuffer) {
        addLog(`SALDO PHRS (${ethers.formatEther(initialBalances.phrsBalance)} PHRS) TIDAK CUKUP UNTUK BIAYA GAS MINIMUM (${ethers.formatEther(config.gasBuffer)} PHRS). Proses dihentikan.`, "error");
        return;
    }

    if (!await loginAndGetJwt()) {
        addLog("Proses dihentikan karena login gagal.", "error");
        return;
    }

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
