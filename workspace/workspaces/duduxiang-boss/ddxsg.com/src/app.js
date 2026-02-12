// 嘟嘟香 - Main Application JavaScript
// Features: Multi-language, Smart Search, Order History, WhatsApp Integration

// ==================== State ====================
let menuData = null;
let cart = [];
let activeFilter = 'all';
let activeTags = new Set();
let currentLang = localStorage.getItem('ddxsg_lang') || 'zh';
let searchQuery = '';
let orderHistory = JSON.parse(localStorage.getItem('ddxsg_history') || '[]');
let orderNote = '';

// ==================== Smart Search: Synonyms & Pinyin ====================
const searchSynonyms = {
    // 肉类同义词
    '肉': ['meat', 'rou', 'daging', 'pork', 'beef', 'lamb', 'chicken'],
    '猪': ['pork', 'zhu', 'babi', '猪肉'],
    '牛': ['beef', 'niu', 'lembu', '牛肉'],
    '羊': ['lamb', 'mutton', 'yang', 'kambing', '羊肉'],
    '鸡': ['chicken', 'ji', 'ayam', '鸡肉'],

    // 海鲜同义词
    '虾': ['shrimp', 'prawn', 'xia', 'udang', '大虾', '河虾', '龙虾'],
    '鱼': ['fish', 'yu', 'ikan'],
    '蚝': ['oyster', 'hao', 'tiram', '生蚝'],
    '鱿鱼': ['squid', 'calamari', 'sotong', 'youyu'],
    '海鲜': ['seafood', 'makanan laut', 'haixian'],

    // 烹饪方式同义词
    '烤': ['bbq', 'grill', 'roast', 'kao', 'panggang', 'barbecue'],
    '炒': ['stir fry', 'chao', 'tumis', 'fried'],
    '凉拌': ['cold', 'salad', 'liangban', 'sejuk'],
    '辣': ['spicy', 'hot', 'la', 'pedas', 'chili', 'chilli'],
    '麻辣': ['mala', 'numbing spicy', 'sichuan'],

    // 菜品类型同义词
    '串': ['skewer', 'satay', 'sate', 'chuan', 'kebab'],
    '汤': ['soup', 'tang', 'sup'],
    '面': ['noodle', 'mian', 'mee'],
    '豆腐': ['tofu', 'doufu', 'tauhu', 'beancurd'],
    '蔬菜': ['vegetable', 'veg', 'sayur', 'veggie', '素'],
    '素食': ['vegetarian', 'vegan', 'sushi', 'sayur'],

    // 口味同义词
    '不辣': ['not spicy', 'mild', 'tidak pedas', 'bu la'],
    '微辣': ['slightly spicy', 'little spicy', 'sedikit pedas'],
    '特辣': ['very spicy', 'extra spicy', 'sangat pedas'],

    // 常见搜索词
    '好吃': ['delicious', 'tasty', 'sedap', 'yummy', 'nice'],
    '推荐': ['recommend', 'popular', 'best', 'signature'],
    '便宜': ['cheap', 'affordable', 'murah', 'budget'],

    // 英文到中文映射
    'chicken': ['鸡', '鸡肉', 'ayam'],
    'pork': ['猪', '猪肉', 'babi'],
    'beef': ['牛', '牛肉', 'lembu'],
    'lamb': ['羊', '羊肉', 'kambing'],
    'fish': ['鱼', 'ikan'],
    'shrimp': ['虾', 'udang', 'prawn'],
    'tofu': ['豆腐', 'tauhu'],
    'spicy': ['辣', 'pedas', 'hot'],
    'vegetarian': ['素食', '素', 'sayur'],
    'bbq': ['烤', '烧烤', 'panggang'],
    'skewer': ['串', 'satay'],
    'cold': ['凉', '凉菜', 'sejuk'],
    'wing': ['翅', '鸡翅'],
    'soup': ['汤', 'sup'],

    // 马来语映射
    'ayam': ['鸡', 'chicken'],
    'babi': ['猪', 'pork'],
    'lembu': ['牛', 'beef'],
    'kambing': ['羊', 'lamb'],
    'udang': ['虾', 'shrimp'],
    'ikan': ['鱼', 'fish'],
    'pedas': ['辣', 'spicy'],
    'sayur': ['蔬菜', '素食', 'vegetable'],
    'panggang': ['烤', 'grill', 'bbq']
};

// Fuzzy match helper
function fuzzyMatch(text, query) {
    text = text.toLowerCase();
    query = query.toLowerCase();

    // Exact match
    if (text.includes(query)) return true;

    // Check synonyms
    for (const [key, synonyms] of Object.entries(searchSynonyms)) {
        if (key.includes(query) || query.includes(key)) {
            if (text.includes(key)) return true;
            for (const syn of synonyms) {
                if (text.includes(syn)) return true;
            }
        }
        for (const syn of synonyms) {
            if (syn.includes(query) || query.includes(syn)) {
                if (text.includes(key)) return true;
            }
        }
    }

    return false;
}

// Smart search function
function smartSearch(dish, query) {
    if (!query) return true;

    query = query.toLowerCase().trim();

    // Build searchable text from all dish fields
    const searchText = [
        dish.name,
        dish.name_en || '',
        dish.name_ms || '',
        dish.name_ta || '',
        dish.description || '',
        dish.desc_en || '',
        dish.category || '',
        ...(dish.keywords || []),
        ...(dish.tags || [])
    ].join(' ').toLowerCase();

    // Split query into words and check each
    const queryWords = query.split(/\s+/);
    return queryWords.every(word => fuzzyMatch(searchText, word));
}

// ==================== DOM Elements ====================
const menuContainer = document.getElementById('menu-container');
const emptyState = document.getElementById('empty-state');
const cartBtn = document.getElementById('cart-btn');
const cartModal = document.getElementById('cart-modal');
const cartItems = document.getElementById('cart-items');
const cartEmpty = document.getElementById('cart-empty');
const cartFooter = document.getElementById('cart-footer');
const cartCount = document.getElementById('cart-count');
const cartTotal = document.getElementById('cart-total');
const closeCart = document.getElementById('close-cart');
const clearCartBtn = document.getElementById('clear-cart');
const sendWhatsAppBtn = document.getElementById('send-whatsapp');
const copyWechatBtn = document.getElementById('copy-wechat');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');
const searchInput = document.getElementById('search-input');
const langBtns = document.querySelectorAll('.lang-btn');
const historySection = document.getElementById('history-section');
const orderNoteInput = document.getElementById('order-note');

// ==================== i18n Helper ====================
function t(key) {
    if (!menuData || !menuData.i18n) return key;
    const translation = menuData.i18n[key];
    if (!translation) return key;
    return translation[currentLang] || translation['zh'] || key;
}

function getDishName(dish) {
    if (currentLang === 'en' && dish.name_en) return dish.name_en;
    if (currentLang === 'ms' && dish.name_ms) return dish.name_ms;
    if (currentLang === 'ta' && dish.name_ta) return dish.name_ta;
    return dish.name;
}

function getDishDesc(dish) {
    if (currentLang === 'en' && dish.desc_en) return dish.desc_en;
    if (currentLang === 'ms' && dish.desc_ms) return dish.desc_ms;
    if (currentLang === 'ta' && dish.desc_ta) return dish.desc_ta;
    return dish.description || '';
}

function getDishUnit(dish) {
    if (currentLang === 'en' && dish.unit_en) return dish.unit_en;
    return dish.unit;
}

// ==================== Initialize ====================
document.addEventListener('DOMContentLoaded', async () => {
    await loadMenu();
    setupEventListeners();
    loadCartFromStorage();
    updateLanguageUI();
    renderHistorySection();
});

// Load menu data
async function loadMenu() {
    try {
        const response = await fetch('data/menu.json');
        menuData = await response.json();
        renderMenu();
        updateAllText();
    } catch (error) {
        console.error('Failed to load menu:', error);
        menuContainer.innerHTML = '<div class="col-span-full text-center py-8 text-red-500">菜单加载失败，请刷新页面</div>';
    }
}

// Update all translatable text
function updateAllText() {
    if (searchInput) {
        searchInput.placeholder = t('search');
    }

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        el.textContent = t(key);
    });
}

// ==================== Render Functions ====================
function getSpicyTag(tags) {
    if (tags.includes('特辣')) {
        return '<span class="menu-card-tag spicy-3">' + t('verySpicy') + '</span>';
    } else if (tags.includes('中辣')) {
        return '<span class="menu-card-tag spicy-2">' + t('mediumSpicy') + '</span>';
    } else if (tags.includes('微辣')) {
        return '<span class="menu-card-tag spicy-1">' + t('mildSpicy') + '</span>';
    } else if (tags.includes('不辣')) {
        return '<span class="menu-card-tag">' + t('notSpicy') + '</span>';
    }
    return '';
}

function renderCartControl(dish) {
    const cartItem = cart.find(item => item.id === dish.id);

    if (cartItem) {
        return '<div class="qty-control">' +
            '<button class="qty-btn minus-btn" data-id="' + dish.id + '">−</button>' +
            '<span class="qty-value">' + cartItem.quantity + '</span>' +
            '<button class="qty-btn plus-btn" data-id="' + dish.id + '">+</button>' +
            '</div>';
    }

    return '<button class="add-to-cart-btn" data-id="' + dish.id + '">+</button>';
}

function renderMenu() {
    const dishes = filterDishes();

    if (dishes.length === 0) {
        menuContainer.innerHTML = '';
        emptyState.classList.remove('hidden');
        const emptyText = emptyState.querySelector('p');
        if (emptyText) emptyText.textContent = t('noResults');
        return;
    }

    emptyState.classList.add('hidden');

    let html = '';
    dishes.forEach((dish, index) => {
        const name = getDishName(dish);
        const desc = getDishDesc(dish);
        const unit = getDishUnit(dish);
        const spicyTag = getSpicyTag(dish.tags);
        const vegTag = dish.tags.includes('素食') ? '<span class="menu-card-tag">' + t('vegetarian') + '</span>' : '';
        const seafoodTag = dish.tags.includes('海鲜') ? '<span class="menu-card-tag">' + t('seafood') + '</span>' : '';
        const cartControl = renderCartControl(dish);
        const historyBadge = isInHistory(dish.id) ? '<span class="history-badge">♥</span>' : '';

        // 优先使用网图，若无则使用本地图片
        const imgSrc = dish.image_url || ('assets/images/' + dish.image);
        html += '<div class="menu-card animate-fade-in" style="animation-delay: ' + (index * 0.03) + 's" data-id="' + dish.id + '">' +
            '<div class="menu-card-image">' +
                '<img src="' + imgSrc + '" alt="' + name + '" loading="lazy" onerror="this.src=\'assets/images/' + dish.image + '\'">' +
                historyBadge +
            '</div>' +
            '<div class="menu-card-content">' +
                '<h3 class="menu-card-name">' + name + '</h3>' +
                '<p class="menu-card-desc">' + desc + '</p>' +
                '<div class="menu-card-tags">' + spicyTag + vegTag + seafoodTag + '</div>' +
                '<div class="menu-card-footer">' +
                    '<div>' +
                        '<span class="menu-card-price">$' + dish.price.toFixed(2) + '</span>' +
                        '<span class="menu-card-unit">/' + unit + '</span>' +
                    '</div>' +
                    cartControl +
                '</div>' +
            '</div>' +
        '</div>';
    });

    menuContainer.innerHTML = html;
    setupMenuEventListeners();
}

// Filter dishes
function filterDishes() {
    if (!menuData) return [];

    return menuData.dishes.filter(dish => {
        // Search filter
        if (searchQuery && !smartSearch(dish, searchQuery)) {
            return false;
        }

        // Category filter
        if (activeFilter !== 'all' && dish.category !== activeFilter) {
            return false;
        }

        // Tag filters
        if (activeTags.size > 0) {
            for (const tag of activeTags) {
                if (!dish.tags.includes(tag)) {
                    return false;
                }
            }
        }

        return true;
    });
}

// ==================== History Functions ====================
function isInHistory(dishId) {
    return orderHistory.some(h => h.id === dishId);
}

function addToHistory(dishId) {
    const existing = orderHistory.find(h => h.id === dishId);
    if (existing) {
        existing.count++;
        existing.lastOrdered = Date.now();
    } else {
        orderHistory.push({
            id: dishId,
            count: 1,
            lastOrdered: Date.now()
        });
    }
    // Keep only top 20
    orderHistory.sort((a, b) => b.count - a.count);
    orderHistory = orderHistory.slice(0, 20);
    localStorage.setItem('ddxsg_history', JSON.stringify(orderHistory));
}

function renderHistorySection() {
    if (!historySection || !menuData) return;

    if (orderHistory.length === 0) {
        historySection.classList.add('hidden');
        return;
    }

    historySection.classList.remove('hidden');
    const historyContainer = historySection.querySelector('.history-items');
    if (!historyContainer) return;

    const topHistory = orderHistory.slice(0, 5);
    let html = '';

    topHistory.forEach(h => {
        const dish = menuData.dishes.find(d => d.id === h.id);
        if (!dish) return;

        const name = getDishName(dish);
        const histImgSrc = dish.image_url || ('assets/images/' + dish.image);
        html += '<button class="history-item" data-id="' + dish.id + '">' +
            '<img src="' + histImgSrc + '" alt="' + name + '" onerror="this.src=\'assets/images/' + dish.image + '\'">' +
            '<span>' + name + '</span>' +
        '</button>';
    });

    historyContainer.innerHTML = html;

    historyContainer.querySelectorAll('.history-item').forEach(btn => {
        btn.addEventListener('click', () => {
            addToCart(parseInt(btn.dataset.id));
        });
    });
}

// ==================== Event Listeners ====================
function setupEventListeners() {
    // Search input
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value;
            renderMenu();
        });
    }

    // Language buttons
    langBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            currentLang = btn.dataset.lang;
            localStorage.setItem('ddxsg_lang', currentLang);
            updateLanguageUI();
            updateAllText();
            renderMenu();
            renderHistorySection();
        });
    });

    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.filter;
            renderMenu();
        });
    });

    // Tag buttons
    document.querySelectorAll('.tag-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            const tag = btn.dataset.tag;
            if (activeTags.has(tag)) {
                activeTags.delete(tag);
            } else {
                activeTags.add(tag);
            }
            renderMenu();
        });
    });

    // Cart modal
    if (cartBtn) cartBtn.addEventListener('click', openCart);
    if (closeCart) closeCart.addEventListener('click', closeCartModal);
    if (cartModal) {
        cartModal.addEventListener('click', (e) => {
            if (e.target === cartModal) closeCartModal();
        });
    }

    // Cart actions
    if (clearCartBtn) clearCartBtn.addEventListener('click', clearCart);
    if (sendWhatsAppBtn) sendWhatsAppBtn.addEventListener('click', sendToWhatsApp);

    // WeChat copy
    if (copyWechatBtn) {
        copyWechatBtn.addEventListener('click', () => {
            copyToClipboard('duduxiang_sg', t('copied'));
        });
    }

    // Order note
    if (orderNoteInput) {
        orderNoteInput.addEventListener('input', (e) => {
            orderNote = e.target.value;
        });
    }
}

function updateLanguageUI() {
    langBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === currentLang);
    });
}

function setupMenuEventListeners() {
    document.querySelectorAll('.add-to-cart-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            addToCart(parseInt(btn.dataset.id));
        });
    });

    document.querySelectorAll('.plus-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            addToCart(parseInt(btn.dataset.id));
        });
    });

    document.querySelectorAll('.minus-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeFromCart(parseInt(btn.dataset.id));
        });
    });
}

// ==================== Cart Functions ====================
function addToCart(dishId) {
    const dish = menuData.dishes.find(d => d.id === dishId);
    if (!dish) return;

    const existingItem = cart.find(item => item.id === dishId);

    if (existingItem) {
        existingItem.quantity++;
    } else {
        cart.push({
            id: dish.id,
            name: dish.name,
            name_en: dish.name_en,
            price: dish.price,
            unit: dish.unit,
            unit_en: dish.unit_en,
            quantity: 1
        });
    }

    addToHistory(dishId);

    updateCart();
    saveCartToStorage();
    renderMenu();
    renderHistorySection();
}

function removeFromCart(dishId) {
    const existingItem = cart.find(item => item.id === dishId);

    if (existingItem) {
        existingItem.quantity--;
        if (existingItem.quantity <= 0) {
            cart = cart.filter(item => item.id !== dishId);
        }
    }

    updateCart();
    saveCartToStorage();
    renderMenu();
}

function updateCart() {
    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    if (cartCount) cartCount.textContent = totalItems;
    if (cartTotal) cartTotal.textContent = totalPrice.toFixed(2);
}

function openCart() {
    if (cartModal) {
        cartModal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        renderCartItems();
    }
}

function closeCartModal() {
    if (cartModal) {
        cartModal.classList.add('hidden');
        document.body.style.overflow = '';
    }
}

function renderCartItems() {
    if (cart.length === 0) {
        if (cartItems) cartItems.classList.add('hidden');
        if (cartFooter) cartFooter.classList.add('hidden');
        if (cartEmpty) {
            cartEmpty.classList.remove('hidden');
            const emptyText = cartEmpty.querySelector('p');
            if (emptyText) emptyText.textContent = t('emptyCart');
        }
        return;
    }

    if (cartItems) cartItems.classList.remove('hidden');
    if (cartFooter) cartFooter.classList.remove('hidden');
    if (cartEmpty) cartEmpty.classList.add('hidden');

    let html = '';
    cart.forEach(item => {
        const name = currentLang === 'en' && item.name_en ? item.name_en : item.name;
        const unit = currentLang === 'en' && item.unit_en ? item.unit_en : item.unit;

        html += '<div class="cart-item">' +
            '<div class="cart-item-info">' +
                '<div class="cart-item-name">' + name + '</div>' +
                '<div class="cart-item-price">$' + item.price.toFixed(2) + ' / ' + unit + '</div>' +
            '</div>' +
            '<div class="qty-control">' +
                '<button class="qty-btn cart-minus" data-id="' + item.id + '">−</button>' +
                '<span class="qty-value">' + item.quantity + '</span>' +
                '<button class="qty-btn cart-plus" data-id="' + item.id + '">+</button>' +
            '</div>' +
            '<div class="cart-item-subtotal">$' + (item.price * item.quantity).toFixed(2) + '</div>' +
        '</div>';
    });

    if (cartItems) {
        cartItems.innerHTML = html;

        document.querySelectorAll('.cart-plus').forEach(btn => {
            btn.addEventListener('click', () => {
                addToCart(parseInt(btn.dataset.id));
                renderCartItems();
            });
        });

        document.querySelectorAll('.cart-minus').forEach(btn => {
            btn.addEventListener('click', () => {
                removeFromCart(parseInt(btn.dataset.id));
                renderCartItems();
            });
        });
    }
}

function clearCart() {
    cart = [];
    updateCart();
    saveCartToStorage();
    renderCartItems();
    renderMenu();
}

// ==================== WhatsApp Integration ====================
function sendToWhatsApp() {
    if (cart.length === 0) {
        showToast(t('emptyCart'));
        return;
    }

    const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const phone = menuData?.restaurant?.whatsapp || '6588199509';

    // 始终使用中文发送 WhatsApp 消息，方便店家处理
    let orderText = '🔥 *嘟嘟香订单*\n\n';

    cart.forEach(item => {
        // 始终使用中文菜名
        orderText += '• ' + item.name + ' x ' + item.quantity + ' = $' + (item.price * item.quantity).toFixed(2) + '\n';
    });

    orderText += '\n💰 *总计: $' + total.toFixed(2) + '*\n';

    if (orderNote) {
        orderText += '\n📝 *备注:* ' + orderNote + '\n';
    }

    orderText += '\n📍 711 Ang Mo Kio Ave 8';

    const encodedText = encodeURIComponent(orderText);
    const whatsappUrl = 'https://wa.me/' + phone + '?text=' + encodedText;

    window.open(whatsappUrl, '_blank');

    showToast('正在打开 WhatsApp...');
}

// ==================== Utility Functions ====================
function copyToClipboard(text, message) {
    navigator.clipboard.writeText(text).then(() => {
        showToast(message);
    }).catch(() => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast(message);
    });
}

function showToast(message) {
    if (toastMessage) toastMessage.textContent = message;
    if (toast) {
        toast.classList.add('toast-show');
        setTimeout(() => {
            toast.classList.remove('toast-show');
        }, 2000);
    }
}

function saveCartToStorage() {
    localStorage.setItem('ddxsg_cart', JSON.stringify(cart));
}

function loadCartFromStorage() {
    const saved = localStorage.getItem('ddxsg_cart');
    if (saved) {
        try {
            cart = JSON.parse(saved);
            updateCart();
        } catch (e) {
            cart = [];
        }
    }
}
