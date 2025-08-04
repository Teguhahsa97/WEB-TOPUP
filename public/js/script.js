document.addEventListener('DOMContentLoaded', () => {
    initializeCategoryTabs();
    initializeSearch();
    
    // Kembalikan posisi scroll jika ada
    const savedScrollPosition = sessionStorage.getItem('scrollPosition');
    if (savedScrollPosition) {
        window.scrollTo(0, parseInt(savedScrollPosition));
        sessionStorage.removeItem('scrollPosition');
    }
});

// Function to initialize category tabs
function initializeCategoryTabs() {
    const categoryTabs = document.querySelectorAll('.category-tab');

    categoryTabs.forEach(tab => {
        // Remove existing event listeners to prevent duplicates
        tab.removeEventListener('click', handleCategoryClick);
        tab.addEventListener('click', handleCategoryClick);
    });
}

// Handle category tab clicks
function handleCategoryClick(e) {
    const category = this.innerText.trim();
    
    // Simpan posisi scroll saat ini
    sessionStorage.setItem('scrollPosition', window.pageYOffset || document.documentElement.scrollTop);
    
    // Arahkan browser ke URL yang sesuai dengan kategori yang di-klik
    if (category === 'Semua') {
        window.location.href = '/';
    } else {
        // encodeURIComponent memastikan spasi atau simbol lain aman untuk URL
        window.location.href = `/?category=${encodeURIComponent(category)}`;
    }
}

// Function to initialize search functionality
function initializeSearch() {
    const searchInput = document.getElementById('search-products');
    const productCards = document.querySelectorAll('.product-card');
    
    if (searchInput && productCards.length > 0) {
        // Remove existing event listeners to prevent duplicates
        const newSearchInput = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearchInput, searchInput);
        
        newSearchInput.addEventListener('input', function() {
            const searchTerm = this.value.toLowerCase();
            const currentProductCards = document.querySelectorAll('.product-card');
            
            currentProductCards.forEach(card => {
                const productTitle = card.querySelector('.product-card-title');
                const productName = productTitle ? productTitle.textContent.toLowerCase() : '';
                const productCategory = card.dataset.category ? card.dataset.category.toLowerCase() : '';
                
                if (productName.includes(searchTerm) || productCategory.includes(searchTerm)) {
                    card.style.display = 'block';
                } else {
                    card.style.display = 'none';
                }
            });
            
            // Show/hide sections based on search results
            const sections = document.querySelectorAll('.product-section');
            sections.forEach(section => {
                const visibleCards = section.querySelectorAll('.product-card[style*="block"], .product-card:not([style*="none"])');
                if (searchTerm === '' || visibleCards.length > 0) {
                    section.style.display = 'block';
                } else {
                    section.style.display = 'none';
                }
            });
        });
    }
}

// Catatan: Logika untuk klik kartu produk sudah ditangani oleh tag <a>
// pada file index.ejs, jadi tidak perlu JavaScript tambahan di sini untuk itu.