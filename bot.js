import { ethers, MaxUint256 } from 'ethers';
import chalk from 'chalk';
import dotenv from 'dotenv';
import moment from 'moment-timezone';

dotenv.config();

// ===================================================================================
// KONFIGURASI
// ===================================================================================
const {
    PRIVATE_KEY, RPC_URL, SLIPPAGE_PERCENT, SWAP_REPETITIONS, MIN_DELAY_SECONDS, MAX_DELAY_SECONDS,
    PHRS_WRAP_AMOUNT, WPHRS_SWAP_MIN, WPHRS_SWAP_MAX, USDT_SWAP_MIN, USDT_SWAP_MAX,
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
    phrsToWrap: PHRS_WRAP_AMOUNT || "0.1",
    wphrs: { min: parseFloat(WPHRS_SWAP_MIN) || 0.01, max: parseFloat(WPHRS_SWAP_MAX) || 0.05 },
    usdt: { min: parseFloat(USDT_SWAP_MIN) || 0.1, max: parseFloat(USDT_SWAP_MAX) || 1 },
    lp: {
        wphrs: LP_WPHRS_AMOUNT || "0.02",
    }
};

// ===================================================================================
// KELAS UTAMA BOT
// ===================================================================================
class PharosBot {
    constructor(privateKey, rpcUrl) {
        // PERBAIKAN: Kembali menggunakan JsonRpcProvider yang stabil
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.wallet = new ethers.Wallet(privateKey, this.provider);

        this.PHRS_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
        this.WPHRS_ADDRESS = "0x3019B247381c850ab53Dc0EE53bCe7A07Ea9155f";
        this.USDT_ADDRESS = "0xD4071393f8716661958F766DF660033b3d35fD29";
        
        this.UNISWAP_ROUTER_ADDRESS = "0xf05Af5E9dC3b1dd3ad0C087BD80D7391283775e0";

        this.ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address, uint256) returns (bool)", "function allowance(address, address) view returns (uint256)", "function decimals() view returns (uint8)"];
        this.WPHRS_ABI = [...this.ERC20_ABI, "function deposit() payable", "function withdraw(uint256)"];
        this.UNISWAP_ROUTER_ABI = [
            "function getAmountsOut(uint256, address[]) view returns (uint256[])",
            "function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)",
            "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
            "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)",
            "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)"
        ];

        this.routerContract = new ethers.Contract(this.UNISWAP_ROUTER_ADDRESS, this.UNISWAP_ROUTER_ABI, this.wallet);
    }

    log(message, type = 'info') {
        const timestamp = moment().tz('Asia/Jakarta').format('HH:mm:ss');
        const colors = { info: 'white', success: 'green', error: 'red', warn: 'yellow' };
        console.log(`${chalk.bold.cyan(`[${timestamp}]`)} | ${chalk[colors[type] || 'white'](message)}`);
    }

    sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    randomDelay() { return Math.floor(Math.random() * (config.maxDelay - config.minDelay + 1)) + config.minDelay; }
    getRandomAmount(min, max) { return Math.random() * (max - min) + min; }
    getTokenAddress(ticker) { return this[`${ticker}_ADDRESS`]; }

    async waitForTx(txHash) {
        this.log(`Menunggu transaksi: ${chalk.yellow(txHash.slice(0, 15))}...`, 'warn');
        try {
            const receipt = await this.provider.waitForTransaction(txHash, 1, 180000);
            if (receipt && receipt.status === 1) { this.log(`Transaksi sukses!`, 'success'); return true; }
            else { this.log(`Transaksi gagal (reverted).`, 'error'); return false; }
        } catch (e) { this.log(`Gagal menunggu transaksi: ${e.message}`, 'error'); return false; }
    }

    async approve(tokenAddress, amount) {
        const tokenContract = new ethers.Contract(tokenAddress, this.ERC20_ABI, this.wallet);
        try {
            const allowance = await tokenContract.allowance(this.wallet.address, this.UNISWAP_ROUTER_ADDRESS);
            if (allowance >= amount) return true;
            this.log(`Melakukan approve untuk token...`, 'info');
            const tx = await tokenContract.approve(this.UNISWAP_ROUTER_ADDRESS, MaxUint256);
            return await this.waitForTx(tx.hash);
        } catch (e) { this.log(`Gagal saat approve: ${e.message}`, 'error'); return false; }
    }

    async wrap(amountDecimal) {
        this.log(`Mempersiapkan wrap ${amountDecimal} PHRS -> WPHRS`, 'info');
        try {
            const amountWei = ethers.parseEther(amountDecimal);
            const wphrsContract = new ethers.Contract(this.WPHRS_ADDRESS, this.WPHRS_ABI, this.wallet);
            const tx = await wphrsContract.deposit({ value: amountWei });
            return await this.waitForTx(tx.hash);
        } catch (e) { this.log(`Wrap gagal: ${e.message}`, 'error'); return false; }
    }
    
    async unwrapAll() {
        this.log(`Mempersiapkan unwrap semua WPHRS -> PHRS`, 'info');
        const wphrsContract = new ethers.Contract(this.WPHRS_ADDRESS, this.WPHRS_ABI, this.wallet);
        try {
            const balance = await wphrsContract.balanceOf(this.wallet.address);
            if (balance <= 0) { this.log('Tidak ada WPHRS untuk di-unwrap.', 'info'); return true; }
            const tx = await wphrsContract.withdraw(balance);
            return await this.waitForTx(tx.hash);
        } catch (e) { this.log(`Unwrap gagal: ${e.message}`, 'error'); return false; }
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

            if (!(await this.approve(fromAddress, amountIn))) return false;
            
            const amountsOut = await this.routerContract.getAmountsOut(amountIn, path);
            const amountOutMin = (amountsOut[1] * BigInt(10000 - config.slippage * 100)) / 10000n;

            const tx = await this.routerContract.swapExactTokensForTokens(
                amountIn, amountOutMin, path, this.wallet.address,
                Math.floor(Date.now() / 1000) + 600
            );
            return await this.waitForTx(tx.hash);
        } catch(e) { this.log(`Swap gagal: ${e.message}`, 'error'); return false; }
    }

    async addLiquidity(tokenATicker, tokenBTicker, amountADecimal) {
        this.log(`Mempersiapkan Add LP: ${amountADecimal} ${tokenATicker} dengan ${tokenBTicker}`, 'info');
        try {
            const tokenAAddress = this.getTokenAddress(tokenATicker);
            const tokenBAddress = this.getTokenAddress(tokenBTicker);
            
            const tokenAContract = new ethers.Contract(tokenAAddress, this.ERC20_ABI, this.provider);
            const decimalsA = await tokenAContract.decimals();
            const amountA = ethers.parseUnits(amountADecimal.toString(), Number(decimalsA));
            
            const amountsOut = await this.routerContract.getAmountsOut(amountA, [tokenAAddress, tokenBAddress]);
            const amountB = amountsOut[1];

            const tokenBContract = new ethers.Contract(tokenBAddress, this.ERC20_ABI, this.provider);
            this.log(`Dibutuhkan sekitar ${ethers.formatUnits(amountB, await tokenBContract.decimals())} ${tokenBTicker}`);

            if (!(await this.approve(tokenAAddress, amountA))) return false;
            if (!(await this.approve(tokenBAddress, amountB))) return false;

            const tx = await this.routerContract.addLiquidity(
                tokenAAddress, tokenBAddress, amountA, amountB, 0, 0,
                this.wallet.address, Math.floor(Date.now() / 1000) + 600
            );
            return await this.waitForTx(tx.hash);
        } catch (e) { this.log(`Add LP gagal: ${e.message}`, 'error'); return false; }
    }

    async cleanup(tokenTicker) {
        this.log(`Memulai Cleanup untuk ${tokenTicker}...`, 'info');
        try {
            const tokenAddress = this.getTokenAddress(tokenTicker);
            const tokenContract = new ethers.Contract(tokenAddress, this.ERC20_ABI, this.provider);
            const balance = await tokenContract.balanceOf(this.wallet.address);
            if (balance <= 0) { this.log(`Tidak ada ${tokenTicker} untuk di-cleanup.`, 'info'); return true; }

            const decimals = await tokenContract.decimals();
            const balanceDecimal = ethers.formatUnits(balance, decimals);
            this.log(`Menukar semua sisa ${balanceDecimal} ${tokenTicker} ke WPHRS...`);
            return await this.swap(tokenTicker, 'WPHRS', balanceDecimal);
        } catch (e) { this.log(`Cleanup ${tokenTicker} gagal: ${e.message}`, 'error'); return false; }
    }
    
    async run() {
        this.log(chalk.blue.bold('--- Memulai Bot Pharoswap (Arsitektur Final) ---'));
        this.log(`Akun: ${this.wallet.address}`);
        
        this.log(chalk.blue.bold('\n--- TAHAP 0: Persiapan Modal Kerja ---'));
        await this.wrap(config.phrsToWrap);
        await this.sleep(this.randomDelay());

        this.log(chalk.blue.bold('\n--- TAHAP 1: Melakukan Swap WPHRS <> USDT ---'));
        for (let i = 0; i < config.swapRepetitions; i++) {
            this.log(`--- Swap #${i + 1}/${config.swapRepetitions} ---`, 'info');
            const from = i % 2 === 0 ? 'WPHRS' : 'USDT';
            const to = i % 2 === 0 ? 'USDT' : 'WPHRS';
            const amount = from === 'WPHRS' ? this.getRandomAmount(config.wphrs.min, config.wphrs.max).toFixed(5) : this.getRandomAmount(config.usdt.min, config.usdt.max).toFixed(5);
            await this.swap(from, to, amount);
            await this.sleep(this.randomDelay());
        }
        
        this.log(chalk.blue.bold('\n--- TAHAP 2: Menambah Likuiditas WPHRS/USDT ---'));
        for (let i = 0; i < config.addLiquidityRepetitions; i++) {
            this.log(`--- Add LP #${i + 1}/${config.addLiquidityRepetitions} ---`, 'info');
            await this.addLiquidity('WPHRS', 'USDT', config.lp.wphrs);
            await this.sleep(this.randomDelay());
        }

        this.log(chalk.blue.bold('\n--- TAHAP 3: Cleanup Aset ---'));
        await this.cleanup('USDT');
        await this.sleep(this.randomDelay());
        await this.unwrapAll();

        this.log(chalk.green.bold('\n--- Semua Tugas Selesai ---'));
    }
}

async function main() {
    try {
        const bot = new PharosBot(PRIVATE_KEY, RPC_URL);
        await bot.run();
    } catch (e) {
        console.log(chalk.red(`\n❌ Terjadi kesalahan fatal: ${e.stack}`));
    }
}

main();
