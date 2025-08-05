require('dotenv').config();

const express = require('express');
const session = require('express-session');
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const crypto = require('crypto');
const midtransClient = require('midtrans-client');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/images/')
    },
    filename: function (req, file, cb) {
        if (file.fieldname === 'banner') {
            cb(null, 'banner-logo' + path.extname(file.originalname))
        } else if (file.fieldname === 'banners') {
            // Untuk multiple banners, gunakan nama file asli dengan timestamp untuk menghindari konflik
            const timestamp = Date.now();
            const originalName = path.parse(file.originalname).name;
            const ext = path.extname(file.originalname);
            cb(null, `${originalName}-${timestamp}${ext}`)
        } else {
            cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname))
        }
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: function (req, file, cb) {
        const allowedTypes = /jpeg|jpg|png|gif|svg/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'));
        }
    },
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 3000;

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
    secret: process.env.SESSION_SECRET || 'kunci-rahasia-super-aman-jangan-disebar',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
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

// Fungsi untuk mengirim invoice ke WhatsApp
async function sendInvoiceToWhatsApp(order) {
    try {
        // Pilih provider WhatsApp (WHAPI atau FONNTE)
        const whapiToken = process.env.WHAPI_TOKEN;
        const whapiInstance = process.env.WHAPI_INSTANCE;
        const fonntToken = process.env.FONNTE_TOKEN;
        
        if (!whapiToken && !fonntToken) {
            console.log('Token WhatsApp tidak ditemukan, skip pengiriman pesan');
            return;
        }

        // Format nomor WhatsApp (hapus karakter non-digit dan tambahkan 62 jika dimulai dengan 0)
        let phoneNumber = order.phone.replace(/\D/g, '');
        if (phoneNumber.startsWith('0')) {
            phoneNumber = '62' + phoneNumber.substring(1);
        } else if (!phoneNumber.startsWith('62')) {
            phoneNumber = '62' + phoneNumber;
        }

        // Format pesan invoice (simple & clean)
        const invoiceMessage = `✅ *PEMBAYARAN BERHASIL*\n\n` +
            `📦 ${order.product}\n` +
            `🆔 ${order.productId}\n` +
            `💳 ${order.trxId}\n\n` +
            `📄 Invoice: ${process.env.APP_BASE_URL}/invoice/${order.trxId}\n\n` +
            `Terima kasih! - *AHSASTORE*`;

        let response;
        
        // Prioritas: gunakan Whapi.id jika tersedia, fallback ke Fonnte
        if (whapiToken && whapiInstance) {
            // Kirim pesan menggunakan Whapi.id API
            response = await axios.post(`${whapiInstance}send-message`, {
                to: phoneNumber + '@s.whatsapp.net',
                body: invoiceMessage
            }, {
                headers: {
                    'Authorization': `Bearer ${whapiToken}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`Invoice berhasil dikirim ke WhatsApp ${phoneNumber} untuk order ${order.trxId} via Whapi.id`);
        } else if (fonntToken) {
            // Fallback ke Fonnte API
            response = await axios.post('https://api.fonnte.com/send', {
                target: phoneNumber,
                message: invoiceMessage,
                countryCode: '62'
            }, {
                headers: {
                    'Authorization': fonntToken,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`Invoice berhasil dikirim ke WhatsApp ${phoneNumber} untuk order ${order.trxId} via Fonnte`);
        }

        return response?.data;
    } catch (error) {
        console.error(`Gagal mengirim invoice ke WhatsApp untuk order ${order.trxId}:`, error.message);
        // Jangan throw error agar tidak mengganggu proses utama
    }
}

// Fungsi untuk mengirim update fulfillment ke WhatsApp
async function sendFulfillmentUpdateToWhatsApp(order) {
    try {
        // Pilih provider WhatsApp (WHAPI atau FONNTE)
        const whapiToken = process.env.WHAPI_TOKEN;
        const whapiInstance = process.env.WHAPI_INSTANCE;
        const fonntToken = process.env.FONNTE_TOKEN;
        
        if (!whapiToken && !fonntToken) {
            console.log('Token WhatsApp tidak ditemukan, skip pengiriman pesan');
            return;
        }

        // Format nomor WhatsApp
        let phoneNumber = order.phone.replace(/\D/g, '');
        if (phoneNumber.startsWith('0')) {
            phoneNumber = '62' + phoneNumber.substring(1);
        } else if (!phoneNumber.startsWith('62')) {
            phoneNumber = '62' + phoneNumber;
        }

        // Format pesan update (simple & clean)
        const updateMessage = `🎉 *PESANAN SELESAI*\n\n` +
            `📦 ${order.product}\n` +
            `🆔 ${order.productId}\n` +
            `💳 ${order.trxId}\n\n` +
            `✅ Produk sudah dikirim!\n\n` +
            `📄 Detail: ${process.env.APP_BASE_URL}/invoice/${order.trxId}\n\n` +
            `Terima kasih! - *AHSASTORE*`;

        let response;
        
        // Prioritas: Whapi.id dulu, baru Fonnte
        if (whapiToken && whapiInstance) {
            // Gunakan Whapi.id
            response = await axios.post(`${whapiInstance}send-message`, {
                to: phoneNumber + '@s.whatsapp.net',
                body: updateMessage
            }, {
                headers: {
                    'Authorization': `Bearer ${whapiToken}`,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`Update fulfillment berhasil dikirim ke WhatsApp ${phoneNumber} untuk order ${order.trxId} via Whapi.id`);
        } else if (fonntToken) {
            // Gunakan Fonnte sebagai fallback
            response = await axios.post('https://api.fonnte.com/send', {
                target: phoneNumber,
                message: updateMessage,
                countryCode: '62'
            }, {
                headers: {
                    'Authorization': fonntToken,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`Update fulfillment berhasil dikirim ke WhatsApp ${phoneNumber} untuk order ${order.trxId} via Fonnte`);
        }

        return response?.data;
    } catch (error) {
        console.error(`Gagal mengirim update fulfillment ke WhatsApp untuk order ${order.trxId}:`, error.message);
        // Jangan throw error agar tidak mengganggu proses utama
    }
}

function calculateSellingPrice(basePrice, category) {
    const markupConfig = { 'Games': 1.07, 'Pulsa': 1.03, 'Paket Data': 1.05, 'Membership': 1.10, 'default': 1.05 };
    const markup = markupConfig[category] || markupConfig[category.split(' ')[0]] || markupConfig['default'];
    return Math.ceil((basePrice * markup) / 50) * 50;
}

// Function to find existing banner image (backward compatibility)
function findBannerImage() {
    const bannerExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];
    const imagesDir = path.join(__dirname, 'public', 'images');
    
    try {
        const files = fs.readdirSync(imagesDir);
        for (const file of files) {
            if (file.startsWith('banner-logo')) {
                return '/images/' + file;
            }
        }
    } catch (error) {
        console.error('Error reading images directory:', error);
    }
    
    return null;
}

// Function to find all banner images
function findAllBanners() {
    const bannerExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];
    const imagesDir = path.join(__dirname, 'public', 'images');
    
    try {
        const files = fs.readdirSync(imagesDir);
        const banners = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return bannerExtensions.includes(ext) && !file.startsWith('.');
            })
            .map(file => ({
                filename: file,
                path: '/images/' + file
            }));
        return banners;
    } catch (error) {
        console.error('Error reading images directory:', error);
        return [];
    }
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
        const bannerImage = findBannerImage(); // backward compatibility
        const allBanners = findAllBanners();
        res.render('index', { allProducts, popularProducts, categories, selectedCategory: category || 'Semua', bannerImage, allBanners });
    } catch (error) {
        console.error('Error loading homepage:', error);
        res.status(500).send('Server error');
    }
});

// API endpoint untuk search products
app.get('/api/products', async (req, res) => {
    try {
        const products = await prisma.product.findMany({
            where: { isActive: true },
            select: {
                brand: true,
                category: true
            },
            orderBy: { brand: 'asc' }
        });
        
        const formattedProducts = products.map(product => ({
            name: product.brand,
            category: product.category,
            brand: product.brand
        }));
        
        res.json(formattedProducts);
    } catch (error) {
        console.error('Error loading products API:', error);
        res.status(500).json({ error: 'Failed to load products' });
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
            data: { trxId: `AHSA-${Date.now()}`, productId: productId, phone: phone, product: selectedProductName, sku: selectedDenom.buyer_sku_code, payment: "Midtrans", paymentStatus: "PENDING", fulfillmentStatus: "PENDING" },
        });
        const parameter = {
            transaction_details: { order_id: newOrder.trxId, gross_amount: sellingPrice },
            customer_details: { first_name: productId, phone: phone },
            item_details: [{ id: selectedDenom.buyer_sku_code, price: sellingPrice, quantity: 1, name: selectedProductName }],
            callbacks: {
                finish: `${process.env.APP_BASE_URL}/invoice/${newOrder.trxId}`,
                error: `${process.env.APP_BASE_URL}/`,
                pending: `${process.env.APP_BASE_URL}/invoice/${newOrder.trxId}`
            }
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
        let order = null;
        if (req.query.trxId) {
            order = await prisma.order.findUnique({ where: { trxId: req.query.trxId } });
        }
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
                
                // Kirim ke Digiflazz
                try { 
                    await createDigiflazzTransaction(order); 
                } catch (digiflazzError) { 
                    console.error(`Gagal mengirim ke Digiflazz untuk order ${orderId}, tapi pembayaran tetap tercatat sukses. Error:`, digiflazzError.message); 
                }
                
                // Kirim invoice ke WhatsApp
                try {
                    await sendInvoiceToWhatsApp(order);
                } catch (whatsappError) {
                    console.error(`Gagal mengirim invoice ke WhatsApp untuk order ${orderId}:`, whatsappError.message);
                }
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
        
        // Update status fulfillment
        await prisma.order.update({ where: { trxId: trxId }, data: { fulfillmentStatus: newStatus } });
        
        // Jika status SUCCESS, kirim notifikasi update ke WhatsApp
        if (newStatus === 'SUCCESS') {
            try {
                const order = await prisma.order.findUnique({ where: { trxId: trxId } });
                if (order) {
                    await sendFulfillmentUpdateToWhatsApp(order);
                }
            } catch (whatsappError) {
                console.error(`Gagal mengirim update fulfillment ke WhatsApp untuk order ${trxId}:`, whatsappError.message);
            }
        }
        
        res.json({ data: true });
    } catch (error) {
        console.error('[DIGIFLAZZ CALLBACK] Error:', error);
        res.status(500).json({ data: false });
    }
});
// === ROUTE UNTUK ADMIN ===
app.get('/admin/login', (req, res) => res.render('admin-login'));
app.post('/admin/login', (req, res) => { if (req.body.username === 'admin' && req.body.password === 'gaspol123') { req.session.isAdmin = true; res.redirect('/admin/dashboard'); } else { res.send('Username atau Password salah!'); } });
app.get('/admin/dashboard', checkAdmin, async (req, res) => { 
    try { 
        const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' } }); 
        res.render('admin-dashboard', { orders: orders }); 
    } catch (error) { 
        res.status(500).send("Gagal memuat dashboard.") 
    } 
});

app.post('/admin/sync-digiflazz', checkAdmin, async (req, res) => {
    try {
        const priceList = await getDigiflazzPriceList();
        const uniqueBrands = [...new Map(priceList.map(item => [item.brand, item])).values()];
        for (const item of uniqueBrands) {
            await prisma.product.upsert({
                where: { brand: item.brand },
                update: { category: item.category },
                create: {
                    brand: item.brand,
                    category: item.category,
                    isActive: false,
                    isPopular: false
                }
            });
        }
        res.redirect('/admin/products');
    } catch (error) {
        res.status(500).send("Gagal melakukan sinkronisasi.");
    }
});

app.get('/admin/products', checkAdmin, async (req, res) => {
    try {
        const products = await prisma.product.findMany({ orderBy: { brand: 'asc' } });
        res.render('admin-products', { products, query: req.query });
    } catch (error) {
        res.status(500).send("Gagal memuat halaman produk.")
    }
});

app.post('/admin/products/toggle-active/:id', checkAdmin, async (req, res) => {
    try {
        const product = await prisma.product.findUnique({ where: { id: req.params.id } });
        await prisma.product.update({
            where: { id: req.params.id },
            data: { isActive: !product.isActive }
        });
        res.redirect('/admin/products');
    } catch (error) {
        res.status(500).send("Gagal update.")
    }
});

app.post('/admin/products/toggle-popular/:id', checkAdmin, async (req, res) => {
    try {
        const product = await prisma.product.findUnique({ where: { id: req.params.id } });
        await prisma.product.update({
            where: { id: req.params.id },
            data: { isPopular: !product.isPopular }
        });
        res.redirect('/admin/products');
    } catch (error) {
        res.status(500).send("Gagal update.")
    }
});
app.post('/admin/products/update-image/:id', checkAdmin, async (req, res) => {
    try {
        await prisma.product.update({
            where: { id: req.params.id },
            data: { imageUrl: req.body.imageUrl }
        });
        res.redirect('/admin/products');
    } catch (error) {
        res.status(500).send("Gagal update.")
    }
});

// Route untuk mengaktifkan semua produk
app.post('/admin/products/activate-all', checkAdmin, async (req, res) => {
    try {
        await prisma.product.updateMany({
            data: { isActive: true }
        });
        res.redirect('/admin/products');
    } catch (error) {
        console.error('Error activating all products:', error);
        res.status(500).send("Gagal mengaktifkan semua produk.");
    }
});

// Route untuk pencairan dana
app.post('/admin/withdraw', checkAdmin, async (req, res) => {
    try {
        const { amount, bank_account } = req.body;
        
        // Validasi input
        if (!amount || !bank_account || amount < 50000) {
            return res.status(400).send("Jumlah minimal pencairan Rp 50.000 dan nomor rekening harus diisi.");
        }
        
        // Di sini bisa ditambahkan logika untuk:
        // 1. Cek saldo tersedia
        // 2. Simpan request pencairan ke database
        // 3. Integrasi dengan payment gateway untuk transfer
        
        console.log(`Permintaan pencairan: Rp ${amount} ke rekening ${bank_account}`);
        
        // Untuk sementara redirect kembali dengan pesan sukses
        res.redirect('/admin/products?withdraw=success');
    } catch (error) {
        console.error('Error processing withdrawal:', error);
        res.status(500).send("Gagal memproses pencairan.");
    }
});

// Route untuk halaman banner admin
app.get('/admin/banner', checkAdmin, (req, res) => {
    try {
        const imagesDir = path.join(__dirname, 'public', 'images');
        let banners = [];
        
        if (fs.existsSync(imagesDir)) {
            const files = fs.readdirSync(imagesDir);
            banners = files
                .filter(file => {
                    const ext = path.extname(file).toLowerCase();
                    return ['.jpg', '.jpeg', '.png', '.gif', '.svg'].includes(ext);
                })
                .map(file => ({
                    filename: file,
                    path: '/images/' + file
                }));
        }
        
        res.render('admin-banner', { banners });
    } catch (error) {
        console.error('Error loading banner page:', error);
        res.status(500).send('Terjadi kesalahan saat memuat halaman banner');
    }
});

// API endpoint for banner list (for dashboard)
app.get('/admin/banner-list', checkAdmin, (req, res) => {
    try {
        const imagesDir = path.join(__dirname, 'public', 'images');
        let banners = [];
        
        if (fs.existsSync(imagesDir)) {
            const files = fs.readdirSync(imagesDir);
            banners = files
                .filter(file => {
                    const ext = path.extname(file).toLowerCase();
                    return ['.jpg', '.jpeg', '.png', '.gif', '.svg'].includes(ext);
                })
                .map(file => ({
                    filename: file,
                    path: '/images/' + file
                }));
        }
        
        res.json({ success: true, banners });
    } catch (error) {
        console.error('Error loading banner list:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan saat memuat daftar banner' });
    }
});

// Route untuk upload multiple banners
app.post('/admin/upload-banners', checkAdmin, upload.array('banners', 10), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: 'Tidak ada file yang diupload' });
        }
        
        res.json({ 
            success: true, 
            message: `${req.files.length} banner berhasil diupload`,
            uploadedCount: req.files.length,
            files: req.files.map(file => ({
                filename: file.filename,
                path: '/images/' + file.filename
            }))
        });
    } catch (error) {
        console.error('Error saat upload banners:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan saat upload' });
    }
});

// Route untuk upload banner logo (backward compatibility)
app.post('/admin/upload-banner', checkAdmin, upload.single('banner'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Tidak ada file yang diupload' });
        }
        
        // Hapus file banner lama sebelum menyimpan yang baru
        const imagesDir = path.join(__dirname, 'public', 'images');
        try {
            const files = fs.readdirSync(imagesDir);
            files.forEach(file => {
                if (file.startsWith('banner-logo') && file !== req.file.filename) {
                    const oldFilePath = path.join(imagesDir, file);
                    if (fs.existsSync(oldFilePath)) {
                        fs.unlinkSync(oldFilePath);
                    }
                }
            });
        } catch (error) {
            console.error('Error deleting old banner:', error);
        }
        
        res.json({ 
            success: true, 
            message: 'Banner logo berhasil diupload',
            filename: req.file.filename,
            path: '/images/' + req.file.filename
        });
    } catch (error) {
        console.error('Error saat upload banner:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan saat upload' });
    }
});

// Route untuk mendapatkan banner saat ini
app.get('/admin/current-banner', checkAdmin, (req, res) => {
    try {
        const bannerImage = findBannerImage();
        res.json({ 
            success: true, 
            bannerImage: bannerImage 
        });
    } catch (error) {
        console.error('Error getting current banner:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan saat mengambil banner' });
    }
});

// Route untuk menghapus banner
app.delete('/admin/delete-banner', checkAdmin, (req, res) => {
    try {
        const { filename } = req.body;
        
        if (!filename) {
            // Fallback untuk menghapus banner-logo lama (backward compatibility)
            const bannerFiles = ['banner-logo.png', 'banner-logo.jpg', 'banner-logo.jpeg', 'banner-logo.gif', 'banner-logo.svg'];
            let deleted = false;
            
            bannerFiles.forEach(bannerFile => {
                const filePath = path.join(__dirname, 'public', 'images', bannerFile);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    deleted = true;
                }
            });
            
            if (deleted) {
                res.json({ success: true, message: 'Banner logo berhasil dihapus' });
            } else {
                res.json({ success: false, message: 'Banner tidak ditemukan' });
            }
            return;
        }
        
        // Hapus file berdasarkan filename
        const filePath = path.join(__dirname, 'public', 'images', filename);
        
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true, message: `Banner "${filename}" berhasil dihapus` });
        } else {
            res.json({ success: false, message: 'Banner logo tidak ditemukan' });
        }
    } catch (error) {
        console.error('Error saat menghapus banner:', error);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan saat menghapus banner' });
    }
});

app.get('/admin/test-webhook', checkAdmin, (req, res) => res.render('admin-test-webhook'));
app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server berjalan di http://0.0.0.0:${port}`);
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('HTTP server closed');
        prisma.$disconnect().then(() => {
            console.log('Database connection closed');
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
        console.log('HTTP server closed');
        prisma.$disconnect().then(() => {
            console.log('Database connection closed');
            process.exit(0);
        });
    });
});