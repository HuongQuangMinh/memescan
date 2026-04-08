// =============================================
// MemeScan – Token Scanner App
// Data source: DexScreener public API (free)
// =============================================

const API_BASE = 'https://api.dexscreener.com';
const REFRESH_INTERVAL = 60000;
const CACHE_KEY = 'memescan_cache_v2';
const CACHE_TTL = 45000; // 45 giây

let allTokens = [];
let tokensSeen = new Set(); // theo dõi pair đã hiển
let watchlist = JSON.parse(localStorage.getItem('memescan_watchlist') || '[]');
let currentChain = 'all';
let refreshTimer = null;
let isLoading = false;

// =============================================
// CACHE
// =============================================

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function saveCache(tokens) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      data: tokens.slice(0, 120),
      ts: Date.now(),
    }));
  } catch {}
}

// =============================================
// FETCH DATA — Progressive, hiện ngay từng batch
// =============================================

async function loadTokens() {
  if (isLoading) return;
  isLoading = true;
  hideError();

  // Bước 1: Hiện cache NGAY LẬP TỨC (0ms)
  const cached = loadCache();
  if (cached && cached.length > 0) {
    allTokens = cached;
    tokensSeen = new Set(cached.map(t => t.pairAddress));
    renderTokens();
    updateStats();
    // Không hiện spinner nếu đã có cache
    showToast('⚡ Đang cập nhật dữ liệu mới...');
  } else {
    setLoading(true);
  }

  // Bước 2: Queries ưu tiên (load nhanh nhất)
  const fastQueries = [
    'meme', 'pepe', 'dog', 'sol meme', 'bnb meme',
  ];

  // Bước 3: Queries phụ (load sau, bổ sung thêm)
  const slowQueries = [
    'moon', 'ai', 'inu', 'eth meme', 'base meme',
    'sol cat', 'baby', 'erc20 inu',
  ];

  // Hàm merge token mới vào danh sách và render ngay
  let newCount = 0;
  const mergeAndRender = (pairs) => {
    const fresh = pairs
      .map(parsePair)
      .filter(t => t && !tokensSeen.has(t.pairAddress));
    if (fresh.length === 0) return;
    fresh.forEach(t => tokensSeen.add(t.pairAddress));
    allTokens = [...allTokens, ...fresh];
    newCount += fresh.length;
    renderTokens();
    updateStats();
    setLoading(false); // Tắt spinner sau batch đầu tiên
  };

  try {
    // Fast queries — chạy song song, mỗi cái xong là render ngay
    await Promise.all(
      fastQueries.map(q =>
        fetchJson(`${API_BASE}/latest/dex/search?q=${encodeURIComponent(q)}`)
          .then(d => { if (d?.pairs) mergeAndRender(d.pairs); })
          .catch(() => {})
      )
    );

    // Slow queries — bổ sung thêm, không block UI
    Promise.all(
      slowQueries.map(q =>
        fetchJson(`${API_BASE}/latest/dex/search?q=${encodeURIComponent(q)}`)
          .then(d => { if (d?.pairs) mergeAndRender(d.pairs); })
          .catch(() => {})
      )
    ).then(() => {
      // Token boosts — fetch song song sau cùng (không block)
      fetchJson(`${API_BASE}/token-boosts/latest/v1`).then(async boosts => {
        if (!Array.isArray(boosts)) return;
        const top = boosts.slice(0, 12);
        const results = await Promise.all(
          top.map(t =>
            fetchJson(`${API_BASE}/latest/dex/tokens/${t.tokenAddress}`)
              .then(r => r?.pairs || [])
              .catch(() => [])
          )
        );
        const allPairs = results.flat();
        if (allPairs.length) mergeAndRender(allPairs);
        saveCache(allTokens);
        updateLastUpdate();
        if (newCount > 0) showToast(`✅ +${newCount} token mới!`);
      }).catch(() => {});
    });

  } catch (err) {
    console.error('Lỗi:', err);
    if (!cached) showError();
  } finally {
    isLoading = false;
    setLoading(false);
    saveCache(allTokens);
    updateLastUpdate();
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000); // 5s timeout
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// Tìm theo contract address — hiện ngay lập tức
async function searchByContract(address) {
  address = address.trim();
  if (!address || address.length < 20) {
    showToast('⚠️ Vui lòng dán địa chỉ hợp lệ!');
    return;
  }
  showToast('🔍 Đang tìm token...');
  setLoading(true);
  try {
    const data = await fetchJson(`${API_BASE}/latest/dex/tokens/${address}`);
    if (!data?.pairs?.length) {
      showToast('❌ Không tìm thấy token này!');
      return;
    }
    const found = data.pairs.map(parsePair).filter(Boolean);
    const grid = document.getElementById('token-grid');
    document.getElementById('empty-state').style.display = 'none';
    grid.innerHTML = '';
    found.forEach((t, i) => grid.appendChild(buildTokenCard(t, i)));
    document.getElementById('total-count').textContent = found.length;
    showToast(`✅ Tìm thấy ${found.length} cặp giao dịch!`);
  } catch {
    showToast('❌ Lỗi kết nối, thử lại!');
  } finally {
    setLoading(false);
  }
}

// =============================================
// PARSE PAIR DATA
// =============================================

function parsePair(pair) {
  if (!pair || !pair.baseToken) return null;

  const priceUsd = parseFloat(pair.priceUsd) || 0;
  const liquidity = pair.liquidity?.usd || 0;
  const volume24h = pair.volume?.h24 || 0;
  const priceChange24h = pair.priceChange?.h24 || 0;
  const pairCreatedAt = pair.pairCreatedAt || Date.now();
  const ageHours = (Date.now() - pairCreatedAt) / 3600000;

  const chain = pair.chainId?.toLowerCase() || 'other';
  const dexUrl = pair.url || `https://dexscreener.com/${chain}/${pair.pairAddress}`;

  // Calculate safety score (0–100)
  const safetyScore = calcSafetyScore({ liquidity, volume24h, ageHours, priceChange24h });

  return {
    name: pair.baseToken.name || 'Unknown',
    symbol: pair.baseToken.symbol || '???',
    address: pair.baseToken.address || '',
    chain,
    priceUsd,
    priceChange24h,
    liquidity,
    volume24h,
    ageHours,
    pairAddress: pair.pairAddress,
    dexUrl,
    safetyScore,
    imgUrl: pair.info?.imageUrl || null,
    txns24h: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
    fdv: pair.fdv || 0,
  };
}

// =============================================
// SAFETY SCORE ALGORITHM
// =============================================

function calcSafetyScore({ liquidity, volume24h, ageHours, priceChange24h }) {
  let score = 0;

  // Liquidity score (max 40 pts)
  if (liquidity >= 500000) score += 40;
  else if (liquidity >= 100000) score += 35;
  else if (liquidity >= 50000) score += 28;
  else if (liquidity >= 10000) score += 18;
  else if (liquidity >= 5000) score += 10;
  else score += 3;

  // Volume score (max 30 pts)
  if (volume24h >= 1000000) score += 30;
  else if (volume24h >= 100000) score += 24;
  else if (volume24h >= 50000) score += 18;
  else if (volume24h >= 10000) score += 12;
  else if (volume24h >= 1000) score += 6;
  else score += 1;

  // Age score (max 20 pts) — older = safer
  if (ageHours >= 720) score += 20;       // 30 ngày+
  else if (ageHours >= 168) score += 16;  // 7 ngày+
  else if (ageHours >= 24) score += 10;   // 1 ngày+
  else if (ageHours >= 6) score += 6;
  else if (ageHours >= 1) score += 3;
  else score += 0;

  // Price stability (max 10 pts)
  const absChange = Math.abs(priceChange24h);
  if (absChange < 20) score += 10;
  else if (absChange < 50) score += 6;
  else if (absChange < 100) score += 3;
  else score += 0;

  return Math.min(100, Math.max(0, score));
}

// =============================================
// RENDER
// =============================================

function getFilterValues() {
  return {
    chain: currentChain,
    minLiquidity: parseFloat(document.getElementById('filter-liquidity').value) || 0,
    maxAgeHours: parseFloat(document.getElementById('filter-age').value) || 999,
    minVolume: parseFloat(document.getElementById('filter-volume').value) || 0,
    sort: document.getElementById('filter-sort').value,
  };
}

function renderTokens() {
  const grid = document.getElementById('token-grid');
  const emptyState = document.getElementById('empty-state');
  const filters = getFilterValues();

  let filtered = allTokens.filter(t => {
    if (filters.chain !== 'all' && t.chain !== filters.chain) return false;
    if (t.liquidity < filters.minLiquidity) return false;
    if (t.ageHours > filters.maxAgeHours) return false;
    if (t.volume24h < filters.minVolume) return false;
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    switch (filters.sort) {
      case 'age': return a.ageHours - b.ageHours;
      case 'liquidity': return b.liquidity - a.liquidity;
      case 'volume': return b.volume24h - a.volume24h;
      case 'priceChange': return b.priceChange24h - a.priceChange24h;
      default: return a.ageHours - b.ageHours;
    }
  });

  grid.innerHTML = '';

  if (filtered.length === 0) {
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';

  filtered.slice(0, 60).forEach((token, i) => {
    const card = buildTokenCard(token, i);
    grid.appendChild(card);
  });

  document.getElementById('total-count').textContent = filtered.length;
}

function buildTokenCard(token, index) {
  const card = document.createElement('div');
  card.className = 'token-card';
  card.style.animationDelay = `${Math.min(index * 0.04, 0.5)}s`;
  card.title = `Xem ${token.name} trên DexScreener`;

  const scoreClass = token.safetyScore >= 70 ? 'high' : token.safetyScore >= 40 ? 'mid' : 'low';
  const scoreEmoji = token.safetyScore >= 70 ? '🟢' : token.safetyScore >= 40 ? '🟡' : '🔴';
  const changeClass = token.priceChange24h > 0 ? 'up' : token.priceChange24h < 0 ? 'down' : 'neutral';
  const changeSign = token.priceChange24h > 0 ? '+' : '';
  const chainClass = ['solana','bsc','ethereum','base'].includes(token.chain) ? token.chain : 'other';
  const isWatched = watchlist.some(w => w.pairAddress === token.pairAddress);

  const avatarContent = token.imgUrl
    ? `<img src="${token.imgUrl}" alt="${token.symbol}" onerror="this.parentElement.textContent='${token.symbol.charAt(0)}'">`
    : token.symbol.charAt(0).toUpperCase();

  card.innerHTML = `
    <div class="age-badge">⏱ ${formatAge(token.ageHours)}</div>
    <div class="card-header">
      <div class="token-identity">
        <div class="token-avatar">${avatarContent}</div>
        <div>
          <div class="token-name">${escHtml(token.name)}</div>
          <div class="token-symbol">$${escHtml(token.symbol)}</div>
        </div>
      </div>
      <div class="card-actions">
        <span class="chain-tag ${chainClass}">${token.chain.toUpperCase()}</span>
        <button class="swap-btn" data-pair="${token.pairAddress}" title="Swap / Mua token">🔄 Swap</button>
        <button class="star-btn ${isWatched ? 'active' : ''}" data-pair="${token.pairAddress}" title="Theo dõi">⭐</button>
      </div>
    </div>

    <div class="price-row">
      <span class="token-price">${formatPrice(token.priceUsd)}</span>
      <span class="price-change ${changeClass}">${changeSign}${token.priceChange24h.toFixed(2)}%</span>
    </div>

    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-name">💧 Thanh khoản</div>
        <div class="stat-value">${formatUSD(token.liquidity)}</div>
      </div>
      <div class="stat-item">
        <div class="stat-name">📊 Volume 24h</div>
        <div class="stat-value">${formatUSD(token.volume24h)}</div>
      </div>
      <div class="stat-item">
        <div class="stat-name">🔄 Giao dịch 24h</div>
        <div class="stat-value">${token.txns24h.toLocaleString()}</div>
      </div>
      <div class="stat-item">
        <div class="stat-name">📈 FDV</div>
        <div class="stat-value">${formatUSD(token.fdv)}</div>
      </div>
    </div>

    <div class="safety-row">
      <span class="safety-label">${scoreEmoji} An toàn</span>
      <div class="safety-bar">
        <div class="safety-fill ${scoreClass}" style="width: ${token.safetyScore}%"></div>
      </div>
      <span class="safety-score-num ${scoreClass}">${token.safetyScore}</span>
    </div>
  `;

  // Click card → open DexScreener
  card.addEventListener('click', (e) => {
    if (e.target.closest('.star-btn') || e.target.closest('.swap-btn')) return;
    window.open(token.dexUrl, '_blank');
  });

  // Star button
  const starBtn = card.querySelector('.star-btn');
  starBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleWatchlist(token, starBtn);
  });

  // Swap button
  const swapBtn = card.querySelector('.swap-btn');
  swapBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSwapModal(token);
  });

  return card;
}

// =============================================
// WATCHLIST
// =============================================

function toggleWatchlist(token, btn) {
  const idx = watchlist.findIndex(w => w.pairAddress === token.pairAddress);
  if (idx === -1) {
    watchlist.push({
      pairAddress: token.pairAddress,
      name: token.name,
      symbol: token.symbol,
      chain: token.chain,
      priceUsd: token.priceUsd,
      dexUrl: token.dexUrl,
    });
    btn.classList.add('active');
    showToast(`⭐ Đã thêm $${token.symbol} vào theo dõi`);
  } else {
    watchlist.splice(idx, 1);
    btn.classList.remove('active');
    showToast(`Đã xóa $${token.symbol} khỏi theo dõi`);
  }
  localStorage.setItem('memescan_watchlist', JSON.stringify(watchlist));
  renderWatchlist();
}

function renderWatchlist() {
  const body = document.getElementById('watchlist-body');
  const countEl = document.getElementById('watchlist-count');
  countEl.textContent = watchlist.length;

  if (watchlist.length === 0) {
    body.innerHTML = '<p class="empty-watchlist">Chưa có token nào. Nhấn ⭐ trên card để thêm.</p>';
    return;
  }

  body.innerHTML = watchlist.map(w => `
    <div class="watchlist-item" onclick="window.open('${w.dexUrl}','_blank')">
      <div class="wl-info">
        <div class="wl-name">$${escHtml(w.symbol)} – ${escHtml(w.name)}</div>
        <div class="wl-chain">${w.chain.toUpperCase()}</div>
      </div>
      <div class="wl-price">${formatPrice(w.priceUsd)}</div>
    </div>
  `).join('');
}

// =============================================
// HELPERS
// =============================================

function formatPrice(p) {
  if (!p || p === 0) return '$0';
  if (p >= 1) return '$' + p.toFixed(4);
  if (p >= 0.0001) return '$' + p.toFixed(6);
  // Very small price
  const str = p.toExponential(2);
  return '$' + str;
}

function formatUSD(n) {
  if (!n) return '$0';
  if (n >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n/1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function formatAge(hours) {
  if (hours < 1) return Math.round(hours * 60) + 'p';
  if (hours < 24) return Math.round(hours) + 'h';
  return Math.round(hours / 24) + 'd';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function setLoading(show) {
  document.getElementById('loading').style.display = show ? 'flex' : 'none';
}

function showError() {
  document.getElementById('error-msg').style.display = 'flex';
}

function hideError() {
  document.getElementById('error-msg').style.display = 'none';
}

function updateStats() {
  document.getElementById('total-count').textContent = allTokens.length;
}

function updateLastUpdate() {
  const now = new Date();
  const time = now.toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  document.getElementById('last-update-text').textContent = `Cập nhật: ${time}`;
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// =============================================
// AUTO REFRESH
// =============================================

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    loadTokens();
  }, REFRESH_INTERVAL);
}

function animateRefreshBtn(spinning) {
  const btn = document.getElementById('btn-refresh');
  if (spinning) btn.classList.add('spinning');
  else btn.classList.remove('spinning');
}

// =============================================
// EVENT LISTENERS
// =============================================

document.getElementById('btn-refresh').addEventListener('click', () => {
  animateRefreshBtn(true);
  loadTokens().finally(() => setTimeout(() => animateRefreshBtn(false), 1000));
});

// Tìm kiếm contract
document.getElementById('btn-contract').addEventListener('click', () => {
  const addr = document.getElementById('contract-input').value;
  searchByContract(addr);
});
document.getElementById('contract-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    searchByContract(e.target.value);
  }
});
// Tự động tìm khi paste
document.getElementById('contract-input').addEventListener('paste', (e) => {
  setTimeout(() => {
    const addr = e.target.value;
    if (addr.length >= 30) searchByContract(addr);
  }, 100);
});

document.getElementById('btn-apply').addEventListener('click', renderTokens);

// Chain filter buttons
document.getElementById('chain-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('.chain-btn');
  if (!btn) return;
  document.querySelectorAll('.chain-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentChain = btn.dataset.chain;
  renderTokens();
});

// Watchlist panel
document.getElementById('watchlist-fab').addEventListener('click', () => {
  document.getElementById('watchlist-panel').classList.add('open');
});
document.getElementById('close-watchlist').addEventListener('click', () => {
  document.getElementById('watchlist-panel').classList.remove('open');
});

// Swap modal close
document.getElementById('swap-close').addEventListener('click', closeSwapModal);
document.getElementById('swap-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('swap-overlay')) closeSwapModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSwapModal();
});

// =============================================
// SWAP MODAL
// =============================================

const DEX_CONFIG = {
  solana: [
    { name: 'Jupiter', logo: '🌀', color: '#16a34a', getUrl: (addr) => `https://jup.ag/swap/SOL-${addr}` },
    { name: 'Raydium', logo: '💧', color: '#7c3aed', getUrl: (addr) => `https://raydium.io/swap/?outputCurrency=${addr}` },
  ],
  bsc: [
    { name: 'PancakeSwap', logo: '🥞', color: '#d97706', getUrl: (addr) => `https://pancakeswap.finance/swap?outputCurrency=${addr}` },
    { name: '1inch BSC', logo: '⚡', color: '#2563eb', getUrl: (addr) => `https://app.1inch.io/#/56/simple/swap/BNB/${addr}` },
  ],
  ethereum: [
    { name: 'Uniswap', logo: '🦄', color: '#db2777', getUrl: (addr) => `https://app.uniswap.org/swap?outputCurrency=${addr}&chain=mainnet` },
    { name: '1inch ETH', logo: '⚡', color: '#2563eb', getUrl: (addr) => `https://app.1inch.io/#/1/simple/swap/ETH/${addr}` },
  ],
  base: [
    { name: 'Uniswap Base', logo: '🔵', color: '#2563eb', getUrl: (addr) => `https://app.uniswap.org/swap?outputCurrency=${addr}&chain=base` },
    { name: 'Aerodrome', logo: '✈️', color: '#7c3aed', getUrl: (addr) => `https://aerodrome.finance/swap?to=${addr}` },
  ],
};

function openSwapModal(token) {
  // Fill token info
  const avatar = document.getElementById('swap-avatar');
  if (token.imgUrl) {
    avatar.innerHTML = `<img src="${token.imgUrl}" onerror="this.parentElement.textContent='${token.symbol.charAt(0)}'">`;
  } else {
    avatar.textContent = token.symbol.charAt(0).toUpperCase();
  }
  document.getElementById('swap-name').textContent = token.name;
  document.getElementById('swap-symbol').textContent = `$${token.symbol} • ${token.chain.toUpperCase()}`;
  document.getElementById('swap-price').textContent = formatPrice(token.priceUsd);

  const changeEl = document.getElementById('swap-change');
  const sign = token.priceChange24h > 0 ? '+' : '';
  changeEl.textContent = `${sign}${token.priceChange24h.toFixed(2)}%`;
  changeEl.className = 'swap-change ' + (token.priceChange24h > 0 ? 'up' : token.priceChange24h < 0 ? 'down' : '');

  // DexScreener link
  document.getElementById('swap-dexscreener').href = token.dexUrl;

  // Copy address
  const copyBtn = document.getElementById('swap-copy-addr');
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(token.address).then(() => {
      showToast('📋 Đã copy địa chỉ token!');
    });
  };

  // DEX buttons
  const grid = document.getElementById('swap-dex-grid');
  const dexList = DEX_CONFIG[token.chain] || [
    { name: 'DexScreener', logo: '📊', color: '#6366f1', getUrl: () => token.dexUrl }
  ];

  grid.innerHTML = dexList.map(dex => `
    <a href="${dex.getUrl(token.address)}" target="_blank" class="dex-btn" style="--dex-color:${dex.color}">
      <span class="dex-logo">${dex.logo}</span>
      <span class="dex-name">${dex.name}</span>
      <span class="dex-arrow">→</span>
    </a>
  `).join('');

  // Show modal
  document.getElementById('swap-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSwapModal() {
  document.getElementById('swap-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

// =============================================
// INIT
// =============================================

renderWatchlist();
loadTokens();
startAutoRefresh();

console.log('%c⚡ MemeScan loaded', 'color:#6366f1;font-weight:bold;font-size:14px');
