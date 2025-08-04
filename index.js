require('dotenv').config();

const express = require('express');
const session = require('express-session');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const crypto = require('crypto');
const midtransClient = require('midtrans-client');

const app = express();
const prisma = new PrismaClient();
const port = 3000;

let priceListCache = null;
let lastFetchTimestamp = 0;
const CACHE_DURATION = 300000;

const snap = new midtransClient.Snap({
    isProduction: false,
    serverKey: process.env.MIDTRANS_SERVER_KEY,
    clientKey: process.env.MIDTRANS_CLIENT_KEY
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(session({
    secret: 'kunci-rahasia-super-aman-jangan-disebar',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

const checkAdmin = (req, res, next) => {
    if (req.session.isAdmin) next(); else res.redirect('/admin/login');
};

async function getDigiflazzPriceList() {
    const currentTime = Date.now();
    if (priceListCache && (currentTime - lastFetchTimestamp < CACHE_DURATION)) {
        console.log("[CACHE] Menggunakan daftar harga dari cache.");
        return priceListCache;
    }
    console.log("[API] Mengambil daftar harga baru dari Digiflazz...");
    const username = process.env.DIGIFLAZZ_USERNAME;
    const devKey = process.env.DIGIFLAZZ_DEV_KEY;
    const sign = crypto.createHash('md5').update(username + devKey + "pricelist").digest("hex");
    try {
        const response = await axios.post("https://api.digiflazz.com/v1/price-list", { cmd: "prepaid", username: username, sign: sign });
        priceListCache = response.data.data;
        lastFetchTimestamp = Date.now();
        console.log("[API] Daftar harga baru berhasil disimpan di cache.");
        return priceListCache;
    } catch (error) {
        console.error("[API] Gagal mengambil daftar harga Digiflazz:", error.response ? error.response.data : error.message);
        return [];
    }
}

async function createDigiflazzTransaction(order) {
    const username = process.env.DIGIFLAZZ_USERNAME;
    const devKey = process.env.DIGIFLAZZ_DEV_KEY;
    const refId = order.trxId;
    const sign = crypto.createHash('md5').update(username + devKey + refId).digest("hex");
    try {
        console.log(`[DIGIFLAZZ] Mencoba mengirim order ${refId} ke Digiflazz...`);
        await axios.post("https://api.digiflazz.com/v1/transaction", {
            username: username,
            buyer_sku_code: order.sku,
            customer_no: order.productId,
            ref_id: refId,
            sign: sign
        });
        await prisma.order.update({ where: { trxId: refId }, data: { fulfillmentStatus: "PROCESSING" } });
        console.log(`[DIGIFLAZZ] Order ${refId} berhasil dikirim. Menunggu callback status akhir.`);
    } catch (error) {
        console.error(`[DIGIFLAZZ] Gagal mengirim order ${refId}:`, error.response ? error.response.data : error.message);
        await prisma.order.update({ where: { trxId: refId }, data: { fulfillmentStatus: "FAILED" } });
        throw error;
    }
}

function calculateSellingPrice(basePrice, category) {
    const markupConfig = { 'Games': 1.07, 'Pulsa': 1.03, 'Paket Data': 1.05, 'Membership': 1.10, 'default': 1.05 };
    const markup = markupConfig[category] || markupConfig[category.split(' ')[0]] || markupConfig['default'];
    return Math.ceil((basePrice * markup) / 50) * 50;
}

// === ROUTE UNTUK USER ===
app.get('/', async (req, res) => {
    try {
        const { category } = req.query;
        let whereClause = { isActive: true };
        if (category) whereClause.category = category;
        const allProducts = await prisma.product.findMany({ where: whereClause, orderBy: { brand: 'asc'} });
        const popularProducts = await prisma.product.findMany({ where: { isActive: true, isPopular: true } });
        const categoriesResult = await prisma.product.findMany({ where: { isActive: true }, select: { category: true }, distinct: ['category'] });
        const categories = categoriesResult.map(item => item.category);
        res.render('index', { allProducts, popularProducts, categories, selectedCategory: category || 'Semua' });
    } catch (error) {
        console.error("Gagal di route '/':", error);
        res.status(500).send("Server Error");
    }
});
app.get('/order/:brand', async (req, res) => {
    try {
        const { brand } = req.params;
        const product = await prisma.product.findUnique({ where: { brand: brand } });
        if (!product || !product.isActive) return res.status(404).send("Produk tidak ditemukan atau tidak aktif");
        const fullPriceList = await getDigiflazzPriceList();
        let productDenominations = fullPriceList.filter(item => item.brand === product.brand);
        productDenominations = productDenominations.map(denom => ({...denom, selling_price: calculateSellingPrice(denom.price, denom.category)}));
        const groupedDenominations = productDenominations.reduce((acc, denom) => {
            let groupName = denom.category;
            const lowerCaseName = denom.product_name.toLowerCase();
            const keywordMapping = { 'membership': 'Membership', 'member': 'Membership', 'pass': 'Pass', 'twilight': 'Pass', 'starlight': 'Starlight', 'diamond': 'Top Up', 'kristal': 'Top Up' };
            for (const keyword in keywordMapping) { if (lowerCaseName.includes(keyword)) { groupName = keywordMapping[keyword]; break; } }
            if (!acc[groupName]) acc[groupName] = [];
            acc[groupName].push(denom);
            return acc;
        }, {});
        const sortedGroupNames = Object.keys(groupedDenominations).sort((a, b) => {
            const order = ['Membership', 'Pass', 'Starlight', 'Top Up'];
            return (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b));
        });
        const groupCount = sortedGroupNames.length;
        res.render('order-page', { product, groupedDenominations, sortedGroupNames, groupCount });
    } catch (error) {
        console.error("Gagal di route '/order/:brand':", error);
        res.status(500).send("Server Error");
    }
});
app.post('/order', async (req, res) => {
    try {
        const { productId, phone, product: selectedProductName } = req.body;
        const fullPriceList = await getDigiflazzPriceList();
        const selectedDenom = fullPriceList.find(d => d.product_name === selectedProductName);
        if (!selectedDenom) return res.status(404).send("Produk tidak ditemukan atau harga berubah. Silakan coba lagi.");
        const sellingPrice = calculateSellingPrice(selectedDenom.price, selectedDenom.category);
        const newOrder = await prisma.order.create({
            data: { trxId: `GASS-${Date.now()}`, productId: productId, phone: phone, product: selectedProductName, sku: selectedDenom.buyer_sku_code, payment: "Midtrans", paymentStatus: "PENDING", fulfillmentStatus: "PENDING" },
        });
        const parameter = {
            transaction_details: { order_id: newOrder.trxId, gross_amount: sellingPrice },
            customer_details: { first_name: productId, phone: phone },
            item_details: [{ id: selectedDenom.buyer_sku_code, price: sellingPrice, quantity: 1, name: selectedProductName }],
            callbacks: { finish: `${process.env.APP_BASE_URL}/invoice/${newOrder.trxId}` }
        };
        const transaction = await snap.createTransaction(parameter);
        res.redirect(transaction.redirect_url);
    } catch (error) {
        console.error("Gagal membuat transaksi:", error);
        res.status(500).send("Terjadi kesalahan, silakan coba beberapa saat lagi.");
    }
});
app.get('/invoice/:trxId', async (req, res) => {
    try {
        const order = await prisma.order.findUnique({ where: { trxId: req.params.trxId } });
        if (!order) return res.status(404).send("Invoice tidak ditemukan.");
        res.render('invoice', { order: order });
    } catch (error) {
        console.error("Gagal di route '/invoice/:trxId':", error);
        res.status(500).send("Server Error");
    }
});
app.get('/cek', (req, res) => res.render('cek', { order: undefined }));
app.get('/cek-pesanan', async (req, res) => {
    try {
        const order = await prisma.order.findUnique({ where: { trxId: req.query.trxId } });
        res.render('cek', { order: order });
    } catch (error) {
        console.error("Gagal di route '/cek-pesanan':", error);
        res.status(500).send("Server Error");
    }
});
app.post('/midtrans-notification', async (req, res) => {
    try {
        const statusResponse = await snap.transaction.notification(req.body);
        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const fraudStatus = statusResponse.fraud_status;
        console.log(`Menerima notifikasi Midtrans untuk order ${orderId} - Status: ${transactionStatus}`);
        const order = await prisma.order.findUnique({ where: { trxId: orderId } });
        if (!order) return res.status(404).send("Order not found");
        if (order.paymentStatus === 'PENDING') {
            if (transactionStatus == 'settlement' && fraudStatus == 'accept') {
                await prisma.order.update({ where: { trxId: orderId }, data: { paymentStatus: "SUCCESS" } });
                console.log(`Order ${orderId} berhasil dibayar. Status diupdate ke SUCCESS.`);
                try { await createDigiflazzTransaction(order); } catch (digiflazzError) { console.error(`Gagal mengirim ke Digiflazz untuk order ${orderId}, tapi pembayaran tetap tercatat sukses. Error:`, digiflazzError.message); }
            } else if (transactionStatus == 'cancel' || transactionStatus == 'expire' || transactionStatus == 'deny') {
                await prisma.order.update({ where: { trxId: orderId }, data: { paymentStatus: "FAILED" } });
            }
        }
        res.status(200).send("OK");
    } catch (error) {
        console.error("Gagal memproses notifikasi Midtrans:", error.message);
        res.status(500).send("Error processing notification");
    }
});
app.post('/digiflazz-callback', async (req, res) => {
    try {
        const data = req.body.data;
        if (!data) return res.status(400).send('Invalid data');
        const trxId = data.ref_id;
        let newStatus = 'PROCESSING';
        if (data.status === 'Sukses') newStatus = 'SUCCESS';
        if (data.status === 'Gagal') newStatus = 'FAILED';
        await prisma.order.update({ where: { trxId: trxId }, data: { fulfillmentStatus: newStatus } });
        res.json({ data: true });
    } catch (error) {
        console.error('[DIGIFLAZZ CALLBACK] Error:', error);
        res.status(500).json({ data: false });
    }
});
// === ROUTE UNTUK ADMIN ===
app.get('/admin/login', (req, res) => res.render('admin-login'));
app.post('/admin/login', (req, res) => { if (req.body.username === 'admin' && req.body.password === 'gaspol123') { req.session.isAdmin = true; res.redirect('/admin/dashboard'); } else { res.send('Username atau Password salah!'); } });
app.get('/admin/dashboard', checkAdmin, async (req, res) => { try { const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' } }); res.render('admin-dashboard', { orders: orders }); } catch (error) { res.status(500).send("Gagal memuat dashboard.") } });
app.post('/admin/sync-digiflazz', checkAdmin, async (req, res) => { try { const priceList = await getDigiflazzPriceList(); const uniqueBrands = [...new Map(priceList.map(item => [item.brand, item])).values()]; for (const item of uniqueBrands) { await prisma.product.upsert({ where: { brand: item.brand }, update: { category: item.category }, create: { brand: item.brand, category: item.category, isActive: false, isPopular: false } }); } res.redirect('/admin/products'); } catch (error) { res.status(500).send("Gagal melakukan sinkronisasi."); } });
app.get('/admin/products', checkAdmin, async (req, res) => { try { const products = await prisma.product.findMany({ orderBy: { brand: 'asc' } }); res.render('admin-products', { products }); } catch (error) { res.status(500).send("Gagal memuat halaman produk.") } });
app.post('/admin/products/toggle-active/:id', checkAdmin, async (req, res) => { try { const product = await prisma.product.findUnique({ where: { id: req.params.id } }); await prisma.product.update({ where: { id: req.params.id }, data: { isActive: !product.isActive } }); res.redirect('/admin/products'); } catch (error) { res.status(500).send("Gagal update.") } });
app.post('/admin/products/toggle-popular/:id', checkAdmin, async (req, res) => { try { const product = await prisma.product.findUnique({ where: { id: req.params.id } }); await prisma.product.update({ where: { id: req.params.id }, data: { isPopular: !product.isPopular } }); res.redirect('/admin/products'); } catch (error) { res.status(500).send("Gagal update.") } });
app.post('/admin/products/update-image/:id', checkAdmin, async (req, res) => { try { await prisma.product.update({ where: { id: req.params.id }, data: { imageUrl: req.body.imageUrl } }); res.redirect('/admin/products'); } catch (error) { res.status(500).send("Gagal update.") } });
app.get('/admin/test-webhook', checkAdmin, (req, res) => res.render('admin-test-webhook'));
app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

app.listen(port, () => console.log(`Server berjalan di http://localhost:${port}`));