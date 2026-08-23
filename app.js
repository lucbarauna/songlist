let db = [];
let filtered = [];
let recommendationFeed = [];
let recommendationState = null;
let translations = {};
let currentMode = 'trending';
let limit = 20;

const CHUNK_SIZE = 20;
const CDN_MAPS_BASE = 'https://jd-s3.cdn.ubi.com/public/jdnext/maps';
const modalState = { activeUuid: null, animationFrameId: null, isReadyToPlay: false, isStarting: false };
const $ = id => document.getElementById(id);

function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeColor(color) {
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#667eea';
}

function ui(key, values = {}) {
    const text = translations.ui?.[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
}

function translate(group, key, fallback = ui('notInformed')) {
    return translations[group]?.[String(key)] ?? fallback;
}

function buildPreviewUrl(uuid, hash, type) {
    if (!hash) return '';
    const file = type === 'video' ? `videoPreview_LOW.vp8.webm/${hash}.webm` : `audioPreview.opus/${hash}.opus`;
    return `${CDN_MAPS_BASE}/${encodeURIComponent(uuid)}/${file}`;
}

function normalizeSong(uuid, song) {
    const genreCodes = Array.isArray(song.g) ? song.g.map(String) : [];
    const decadeCodes = Array.isArray(song.d) ? song.d.map(String) : [];
    const originalGame = song.o === undefined || song.o === null ? '' : String(song.o);
    return {
        uuid,
        title: song.t || ui('unknownTitle'),
        artist: song.a || ui('unknownArtist'),
        videoUrl: buildPreviewUrl(uuid, song.w, 'video'),
        audioUrl: buildPreviewUrl(uuid, song.z, 'audio'),
        spotifyRank: Number.isFinite(Number(song.s)) ? Number(song.s) : Number.MAX_SAFE_INTEGER,
        youtubeRank: Number.isFinite(Number(song.y)) ? Number(song.y) : Number.MAX_SAFE_INTEGER,
        bpm: Number(song.b) || 120,
        color: sanitizeColor(`#${song.h || '667eea'}`),
        originalGame,
        gameLabel: translate('o', originalGame),
        coachCount: Number(song.c) || 1,
        genreCodes,
        decadeCodes,
        genreLabel: genreCodes.map(code => translate('g', code)).join('/'),
        decadeLabel: decadeCodes.map(code => translate('d', code)).join('/')
    };
}

async function readGzipJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (typeof DecompressionStream !== 'function') throw new Error(ui('gzipUnsupported'));
    const alreadyDecoded = response.headers.get('content-encoding')?.includes('gzip');
    const stream = alreadyDecoded ? response.body : response.body.pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
}

async function loadCatalog() {
    const localeResponse = await fetch('languages/pt-br.json');
    if (!localeResponse.ok) throw new Error(`HTTP ${localeResponse.status}`);
    translations = await localeResponse.json();
    applyTranslations();
    const songs = await readGzipJson('songs.gz');
    db = Object.entries(songs).map(([uuid, song]) => normalizeSong(uuid, song));
}

function applyTranslations() {
    document.title = ui('documentTitle');
    document.querySelector('meta[name="description"]').content = ui('documentDescription');
    const textTargets = {
        loadingText: 'loading', catalogTitle: 'catalogTitle', catalogSubtitle: 'catalogSubtitle',
        tabTrending: 'tabTrending', tabLibrary: 'tabLibrary', spotifyWeightLabel: 'spotifyWeight',
        youtubeWeightLabel: 'youtubeWeight', recommendationTitle: 'recommendationTitle',
        recommendationDescription: 'recommendationDescription', jdnextGamesLabel: 'jdnextGames',
        jdnextPercentLabel: 'jdnextPercent', lastgameLabel: 'lastgame', lastgamePercentLabel: 'lastgamePercent',
        discoverPercentLabel: 'discoverPercent', normalPercentLabel: 'normalPercent', searchLabel: 'search',
        genreLabel: 'genre', decadeLabel: 'decade', gameLabel: 'games', playersLabel: 'dancers',
        btnResetFilters: 'clear'
    };
    Object.entries(textTargets).forEach(([id, key]) => { $(id).textContent = ui(key); });
    $('catalogTabs').setAttribute('aria-label', ui('navigation'));
    $('weightSp').setAttribute('aria-label', ui('spotifyWeightAria'));
    $('weightYt').setAttribute('aria-label', ui('youtubeWeightAria'));
    $('filtersSection').setAttribute('aria-label', ui('filters'));
    $('searchGeneral').placeholder = ui('searchPlaceholder');
    $('modalClose').setAttribute('aria-label', ui('closePreview'));
    updateThemeLabel();
}

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    loadCatalog().then(initApp).catch(error => {
        console.error('Catalog load error:', error);
        $('loadingSection').innerHTML = `<h2>${escapeHtml(ui('loadErrorTitle'))}</h2><p>${escapeHtml(ui('loadErrorDescription'))}</p><button type="button" id="retryLoad">${escapeHtml(ui('retry'))}</button>`;
        $('retryLoad')?.addEventListener('click', () => location.reload());
    });
});

function bindEvents() {
    $('themeToggle').addEventListener('click', toggleTheme);
    $('tabTrending').addEventListener('click', () => switchTab('trending'));
    $('tabLibrary').addEventListener('click', () => switchTab('library'));
    $('weightSp').addEventListener('input', scheduleUpdateRanks);
    $('weightYt').addEventListener('input', scheduleUpdateRanks);
    $('btnResetFilters').addEventListener('click', resetFilters);
    $('musicGrid').addEventListener('click', handleGridClick);
    $('modalClose').addEventListener('click', closeModal);
    $('videoModal').addEventListener('click', event => { if (event.target.id === 'videoModal') closeModal(); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && $('videoModal').classList.contains('active')) closeModal();
    });

    let searchDebounceId = null;
    $('searchGeneral').addEventListener('input', () => {
        clearTimeout(searchDebounceId);
        searchDebounceId = setTimeout(applyFilters, 120);
    });
    ['filterGenre', 'filterDecade', 'filterPlayers', 'filterGame'].forEach(id => $(id).addEventListener('change', applyFilters));
    ['ruleJdnextGames', 'ruleLastgame'].forEach(id => $(id).addEventListener('change', applyFilters));
    ['ruleJdnextPercent', 'ruleLastgamePercent', 'ruleDiscoverPercent', 'ruleNormalPercent'].forEach(id => {
        $(id).addEventListener('input', debounce(applyFilters, 180));
    });
}

function debounce(callback, delay) {
    let timerId;
    return () => { clearTimeout(timerId); timerId = setTimeout(callback, delay); };
}

function initApp() {
    $('loadingSection').classList.add('hidden');
    $('mainApp').classList.remove('hidden');
    populateSelect('filterGenre', db.flatMap(song => song.genreCodes), code => translate('g', code));
    populateSelect('filterDecade', db.flatMap(song => song.decadeCodes), code => translate('d', code));
    populateSelect('filterPlayers', db.map(song => String(song.coachCount)), value => value);
    populateSelect('filterGame', db.map(song => song.originalGame), code => translate('o', code));
    populateRecommendationControls();
    restoreTheme();
    updateThemeLabel();
    updateRanks();
}

function populateSelect(id, values, labelForValue, selectedValue = '') {
    const uniqueValues = [...new Set(values)].sort((a, b) => labelForValue(a).localeCompare(labelForValue(b), 'pt-BR', { numeric: true }));
    const options = uniqueValues.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(labelForValue(value))}</option>`).join('');
    $(id).innerHTML = `<option value="">${escapeHtml(ui('all'))}</option>${options}`;
    $(id).value = selectedValue;
}

function getGameCodes() {
    return [...new Set(db.map(song => song.originalGame))].sort((a, b) => Number(b) - Number(a));
}

function populateRecommendationControls() {
    const gameCodes = getGameCodes();
    const options = gameCodes.map(code => `<option value="${escapeHtml(code)}">${escapeHtml(translate('o', code))}</option>`).join('');
    $('ruleJdnextGames').innerHTML = options;
    $('ruleLastgame').innerHTML = `<option value="">${escapeHtml(ui('all'))}</option>${options}`;
    const jdNextDefaults = new Set(['2023', '2024', '2025', '2026']);
    [...$('ruleJdnextGames').options].forEach(option => { option.selected = jdNextDefaults.has(option.value); });
    $('ruleLastgame').value = gameCodes[0] || '';
}

let ranksRAF = null;
function scheduleUpdateRanks() {
    $('valSp').textContent = $('weightSp').value;
    $('valYt').textContent = $('weightYt').value;
    if (ranksRAF) return;
    ranksRAF = requestAnimationFrame(() => { ranksRAF = null; updateRanks(); });
}

function updateRanks() {
    const spotifyWeight = parseFloat($('weightSp').value) || 0;
    const youtubeWeight = parseFloat($('weightYt').value) || 0;
    $('valSp').textContent = spotifyWeight;
    $('valYt').textContent = youtubeWeight;
    db.forEach(song => { song.finalScore = (song.spotifyRank * spotifyWeight) + (song.youtubeRank * youtubeWeight); });
    [...db].sort((a, b) => a.finalScore - b.finalScore || a.title.localeCompare(b.title, 'pt-BR'))
        .forEach((song, index) => { song.finalRank = index; });
    applyFilters();
}

function switchTab(tab) {
    currentMode = tab;
    const isTrending = tab === 'trending';
    $('tabTrending').classList.toggle('active', isTrending);
    $('tabTrending').setAttribute('aria-selected', String(isTrending));
    $('tabLibrary').classList.toggle('active', !isTrending);
    $('tabLibrary').setAttribute('aria-selected', String(!isTrending));
    $('weightControls').classList.toggle('hidden', !isTrending);
    $('recommendationControls').classList.toggle('hidden', !isTrending);
    $('catalogPanel').setAttribute('aria-labelledby', isTrending ? 'tabTrending' : 'tabLibrary');
    applyFilters();
}

function getEligibleSongs() {
    const search = $('searchGeneral').value.trim().toLocaleLowerCase('pt-BR');
    const genre = $('filterGenre').value;
    const decade = $('filterDecade').value;
    const players = $('filterPlayers').value;
    const game = $('filterGame').value;
    return db.filter(song => {
        const matchesSearch = !search || song.title.toLocaleLowerCase('pt-BR').includes(search) || song.artist.toLocaleLowerCase('pt-BR').includes(search);
        return matchesSearch && (!genre || song.genreCodes.includes(genre)) && (!decade || song.decadeCodes.includes(decade)) &&
            (!players || String(song.coachCount) === players) && (!game || song.originalGame === game);
    });
}

function applyFilters() {
    const eligibleSongs = getEligibleSongs();
    $('resultsInfo').textContent = ui('showing', { count: eligibleSongs.length });
    if (currentMode === 'trending') {
        setupRecommendationFeed(eligibleSongs);
        limit = recommendationFeed.length;
    } else {
        filtered = eligibleSongs.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
        limit = Math.min(CHUNK_SIZE, filtered.length);
    }
    render();
}

function resetFilters() {
    ['searchGeneral', 'filterGenre', 'filterDecade', 'filterPlayers', 'filterGame'].forEach(id => { $(id).value = ''; });
    applyFilters();
}

function getRecommendationConfig() {
    const jdnextGames = [...$('ruleJdnextGames').selectedOptions].map(option => option.value);
    const percentages = ['ruleJdnextPercent', 'ruleLastgamePercent', 'ruleDiscoverPercent', 'ruleNormalPercent']
        .map(id => Math.max(0, Number($(id).value) || 0));
    return { jdnextGames, lastgame: $('ruleLastgame').value, percentages };
}

function allocateChunkSlots(percentages) {
    const total = percentages.reduce((sum, value) => sum + value, 0);
    if (total === 0) return [0, 0, 0, CHUNK_SIZE];
    const exact = percentages.map(value => (value / total) * CHUNK_SIZE);
    const slots = exact.map(Math.floor);
    let remaining = CHUNK_SIZE - slots.reduce((sum, value) => sum + value, 0);
    exact.map((value, index) => ({ index, fraction: value - slots[index] }))
        .sort((a, b) => b.fraction - a.fraction)
        .forEach(item => { if (remaining-- > 0) slots[item.index] += 1; });
    return slots;
}

function shuffle(items) {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
    }
    return copy;
}

function setupRecommendationFeed(eligibleSongs) {
    const ranked = [...eligibleSongs].sort((a, b) => a.finalRank - b.finalRank);
    recommendationState = {
        ranked,
        used: new Set(),
        normalQueue: [...ranked],
        jdnextTier: 0,
        lastgameKey: '',
        lastgameQueue: [],
        chunksGenerated: 0
    };
    recommendationFeed = [];
    appendRecommendationChunk();
}

function takeSongs(state, candidates, count, random = false) {
    if (!count) return [];
    const available = candidates.filter(song => !state.used.has(song.uuid));
    const selected = (random ? shuffle(available) : available).slice(0, count);
    selected.forEach(song => state.used.add(song.uuid));
    return selected;
}

function takeJdnextSongs(state, count, config) {
    const pool = state.ranked.filter(song => config.jdnextGames.includes(song.originalGame));
    if (!pool.length || !count) return [];
    const tierSize = Math.max(1, Math.ceil(pool.length / 5));
    const tierStart = state.jdnextTier * tierSize;
    const tier = pool.slice(tierStart, tierStart + tierSize);
    state.jdnextTier = (state.jdnextTier + 1) % 5;
    return takeSongs(state, tier, count, true);
}

function takeLastgameSongs(state, count, config) {
    if (!config.lastgame || !count) return [];
    const pool = state.ranked.filter(song => song.originalGame === config.lastgame).slice(0, 15);
    if (!pool.length) return [];
    if (state.lastgameKey !== config.lastgame || !state.lastgameQueue.length) {
        state.lastgameKey = config.lastgame;
        state.lastgameQueue = shuffle(pool);
    }
    const selected = [];
    while (state.lastgameQueue.length && selected.length < count) {
        const song = state.lastgameQueue.shift();
        if (!state.used.has(song.uuid)) {
            state.used.add(song.uuid);
            selected.push(song);
        }
    }
    return selected;
}

function takeDiscoverySongs(state, count) {
    const selected = [];
    for (let index = 0; index < count; index += 1) {
        const band = index % 4;
        const candidates = state.ranked.slice(100 + (band * 100), 200 + (band * 100));
        const pick = takeSongs(state, candidates, 1, true);
        if (pick.length) selected.push(pick[0]);
    }
    return selected;
}

function takeNormalSongs(state, count) {
    const selected = [];
    while (state.normalQueue.length && selected.length < count) {
        const song = state.normalQueue.shift();
        if (!state.used.has(song.uuid)) {
            state.used.add(song.uuid);
            selected.push(song);
        }
    }
    return selected;
}

function appendRecommendationChunk() {
    if (!recommendationState || recommendationFeed.length >= recommendationState.ranked.length) return;
    const state = recommendationState;
    const config = getRecommendationConfig();
    const [jdnextSlots, lastgameSlots, discoverSlots, normalSlots] = allocateChunkSlots(config.percentages);
    const chunk = [
        ...takeJdnextSongs(state, jdnextSlots, config),
        ...takeLastgameSongs(state, lastgameSlots, config),
        ...takeDiscoverySongs(state, discoverSlots),
        ...takeNormalSongs(state, normalSlots)
    ];
    const missing = Math.min(CHUNK_SIZE - chunk.length, state.ranked.length - recommendationFeed.length - chunk.length);
    chunk.push(...takeNormalSongs(state, missing));
    recommendationFeed.push(...shuffle(chunk));
    state.chunksGenerated += 1;
    if (recommendationFeed.length > 0 && recommendationFeed.length % 100 === 0) {
        state.normalQueue = shuffle(state.normalQueue.filter(song => !state.used.has(song.uuid)));
    }
}

function getActiveFeed() {
    return currentMode === 'trending' ? recommendationFeed : filtered;
}

function handleGridClick(event) {
    const button = event.target.closest('.btn-preview');
    if (button) openModal(button.dataset.uuid);
}

function render(append = false, start = 0) {
    const wrap = $('musicGrid');
    const feed = getActiveFeed();
    if (!feed.length) {
        wrap.innerHTML = `<div class="empty-state"><h2>${escapeHtml(ui('noResults'))}</h2><p>${escapeHtml(ui('noResultsDescription'))}</p><button type="button" id="emptyReset">${escapeHtml(ui('clearFilters'))}</button></div>`;
        $('emptyReset')?.addEventListener('click', resetFilters);
        return;
    }
    const songs = append ? feed.slice(start, limit) : feed.slice(0, limit);
    const html = songs.map(song => renderSong(song)).join('');
    if (append) wrap.insertAdjacentHTML('beforeend', html);
    else wrap.innerHTML = html;
}

function renderSong(song) {
    const tags = [song.genreLabel, song.decadeLabel].filter(Boolean)
        .map(tag => `<span class="music-tag">${escapeHtml(tag)}</span>`).join('');
    const ranks = currentMode === 'trending' ? `<div class="rank-badges" aria-label="${escapeHtml(ui('rankAria'))}">
        <span class="badge badge-rank badge-spotify" title="${escapeHtml(ui('spotifyRank', { rank: song.spotifyRank }))}">${escapeHtml(ui('spotifyRank', { rank: song.spotifyRank }))}</span>
        <span class="badge badge-rank badge-youtube" title="${escapeHtml(ui('youtubeRank', { rank: song.youtubeRank }))}">${escapeHtml(ui('youtubeRank', { rank: song.youtubeRank }))}</span>
        <span class="badge badge-rank badge-final" title="${escapeHtml(ui('finalRank', { rank: song.finalRank }))}">${escapeHtml(ui('finalRank', { rank: song.finalRank }))}</span>
    </div>` : '';
    const previewButton = song.videoUrl && song.audioUrl ? `<button type="button" class="btn-preview" data-uuid="${escapeHtml(song.uuid)}">${escapeHtml(ui('preview'))}</button>` : '';
    const coverUrl = `https://raw.githubusercontent.com/itslucasbish/songlist/main/covers/${encodeURIComponent(song.uuid)}.webp`;
    return `<article class="music-card">
        <div class="music-cover-wrapper" style="background:linear-gradient(135deg,#111,${song.color} 150%)">
            ${ranks}
            <img src="${coverUrl}" class="music-cover" loading="lazy" decoding="async" fetchpriority="low" width="320" height="180" alt="${escapeHtml(ui('coverAlt', { title: song.title }))}" onerror="this.style.opacity='0.3'">
            <span class="badge badge-players">${escapeHtml(ui('dancerBadge', { count: song.coachCount }))}</span>
            <span class="badge badge-game">${escapeHtml(song.gameLabel)}</span>
        </div>
        <div class="music-info"><div><div class="music-name">${escapeHtml(song.title)}</div><div class="music-artist">${escapeHtml(song.artist)}</div></div><div class="music-tags">${tags}</div>${previewButton}</div>
    </article>`;
}

let scrollFramePending = false;
window.addEventListener('scroll', () => {
    if (scrollFramePending) return;
    scrollFramePending = true;
    requestAnimationFrame(() => {
        scrollFramePending = false;
        if (window.innerHeight + window.scrollY < document.body.offsetHeight - 400) return;
        const feed = getActiveFeed();
        if (currentMode === 'trending' && recommendationState && recommendationFeed.length < recommendationState.ranked.length) appendRecommendationChunk();
        const updatedFeed = getActiveFeed();
        if (limit >= updatedFeed.length) return;
        const previousLimit = limit;
        limit = Math.min(limit + CHUNK_SIZE, updatedFeed.length);
        render(true, previousLimit);
    });
}, { passive: true });

const vp = $('modalVideoPlayer');
const ap = $('modalAudioPlayer');
const bl = $('bufferLoading');
const modalBox = $('modalContentBox');
const videoModal = $('videoModal');

function getActiveBpm() { return db.find(song => song.uuid === modalState.activeUuid)?.bpm || 120; }

function clearMediaSource(media) {
    media.pause();
    media.removeAttribute('src');
    media.load();
}

function waitForFullBuffer(media) {
    if (media.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(media.error || new Error('Media error')); };
        const cleanup = () => {
            media.removeEventListener('canplaythrough', done);
            media.removeEventListener('error', failed);
        };
        media.addEventListener('canplaythrough', done, { once: true });
        media.addEventListener('error', failed, { once: true });
    });
}

function openModal(uuid) {
    const song = db.find(item => item.uuid === uuid);
    if (!song) return;
    clearMediaSource(vp);
    clearMediaSource(ap);
    modalState.activeUuid = uuid;
    modalState.isReadyToPlay = false;
    $('modalTitle').textContent = song.title;
    $('modalArtist').textContent = song.artist;
    $('modalTags').innerHTML = [
        `<span class="music-tag">${escapeHtml(ui('dancerBadge', { count: song.coachCount }))}</span>`,
        `<span class="music-tag">${escapeHtml(song.gameLabel)}</span>`,
        song.genreLabel ? `<span class="music-tag">${escapeHtml(song.genreLabel)}</span>` : '',
        song.decadeLabel ? `<span class="music-tag">${escapeHtml(song.decadeLabel)}</span>` : ''
    ].join('');
    document.documentElement.style.setProperty('--music-color', song.color);
    vp.muted = true;
    vp.preload = 'auto';
    ap.preload = 'auto';
    vp.src = song.videoUrl;
    ap.src = song.audioUrl;
    bl.style.display = 'flex';
    bl.textContent = ui('preparingPreview');
    videoModal.classList.add('active');
    document.body.style.overflow = 'hidden';
    const activeUuid = uuid;
    Promise.all([waitForFullBuffer(vp), waitForFullBuffer(ap)]).then(() => {
        if (modalState.activeUuid === activeUuid) startPreview();
    }).catch(() => {
        if (modalState.activeUuid === activeUuid) bl.textContent = ui('previewError');
    });
}

function startPreview() {
    modalState.isReadyToPlay = true;
    modalState.isStarting = true;
    bl.style.display = 'none';
    Promise.all([vp.play(), ap.play()]).then(startPulse).catch(() => {
        bl.style.display = 'flex';
        bl.textContent = ui('previewError');
    }).finally(() => {
        modalState.isStarting = false;
    });
}

let pulseAnchor = null;
let lastShadowCss = null;
let lastPulseFrameTs = 0;
const IDLE_SHADOW = '0 0 10px rgba(0,0,0,0.5)';
const mqMobile = window.matchMedia('(max-width:768px)');

function syncPulseAnchor() { pulseAnchor = performance.now() - (vp.currentTime * 1000); }
function setShadow(css) {
    if (css === lastShadowCss) return;
    modalBox.style.boxShadow = css;
    lastShadowCss = css;
}

function startPulse() {
    syncPulseAnchor();
    cancelAnimationFrame(modalState.animationFrameId);
    function loop(now) {
        modalState.animationFrameId = requestAnimationFrame(loop);
        if (now - lastPulseFrameTs < 33) return;
        lastPulseFrameTs = now;
        if (vp.paused || vp.seeking || pulseAnchor === null) return setShadow(IDLE_SHADOW);
        const beatDuration = 60 / getActiveBpm();
        const elapsed = (now - pulseAnchor) / 1000;
        if (elapsed < beatDuration || elapsed > ((vp.duration || 30) - beatDuration)) return setShadow(IDLE_SHADOW);
        const intensity = Math.exp(-6 * ((elapsed % beatDuration) / beatDuration));
        setShadow(`0 0 ${Math.round(10 + ((mqMobile.matches ? 50 : 80) * intensity))}px var(--music-color)`);
    }
    modalState.animationFrameId = requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(modalState.animationFrameId);
    else if (modalState.activeUuid !== null && modalState.isReadyToPlay) startPulse();
});

vp.onended = () => { ap.pause(); ap.currentTime = 0; };
vp.onpause = () => ap.pause();
vp.onplay = () => {
    if (modalState.isReadyToPlay && !modalState.isStarting && ap.paused) ap.play().catch(() => {});
};
vp.onseeked = () => { ap.currentTime = vp.currentTime; };
vp.ontimeupdate = syncPulseAnchor;

function closeModal() {
    if (!videoModal.classList.contains('active')) return;
    videoModal.classList.remove('active');
    document.body.style.overflow = '';
    cancelAnimationFrame(modalState.animationFrameId);
    modalState.activeUuid = null;
    modalState.isReadyToPlay = false;
    modalState.isStarting = false;
    clearMediaSource(vp);
    clearMediaSource(ap);
    pulseAnchor = null;
    lastShadowCss = null;
    modalBox.style.boxShadow = IDLE_SHADOW;
    bl.style.display = 'none';
}

function toggleTheme() {
    const html = document.documentElement;
    html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    localStorage.setItem('theme', html.getAttribute('data-theme'));
    updateThemeLabel();
}

function restoreTheme() {
    if (localStorage.getItem('theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');
}

function updateThemeLabel() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    $('themeToggle').textContent = ui(isDark ? 'themeLight' : 'themeDark');
    $('themeToggle').setAttribute('aria-label', ui(isDark ? 'activateLightTheme' : 'activateDarkTheme'));
}
