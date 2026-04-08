// =============================================
// MemeScan – Token Scanner App
// Data source: DexScreener public API (free)
// =============================================

const API_BASE = 'https://api.dexscreener.com';
const REFRESH_INTERVAL = 60000; // 60 giây

let allTokens = [];
let watchlist = JSON.parse(localStorage.getItem('memescan_watchlist') || '[]');
let currentChain = 'all';
let refreshTimer = null;

// =============================================
// FETCH DATA
// =============================================

async function loadTokens() {
  setLoading(true);
  hideError();

  // Queries to search new promising memecoins
  // DexScreener search API: /latest/dex/search?q=...
  const queries = [
    'meme', 'moon', 'pepe', 'dog', 'cat', 'inu', 'ai', 'baby', 'elon'
  ];

  // Also fetch token boosts (trending boosted tokens)
  const fetchPromises = [
    fetchWithTimeout(`${API_BASE}/token-boosts/latest/v1`),
    fetchWithTimeout(`${API_BASE}/token-profiles/latest/v1`),
    ...queries.slice(0, 3).map(q =>
      fetchWithTimeout(`${API_BASE}/latest/dex/search?q=${q}`)
    )
  ];

  try {
    const results = await Promise.allSettled(fetchPromises);
    const pairs = [];

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const data = result.value;

        // token-boosts format
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item.tokenAddress && item.chainId) {
              // Fetch pair info for this token
              pairs.push(...(await fetchPairData(item.chainId, item.tokenAddress)));
            }
          }
        }

        // search format: { pairs: [...] }
        if (data.pairs && Array.isArray(data.pairs)) {
          pairs.push(...data.pairs);
        }
      }
    }

    // Deduplicate by pairAddress
    const seen = new Set();
    const unique = pairs.filter(p => {
      if (!p || !p.pairAddress) return false;
      if (seen.has(p.pairAddress)) return false;
      seen.add(p.pairAddress);
      return true;
    });

    allTokens = unique.map(parsePair).filter(Boolean);
    renderTokens();
    updateStats();
    updateLastUpdate();

  } catch (err) {
    console.error('Load error:', err);
    showError();
  } finally {
    setLoading(false);
  }
}

async function fetchPairData(chain, tokenAddress) {
  try {
    const data = await fetchWithTimeout(
      `${API_BASE}/latest/dex/tokens/${tokenAddress}`
    );
    return data?.pairs || [];
  } catch {
    return [];
  }
}

async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
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
    if (e.target.closest('.star-btn')) return;
    window.open(token.dexUrl, '_blank');
  });

  // Star button
  const starBtn = card.querySelector('.star-btn');
  starBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleWatchlist(token, starBtn);
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

// =============================================
// INIT
// =============================================

renderWatchlist();
loadTokens();
startAutoRefresh();

console.log('%c⚡ MemeScan loaded', 'color:#6366f1;font-weight:bold;font-size:14px');
