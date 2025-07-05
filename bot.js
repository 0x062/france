import { ethers, MaxUint256 } from 'ethers';
import axios from 'axios';
import chalk from 'chalk';
import dotenv from 'dotenv';
import moment from 'moment-timezone';

dotenv.config();

// ===================================================================================
// KONFIGURASI
// ===================================================================================
const {
    PRIVATE_KEY, RPC_URL, SLIPPAGE_PERCENT, SWAP_REPETITIONS, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS,
    PHRS_SWAP_MIN, PHRS_SWAP_MAX, USDT_SWAP_MIN, USDT_SWAP_MAX,
    ADD_LIQUIDITY_REPETITIONS, LP_WPHRS_AMOUNT, LP_USDT_AMOUNT
} = process.env;

if (!PRIVATE_KEY || !RPC_URL) {
    console.error(chalk.red("❌ Error: Harap isi PRIVATE_KEY dan RPC_URL di file .env"));
    process.exit(1);
}

const config = {
    slippage: parseFloat(SLIPPAGE_PERCENT) || 5,
    swapRepetitions: parseInt(SWAP_REPETITIONS, 10) || 4,
    addLiquidityRepetitions: parseInt(ADD_LIQUIDITY_REPETITIONS, 10) || 1,
    minDelay: (parseInt(MIN_DELAY_SECONDS, 10) || 30) * 1000,
    maxDelay: (parseInt(MAX_DELAY_SECONDS, 10) || 60) * 1000,
    phrs: { min: parseFloat(PHRS_SWAP_MIN) || 0.01, max: parseFloat(PHRS_SWAP_MAX) || 0.05 },
    usdt: { min: parseFloat(USDT_SWAP_MIN) || 0.1, max: parseFloat(USDT_SWAP_MAX) || 1 },
    lp: {
        wphrs: LP_WPHRS_AMOUNT || "0.02",
        usdt: LP_USDT_AMOUNT || "0.5"
    }
};

// ===================================================================================
// KELAS UTAMA BOT
// ===================================================================================
class PharosBot {
    constructor(privateKey, rpcUrl) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.wallet = new ethers.Wallet(privateKey, this.provider);

        // --- Alamat Kontrak ---
        this.PHRS_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
        this.WPHRS_ADDRESS = "0x3019B247381c850ab53Dc0EE53bCe7A07Ea9155f";
        this.USDT_ADDRESS = "0xD4071393f8716661958F766DF660033b3d35fD29";
        // Tambahkan token lain jika perlu
        
        // PERUBAHAN KUNCI: Menggunakan Router Uniswap V2 yang Stabil
        this.UNISWAP_ROUTER_ADDRESS = "0xf05Af5E9dC3b1dd3ad0C087BD80D7391283775e0";

        // --- ABI (Application Binary Interface) ---
        this.ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address, uint256) returns (bool)", "function allowance(address, address) view returns (uint256)", "function decimals() view returns (uint8)"];
        this.WPHRS_ABI = [...this.ERC20_ABI, "function deposit() payable", "function withdraw(uint256)"];
        this.UNISWAP_ROUTER_ABI = ["function getAmountsOut(uint256, address[]) view returns (uint256[])", "function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256) returns (uint, uint, uint)", "function addLiquidityETH(address, uint256, uint256, uint256, address, uint256) payable returns (uint, uint, uint)", "function swapExactTokensForETH(uint, uint, address[], address, uint)", "function swapExactETHForTokens(uint, address[], address, uint) payable"];

        this.routerContract = new ethers.Contract(this.UNISWAP_ROUTER_ADDRESS, this.UNISWAP_ROUTER_ABI, this.wallet);
    }

    log(message, type = 'info') {
        const timestamp = moment().tz('Asia/Jakarta').format('HH:mm:ss');
        const colors = { info: 'white', success: 'green', error: 'red', warn: 'yellow' };
        console.log(`${chalk.bold.cyan(`[${timestamp}]`)} | ${chalk[colors[type]](message)}`);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    randomDelay() {
        return Math.floor(Math.random() * (config.maxDelay - config.minDelay + 1)) + config.minDelay;
    }

    getTokenAddress(ticker) {
        return this[`${ticker}_ADDRESS`] || null;
    }
    
    async waitForTx(txHash) {
        this.log(`Menunggu transaksi: ${chalk.yellow(txHash.slice(0, 15))}...`, 'wait');
        try {
            const receipt = await this.provider.waitForTransaction(txHash, 1, 180000);
            if (receipt && receipt.status === 1) {
                this.log(`Transaksi sukses!`, 'success');
                return true;
            } else {
                this.log(`Transaksi gagal (reverted).`, 'error');
                return false;
            }
        } catch (e) {
            this.log(`Gagal menunggu transaksi: ${e.message}`, 'error');
            return false;
        }
    }

    async approve(tokenAddress, amount) {
        const tokenContract = new ethers.Contract(tokenAddress, this.ERC20_ABI, this.wallet);
        try {
            const allowance = await tokenContract.allowance(this.wallet.address, this.UNISWAP_ROUTER_ADDRESS);
            if (allowance >= amount) return true;

            this.log(`Melakukan approve untuk token...`, 'info');
            const tx = await tokenContract.approve(this.UNISWAP_ROUTER_ADDRESS, MaxUint256);
            return await this.waitForTx(tx.hash);
        } catch (e) {
            this.log(`Gagal saat approve: ${e.message}`, 'error');
            return false;
        }
    }

    async swap(fromTicker, toTicker, amountDecimal) {
        this.log(`Mempersiapkan swap: ${amountDecimal} ${fromTicker} -> ${toTicker}`, 'info');
        const fromAddress = this.getTokenAddress(fromTicker);
        const toAddress = this.getTokenAddress(toTicker);
        const path = [fromAddress, toAddress];

        try {
            const fromContract = new ethers.Contract(fromAddress, this.ERC20_ABI, this.provider);
            const decimals = await fromContract.decimals();
            const amountIn = ethers.parseUnits(amountDecimal.toString(), Number(decimals));

            const amountsOut = await this.routerContract.getAmountsOut(amountIn, path);
            const amountOutMin = (amountsOut[1] * BigInt(10000 - config.slippage * 100)) / 10000n;
            
            if (!(await this.approve(fromAddress, amountIn))) return false;

            const tx = await this.routerContract.swapExactTokensForETH(
                amountIn, amountOutMin, path, this.wallet.address,
                Math.floor(Date.now() / 1000) + 600
            );

            return await this.waitForTx(tx.hash);
        } catch(e) {
            this.log(`Swap gagal: ${e.message}`, 'error');
            return false;
        }
    }

    async addLiquidity(tokenTicker, phrsAmountDecimal) {
        this.log(`Mempersiapkan Add LP: ${phrsAmountDecimal} PHRS dengan ${tokenTicker}`, 'info');
        try {
            const tokenAddress = this.getTokenAddress(tokenTicker);
            const phrsAmount = ethers.parseEther(phrsAmountDecimal);

            if (!(await this.approve(tokenAddress, MaxUint256))) return;

            const tx = await this.routerContract.addLiquidityETH(
                tokenAddress, phrsAmount, 0, 0, this.wallet.address,
                Math.floor(Date.now() / 1000) + 600,
                { value: phrsAmount }
            );
            return await this.waitForTx(tx.hash);
        } catch (e) {
            this.log(`Add LP gagal: ${e.message}`, 'error');
            return false;
        }
    }

    async cleanup(tokenTicker) {
        this.log(`Memulai Cleanup untuk ${tokenTicker}...`, 'info');
        try {
            const tokenAddress = this.getTokenAddress(tokenTicker);
            const tokenContract = new ethers.Contract(tokenAddress, this.ERC20_ABI, this.provider);
            const balance = await tokenContract.balanceOf(this.wallet.address);

            if (balance <= 0) {
                this.log(`Tidak ada saldo ${tokenTicker} untuk di-cleanup.`, 'info');
                return true;
            }

            this.log(`Menukar semua sisa ${ethers.formatUnits(balance, await tokenContract.decimals())} ${tokenTicker} ke PHRS...`);
            return await this.swap(tokenTicker, 'PHRS', ethers.formatUnits(balance, await tokenContract.decimals()));

        } catch (e) {
            this.log(`Cleanup ${tokenTicker} gagal: ${e.message}`, 'error');
            return false;
        }
    }

    async run() {
        this.log(chalk.blue.bold('--- Memulai Bot Pharoswap ---'));
        this.log(`Akun: ${this.wallet.address}`);

        // FASE 1: SWAP
        this.log(chalk.blue.bold('\n--- FASE 1: Melakukan Swap Acak ---'));
        for (let i = 0; i < config.swapRepetitions; i++) {
            this.log(`--- Swap #${i + 1}/${config.swapRepetitions} ---`, 'info');
            const from = i % 2 === 0 ? 'PHRS' : 'USDT';
            const to = i % 2 === 0 ? 'USDT' : 'PHRS';
            const amount = from === 'PHRS' ? getRandomAmount(config.phrs.min, config.phrs.max).toFixed(4) : getRandomAmount(config.usdt.min, config.usdt.max).toFixed(4);
            await this.swap(from, to, amount);
            await this.sleep(this.randomDelay());
        }

        // FASE 2: ADD LIQUIDITY
        this.log(chalk.blue.bold('\n--- FASE 2: Menambah Likuiditas ---'));
        for (let i = 0; i < config.addLiquidityRepetitions; i++) {
            this.log(`--- Add LP #${i + 1}/${config.addLiquidityRepetitions} ---`, 'info');
            await this.addLiquidity('USDT', config.lp.phrs);
            await this.sleep(this.randomDelay());
        }

        // FASE 3: CLEANUP
        this.log(chalk.blue.bold('\n--- FASE 3: Cleanup Aset ---'));
        await this.cleanup('USDT');
        // Tambahkan cleanup untuk token lain jika perlu
        // await this.cleanup('WPHRS');

        this.log(chalk.green.bold('\n--- Semua Tugas Selesai ---'));
    }
}

// ===================================================================================
// EKSEKUSI UTAMA
// ===================================================================================
async function main() {
    try {
        const bot = new PharosBot(PRIVATE_KEY, RPC_URL);
        await bot.run();
    } catch (e) {
        console.log(chalk.red(`\n❌ Terjadi kesalahan fatal: ${e.message}`));
    }
}

main();
