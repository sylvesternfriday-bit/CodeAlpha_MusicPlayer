/* AlphaPlay — a private, browser-based music library.
   Tracks are imported only after the user selects them with the browser file picker.
   Selected audio copies are stored in this site's IndexedDB storage when supported. */
const SONGS = [];
const $ = s => document.querySelector(s);
const au = $('#au');
const DEFAULT_COVER = 'image/AlphaPlay.jpg';
const ls = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};
const LIBRARY_VERSION = 4;
const oldVersion = ls.get('ap_library_version', 0);
if (oldVersion < LIBRARY_VERSION) {
  ls.set('ap_recent', []);
  ls.set('ap_favs', []);
  ls.set('ap_idx', 0);
  ls.set('ap_library_version', LIBRARY_VERSION);
}
let idx = Number(ls.get('ap_idx', 0)) || 0;
let queue = [];
let shuffle = Boolean(ls.get('ap_shuffle', false));
const savedQueueIds = ls.get('ap_queue_ids', null);
let autoplay = ls.get('ap_auto', true);
let favs = (ls.get('ap_favs', []) || []).filter(Number.isInteger);
let recent = (ls.get('ap_recent', []) || []).filter(Number.isInteger);
let view = 'home';
let listMode = 'songs';
let listKey = null;
let deleteRevealIndex = null;
let longPressTriggered = false;
let pressTimer = null;
let pressTarget = null;
let db = null;
let persistentStorage = false;
let pendingPlaylistSongIndex = null;
let chosenCoverFile = null;
let chosenCoverUrl = null;
let libraryPickerPurpose = 'library';

const ico = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 4v16M17 4v16" stroke-width="4"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  dots: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-11 0 1 14h12l1-14M10 10v6m4-6v6"/></svg>'
};
const fmt = s => { if (!Number.isFinite(s)) return '0:00'; s = Math.floor(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chev = '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
const makeId = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* Keep one real playback order for the player and the visible Queue. */
function shuffleArray(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
function makeShuffledQueue(indices = SONGS.map((_, i) => i), current = idx) {
  const rest = indices.filter(i => i !== current);
  shuffleArray(rest);
  return indices.includes(current) ? [current, ...rest] : rest;
}
function persistQueue() {
  ls.set('ap_queue_ids', queue.map(i => SONGS[i]?.id).filter(Boolean));
  ls.set('ap_shuffle', shuffle);
}
function updateShuffleButton() {
  const button = $('#shuf');
  if (!button) return;
  button.classList.toggle('on', shuffle);
  button.setAttribute('aria-pressed', String(shuffle));
  button.title = shuffle ? 'Shuffle on' : 'Shuffle off';
}
function restoreQueue() {
  const all = SONGS.map((_, i) => i);
  if (!shuffle) {
    queue = all;
  } else {
    const indexById = new Map(SONGS.map((song, i) => [String(song.id), i]));
    const restored = Array.isArray(savedQueueIds)
      ? savedQueueIds.map(id => indexById.get(String(id))).filter(i => Number.isInteger(i))
      : [];
    const seen = new Set(restored);
    const missing = all.filter(i => !seen.has(i));
    queue = restored.length ? [...restored, ...shuffleArray(missing)] : makeShuffledQueue(all, idx);
    // A persisted queue might be from an older library version or contain duplicates.
    queue = [...new Set(queue)].filter(i => i >= 0 && i < SONGS.length);
    missing.filter(i => !queue.includes(i)).forEach(i => queue.push(i));
    if (!queue.length && all.length) queue = makeShuffledQueue(all, idx);
  }
  persistQueue();
  updateShuffleButton();
}
function ensureQueueIntegrity() {
  const all = SONGS.map((_, i) => i);
  if (!shuffle) {
    const changed = queue.length !== all.length || queue.some((value, i) => value !== all[i]);
    if (changed) { queue = all; persistQueue(); }
    return;
  }
  const seen = new Set();
  const valid = queue.filter(i => Number.isInteger(i) && i >= 0 && i < SONGS.length && !seen.has(i) && seen.add(i));
  const missing = all.filter(i => !seen.has(i));
  if (valid.length !== queue.length || missing.length) {
    queue = valid;
    for (const i of shuffleArray(missing)) {
      const currentPosition = queue.indexOf(idx);
      const start = currentPosition >= 0 ? currentPosition + 1 : 0;
      const insertAt = start + Math.floor(Math.random() * (queue.length - start + 1));
      queue.splice(insertAt, 0, i);
    }
    persistQueue();
  }
}
function addImportedSongsToQueue(previousSongCount) {
  if (SONGS.length <= previousSongCount) return;
  // The new indices are now in SONGS; integrity repair adds them once, in
  // natural order or at random positions after the current track when shuffling.
  ensureQueueIntegrity();
  persistQueue();
}
function renderQueue() {
  ensureQueueIntegrity();
  $('#queue').innerHTML = queue.length
    ? queue.map(i => rowHTML(i)).join('')
    : '<p class="empty">Your queue is empty. Import audio files to get started.</p>';
}
// All sections use one cover source per song. Keep a single object URL for each
// cover Blob so Home, Recently Played, Songs, Search, Favorites, Queue, and
// playlist/album track lists always display the same image and remain in sync.
const songCoverURLs = new WeakMap();
function coverSrc(song) {
  if (!song) return DEFAULT_COVER;
  if (song.coverBlob instanceof Blob) {
    let cached = songCoverURLs.get(song);
    if (!cached || cached.blob !== song.coverBlob) {
      if (cached?.url) URL.revokeObjectURL(cached.url);
      cached = { blob: song.coverBlob, url: URL.createObjectURL(song.coverBlob) };
      songCoverURLs.set(song, cached);
    }
    song.cover = cached.url;
    return cached.url;
  }
  return song.cover || DEFAULT_COVER;
}
const imageHTML = song => `<img class="art-image" data-song-artwork="${esc(song?.id || '')}" src="${esc(coverSrc(song))}" alt="${esc(song?.title || '')}" draggable="false">`;
function setArtwork(element, song) {
  if (!element) return;
  element.style.cssText = '';
  element.innerHTML = song ? imageHTML(song) : '';
}
function refreshSongArtwork(song) {
  if (!song) return;
  const src = coverSrc(song);
  document.querySelectorAll('.art-image[data-song-artwork]').forEach(img => {
    if (img.dataset.songArtwork === String(song.id) && img.getAttribute('src') !== src) img.setAttribute('src', src);
  });
}
function refreshAllSongArtwork() {
  const songsById = new Map(SONGS.map(song => [String(song.id), song]));
  document.querySelectorAll('.art-image[data-song-artwork]').forEach(img => {
    const song = songsById.get(img.dataset.songArtwork);
    if (!song) return;
    const src = coverSrc(song);
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
  });
}
function releaseSongCover(song) {
  if (!song) return;
  const cached = songCoverURLs.get(song);
  if (cached?.url) URL.revokeObjectURL(cached.url);
  songCoverURLs.delete(song);
  if (!cached && typeof song.cover === 'string' && song.cover.startsWith('blob:')) URL.revokeObjectURL(song.cover);
}

/* IndexedDB stores copies of user-selected audio and optional cover-image blobs. */
function openTrackDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB is unavailable in this browser.')); return; }
    const request = indexedDB.open('AlphaPlayMusicLibrary', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('tracks')) database.createObjectStore('tracks', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local music storage.'));
    request.onblocked = () => reject(new Error('Music storage is blocked by another AlphaPlay tab.'));
  });
}
function dbRequest(mode, operation) {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('Persistent browser storage is unavailable.')); return; }
    const tx = db.transaction('tracks', mode);
    const store = tx.objectStore('tracks');
    let request;
    try { request = operation(store); } catch (error) { reject(error); return; }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Local music storage operation failed.'));
    tx.onabort = () => reject(tx.error || new Error('Local music storage transaction was interrupted.'));
  });
}
const dbGetAll = () => dbRequest('readonly', store => store.getAll());
const dbPut = record => dbRequest('readwrite', store => store.put(record));
const dbDelete = id => dbRequest('readwrite', store => store.delete(id));
function persistableSong(song) {
  return {
    id: song.id, title: song.title, artist: song.artist, album: song.album,
    genre: song.genre || 'Audio', folder: song.folder || 'Imported music',
    createdAt: song.createdAt || Date.now(), audioBlob: song.audioBlob,
    coverBlob: song.coverBlob || null
  };
}
function songFromRecord(record) {
  return {
    id: String(record.id), title: record.title || 'Untitled audio', artist: record.artist || 'Unknown Artist',
    album: record.album || 'Unknown Album', genre: record.genre || 'Audio', folder: record.folder || 'Imported music',
    createdAt: Number(record.createdAt) || Date.now(), audioBlob: record.audioBlob, coverBlob: record.coverBlob || null,
    file: URL.createObjectURL(record.audioBlob), cover: DEFAULT_COVER,
    local: true
  };
}

/* Collections refer to stable song IDs so deleting a track cannot point a playlist at another song. */
let albums = (ls.get('ap_albums', []) || []).filter(a => a && typeof a.name === 'string' && a.name.trim()).map(a => ({
  id: String(a.id || makeId('album')), name: a.name, cover: typeof a.cover === 'string' ? a.cover : '',
  songIds: Array.isArray(a.songIds) ? a.songIds.map(String).filter(id => id !== 'alphaplay-intro') : []
}));
let playlists = (ls.get('ap_playlists', []) || []).filter(p => p && typeof p.name === 'string' && p.name.trim()).map(p => ({
  id: String(p.id || makeId('playlist')), name: p.name,
  songIds: Array.isArray(p.songIds) ? p.songIds.map(String).filter(id => id !== 'alphaplay-intro') : []
}));
let folders = (ls.get('ap_folders', []) || []).filter(f => f && typeof f.name === 'string' && f.name.trim()).map(f => ({
  id: String(f.id || makeId('folder')), name: f.name,
  songIds: Array.isArray(f.songIds) ? f.songIds.map(String) : []
}));
const foldersSeen = new Set((ls.get('ap_folders_seen', []) || []).map(String));
/* Folders are user-editable collections. Songs not seen before are placed once into the folder they were imported from. */
function syncFolders() {
  let changed = false;
  SONGS.forEach(song => {
    if (!song || foldersSeen.has(song.id)) return;
    foldersSeen.add(song.id); changed = true;
    const name = String(song.folder || '').trim(); if (!name) return;
    let folder = folders.find(f => f.name.toLowerCase() === name.toLowerCase());
    if (!folder) { folder = { id: makeId('folder'), name, songIds: [] }; folders.push(folder); }
    if (!folder.songIds.includes(song.id)) folder.songIds.push(song.id);
  });
  if (changed) saveCollections();
}
// Remove the old built-in-only album record left by earlier versions.
albums = albums.filter(a => !a.songIds.includes('alphaplay-intro'));
const deletedAlbumNames = new Set((ls.get('ap_deleted_album_names', []) || []).map(n => String(n).toLowerCase()));
function getSongById(id) { return SONGS.find(song => song.id === id); }
function ensureAlbum(name) {
  const clean = String(name || '').trim();
  if (!clean || deletedAlbumNames.has(clean.toLowerCase())) return null;
  let album = albums.find(item => item.name.toLowerCase() === clean.toLowerCase());
  if (!album) { album = { id: makeId('album'), name: clean, cover: '', songIds: [] }; albums.push(album); }
  return album;
}
function saveCollections() {
  ls.set('ap_albums', albums.map(a => ({ id: a.id, name: a.name, cover: a.cover || '', songIds: a.songIds })));
  ls.set('ap_playlists', playlists.map(p => ({ id: p.id, name: p.name, songIds: p.songIds })));
  ls.set('ap_deleted_album_names', [...deletedAlbumNames]);
  ls.set('ap_folders', folders.map(f => ({ id: f.id, name: f.name, songIds: f.songIds })));
  ls.set('ap_folders_seen', [...foldersSeen]);
}

/* Browser audio APIs differ by codec, so surface useful errors instead of silently failing. */
function setAudioStatus(message = '', isError = false) {
  const status = $('#audioStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', Boolean(message && isError));
}
function audioPlaybackError(error) {
  if (!error || error.name === 'AbortError') return;
  if (error.name === 'NotAllowedError') {
    setAudioStatus('Playback was blocked by the browser. Tap Play again to start the song.', true);
  } else if (error.name === 'NotSupportedError') {
    setAudioStatus('This browser cannot play this audio format. Try an MP3, AAC/M4A, or WAV version of the song.', true);
  } else {
    setAudioStatus('AlphaPlay could not start this track. Check the audio format and try another file.', true);
  }
}
function playCurrentAudio() {
  if (!SONGS[idx]) return;
  setAudioStatus('');
  try {
    const result = au.play();
    if (result && typeof result.then === 'function') result.catch(audioPlaybackError);
  } catch (error) {
    audioPlaybackError(error);
  }
}
function audioUrlFor(song) {
  if (song && typeof song.file === 'string' && song.file) return song.file;
  if (song?.audioBlob instanceof Blob) {
    song.file = URL.createObjectURL(song.audioBlob);
    return song.file;
  }
  return '';
}
function guessAudioMime(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wma: 'audio/x-ms-wma', aif: 'audio/aiff', aiff: 'audio/aiff', alac: 'audio/mp4', amr: 'audio/amr', '3gp': 'audio/3gpp' })[ext] || '';
}
function normaliseAudioBlob(file) {
  const type = guessAudioMime(file?.name);
  const reportedType = String(file?.type || '').toLowerCase();
  // Some desktop file pickers report application/octet-stream for audio. Use the
  // extension-derived audio MIME in that case so browsers can choose a decoder.
  if (type && (!reportedType || reportedType === 'application/octet-stream' || !reportedType.startsWith('audio/'))) {
    return new Blob([file], { type });
  }
  return file;
}

/* ===== PLAYER ===== */
function setFill(el) {
  if (!el) return;
  const min = Number(el.min) || 0, max = Number(el.max) || 100, value = Number(el.value) || 0;
  el.style.setProperty('--v', (max === min ? 0 : (value - min) / (max - min) * 100) + '%');
}
function updatePlayerLabels(song) {
  if (!song) return;
  $('#npTitle').textContent = song.title;
  $('#npArtist').textContent = song.artist;
  $('#npAlbum').textContent = song.album || 'Unknown Album';
  setArtwork($('#npArt'), song);
  setArtwork($('#miArt'), song);
  $('#miTitle').textContent = song.title;
  $('#miArtist').textContent = song.artist;
  document.title = `${song.title} · ${song.artist} | AlphaPlay`;
}
function clearPlayer() {
  au.pause(); au.removeAttribute('src'); au.load(); setAudioStatus('');
  $('#npTitle').textContent = 'No music selected';
  $('#npArtist').textContent = 'Choose audio files to get started';
  $('#npAlbum').textContent = '';
  setArtwork($('#npArt'), null);
  setArtwork($('#miArt'), null);
  $('#miTitle').textContent = 'No music selected';
  $('#miArtist').textContent = 'Import music to begin';
  $('#dur').textContent = '0:00'; $('#cur').textContent = '0:00';
  $('#seek').value = 0; setFill($('#seek')); $('#miProg').style.width = '0%';
  $('#pp').innerHTML = ico.play; $('#miPP').innerHTML = ico.play;
  $('#pp').disabled = true; $('#miPP').disabled = true; $('#prev').disabled = true; $('#next').disabled = true;
  $('#fav').disabled = true; $('#fav').classList.remove('on');
  document.title = 'AlphaPlay';
}
function load(i, play = false) {
  if (!SONGS.length) { idx = 0; clearPlayer(); renderAll(); return; }
  i = Math.max(0, Math.min(Number(i) || 0, SONGS.length - 1));
  idx = i;
  const song = SONGS[i];
  const src = audioUrlFor(song);
  setAudioStatus('');
  au.pause();
  if (!src) {
    au.removeAttribute('src'); au.load();
    setAudioStatus('The selected audio file is no longer available. Import it again to play it.', true);
  } else {
    au.src = src;
    au.load();
  }
  updatePlayerLabels(song);
  $('#dur').textContent = '0:00'; $('#cur').textContent = '0:00'; $('#seek').value = 0; setFill($('#seek')); $('#miProg').style.width = '0%';
  $('#pp').disabled = !src; $('#miPP').disabled = !src; $('#prev').disabled = !src; $('#next').disabled = !src; $('#fav').disabled = false;
  ls.set('ap_idx', i); favUI(); renderAll();
  if (play && src) playCurrentAudio();
}
function step(direction) {
  if (!SONGS.length) { openAccessPrompt(); return; }
  ensureQueueIntegrity();
  if (!queue.length) { queue = SONGS.map((_, i) => i); }
  let pos = queue.indexOf(idx);
  if (pos < 0) {
    queue.push(...SONGS.map((_, i) => i).filter(i => !queue.includes(i)));
    pos = queue.indexOf(idx);
  }
  const nextPos = (Math.max(pos, 0) + direction + queue.length) % queue.length;
  load(queue[nextPos], true);
}
function toggle() {
  if (!SONGS.length) { openAccessPrompt(); return; }
  if (au.paused) playCurrentAudio(); else au.pause();
}
au.onplay = au.onpause = () => {
  const playing = !au.paused;
  $('#pp').innerHTML = playing ? ico.pause : ico.play;
  $('#miPP').innerHTML = playing ? ico.pause : ico.play;
  $('#np').classList.toggle('playing', playing);
  if (playing && SONGS[idx]) {
    recent = [idx, ...recent.filter(i => i !== idx && i >= 0 && i < SONGS.length)].slice(0, 12);
    ls.set('ap_recent', recent); renderAll();
  }
};
au.onloadedmetadata = () => { $('#dur').textContent = fmt(au.duration); };
au.oncanplay = () => setAudioStatus('');
au.ontimeupdate = () => {
  if (!au.duration) return;
  const progress = au.currentTime / au.duration * 100;
  $('#seek').value = progress; setFill($('#seek')); $('#cur').textContent = fmt(au.currentTime); $('#miProg').style.width = progress + '%';
};
au.onended = () => { autoplay ? step(1) : au.pause(); };
au.onerror = () => {
  if (!SONGS.length || !SONGS[idx]) return;
  $('#dur').textContent = '--:--';
  const code = au.error?.code;
  if (code === 3 || code === 4) {
    setAudioStatus('This browser cannot decode this audio file. Try an MP3, AAC/M4A, or WAV version; format support varies by browser.', true);
  } else if (code === 2) {
    setAudioStatus('The browser could not read this audio file. Re-import the track and try again.', true);
  } else {
    setAudioStatus('There was a problem reading this audio file. Try another copy or audio format.', true);
  }
};
$('#seek').oninput = e => { if (au.duration) au.currentTime = e.target.value / 100 * au.duration; setFill(e.target); };
$('#vol').oninput = e => { au.volume = Number(e.target.value); setFill(e.target); ls.set('ap_vol', e.target.value); };
$('#pp').onclick = toggle;
$('#miPP').onclick = e => { e.stopPropagation(); toggle(); };
$('#next').onclick = () => step(1);
$('#prev').onclick = () => { if (au.currentTime > 3) au.currentTime = 0; else step(-1); };
$('#miNext').onclick = e => { e.stopPropagation(); step(1); };
$('#shuf').onclick = () => {
  shuffle = !shuffle;
  queue = shuffle ? makeShuffledQueue(SONGS.map((_, i) => i), idx) : SONGS.map((_, i) => i);
  persistQueue(); updateShuffleButton(); renderQueue();
};
$('#auto').onclick = e => { autoplay = !autoplay; ls.set('ap_auto', autoplay); e.target.textContent = 'Autoplay: ' + (autoplay ? 'On' : 'Off'); };
$('#fav').onclick = () => { if (SONGS[idx]) toggleFavorite(idx); };
function toggleFavorite(i) {
  if (!SONGS[i]) return;
  favs = favs.includes(i) ? favs.filter(n => n !== i) : [...favs, i];
  ls.set('ap_favs', favs); favUI(); renderAll();
}
function favUI() {
  const current = SONGS[idx];
  const isFavorite = !!current && favs.includes(idx);
  $('#fav').classList.toggle('on', isFavorite);
  const favoriteSvg = $('#fav svg'); if (favoriteSvg) favoriteSvg.style.fill = isFavorite ? 'currentColor' : 'none';
  $('#favCount').textContent = `${favs.filter(i => SONGS[i]).length} songs`;
}
document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select')) return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  if (e.code === 'ArrowRight') step(1);
  if (e.code === 'ArrowLeft') step(-1);
});
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => playCurrentAudio());
    navigator.mediaSession.setActionHandler('pause', () => au.pause());
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    au.addEventListener('play', () => {
      const song = SONGS[idx];
      if (song && 'MediaMetadata' in window) navigator.mediaSession.metadata = new MediaMetadata({ title: song.title, artist: song.artist, album: song.album });
    });
  } catch {}
}

/* ===== SONG ROWS AND LIBRARY RENDERING ===== */
const groups = key => [...new Set(SONGS.map(song => song[key]).filter(Boolean))];
function rowHTML(i, context = {}) {
  const song = SONGS[i]; if (!song) return '';
  const playlistAttr = (context.playlistId ? ` data-playlist-id="${esc(context.playlistId)}"` : '') + (context.folderId ? ` data-folder-id="${esc(context.folderId)}"` : '');
  const row = `<a class="row ${i === idx ? 'cur' : ''}" href="#" data-i="${i}"><div class="art">${imageHTML(song)}</div><div class="t"><b title="${esc(song.title)}">${esc(song.title)}</b><small title="${esc(song.artist)} · ${esc(song.album || 'Unknown Album')}">${esc(song.artist)} · ${esc(song.album || 'Unknown Album')}</small></div><span class="d">${i === idx && au.duration ? fmt(au.duration) : ''}</span></a>`;
  return `<div class="song-wrap ${deleteRevealIndex === i ? 'delete-revealed' : ''}" data-song-index="${i}"${playlistAttr}>${row}<button class="song-more" type="button" data-more-index="${i}" aria-label="More options for ${esc(song.title)}" title="Song options">${ico.dots}</button><button class="delete-song" type="button" data-delete-index="${i}" aria-label="Remove ${esc(song.title)} from AlphaPlay" title="Remove from AlphaPlay">${ico.trash}</button></div>`;
}
function renderAll() {
  syncFolders();
  const tiles = [
    ['Songs', SONGS.length + ' items', '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', 'songs'],
    ['Albums', albums.length + ' albums', '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>', 'albums'],
    ['Artists', groups('artist').length + ' artists', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', 'artists'],
    ['Genres', groups('genre').length + ' genres', '<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1"/>', 'genres'],
    ['Folders', folders.length + ' folders', '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 'folders'],
    ['Playlists', playlists.length + ' playlists', '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="17" r="3"/>', 'playlists']
  ];
  const tileColors = ['#3ea6ff','#7b4dff','#b07bff','#4d8bff','#2ed3a0','#ff9a6b'];
  $('#tiles').innerHTML = tiles.map((tile, n) => `<button class="tile ${n > 3 ? 'w' : ''}" onclick="go('library','${tile[3]}')"><svg viewBox="0 0 24 24" style="color:${tileColors[n]}">${tile[2]}</svg><span><b>${tile[0]}</b><br><small>${tile[1]}</small></span>${chev}</button>`).join('');
  const validRecent = recent.filter(i => Number.isInteger(i) && i >= 0 && i < SONGS.length);
  $('#recentSection').style.display = validRecent.length ? '' : 'none';
  $('#recent').innerHTML = validRecent.map(i => {
    const song = SONGS[i];
    return `<a class="item" href="#" data-i="${i}"><div class="art sm">${imageHTML(song)}</div><b>${esc(song.title)}</b><small>${esc(song.artist)}</small></a>`;
  }).join('');
  $('#emptyLibrary').style.display = SONGS.length ? 'none' : '';
  renderQueue();
  $('#libraryStorageNote').textContent = persistentStorage
    ? 'Selected audio is kept in this browser on this device. Import the files separately on other devices; removing a track here does not delete the original file.'
    : 'This browser cannot keep imported audio between visits right now. Selected files are temporary in this session, and must be imported again after closing AlphaPlay.';
  if (view === 'list') renderList();
  favUI();
  refreshAllSongArtwork();
}
function renderLibraryTabs(active) {
  const names = { songs: 'Songs', albums: 'Albums', artists: 'Artists', genres: 'Genres', folders: 'Folders', playlists: 'Playlists', favs: 'Favorites' };
  return `<div class="library-tabs">${['songs','albums','artists','genres','folders','playlists','favs'].map(key => `<button class="${key === active ? 'active' : ''}" data-library-mode="${key}">${names[key]}</button>`).join('')}</div>`;
}
function renderList() {
  const mode = listMode, head = $('#listHead'), list = $('#list');
  if (listKey !== null && mode === 'albums') {
    const album = albums.find(a => a.id === listKey);
    if (!album) { listKey = null; return renderList(); }
    const ids = album.songIds.map(id => SONGS.findIndex(song => song.id === id)).filter(i => i >= 0);
    head.innerHTML = `<div class="detail-head"><button class="back" data-action="back-library">‹ Back to Library</button><h3>${esc(album.name)}</h3><button class="round-add" data-action="add-to-collection" data-type="album" data-id="${esc(album.id)}" aria-label="Add songs to album" title="Add songs">${ico.plus}</button></div>`;
    list.innerHTML = ids.length ? ids.map(i => rowHTML(i)).join('') : '<p class="empty">No songs in this album yet. Tap + to add songs.</p>';
    return;
  }
  if (listKey !== null && mode === 'playlists') {
    const playlist = playlists.find(p => p.id === listKey);
    if (!playlist) { listKey = null; return renderList(); }
    const ids = playlist.songIds.map(id => SONGS.findIndex(song => song.id === id)).filter(i => i >= 0);
    head.innerHTML = `<div class="detail-head"><button class="back" data-action="back-library">‹ Back to Playlists</button><h3>${esc(playlist.name)}</h3><button class="round-add" data-action="add-to-collection" data-type="playlist" data-id="${esc(playlist.id)}" aria-label="Add songs to playlist" title="Add songs">${ico.plus}</button></div>`;
    list.innerHTML = ids.length ? ids.map(i => rowHTML(i, { playlistId: playlist.id })).join('') : '<p class="empty">No songs in this playlist yet. Tap + to add songs.</p>';
    return;
  }
  if (listKey !== null && mode === 'folders') {
    const folder = folders.find(f => f.id === listKey);
    if (!folder) { listKey = null; return renderList(); }
    const ids = folder.songIds.map(id => SONGS.findIndex(song => song.id === id)).filter(i => i >= 0);
    head.innerHTML = `<div class="detail-head"><button class="back" data-action="back-library">‹ Back to Folders</button><h3>${esc(folder.name)}</h3><button class="round-add" data-action="add-to-collection" data-type="folder" data-id="${esc(folder.id)}" aria-label="Add songs to folder" title="Add songs">${ico.plus}</button></div>`;
    list.innerHTML = ids.length ? ids.map(i => rowHTML(i, { folderId: folder.id })).join('') : '<p class="empty">No songs in this folder yet. Tap + to add songs.</p>';
    return;
  }
  head.innerHTML = renderLibraryTabs(mode) + (mode === 'playlists' ? `<button class="create-playlist" data-action="create-playlist">+ Create playlist</button>` : '') + (mode === 'folders' ? `<button class="create-playlist" data-action="create-folder">+ Create folder</button>` : '');
  if (mode === 'songs' || mode === 'favs') {
    const ids = mode === 'favs' ? favs : SONGS.map((_, i) => i);
    list.innerHTML = ids.filter(i => SONGS[i]).map(i => rowHTML(i)).join('') || (mode === 'favs' ? '<p class="empty">No favorites yet.</p>' : '<p class="empty">No songs yet. Use the + button to import audio.</p>');
    return;
  }
  if (mode === 'playlists') {
    list.innerHTML = playlists.length ? playlists.map(p => `<div class="collection-wrap"><button class="row collection-row" data-open-playlist="${esc(p.id)}"><div class="collection-art"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="17" r="3"/></svg></div><div class="t"><b>${esc(p.name)}</b><small>${p.songIds.filter(id => getSongById(id)).length} songs</small></div>${chev}</button><button type="button" class="album-more" data-collection-more="playlist" data-id="${esc(p.id)}" aria-label="Options for ${esc(p.name)}" title="Playlist options">${ico.dots}</button></div>`).join('') : '<p class="empty">No existing playlist</p>';
    return;
  }
  if (mode === 'albums') {
    list.innerHTML = albums.map(album => `<div class="collection-wrap"><button class="row collection-row" data-open-album="${esc(album.id)}"><div class="collection-art" ${album.cover ? `style="background-image:url('${esc(album.cover)}');background-size:cover;background-position:center"` : ''}>${album.cover ? '' : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>'}</div><div class="t"><b>${esc(album.name)}</b><small>${album.songIds.filter(id => getSongById(id)).length} songs</small></div>${chev}</button><button type="button" class="album-more" data-album-more="${esc(album.id)}" aria-label="Options for ${esc(album.name)}" title="Album options">${ico.dots}</button></div>`).join('') || '<p class="empty">No albums yet. Edit a song and give it an album name to create one.</p>';
    return;
  }
  if (mode === 'folders') {
    list.innerHTML = folders.length ? folders.map(f => `<div class="collection-wrap"><button class="row collection-row" data-open-folder="${esc(f.id)}"><div class="collection-art"><svg viewBox="0 0 24 24"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div><div class="t"><b>${esc(f.name)}</b><small>${f.songIds.filter(id => getSongById(id)).length} songs</small></div>${chev}</button><button type="button" class="album-more" data-collection-more="folder" data-id="${esc(f.id)}" aria-label="Options for ${esc(f.name)}" title="Folder options">${ico.dots}</button></div>`).join('') : '<p class="empty">No folders yet. Tap + Create folder.</p>';
    return;
  }
  const key = { artists: 'artist', genres: 'genre' }[mode];
  if (listKey !== null && key) {
    const ids = SONGS.map((song, i) => song[key] === listKey ? i : -1).filter(i => i >= 0);
    head.innerHTML = `<button class="back" data-action="back-library">‹ Back to Library</button><h3>${esc(listKey)}</h3>`;
    list.innerHTML = ids.length ? ids.map(i => rowHTML(i)).join('') : '<p class="empty">Nothing here yet.</p>';
    return;
  }
  const items = key ? groups(key) : [];
  list.innerHTML = items.map(name => `<button class="row collection-row" data-open-group="${esc(name)}"><div class="collection-art"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></div><div class="t"><b>${esc(name)}</b><small>${SONGS.filter(song => song[key] === name).length} songs</small></div>${chev}</button>`).join('') || '<p class="empty">Nothing here yet.</p>';
}

/* ===== NAVIGATION ===== */
const NAV = [
  ['home','Home','<path d="M3 11l9-8 9 8v10H3z"/>'],
  ['library','Library','<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="14" r="3"/>'],
  ['search','Search','<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'],
  ['queue','Queue','<path d="M3 6h18M3 12h12M3 18h8"/>'],
  ['more','More','<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/>']
];
const scrolls = {};
function go(targetView, mode, keep, fromPop) {
  scrolls[view] = scrollY;
  if (targetView === 'library') {
    if (mode !== undefined && mode !== null) { listMode = mode; listKey = null; }
    else if (!keep && !fromPop && view !== 'list') listKey = null;
    targetView = 'list';
  }
  if (!fromPop) history.pushState({ v: targetView, listMode, listKey }, '');
  view = targetView;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('show', el.id === 'v-' + targetView));
  document.querySelectorAll('#nav button').forEach(button => button.classList.toggle('on', button.dataset.v === (targetView === 'list' ? 'library' : targetView)));
  renderAll();
  if (targetView === 'search') $('#q').focus({ preventScroll: true });
  scrollTo(0, scrolls[targetView] || 0);
}
$('#nav').innerHTML = NAV.map(navItem => `<button data-v="${navItem[0]}" onclick="go('${navItem[0]}')"><svg viewBox="0 0 24 24">${navItem[2]}</svg>${navItem[1]}</button>`).join('');
history.replaceState({ v: 'home' }, '');
addEventListener('popstate', e => {
  const state = e.state || { v: 'home' };
  listMode = state.listMode || 'songs'; listKey = state.listKey ?? null;
  go(state.v === 'list' ? 'library' : state.v, undefined, true, true);
});
document.addEventListener('click', e => {
  const songLink = e.target.closest('a[data-i]');
  if (songLink) {
    e.preventDefault();
    if (longPressTriggered) { longPressTriggered = false; return; }
    const songIndex = Number(songLink.dataset.i);
    if (SONGS[songIndex]) load(songIndex, true);
  }
});
$('#q').oninput = e => {
  const query = e.target.value.trim().toLowerCase();
  const results = SONGS.map((song, i) => i).filter(i => !query || [SONGS[i].title, SONGS[i].artist, SONGS[i].album, SONGS[i].genre].join(' ').toLowerCase().includes(query));
  $('#res').innerHTML = results.map(i => rowHTML(i)).join('') || '<p class="empty">No results</p>';
};

/* ===== MODALS AND COLLECTION ACTIONS ===== */
const interactionModal = $('#interactionModal');
const interactionPanel = $('#interactionPanel');
function openPanel(title, body) {
  interactionPanel.innerHTML = `<div class="interaction-head"><h3>${esc(title)}</h3><button type="button" data-action="close-modal" aria-label="Close">×</button></div><div class="interaction-body">${body}</div>`;
  interactionModal.classList.add('show');
}
function closePanel() { interactionModal.classList.remove('show'); interactionPanel.innerHTML = ''; }
interactionModal.addEventListener('click', e => { if (e.target === interactionModal) closePanel(); });
function openSongMenu(i, playlistId = null, folderId = null) {
  const song = SONGS[i]; if (!song) return;
  let body = `<p class="modal-subtitle">${esc(song.title)} · ${esc(song.artist)}</p>`;
  if (playlistId) {
    const playlist = playlists.find(item => item.id === playlistId);
    if (playlist) body += `<button class="action-option" data-action="remove-from-playlist" data-song-index="${i}" data-playlist-id="${esc(playlist.id)}"><span>Remove from playlist</span>${chev}</button>`;
  }
  if (folderId) {
    const folder = folders.find(item => item.id === folderId);
    if (folder) body += `<button class="action-option" data-action="remove-from-folder" data-song-index="${i}" data-folder-id="${esc(folder.id)}"><span>Remove from folder</span>${chev}</button>`;
  }
  body += `<button class="action-option" data-action="edit-song" data-song-index="${i}"><span>Edit song details</span>${chev}</button>`;
  body += `<button class="action-option" data-action="song-add-album" data-song-index="${i}"><span>Add to existing album</span>${chev}</button>`;
  body += `<button class="action-option" data-action="song-add-playlist" data-song-index="${i}"><span>Add to playlist</span>${chev}</button>`;
  body += `<button class="action-option" data-action="song-add-folder" data-song-index="${i}"><span>Add to folder</span>${chev}</button>`;
  body += `<button class="action-option" data-action="toggle-favorite" data-song-index="${i}"><span>${favs.includes(i) ? 'Remove from favorites' : 'Add to favorites'}</span>${chev}</button>`;
  body += `<button class="action-option danger" data-action="delete-song" data-song-index="${i}"><span>Remove from AlphaPlay</span>${ico.trash}</button>`;
  openPanel('Song options', body);
}
function openAlbumMenu(albumId) {
  const album = albums.find(item => item.id === albumId); if (!album) return;
  openPanel('Album options', `<p class="modal-subtitle">${esc(album.name)}</p><button class="action-option" data-action="edit-album" data-id="${esc(album.id)}"><span>Edit album</span>${chev}</button><button class="action-option danger" data-action="delete-album" data-id="${esc(album.id)}"><span>Delete album</span>${ico.trash}</button>`);
}
function openEditAlbum(albumId) {
  const album = albums.find(item => item.id === albumId); if (!album) return;
  openPanel('Edit album', `<form id="editAlbumForm" class="modal-form"><label for="editAlbumName">Album name</label><input id="editAlbumName" type="text" maxlength="70" value="${esc(album.name)}" required><label for="editAlbumCover">Cover photo</label><input id="editAlbumCover" type="file" accept="image/*"><div id="editAlbumPreview" class="album-cover-preview">${album.cover ? `<img src="${esc(album.cover)}" alt="Album cover preview">` : '<span>Default cover</span>'}</div><div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn">Save</button></div></form>`);
  let coverData = album.cover || '';
  $('#editAlbumCover').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); e.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { coverData = String(reader.result || ''); $('#editAlbumPreview').innerHTML = `<img src="${coverData}" alt="Album cover preview">`; };
    reader.readAsDataURL(file);
  });
  $('#editAlbumForm').addEventListener('submit', e => {
    e.preventDefault(); const name = $('#editAlbumName').value.trim(); if (!name) return;
    if (albums.some(item => item.id !== album.id && item.name.toLowerCase() === name.toLowerCase())) { alert('An album with this name already exists.'); return; }
    album.name = name; album.cover = coverData; saveCollections(); closePanel(); renderAll();
  });
}
function deleteAlbum(albumId) {
  const album = albums.find(item => item.id === albumId); if (!album) return;
  if (!window.confirm(`Delete the album "${album.name}"? The songs will remain in Songs.`)) return;
  deletedAlbumNames.add(album.name.toLowerCase());
  albums = albums.filter(item => item.id !== albumId);
  saveCollections();
  if (listMode === 'albums' && listKey === albumId) listKey = null;
  closePanel(); renderAll();
}
function openEditSong(i) {
  const song = SONGS[i]; if (!song) return;
  openPanel('Edit song details', `<form id="editSongForm" class="modal-form"><label for="editSongTitle">Title</label><input id="editSongTitle" type="text" maxlength="120" value="${esc(song.title)}" required><label for="editSongArtist">Artist</label><input id="editSongArtist" type="text" maxlength="120" value="${esc(song.artist)}"><label for="editSongAlbum">Album</label><input id="editSongAlbum" type="text" maxlength="120" value="${esc(song.album === 'Unknown Album' ? '' : song.album)}" placeholder="Leave blank if unknown"><label for="editSongCover">Cover photo</label><input id="editSongCover" type="file" accept="image/*"><div id="editSongPreview" class="album-cover-preview">${song.cover && song.cover !== DEFAULT_COVER ? `<img src="${esc(song.cover)}" alt="Current song cover">` : '<span>Using default AlphaPlay cover</span>'}</div><div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn">Save changes</button></div></form>`);
  let nextCoverBlob = song.coverBlob || null;
  let nextCoverUrl = song.cover || DEFAULT_COVER;
  let coverChanged = false;
  $('#editSongCover').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); e.target.value = ''; return; }
    if (nextCoverUrl && nextCoverUrl.startsWith('blob:') && nextCoverUrl !== song.cover) URL.revokeObjectURL(nextCoverUrl);
    nextCoverBlob = file; nextCoverUrl = URL.createObjectURL(file); coverChanged = true;
    $('#editSongPreview').innerHTML = `<img src="${nextCoverUrl}" alt="New song cover preview">`;
  });
  $('#editSongForm').addEventListener('submit', async e => {
    e.preventDefault();
    const title = $('#editSongTitle').value.trim(); if (!title) return;
    const oldAlbumName = song.album;
    const newAlbumName = $('#editSongAlbum').value.trim() || 'Unknown Album';
    song.title = title;
    song.artist = $('#editSongArtist').value.trim() || 'Unknown Artist';
    song.album = newAlbumName;
    if (coverChanged) {
      song.coverBlob = nextCoverBlob;
      song.cover = DEFAULT_COVER;
      // coverSrc replaces the previous cached URL and creates the new shared URL.
      coverSrc(song);
      // Refresh already-rendered images immediately, including hidden sections.
      refreshSongArtwork(song);
      // The preview URL is separate from the shared song artwork URL.
      if (nextCoverUrl && nextCoverUrl.startsWith('blob:')) URL.revokeObjectURL(nextCoverUrl);
    }
    if (oldAlbumName !== newAlbumName) {
      albums.forEach(album => { if (album.name.toLowerCase() === oldAlbumName.toLowerCase()) album.songIds = album.songIds.filter(id => id !== song.id); });
      if (newAlbumName !== 'Unknown Album') {
        const album = ensureAlbum(newAlbumName);
        if (album && !album.songIds.includes(song.id)) album.songIds.push(song.id);
      }
    }
    try {
      if (persistentStorage) await dbPut(persistableSong(song));
    } catch (error) {
      alert('The changes are visible now, but AlphaPlay could not save them to browser storage. Check available storage space.');
    }
    saveCollections(); closePanel();
    updatePlayerLabels(SONGS[idx]);
    renderAll();
    refreshSongArtwork(song);
  });
}
function getCollection(type, id) {
  return type === 'album' ? albums.find(a => a.id === id) : type === 'folder' ? folders.find(f => f.id === id) : playlists.find(p => p.id === id);
}
function openCollectionMenu(type, id) {
  const item = getCollection(type, id); if (!item) return;
  const label = type === 'folder' ? 'folder' : 'playlist';
  openPanel(`${label[0].toUpperCase() + label.slice(1)} options`, `<p class="modal-subtitle">${esc(item.name)}</p><button class="action-option" data-action="rename-collection" data-type="${type}" data-id="${esc(id)}"><span>Edit ${label} name</span>${chev}</button><button class="action-option danger" data-action="delete-collection" data-type="${type}" data-id="${esc(id)}"><span>Delete ${label}</span>${ico.trash}</button>`);
}
function openRenameCollection(type, id) {
  const item = getCollection(type, id); if (!item) return;
  const label = type === 'folder' ? 'folder' : 'playlist', list = type === 'folder' ? folders : playlists;
  openPanel(`Edit ${label} name`, `<form id="renameForm" class="modal-form"><label for="renameInput">${label[0].toUpperCase() + label.slice(1)} name</label><input id="renameInput" type="text" maxlength="70" value="${esc(item.name)}" required autocomplete="off"><div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn">Save</button></div></form>`);
  $('#renameForm').addEventListener('submit', e => {
    e.preventDefault(); const name = $('#renameInput').value.trim(); if (!name) return;
    if (list.some(x => x.id !== item.id && x.name.toLowerCase() === name.toLowerCase())) { $('#renameInput').setCustomValidity(`A ${label} with this name already exists.`); $('#renameInput').reportValidity(); return; }
    item.name = name; saveCollections(); closePanel(); renderAll();
  });
}
function deleteCollection(type, id) {
  const item = getCollection(type, id); if (!item) return;
  const label = type === 'folder' ? 'folder' : 'playlist';
  if (!window.confirm(`Delete the ${label} "${item.name}"? The songs will remain in Songs.`)) return;
  if (type === 'folder') folders = folders.filter(f => f.id !== id); else playlists = playlists.filter(p => p.id !== id);
  saveCollections();
  if (listMode === (type === 'folder' ? 'folders' : 'playlists') && listKey === id) listKey = null;
  closePanel(); renderAll();
}
function openCreateFolder(pendingSongIndex = null) {
  openPanel('Create folder', `<form id="folderForm" class="modal-form"><label for="folderName">Folder name</label><input id="folderName" type="text" maxlength="70" placeholder="Enter folder name" required autocomplete="off"><div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Create folder</button></div></form>`);
  $('#folderForm').addEventListener('submit', e => {
    e.preventDefault(); const name = $('#folderName').value.trim(); if (!name) return;
    if (folders.some(f => f.name.toLowerCase() === name.toLowerCase())) { $('#folderName').setCustomValidity('A folder with this name already exists.'); $('#folderName').reportValidity(); return; }
    const folder = { id: makeId('folder'), name, songIds: [] };
    if (Number.isInteger(pendingSongIndex) && SONGS[pendingSongIndex]) folder.songIds.push(SONGS[pendingSongIndex].id);
    folders.push(folder); saveCollections(); closePanel(); go('library', 'folders'); listMode = 'folders'; listKey = folder.id; renderList();
  });
}
function openFolderChooser(i) {
  const options = folders.map(folder => `<button class="action-option" data-action="choose-folder" data-song-index="${i}" data-id="${esc(folder.id)}"><span>${esc(folder.name)}</span><small>${folder.songIds.length} songs</small>${chev}</button>`).join('');
  openPanel('Add to folder', `${options || '<p class="empty compact">No folders yet.</p>'}<button class="create-playlist" data-action="create-folder-with-song" data-song-index="${i}">+ Create new folder</button>`);
}
function addSongToFolder(i, folderId) {
  const song = SONGS[i], folder = folders.find(item => item.id === folderId); if (!song || !folder) return;
  if (!folder.songIds.includes(song.id)) folder.songIds.push(song.id);
  saveCollections(); closePanel(); renderAll();
}
function removeFromFolder(i, folderId) {
  const song = SONGS[i], folder = folders.find(item => item.id === folderId); if (!song || !folder) return;
  folder.songIds = folder.songIds.filter(id => id !== song.id); saveCollections(); closePanel(); renderAll();
}
function openCreatePlaylist(pendingSongIndex = null) {
  pendingPlaylistSongIndex = Number.isInteger(pendingSongIndex) ? pendingSongIndex : null;
  openPanel('Create playlist', `<form id="playlistForm" class="modal-form"><label for="playlistName">Playlist name</label><input id="playlistName" name="playlistName" type="text" maxlength="70" placeholder="Enter playlist name" required autocomplete="off"><div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">Cancel</button><button class="primary-btn" type="submit">Create playlist</button></div></form>`);
  $('#playlistForm').addEventListener('submit', e => {
    e.preventDefault(); const name = $('#playlistName').value.trim(); if (!name) return;
    if (playlists.some(p => p.name.toLowerCase() === name.toLowerCase())) { $('#playlistName').setCustomValidity('A playlist with this name already exists.'); $('#playlistName').reportValidity(); return; }
    const playlist = { id: makeId('playlist'), name, songIds: [] };
    if (pendingPlaylistSongIndex !== null && SONGS[pendingPlaylistSongIndex]) playlist.songIds.push(SONGS[pendingPlaylistSongIndex].id);
    playlists.push(playlist); saveCollections(); listMode = 'playlists'; listKey = playlist.id;
    pendingPlaylistSongIndex = null; closePanel(); go('library', 'playlists'); listKey = playlist.id; renderList();
  });
}
function openPlaylistChooser(i) {
  const options = playlists.map(playlist => `<button class="action-option" data-action="choose-playlist" data-song-index="${i}" data-id="${esc(playlist.id)}"><span>${esc(playlist.name)}</span><small>${playlist.songIds.length} songs</small>${chev}</button>`).join('');
  openPanel('Add to playlist', `${options || '<p class="empty compact">No existing playlist yet.</p>'}<button class="create-playlist" data-action="create-playlist-with-song" data-song-index="${i}">+ Create new playlist</button>`);
}
function openAlbumChooser(i) {
  const options = albums.map(album => `<button class="action-option" data-action="choose-album" data-song-index="${i}" data-id="${esc(album.id)}"><span>${esc(album.name)}</span><small>${album.songIds.length} songs</small>${chev}</button>`).join('');
  openPanel('Add to existing album', `${options || '<p class="empty">No albums exist yet. Edit a song and enter an album name to create one.</p>'}`);
}
function addSongToAlbum(i, albumId) {
  const song = SONGS[i], album = albums.find(item => item.id === albumId); if (!song || !album) return;
  if (!album.songIds.includes(song.id)) album.songIds.push(song.id);
  saveCollections(); closePanel(); renderAll();
}
function addSongToPlaylist(i, playlistId) {
  const song = SONGS[i], playlist = playlists.find(item => item.id === playlistId); if (!song || !playlist) return;
  if (!playlist.songIds.includes(song.id)) playlist.songIds.push(song.id);
  saveCollections(); closePanel(); renderAll();
}
function openCollectionPicker(type, id) {
  const collection = getCollection(type, id);
  if (!collection) return;
  const existingIds = new Set(collection.songIds);
  const available = SONGS.map((song, i) => ({ song, i })).filter(item => !existingIds.has(item.song.id));
  const title = `Add songs to ${collection.name}`;
  if (!available.length) { openPanel(title, '<p class="empty">All available songs are already in this collection.</p><button class="primary-btn full-btn" data-action="close-modal">Done</button>'); return; }
  const checks = available.map(({ song, i }) => `<label class="pick-song"><input type="checkbox" name="selectedSong" value="${i}"><span class="art mini-art">${imageHTML(song)}</span><span class="pick-copy"><b>${esc(song.title)}</b><small>${esc(song.artist)} · ${esc(song.album)}</small></span></label>`).join('');
  openPanel(title, `<form id="collectionPickerForm" class="modal-form"><div class="picker-list">${checks}</div><div class="form-actions"><button type="button" class="outline-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn">Add selected</button></div></form>`);
  $('#collectionPickerForm').addEventListener('submit', e => {
    e.preventDefault();
    const selected = [...$('#collectionPickerForm').querySelectorAll('input[name="selectedSong"]:checked')].map(input => Number(input.value));
    if (!selected.length) { alert('Select at least one song to add.'); return; }
    selected.forEach(songIndex => { const song = SONGS[songIndex]; if (song && !collection.songIds.includes(song.id)) collection.songIds.push(song.id); });
    saveCollections(); closePanel(); renderAll();
  });
}
function removeFromPlaylist(i, playlistId) {
  const song = SONGS[i], playlist = playlists.find(item => item.id === playlistId); if (!song || !playlist) return;
  playlist.songIds = playlist.songIds.filter(id => id !== song.id); saveCollections(); closePanel(); renderAll();
}
async function deleteSong(i) {
  const song = SONGS[i]; if (!song) return;
  closePanel();
  const shouldDelete = window.confirm(`Remove “${song.title}” from AlphaPlay? This removes AlphaPlay's stored copy. The original file on your phone will not be deleted.`);
  if (!shouldDelete) { deleteRevealIndex = null; renderAll(); return; }
  if (persistentStorage) {
    try { await dbDelete(song.id); }
    catch (error) { alert('AlphaPlay could not remove the saved copy from browser storage. Please try again.'); return; }
  }
  const wasCurrent = i === idx;
  const queuePosition = queue.indexOf(i);
  const nextSongId = wasCurrent && queue.length > 1 && queuePosition >= 0
    ? SONGS[queue[(queuePosition + 1) % queue.length]]?.id
    : null;
  if (wasCurrent) { au.pause(); au.removeAttribute('src'); au.load(); setAudioStatus(''); }
  if (song.file && song.file.startsWith('blob:')) URL.revokeObjectURL(song.file);
  releaseSongCover(song);
  const removedId = song.id;
  SONGS.splice(i, 1);
  queue = queue.filter(n => n !== i).map(n => n > i ? n - 1 : n);
  if (!shuffle) queue = SONGS.map((_, n) => n);
  favs = favs.filter(n => n !== i).map(n => n > i ? n - 1 : n);
  recent = recent.filter(n => n !== i).map(n => n > i ? n - 1 : n);
  albums.forEach(album => album.songIds = album.songIds.filter(id => id !== removedId));
  playlists.forEach(playlist => playlist.songIds = playlist.songIds.filter(id => id !== removedId));
  folders.forEach(folder => folder.songIds = folder.songIds.filter(id => id !== removedId));
  const nextIndex = nextSongId ? SONGS.findIndex(item => item.id === nextSongId) : -1;
  idx = wasCurrent ? (nextIndex >= 0 ? nextIndex : Math.min(i, Math.max(0, SONGS.length - 1))) : (idx > i ? idx - 1 : idx);
  if (SONGS.length && !queue.includes(idx)) queue.splice(Math.max(0, Math.min(queuePosition, queue.length)), 0, idx);
  deleteRevealIndex = null; longPressTriggered = false;
  ls.set('ap_favs', favs); ls.set('ap_recent', recent); ls.set('ap_idx', idx); persistQueue(); saveCollections();
  if (SONGS.length) {
    if (wasCurrent) load(idx, false);
    else { updatePlayerLabels(SONGS[idx]); renderAll(); }
  } else { clearPlayer(); renderAll(); }
}
document.addEventListener('click', e => {
  const more = e.target.closest('[data-more-index]');
  if (more) { e.preventDefault(); e.stopPropagation(); const wrap = more.closest('.song-wrap'); openSongMenu(Number(more.dataset.moreIndex), wrap?.dataset.playlistId || null, wrap?.dataset.folderId || null); return; }
  const deleteButton = e.target.closest('[data-delete-index]');
  if (deleteButton) { e.preventDefault(); e.stopPropagation(); deleteSong(Number(deleteButton.dataset.deleteIndex)); return; }
  const collectionMore = e.target.closest('[data-collection-more]');
  if (collectionMore) { e.preventDefault(); e.stopPropagation(); openCollectionMenu(collectionMore.dataset.collectionMore, collectionMore.dataset.id); return; }
  const albumMore = e.target.closest('[data-album-more]');
  if (albumMore) { e.preventDefault(); e.stopPropagation(); openAlbumMenu(albumMore.dataset.albumMore); return; }
  const actionButton = e.target.closest('[data-action]');
  if (actionButton) {
    const action = actionButton.dataset.action;
    const songIndex = Number(actionButton.dataset.songIndex);
    const id = actionButton.dataset.id;
    if (action === 'close-modal') closePanel();
    else if (action === 'back-library') { listKey = null; renderList(); }
    else if (action === 'create-playlist') openCreatePlaylist();
    else if (action === 'create-folder') openCreateFolder();
    else if (action === 'create-folder-with-song') openCreateFolder(songIndex);
    else if (action === 'rename-collection') openRenameCollection(actionButton.dataset.type, id);
    else if (action === 'delete-collection') deleteCollection(actionButton.dataset.type, id);
    else if (action === 'song-add-folder') openFolderChooser(songIndex);
    else if (action === 'choose-folder') addSongToFolder(songIndex, id);
    else if (action === 'remove-from-folder') removeFromFolder(songIndex, actionButton.dataset.folderId);
    else if (action === 'edit-album') openEditAlbum(id);
    else if (action === 'delete-album') deleteAlbum(id);
    else if (action === 'edit-song') openEditSong(songIndex);
    else if (action === 'create-playlist-with-song') openCreatePlaylist(songIndex);
    else if (action === 'add-to-collection') openCollectionPicker(actionButton.dataset.type, id);
    else if (action === 'song-add-album') openAlbumChooser(songIndex);
    else if (action === 'song-add-playlist') openPlaylistChooser(songIndex);
    else if (action === 'choose-album') addSongToAlbum(songIndex, id);
    else if (action === 'choose-playlist') addSongToPlaylist(songIndex, id);
    else if (action === 'toggle-favorite') { toggleFavorite(songIndex); closePanel(); }
    else if (action === 'remove-from-playlist') removeFromPlaylist(songIndex, actionButton.dataset.playlistId);
    else if (action === 'delete-song') deleteSong(songIndex);
    return;
  }
  const albumButton = e.target.closest('[data-open-album]');
  if (albumButton) { listKey = albumButton.dataset.openAlbum; renderList(); return; }
  const folderButton = e.target.closest('[data-open-folder]');
  if (folderButton) { listKey = folderButton.dataset.openFolder; renderList(); return; }
  const playlistButton = e.target.closest('[data-open-playlist]');
  if (playlistButton) { listKey = playlistButton.dataset.openPlaylist; renderList(); return; }
  const groupButton = e.target.closest('[data-open-group]');
  if (groupButton) { listKey = groupButton.dataset.openGroup; renderList(); return; }
  const modeButton = e.target.closest('[data-library-mode]');
  if (modeButton) { listMode = modeButton.dataset.libraryMode; listKey = null; renderList(); }
});

/* ===== SETTINGS / THEME ===== */
function sheet(open) { $('#sheet').classList.toggle('show', !!open); }
function theme(themeName) { document.documentElement.dataset.theme = themeName; $('#themeSw').classList.toggle('on', themeName === 'dark'); ls.set('ap_theme', themeName); }
$('#themeSw').onclick = () => theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
const ACC = [['#3ea6ff','#7b4dff'],['#2ed3a0','#1b8f6f'],['#ff5fa2','#b83cff'],['#ffb02e','#ff5a3c']];
$('#accs').innerHTML = ACC.map((colors, i) => `<i role="button" tabindex="0" aria-label="Accent colour ${i + 1}" style="background:linear-gradient(135deg,${colors[0]},${colors[1]})" onclick="accent(${i})"></i>`).join('');
function accent(i) { const root = document.documentElement.style, colors = ACC[i]; root.setProperty('--acc', colors[0]); root.setProperty('--acc2', colors[1]); root.setProperty('--grad', `linear-gradient(135deg,${colors[0]},${colors[1]})`); ls.set('ap_acc', i); }

/* ===== IMPORT / FILE PICKER ===== */
const addModal = $('#addModal');
const accessModal = $('#accessModal');
const libraryPicker = $('#libraryPicker');
const importProgressModal = $('#importProgressModal');
const importProgressTitle = $('#importProgressTitle');
const importProgressMessage = $('#importProgressMessage');
const importProgressCount = $('#importProgressCount');
const importProgressFill = $('#importProgressFill');
const importProgressBar = $('#importProgressBar');
const importProgressSpinner = $('#importProgressSpinner');
const importProgressErrors = $('#importProgressErrors');
const cancelImportButton = $('#cancelImport');
let importInProgress = false;
let cancelImportRequested = false;
let libraryPickerImportRunning = false;
// Keep multi-select enabled even if the page is embedded by a mobile browser wrapper.
$('#newAudio').multiple = true;
libraryPicker.multiple = true;
const addFab = $('#addFab');
function openAccessPrompt() { accessModal.classList.add('show'); }
function closeAccessPrompt() { accessModal.classList.remove('show'); }
function openLibraryPicker(purpose = 'library') {
  libraryPickerPurpose = purpose;
  libraryPicker.value = '';
  // click() is kept in the same user gesture so Android can open its file picker.
  libraryPicker.click();
}
function showImportProgress(total) {
  importInProgress = true;
  cancelImportRequested = false;
  importProgressModal.classList.remove('complete');
  importProgressTitle.textContent = 'Adding your songs';
  importProgressMessage.textContent = 'Preparing your selected audio files…';
  importProgressCount.textContent = `0 of ${total} songs added`;
  importProgressFill.style.width = '0%';
  importProgressBar.setAttribute('aria-valuenow', '0');
  importProgressSpinner.style.display = '';
  importProgressErrors.hidden = true;
  importProgressErrors.textContent = '';
  cancelImportButton.disabled = false;
  cancelImportButton.textContent = 'Cancel';
  importProgressModal.classList.add('show');
}
function updateImportProgress(processed, total, imported, currentName = '') {
  const percent = total ? Math.round(processed / total * 100) : 0;
  importProgressFill.style.width = `${percent}%`;
  importProgressBar.setAttribute('aria-valuenow', String(percent));
  importProgressCount.textContent = `${imported} of ${total} songs added · ${processed} processed`;
  if (currentName && !cancelImportRequested) importProgressMessage.textContent = `Adding: ${currentName}`;
}
function finishImportProgress({ imported, total, processed, cancelled, failures }) {
  importInProgress = false;
  importProgressModal.classList.add('complete');
  importProgressSpinner.style.display = 'none';
  importProgressTitle.textContent = cancelled ? 'Import cancelled' : (failures.length ? 'Import finished with issues' : 'Songs added');
  importProgressMessage.textContent = cancelled
    ? `Stopped after adding ${imported} song${imported === 1 ? '' : 's'}.`
    : `Successfully added ${imported} song${imported === 1 ? '' : 's'}.`;
  importProgressCount.textContent = `${processed} of ${total} processed · ${failures.length} failed`;
  importProgressFill.style.width = `${total ? Math.round(processed / total * 100) : 100}%`;
  importProgressBar.setAttribute('aria-valuenow', String(total ? Math.round(processed / total * 100) : 100));
  if (failures.length) {
    importProgressErrors.hidden = false;
    importProgressErrors.textContent = 'Could not add:\n' + failures.slice(0, 5).join('\n') + (failures.length > 5 ? `\n…and ${failures.length - 5} more.` : '');
  }
  cancelImportButton.disabled = false;
  cancelImportButton.textContent = 'Done';
}
cancelImportButton.addEventListener('click', () => {
  if (importInProgress) {
    cancelImportRequested = true;
    cancelImportButton.disabled = true;
    cancelImportButton.textContent = 'Cancelling…';
    importProgressMessage.textContent = 'Cancelling after the current song finishes…';
    return;
  }
  importProgressModal.classList.remove('show', 'complete');
  cancelImportButton.textContent = 'Cancel';
});
function resetAddForm() {
  $('#addForm').reset(); chosenCoverFile = null;
  $('#selectionStatus').textContent = 'Select one or more audio files. On Android, long-press a file in the picker, then tap the other files you want to select.';
  if (chosenCoverUrl && chosenCoverUrl.startsWith('blob:')) URL.revokeObjectURL(chosenCoverUrl);
  chosenCoverUrl = null;
  $('#coverPreview').innerHTML = '<img src="image/AlphaPlay.jpg" alt="Cover preview"><span>Default cover</span>';
  $('#multiImportNote').style.display = 'none';
  $('#singleSongFields').style.display = '';
}
function closeAdd() { addModal.classList.remove('show'); resetAddForm(); }
$('#cancelAdd').onclick = closeAdd;
addModal.addEventListener('click', e => { if (e.target === addModal) closeAdd(); });
$('#newAudio').addEventListener('change', e => {
  const files = [...(e.target.files || [])].filter(isAudioFile);
  $('#selectionStatus').textContent = files.length
    ? `${files.length} audio file${files.length === 1 ? '' : 's'} selected.`
    : 'Select one or more audio files. On Android, long-press a file in the picker, then tap the other files you want to select.';
  if (files.length > 1) {
    $('#singleSongFields').style.display = 'none';
    $('#multiImportNote').style.display = '';
  } else {
    $('#singleSongFields').style.display = '';
    $('#multiImportNote').style.display = 'none';
    if (files[0] && !$('#newTitle').value.trim()) $('#newTitle').value = files[0].name.replace(/\.[^.]+$/, '');
  }
});
$('#newCover').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0]; if (!file) return;
  if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); e.target.value = ''; return; }
  chosenCoverFile = file;
  if (chosenCoverUrl && chosenCoverUrl.startsWith('blob:')) URL.revokeObjectURL(chosenCoverUrl);
  chosenCoverUrl = URL.createObjectURL(file);
  $('#coverPreview').innerHTML = `<img src="${chosenCoverUrl}" alt="Selected cover"><span>Custom cover selected</span>`;
});
function isAudioFile(file) {
  return !!file && ((file.type && file.type.startsWith('audio/')) || /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|wma|aif|aiff|alac|amr|3gp)$/i.test(file.name || ''));
}
async function importAudioFiles(fileList, options = {}) {
  if (importInProgress) return 0;
  const hadSongsBeforeImport = SONGS.length > 0;
  const previousSongCount = SONGS.length;
  const selectedAudioFiles = [...(fileList || [])].filter(isAudioFile);
  if (!selectedAudioFiles.length) {
    alert('AlphaPlay could not read any supported audio files. Please select MP3, M4A, WAV, AAC, OGG, FLAC, or another supported audio file.');
    return 0;
  }
  const files = selectedAudioFiles;
  let imported = 0;
  let processed = 0;
  let cancelled = false;
  const failures = [];
  showImportProgress(files.length);

  try {
    for (let position = 0; position < files.length; position++) {
      // Yield to the browser between files so the progress dialog paints and Cancel remains responsive,
      // including on browsers where IndexedDB is unavailable and imports are session-only.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cancelImportRequested) { cancelled = true; break; }
      const file = files[position];
      const singleWithDetails = files.length === 1 && options.useDetails;
      const explicitAlbum = singleWithDetails ? String(options.album || '').trim() : '';
      let song = null;
      try {
        const audioBlob = normaliseAudioBlob(file);
        song = {
          id: makeId('song'),
          title: singleWithDetails && String(options.title || '').trim() ? String(options.title).trim() : file.name.replace(/\.[^.]+$/, '') || 'Untitled audio',
          artist: singleWithDetails && String(options.artist || '').trim() ? String(options.artist).trim() : 'Unknown Artist',
          album: explicitAlbum || 'Unknown Album',
          genre: 'Audio', folder: file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1).join('/') : 'Imported music',
          createdAt: Date.now() + position, audioBlob, coverBlob: singleWithDetails ? (options.coverBlob || null) : null,
          file: URL.createObjectURL(audioBlob), cover: DEFAULT_COVER, local: true
        };
        if (persistentStorage) await dbPut(persistableSong(song));
        SONGS.push(song);
        if (explicitAlbum) {
          deletedAlbumNames.delete(explicitAlbum.toLowerCase());
          const album = ensureAlbum(explicitAlbum);
          if (album && !album.songIds.includes(song.id)) album.songIds.push(song.id);
        }
        imported++;
      } catch (error) {
        if (song?.file && song.file.startsWith('blob:')) URL.revokeObjectURL(song.file);
        if (song?.cover && song.cover.startsWith('blob:')) URL.revokeObjectURL(song.cover);
        failures.push(`${file.name}: ${error?.name || error?.message || 'storage error'}`);
      }
      processed = position + 1;
      updateImportProgress(processed, files.length, imported, file.name);
    }
    cancelled = cancelled || (cancelImportRequested && processed < files.length);
    if (imported) {
      addImportedSongsToQueue(previousSongCount);
      favs = favs.filter(i => SONGS[i]); recent = recent.filter(i => SONGS[i]);
      ls.set('ap_favs', favs); ls.set('ap_recent', recent);
      ls.set('ap_audio_access_granted', true);
      ls.set('ap_last_import_time', Date.now());
      saveCollections();
      closeAccessPrompt();
      if (!hadSongsBeforeImport || !SONGS[idx]) load(0, false);
      else renderAll();
    }
    if (imported && !persistentStorage) {
      failures.push('Browser storage is unavailable. The songs are available for this session but may disappear after you close or reload AlphaPlay.');
    }
    finishImportProgress({ imported, total: files.length, processed, cancelled, failures });
    return imported;
  } catch (error) {
    console.error('AlphaPlay batch import failed:', error);
    failures.push(error?.message || 'Unexpected import error');
    finishImportProgress({ imported, total: files.length, processed, cancelled: false, failures });
    return imported;
  }
}
$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const chosenFiles = [...($('#newAudio').files || [])];
  if (!chosenFiles.length) { alert('Choose an audio file first.'); return; }
  if (chosenFiles.length > 1) {
    closeAdd();
    await importAudioFiles(chosenFiles);
    return;
  }
  const file = chosenFiles[0];
  const options = {
    useDetails: true,
    title: $('#newTitle').value.trim() || file.name.replace(/\.[^.]+$/, ''),
    artist: $('#newArtist').value.trim(),
    album: $('#newAlbum').value.trim(),
    coverBlob: chosenCoverFile
  };
  closeAdd();
  await importAudioFiles([file], options);
});
$('#importMultiple').onclick = () => { closeAdd(); openLibraryPicker('library'); };
$('#grantAudioAccess').onclick = () => openLibraryPicker('onboarding');
$('#skipAudioAccess').onclick = closeAccessPrompt;
$('#emptyImport').onclick = () => openLibraryPicker('library');
$('#moreImport').onclick = () => openLibraryPicker('library');
async function handleLibraryPickerSelection(e) {
  const files = [...(e.target.files || [])];
  if (!files.length || libraryPickerImportRunning) return;
  libraryPickerImportRunning = true;
  const purpose = libraryPickerPurpose;
  try {
    const count = await importAudioFiles(files);
    if (count && purpose === 'onboarding') closeAccessPrompt();
  } catch (error) {
    console.error('Could not import the selected files.', error);
    alert('AlphaPlay could not add the selected songs. Please try selecting them again.');
  } finally {
    // Clear the input so the same track(s) can be selected again next time.
    libraryPicker.value = '';
    libraryPickerImportRunning = false;
  }
}
// Mobile file pickers normally fire change; listen to input as well because some
// Android document-picker wrappers fire input first or only.
libraryPicker.addEventListener('input', handleLibraryPickerSelection);
libraryPicker.addEventListener('change', handleLibraryPickerSelection);

/* ===== LONG-PRESS REMOVE FROM ALPHAPLAY ===== */
function revealDelete(target) {
  const wrap = target?.closest('.song-wrap'); if (!wrap) return;
  const index = Number(wrap.dataset.songIndex); if (!SONGS[index]) return;
  deleteRevealIndex = index;
  document.querySelectorAll('.song-wrap.delete-revealed').forEach(el => el.classList.remove('delete-revealed'));
  wrap.classList.add('delete-revealed'); longPressTriggered = true;
}
document.addEventListener('pointerdown', e => {
  const row = e.target.closest('.song-wrap .row'); if (!row) return;
  pressTarget = row; longPressTriggered = false; clearTimeout(pressTimer);
  pressTimer = setTimeout(() => revealDelete(pressTarget), 620);
});
['pointerup','pointercancel'].forEach(type => document.addEventListener(type, () => { clearTimeout(pressTimer); pressTimer = null; }));
document.addEventListener('contextmenu', e => {
  const row = e.target.closest('.song-wrap .row'); if (row) { e.preventDefault(); revealDelete(row); }
});

/* ===== DRAGGABLE FLOATING ACTION BUTTON ===== */
let fabPointerId = null, fabStartX = 0, fabStartY = 0, fabLeft = 0, fabTop = 0, fabMoved = false, suppressFabClick = false;
function clamp(n, min, max) { return Math.max(min, Math.min(n, max)); }
function applyFabPosition(position) {
  if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) return;
  const left = clamp(position.left, 0, Math.max(0, innerWidth - addFab.offsetWidth));
  const top = clamp(position.top, 0, Math.max(0, innerHeight - addFab.offsetHeight));
  addFab.style.left = left + 'px'; addFab.style.top = top + 'px'; addFab.style.right = 'auto'; addFab.style.bottom = 'auto';
}
const savedFab = ls.get('ap_fab_position', null);
if (savedFab) requestAnimationFrame(() => applyFabPosition(savedFab));
addFab.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  fabPointerId = e.pointerId; fabMoved = false;
  const rect = addFab.getBoundingClientRect(); fabLeft = rect.left; fabTop = rect.top; fabStartX = e.clientX; fabStartY = e.clientY;
  try { addFab.setPointerCapture(e.pointerId); } catch {}
});
addFab.addEventListener('pointermove', e => {
  if (fabPointerId !== e.pointerId) return;
  const dx = e.clientX - fabStartX, dy = e.clientY - fabStartY;
  if (!fabMoved && Math.hypot(dx, dy) < 6) return;
  fabMoved = true; addFab.classList.add('dragging'); e.preventDefault();
  applyFabPosition({ left: fabLeft + dx, top: fabTop + dy });
});
function endFabPointer(e) {
  if (fabPointerId !== e.pointerId) return;
  if (fabMoved) {
    const rect = addFab.getBoundingClientRect(); ls.set('ap_fab_position', { left: rect.left, top: rect.top });
    suppressFabClick = true; setTimeout(() => { suppressFabClick = false; }, 400);
  }
  fabPointerId = null; addFab.classList.remove('dragging');
}
addFab.addEventListener('pointerup', endFabPointer); addFab.addEventListener('pointercancel', endFabPointer);
addFab.addEventListener('click', e => {
  if (suppressFabClick) { e.preventDefault(); return; }
  addModal.classList.add('show');
});
addEventListener('resize', () => { const position = ls.get('ap_fab_position', null); if (position) applyFabPosition(position); });

/* ===== STARTUP ===== */
async function init() {
  theme(ls.get('ap_theme', 'dark'));
  if (ls.get('ap_acc', null) !== null) accent(ls.get('ap_acc'));
  au.volume = Number(ls.get('ap_vol', 0.8)); $('#vol').value = au.volume; setFill($('#vol'));
  $('#auto').textContent = 'Autoplay: ' + (autoplay ? 'On' : 'Off');
  $('#pp').innerHTML = ico.play; $('#miPP').innerHTML = ico.play;
  try {
    db = await openTrackDB(); persistentStorage = true;
    const records = await dbGetAll();
    records.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    records.forEach(record => {
      if (record?.audioBlob && typeof record.id === 'string') {
        try { SONGS.push(songFromRecord(record)); } catch (error) { console.warn('Could not load an imported audio record.', error); }
      }
    });
  } catch (error) {
    persistentStorage = false;
    console.warn('AlphaPlay local storage is unavailable; imported audio will be session-only.', error);
  }
  const validIds = new Set(SONGS.map(song => song.id));
  albums.forEach(album => album.songIds = [...new Set(album.songIds.filter(id => validIds.has(id)))]);
  playlists.forEach(playlist => playlist.songIds = [...new Set(playlist.songIds.filter(id => validIds.has(id)))]);
  folders.forEach(folder => folder.songIds = [...new Set(folder.songIds.filter(id => validIds.has(id)))]);
  favs = favs.filter(i => i >= 0 && i < SONGS.length);
  recent = recent.filter(i => i >= 0 && i < SONGS.length);
  if (idx < 0 || idx >= SONGS.length) idx = 0;
  restoreQueue();
  saveCollections(); ls.set('ap_favs', favs); ls.set('ap_recent', recent);
  if (SONGS.length) load(idx, false); else clearPlayer();
  go('home', null, true, true);
  if (!SONGS.length && !ls.get('ap_audio_access_granted', false)) openAccessPrompt();
}
init().catch(error => {
  console.error('AlphaPlay startup failed:', error);
  clearPlayer(); renderAll();
});
