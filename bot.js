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
    ADD_LIQUIDITY_REPETITIONS, LP_WPHRS_AMOUNT
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
        phrs: LP_WPHRS_AMOUNT || "0.02",
    }
};

// ===================================================================================
// KELAS UTAMA BOT
// ===================================================================================
class PharosBot {
    constructor(privateKey, rpcUrl) {
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.wallet = new ethers.Wallet(privateKey, this.provider);

        this.PHRS_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
        this.WPHRS_ADDRESS = "0x3019B247381c850ab53Dc0EE53bCe7A07Ea9155f";
        this.USDT_ADDRESS = "0xD4071393f8716661958F766DF660033b3d35fD29";
        
        this.UNISWAP_ROUTER_ADDRESS = "0xf05Af5E9dC3b1dd3ad0C087BD80D7391283775e0";

        this.ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address, uint256) returns (bool)", "function allowance(address, address) view returns (uint256)", "function decimals() view returns (uint8)"];
        this.UNISWAP_ROUTER_ABI = [
            "function getAmountsOut(uint256, address[]) view returns (uint256[])",
            "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)",
            "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
            "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)"
        ];

        this.routerContract = new ethers.Contract(this.UNISWAP_ROUTER_ADDRESS, this.UNISWAP_ROUTER_ABI, this.wallet);
    }

    log(message, type = 'info') {
        const timestamp = moment().tz('Asia/Jakarta').format('HH:mm:ss');
        const colors = { info: 'white', success: 'green', error: 'red', warn: 'yellow' };
        console.log(`${chalk.bold.cyan(`[${timestamp}]`)} | ${chalk[colors[type] || 'white'](message)}`);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    randomDelay() {
        return Math.floor(Math.random() * (config.maxDelay - config.minDelay + 1)) + config.minDelay;
    }

    getRandomAmount(min, max) {
        return Math.random() * (max - min) + min;
    }

    getTokenAddress(ticker) {
        return this[`${ticker}_ADDRESS`] || null;
    }
    
    async waitForTx(txHash) {
        this.log(`Menunggu transaksi: ${chalk.yellow(txHash.slice(0, 15))}...`, 'warn');
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
        
        // --- PERBAIKAN KUNCI: Gunakan alamat WPHRS untuk path quoting ---
        const path = [
            fromAddress === this.PHRS_ADDRESS ? this.WPHRS_ADDRESS : fromAddress,
            toAddress === this.PHRS_ADDRESS ? this.WPHRS_ADDRESS : toAddress
        ];

        try {
            const isSwappingFromNative = fromTicker === 'PHRS';
            const isSwappingToNative = toTicker === 'PHRS';

            let amountIn, tx;
            const amountsOut = await this.routerContract.getAmountsOut(
                isSwappingFromNative ? ethers.parseEther(amountDecimal.toString()) : ethers.parseUnits(amountDecimal.toString(), await new ethers.Contract(fromAddress, this.ERC20_ABI, this.provider).decimals()),
                path
            );
            const amountOutMin = (amountsOut[1] * BigInt(10000 - config.slippage * 100)) / 10000n;

            if (isSwappingFromNative) {
                amountIn = ethers.parseEther(amountDecimal.toString());
                tx = await this.routerContract.swapExactETHForTokens(amountOutMin, path, this.wallet.address, Math.floor(Date.now() / 1000) + 600, { value: amountIn });
            } else {
                const fromContract = new ethers.Contract(fromAddress, this.ERC20_ABI, this.provider);
                const decimals = await fromContract.decimals();
                amountIn = ethers.parseUnits(amountDecimal.toString(), Number(decimals));

                if (!(await this.approve(fromAddress, amountIn))) return false;
                
                if (isSwappingToNative) {
                    tx = await this.routerContract.swapExactTokensForETH(amountIn, amountOutMin, path, this.wallet.address, Math.floor(Date.now() / 1000) + 600);
                } else {
                    this.log('Swap Token -> Token belum diimplementasikan.', 'warn');
                    return false;
                }
            }
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
            const phrsAmount = ethers.parseEther(phrsAmountDecimal.toString());
            
            const amountsOut = await this.routerContract.getAmountsOut(phrsAmount, [this.WPHRS_ADDRESS, tokenAddress]);
            const tokenAmountDesired = amountsOut[1];
            
            const tokenContract = new ethers.Contract(tokenAddress, this.ERC20_ABI, this.provider);
            this.log(`Dibutuhkan sekitar ${ethers.formatUnits(tokenAmountDesired, await tokenContract.decimals())} ${tokenTicker}`);

            if (!(await this.approve(tokenAddress, tokenAmountDesired))) return false;

            const tx = await this.routerContract.addLiquidityETH(
                tokenAddress, tokenAmountDesired, 0, 0,
                this.wallet.address, Math.floor(Date.now() / 1000) + 600,
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
            const decimals = await tokenContract.decimals();
            
            if (balance <= 0) {
                this.log(`Tidak ada saldo ${tokenTicker} untuk di-cleanup.`, 'info');
                return true;
            }

            const balanceDecimal = ethers.formatUnits(balance, decimals);
            this.log(`Menukar semua sisa ${balanceDecimal} ${tokenTicker} ke PHRS...`);
            return await this.swap(tokenTicker, 'PHRS', balanceDecimal);

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
            
            const amount = from === 'PHRS' 
                ? this.getRandomAmount(config.phrs.min, config.phrs.max).toFixed(5) 
                : this.getRandomAmount(config.usdt.min, config.usdt.max).toFixed(5);
            
            await this.swap(from, to, amount);

            if (i < config.swapRepetitions - 1 || config.addLiquidityRepetitions > 0) {
                const delay = this.randomDelay();
                this.log(`Menunggu ${delay / 1000} detik...`, 'wait');
                await this.sleep(delay);
            }
        }
        
        // FASE 2: ADD LIQUIDITY
        this.log(chalk.blue.bold('\n--- FASE 2: Menambah Likuiditas ---'));
        for (let i = 0; i < config.addLiquidityRepetitions; i++) {
            this.log(`--- Add LP #${i + 1}/${config.addLiquidityRepetitions} ---`, 'info');
            await this.addLiquidity('USDT', config.lp.phrs);
            if (i < config.addLiquidityRepetitions - 1 || true) {
                await this.sleep(this.randomDelay());
            }
        }

        // FASE 3: CLEANUP
        this.log(chalk.blue.bold('\n--- FASE 3: Cleanup Aset ---'));
        await this.cleanup('USDT');

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
        console.log(chalk.red(`\n❌ Terjadi kesalahan fatal: ${e.stack}`));
    }
}

main();
