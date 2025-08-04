document.addEventListener('DOMContentLoaded', () => {
    // Logika untuk Klik Tombol Kategori
    const categoryTabs = document.querySelectorAll('.category-tab');

    categoryTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const category = tab.innerText.trim();

            // Arahkan browser ke URL yang sesuai dengan kategori yang di-klik
            if (category === 'Semua') {
                window.location.href = '/';
            } else {
                // encodeURIComponent memastikan spasi atau simbol lain aman untuk URL
                window.location.href = `/?category=${encodeURIComponent(category)}`;
            }
        });
    });

    // Catatan: Logika untuk klik kartu produk sudah ditangani oleh tag <a>
    // pada file index.ejs, jadi tidak perlu JavaScript tambahan di sini untuk itu.
});