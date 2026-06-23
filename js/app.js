// Global State Management
let dueWords = [];
let currentCardIndex = 0;
let studySessionStats = { total: 0, reviewed: 0, correct: 0 };
let currentSearchData = null;
const studyMode = 'flashcard'; // Fixed to flashcard mode
let currentStudyMode = 'normal'; // 'normal' (spaced review) or 'test' (random test)
let currentRecommendationWord = null;
let currentDueWords = [];
let currentDueWordIndex = 0;

// IndexedDB Globals
const DB_NAME = 'girigiri_db';
const DB_VERSION = 1;
let db = null;

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('Service Worker registered successfully'))
      .catch(err => console.warn('Service Worker registration failed:', err));
  });
}

// Initialize App when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Load Theme
  const savedTheme = localStorage.getItem('theme') || 'dark';
  if (savedTheme === 'light') {
    document.body.classList.add('light-theme');
    document.body.classList.remove('dark-theme');
  } else {
    document.body.classList.add('dark-theme');
    document.body.classList.remove('light-theme');
  }
  updateThemeButtonUI();

  // Initialize Lucide Icons
  lucide.createIcons();

  // Initialize IndexedDB first, then load UI
  initIndexedDB()
    .then(() => {
      console.log("IndexedDB Initialized Successfully.");
      
      // Tab Navigation Handling
      const navItems = document.querySelectorAll('.nav-item');
      const screens = document.querySelectorAll('.app-screen');
      
      navItems.forEach(item => {
        item.addEventListener('click', () => {
          const targetId = item.getAttribute('data-target');
          
          navItems.forEach(n => n.classList.remove('active'));
          screens.forEach(s => s.classList.remove('active'));
          
          item.classList.add('active');
          const targetScreen = document.getElementById(targetId);
          targetScreen.classList.add('active');
          
          // Screen transition refresh logic
          if (targetId === 'screen-study') {
            loadStudySession();
          } else if (targetId === 'screen-stats') {
            loadStatistics();
          } else if (targetId === 'screen-settings') {
            loadSettings();
          } else if (targetId === 'screen-input') {
            loadTodayRecommendation();
            loadTodayDueWord();
          }
        });
      });
      
      // Setup all event listeners
      setupSearchEvents();
      setupStudyEvents();
      setupSettingsEvents();
      setupGridEvents();
      
      // Initialize Badges & General Counts
      updateHeaderBadge();

      // Initialize Today's Recommendation Card
      loadTodayRecommendation();
      loadTodayDueWord();

      // Today's Recommendation Interactive Events
      document.getElementById('btn-refresh-recommendation').addEventListener('click', (e) => {
        e.stopPropagation();
        loadTodayRecommendation();
      });

      document.getElementById('btn-tts-recommend').addEventListener('click', (e) => {
        e.stopPropagation();
        if (currentRecommendationWord) {
          speakJapanese(currentRecommendationWord.word);
        }
      });
    })
    .catch(err => {
      console.error("Failed to initialize IndexedDB:", err);
      showToast("로컬 데이터베이스 초기화 실패!", false);
    });
});

/* ========================================================
   INDEXEDDB DATA ACCESS LAYER (DAL)
   ======================================================== */
function initIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      reject(event.target.error);
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const dbInstance = event.target.result;

      // 1. words store
      if (!dbInstance.objectStoreNames.contains('words')) {
        const wordStore = dbInstance.createObjectStore('words', { keyPath: 'id', autoIncrement: true });
        wordStore.createIndex('next_review', 'next_review', { unique: false });
        wordStore.createIndex('word', 'word', { unique: false });
        wordStore.createIndex('created_at', 'created_at', { unique: false });
      }

      // 2. stats store
      if (!dbInstance.objectStoreNames.contains('stats')) {
        dbInstance.createObjectStore('stats', { keyPath: 'date' });
      }

      // 3. settings store
      if (!dbInstance.objectStoreNames.contains('settings')) {
        const settingsStore = dbInstance.createObjectStore('settings', { keyPath: 'key' });
        // Add default settings
        settingsStore.put({ key: 'daily_target', value: '10' });
        settingsStore.put({ key: 'spaced_repetition_enabled', value: 'true' });
      }
    };
  });
}

function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getOrCreateTodayStats(transaction, dateStr) {
  return new Promise((resolve, reject) => {
    const store = transaction.objectStore('stats');
    const getReq = store.get(dateStr);
    
    getReq.onsuccess = (e) => {
      const row = e.target.result;
      if (!row) {
        const newRow = {
          date: dateStr,
          reviewed_count: 0,
          correct_count: 0,
          new_words_count: 0
        };
        const addReq = store.add(newRow);
        addReq.onsuccess = () => resolve(newRow);
        addReq.onerror = (err) => reject(err.target.error);
      } else {
        resolve(row);
      }
    };
    getReq.onerror = (err) => reject(err.target.error);
  });
}

function dbAddWord(wordData) {
  return new Promise((resolve, reject) => {
    const todayStr = getTodayString();
    const transaction = db.transaction(['words', 'stats'], 'readwrite');
    const wordStore = transaction.objectStore('words');
    
    const newWord = {
      word: wordData.word,
      hiragana: wordData.hiragana,
      meaning: wordData.meaning,
      interval: 1,
      repetition: 0,
      efactor: 2.5,
      next_review: todayStr,
      status: 'new',
      exposure_count: 0,
      tag: wordData.tag || null,
      created_at: new Date().toISOString(),
      examples: wordData.examples || []
    };
    
    const addReq = wordStore.add(newWord);
    
    addReq.onsuccess = (event) => {
      const wordId = event.target.result;
      newWord.id = wordId;
      
      // Update stats
      getOrCreateTodayStats(transaction, todayStr)
        .then(stats => {
          stats.new_words_count += 1;
          const statsStore = transaction.objectStore('stats');
          statsStore.put(stats);
        })
        .catch(err => console.error("Stats update failed in dbAddWord:", err));
    };
    
    transaction.oncomplete = () => resolve(newWord);
    transaction.onerror = (event) => reject(event.target.error);
  });
}

function dbGetWords(dueOnly = false) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['words'], 'readonly');
    const wordStore = transaction.objectStore('words');
    const index = wordStore.index('next_review');
    const words = [];
    
    const todayStr = getTodayString();
    let range = null;
    if (dueOnly) {
      // Fetch only cards with next_review <= todayStr
      range = IDBKeyRange.upperBound(todayStr);
    }
    
    const request = range ? index.openCursor(range) : index.openCursor();
    
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        words.push(cursor.value);
        cursor.continue();
      } else {
        // Sort: next_review asc, created_at desc
        words.sort((a, b) => {
          if (a.next_review !== b.next_review) {
            return a.next_review.localeCompare(b.next_review);
          }
          return b.created_at.localeCompare(a.created_at);
        });
        resolve(words);
      }
    };
    
    request.onerror = (event) => reject(event.target.error);
  });
}

function dbReviewWord(wordId, score, isTestMode = false) {
  return new Promise((resolve, reject) => {
    const todayStr = getTodayString();
    const transaction = db.transaction(['words', 'stats'], 'readwrite');
    const wordStore = transaction.objectStore('words');
    let updatedWord = null;
    
    const getReq = wordStore.get(wordId);
    
    getReq.onsuccess = (event) => {
      const word = event.target.result;
      if (!word) {
        reject(new Error("Word not found"));
        return;
      }
      
      updatedWord = word;
      
      if (!isTestMode) {
        let repetition = word.repetition || 0;
        let interval = word.interval || 1;
        let efactor = word.efactor || 2.5;
        
        // SM-2 Spaced Repetition Algorithm
        if (score === 1) {
          repetition = 0;
          interval = 1;
          efactor = Math.max(1.3, efactor - 0.2);
        } else if (score === 4) {
          repetition += 1;
          if (repetition === 1) {
            interval = 1;
          } else if (repetition === 2) {
            interval = 4;
          } else {
            interval = Math.round(interval * efactor);
          }
        } else if (score === 5) {
          repetition += 1;
          efactor = Math.min(2.8, efactor + 0.15);
          if (repetition === 1) {
            interval = 2;
          } else if (repetition === 2) {
            interval = 6;
          } else {
            interval = Math.round(interval * efactor * 1.2);
          }
        }
        
        interval = Math.min(365, interval);
        
        // Calculate next review date
        const reviewDate = new Date();
        reviewDate.setDate(reviewDate.getDate() + interval);
        const nextReviewStr = `${reviewDate.getFullYear()}-${String(reviewDate.getMonth() + 1).padStart(2, '0')}-${String(reviewDate.getDate()).padStart(2, '0')}`;
        
        // 단어 상태 결정: new, learning, memorized
        let status = 'learning';
        if (interval <= 1) {
          status = 'new';
        } else if (interval >= 21) {
          status = 'memorized';
        }
        
        word.repetition = repetition;
        word.interval = interval;
        word.efactor = efactor;
        word.next_review = nextReviewStr;
        word.status = status;
        word.exposure_count = (word.exposure_count || 0) + 1; // 누적 노출 횟수 증가
        
        wordStore.put(word);
        updatedWord = word;
      }
      
      // Update stats
      getOrCreateTodayStats(transaction, todayStr)
        .then(stats => {
          stats.reviewed_count += 1;
          if (score >= 4) {
            stats.correct_count += 1;
          }
          const statsStore = transaction.objectStore('stats');
          statsStore.put(stats);
        })
        .catch(err => console.error("Stats update failed in dbReviewWord:", err));
    };
    
    transaction.oncomplete = () => resolve(updatedWord);
    transaction.onerror = (event) => reject(event.target.error);
  });
}

function dbDeleteWord(wordId) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['words'], 'readwrite');
    const wordStore = transaction.objectStore('words');
    const req = wordStore.delete(wordId);
    
    req.onsuccess = () => resolve();
    req.onerror = (event) => reject(event.target.error);
  });
}

function dbGetSettings() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['settings'], 'readonly');
    const store = transaction.objectStore('settings');
    const req = store.getAll();
    
    req.onsuccess = (e) => {
      const list = e.target.result;
      const settingsMap = {};
      list.forEach(item => {
        settingsMap[item.key] = item.value;
      });
      resolve(settingsMap);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbSaveSettings(settingsMap) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['settings'], 'readwrite');
    const store = transaction.objectStore('settings');
    
    for (let key in settingsMap) {
      store.put({ key: key, value: String(settingsMap[key]) });
    }
    
    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(e.target.error);
  });
}

function calculateStreakFromStats(statsList) {
  const todayStr = getTodayString();
  
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterdayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  
  const statsMap = {};
  statsList.forEach(s => {
    statsMap[s.date] = s.reviewed_count;
  });
  
  const todayHasReviews = (statsMap[todayStr] || 0) > 0;
  const yesterdayHasReviews = (statsMap[yesterdayStr] || 0) > 0;
  
  if (!todayHasReviews && !yesterdayHasReviews) {
    return 0;
  }
  
  let streak = 0;
  let currentDate = todayHasReviews ? new Date() : d;
  
  while (true) {
    const curStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
    if ((statsMap[curStr] || 0) > 0) {
      streak++;
      currentDate.setDate(currentDate.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function dbGetStats() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['words', 'stats', 'settings'], 'readonly');
    const wordsStore = transaction.objectStore('words');
    const statsStore = transaction.objectStore('stats');
    const settingsStore = transaction.objectStore('settings');
    
    let totalCount = 0;
    let learningCount = 0;
    let memorizedCount = 0;
    let dueCount = 0;
    let dailyTarget = 10;
    let reviewedToday = 0;
    let correctToday = 0;
    let streak = 0;
    let historyList = [];
    
    const todayStr = getTodayString();
    
    let newCount = 0;
    let memorizedExposuresSum = 0;
    let avgReviewsToMemorized = 0;
    
    const wordsReq = wordsStore.getAll();
    wordsReq.onsuccess = (e) => {
      const words = e.target.result;
      totalCount = words.length;
      words.forEach(w => {
        // 단어 상태 세분화 집계
        if (w.status === 'new') newCount++;
        else if (w.status === 'learning') learningCount++;
        else if (w.status === 'memorized') {
          memorizedCount++;
          memorizedExposuresSum += (w.exposure_count || 0);
        } else {
          // Fallback if status is legacy or not set
          const intervalVal = w.interval || 1;
          if (intervalVal <= 1) newCount++;
          else if (intervalVal >= 21) {
            memorizedCount++;
            memorizedExposuresSum += (w.exposure_count || 0);
          } else learningCount++;
        }
        
        if (w.next_review <= todayStr) dueCount++;
      });
      
      if (memorizedCount > 0) {
        avgReviewsToMemorized = memorizedExposuresSum / memorizedCount;
      }
    };
    
    const targetReq = settingsStore.get('daily_target');
    targetReq.onsuccess = (e) => {
      if (e.target.result) {
        dailyTarget = parseInt(e.target.result.value) || 10;
      }
    };
    
    const statsReq = statsStore.getAll();
    statsReq.onsuccess = (e) => {
      const allStats = e.target.result;
      
      const todayStat = allStats.find(s => s.date === todayStr);
      if (todayStat) {
        reviewedToday = todayStat.reviewed_count;
        correctToday = todayStat.correct_count;
      }
      
      streak = calculateStreakFromStats(allStats);
      
      const historyMap = {};
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - (6 - i));
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        historyMap[dateStr] = { reviewed: 0, correct: 0, new: 0 };
      }
      
      allStats.forEach(s => {
        if (historyMap[s.date]) {
          historyMap[s.date] = {
            reviewed: s.reviewed_count,
            correct: s.correct_count,
            new: s.new_words_count
          };
        }
      });
      
      historyList = Object.keys(historyMap).sort().map(k => ({
        date: k,
        reviewed: historyMap[k].reviewed,
        correct: historyMap[k].correct,
        new: historyMap[k].new
      }));
    };
    
    transaction.oncomplete = () => {
      resolve({
        total_count: totalCount,
        new_count: newCount,
        learning_count: learningCount,
        memorized_count: memorizedCount,
        due_count: dueCount,
        daily_target: dailyTarget,
        reviewed_today: reviewedToday,
        correct_today: correctToday,
        streak: streak,
        history: historyList,
        avg_reviews_to_memorized: avgReviewsToMemorized
      });
    };
    
    transaction.onerror = (e) => reject(e.target.error);
  });
}

function dbExportData() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['words'], 'readonly');
    const store = transaction.objectStore('words');
    const req = store.getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbImportData(jsonData) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['words', 'stats'], 'readwrite');
    const wordStore = transaction.objectStore('words');
    
    const clearReq = wordStore.clear();
    clearReq.onsuccess = () => {
      jsonData.forEach(item => {
        const intervalVal = item.interval || 1;
        let statusVal = item.status;
        if (!statusVal || !['new', 'learning', 'memorized'].includes(statusVal)) {
          if (intervalVal <= 1) statusVal = 'new';
          else if (intervalVal >= 21) statusVal = 'memorized';
          else statusVal = 'learning';
        }
        
        const wordRecord = {
          word: item.word,
          hiragana: item.hiragana,
          meaning: item.meaning,
          interval: intervalVal,
          repetition: item.repetition || 0,
          efactor: item.efactor || 2.5,
          next_review: item.next_review || getTodayString(),
          status: statusVal,
          exposure_count: item.exposure_count || 0,
          tag: item.tag || null,
          created_at: item.created_at || new Date().toISOString(),
          examples: item.examples || []
        };
        wordStore.add(wordRecord);
      });
    };
    
    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(e.target.error);
  });
}

function dbClearDatabase() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['words', 'stats'], 'readwrite');
    transaction.objectStore('words').clear();
    transaction.objectStore('stats').clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = (e) => reject(e.target.error);
  });
}

/* ========================================================
   CORS BYPASSING NAVER CRAWLER & AUTOCOMPLETE
   ======================================================== */
async function fetchNaverDictionaryData(word) {
  const encodedWord = encodeURIComponent(word);
  const targetUrl = `https://dict.naver.com/search.dict?dicQuery=${encodedWord}&query=${encodedWord}&target=dic&ie=utf8`;
  
  const isAndroidApk = window.location.protocol === 'file:' && /Android|iPhone|iPad|iPod|cordova|capacitor/i.test(navigator.userAgent);
  const proxyUrl = isAndroidApk ? targetUrl : `https://fragrant-shape-83a4.gimong9283.workers.dev/?url=${encodeURIComponent(targetUrl)}`;
  
  const response = await fetch(proxyUrl);
  if (!response.ok) {
    throw new Error('Failed to fetch data');
  }
  const htmlContent = await response.text();
  
  return parseNaverHtml(htmlContent);
}

function parseNaverHtml(htmlContent) {
  // Find window.__NUXT__=(function...)(...)
  const match = htmlContent.match(/window\.__NUXT__\s*=\s*([\s\S]*?)(?:<\/script>|$)/);
  if (!match) {
    console.warn("Could not find window.__NUXT__ in HTML.");
    return null;
  }
  
  let scriptText = match[1].trim();
  if (scriptText.endsWith(';')) {
    scriptText = scriptText.slice(0, -1);
  }
  
  let nuxtData;
  try {
    const fn = new Function('window', `window.__NUXT__ = ${scriptText};`);
    const mockWindow = {};
    fn(mockWindow);
    nuxtData = mockWindow.__NUXT__;
  } catch (e) {
    console.error("Failed to parse __NUXT__ JS:", e);
    return null;
  }
  
  if (!nuxtData || !nuxtData.state || !nuxtData.state.search) {
    console.warn("Invalid __NUXT__ structure.");
    return null;
  }
  
  const searchResult = nuxtData.state.search;
  const searchList = searchResult.searchResultList || [];
  
  const jakoResults = searchList.filter(r => r.dicType === 'jako');
  if (jakoResults.length === 0 || !jakoResults[0].items || jakoResults[0].items.length === 0) {
    return null;
  }
  
  const firstItem = jakoResults[0].items[0];
  
  const rawWord = firstItem.expKanji || firstItem.entryName || '';
  const cleanWord = stripHtmlTags(unescapeHtml(rawWord));
  const hiraganaRaw = firstItem.entryName || '';
  const hiragana = stripHtmlTags(unescapeHtml(hiraganaRaw));
  
  const meanings = [];
  const allExamples = [];
  
  const meanList = firstItem.meanList || [];
  for (let meanObj of meanList) {
    const meanText = meanObj.mean || '';
    const cleanMean = stripHtmlTags(unescapeHtml(meanText));
    if (cleanMean) {
      meanings.push(cleanMean);
    }
    
    if (meanObj.exampleOri) {
      let exJpRaw = meanObj.exampleOri;
      let exJp = preserveRubyTags(exJpRaw);
      
      let exKoRaw = meanObj.exampleTrans || '';
      let exKo = stripHtmlTags(unescapeHtml(exKoRaw)).trim();
      
      if (exJp && exKo) {
        // Prevent duplicate examples
        const isDuplicate = allExamples.some(e => stripHtmlTags(e.japanese).trim() === stripHtmlTags(exJp).trim());
        if (!isDuplicate) {
          allExamples.push({
            japanese: exJp.trim(),
            korean: exKo
          });
        }
      }
    }
  }
  
  // Sort examples by clean text length (easier/shorter first)
  allExamples.sort((a, b) => {
    const cleanA = stripHtmlTags(a.japanese);
    const cleanB = stripHtmlTags(b.japanese);
    return cleanA.length - cleanB.length;
  });
  
  const examples = allExamples.slice(0, 3);
  const mainMeaning = meanings.slice(0, 3).join("\n");
  
  return {
    word: cleanWord.trim(),
    hiragana: hiragana.trim(),
    meaning: mainMeaning.trim(),
    examples: examples
  };
}

async function fetchNaverAutocomplete(query) {
  const encodedQ = encodeURIComponent(query);
  const targetUrl = `https://ac-dict.naver.com/jako/ac?q=${encodedQ}&q_enc=utf-8&st=11&r_format=json&r_enc=utf-8&r_lt=11`;
  
  const isAndroidApk = window.location.protocol === 'file:' && /Android|iPhone|iPad|iPod|cordova|capacitor/i.test(navigator.userAgent);
  const proxyUrl = isAndroidApk ? targetUrl : `https://fragrant-shape-83a4.gimong9283.workers.dev/?url=${encodeURIComponent(targetUrl)}`;
  
  const response = await fetch(proxyUrl);
  if (!response.ok) {
    throw new Error('Autocomplete failed');
  }
  const resData = await response.json();
  
  const items = resData.items || [];
  const suggestions = [];
  
  for (let group of items) {
    for (let item of group) {
      try {
        const hiraList = item[0];
        const kanjiList = item[1];
        const meanList = item[3];
        
        let hiragana = hiraList && hiraList.length > 0 ? hiraList[0] : '';
        let kanji = kanjiList && kanjiList.length > 0 ? kanjiList[0] : '';
        let meaning = meanList && meanList.length > 0 ? meanList[0] : '';
        
        hiragana = stripHtmlTags(unescapeHtml(hiragana));
        kanji = stripHtmlTags(unescapeHtml(kanji));
        meaning = stripHtmlTags(unescapeHtml(meaning));
        
        const word = kanji ? kanji : hiragana;
        if (word) {
          suggestions.push({
            word: word.trim(),
            hiragana: hiragana.trim(),
            meaning: meaning.trim()
          });
        }
      } catch (err) {
        continue;
      }
    }
  }
  
  // Deduplicate
  const seen = new Set();
  const uniqueSuggestions = [];
  for (let s of suggestions) {
    const key = `${s.word}_${s.meaning}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueSuggestions.push(s);
    }
  }
  
  return uniqueSuggestions.slice(0, 10);
}

function stripHtmlTags(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '');
}

function preserveRubyTags(rawHtml) {
  if (!rawHtml) return '';
  let unescaped = unescapeHtml(rawHtml);
  unescaped = unescaped.replace(/<\/?strong[^>]*>/gi, '');
  
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${unescaped}</div>`, 'text/html');
  const div = doc.body.firstChild;
  
  function clean(node) {
    const childNodes = Array.from(node.childNodes);
    for (let child of childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tagName = child.tagName.toLowerCase();
        if (tagName === 'ruby' || tagName === 'rb' || tagName === 'rt') {
          clean(child);
        } else {
          const textNode = doc.createTextNode(child.textContent);
          node.replaceChild(textNode, child);
        }
      }
    }
  }
  clean(div);
  return div.innerHTML;
}

function unescapeHtml(str) {
  if (!str) return '';
  const doc = new DOMParser().parseFromString(str, 'text/html');
  return doc.documentElement.textContent;
}

/* ========================================================
   GLOBAL HELPERS & RENDER UTILS
   ======================================================== */
const JLPT_N5_WORDS = [
  {
    "word": "行く",
    "hiragana": "いく",
    "meaning": "가다",
    "examples": [
      {
        "japanese": "<ruby>図書館<rt>としょかん</rt></ruby>に<ruby>行<rt>い</rt></ruby>く。",
        "korean": "도서관에 가다."
      }
    ]
  },
  {
    "word": "来る",
    "hiragana": "くる",
    "meaning": "오다",
    "examples": [
      {
        "japanese": "<ruby>友達<rt>ともだち</rt></ruby>が<ruby>家<rt>いえ</rt></ruby>に<ruby>来<rt>く</rt></ruby>る。",
        "korean": "친구들이 집에 오다."
      }
    ]
  },
  {
    "word": "食べる",
    "hiragana": "たべる",
    "meaning": "먹다",
    "examples": [
      {
        "japanese": "りんごを<ruby>食<rt>た</rt></ruby>べる。",
        "korean": "사과를 먹다."
      }
    ]
  },
  {
    "word": "飲む",
    "hiragana": "のむ",
    "meaning": "마시다",
    "examples": [
      {
        "japanese": "お<ruby>水<rt>みず</rt></ruby>を<ruby>飲<rt>の</rt></ruby>む。",
        "korean": "물을 마시다."
      }
    ]
  },
  {
    "word": "見る",
    "hiragana": "みる",
    "meaning": "보다",
    "examples": [
      {
        "japanese": "<ruby>映画<rt>えいが</rt></ruby>を<ruby>見<rt>み</rt></ruby>る。",
        "korean": "영화를 보다."
      }
    ]
  },
  {
    "word": "聞く",
    "hiragana": "きく",
    "meaning": "듣다/묻다",
    "examples": [
      {
        "japanese": "<ruby>音楽<rt>おんがく</rt></ruby>を<ruby>聞<rt>き</rt></ruby>く。",
        "korean": "음악을 듣다."
      }
    ]
  },
  {
    "word": "話す",
    "hiragana": "はなす",
    "meaning": "말하다",
    "examples": [
      {
        "japanese": "<ruby>日本語<rt>にほんご</rt></ruby>で<ruby>話<rt>はな</rt></ruby>す。",
        "korean": "일본어로 말하다."
      }
    ]
  },
  {
    "word": "読む",
    "hiragana": "よむ",
    "meaning": "읽다",
    "examples": [
      {
        "japanese": "<ruby>本<rt>ほん</rt></ruby>を<ruby>読<rt>よ</rt></ruby>む。",
        "korean": "책을 읽다."
      }
    ]
  },
  {
    "word": "書く",
    "hiragana": "かく",
    "meaning": "쓰다",
    "examples": [
      {
        "japanese": "편지를 쓰다.",
        "korean": "편지를 쓰다."
      }
    ]
  },
  {
    "word": "買う",
    "hiragana": "かう",
    "meaning": "사다",
    "examples": [
      {
        "japanese": "옷을 사다.",
        "korean": "옷을 사다."
      }
    ]
  },
  {
    "word": "会う",
    "hiragana": "あう",
    "meaning": "만나다",
    "examples": [
      {
        "japanese": "<ruby>友達<rt>ともだち</rt></ruby>に<ruby>会<rt>あ</rt></ruby>う。",
        "korean": "친구를 만나다."
      }
    ]
  },
  {
    "word": "勉強する",
    "hiragana": "べんきょうする",
    "meaning": "공부하다",
    "examples": [
      {
        "japanese": "<ruby>日本語<rt>にほんご</rt></ruby>를<ruby>勉強<rt>べんきょう</rt></ruby>する。",
        "korean": "일본어를 공부하다."
      }
    ]
  },
  {
    "word": "大きい",
    "hiragana": "おおきい",
    "meaning": "크다",
    "examples": [
      {
        "japanese": "큰 집.",
        "korean": "큰 집."
      }
    ]
  },
  {
    "word": "小さい",
    "hiragana": "치이사이",
    "meaning": "작다",
    "examples": [
      {
        "japanese": "작은 고양이.",
        "korean": "작은 고양이."
      }
    ]
  },
  {
    "word": "新しい",
    "hiragana": "あたらしい",
    "meaning": "새롭다",
    "examples": [
      {
        "japanese": "새 휴대폰.",
        "korean": "새 휴대폰."
      }
    ]
  },
  {
    "word": "古い",
    "hiragana": "ふるい",
    "meaning": "오래되다/낡다",
    "examples": [
      {
        "japanese": "오래된 책.",
        "korean": "오래된 책."
      }
    ]
  },
  {
    "word": "좋은",
    "hiragana": "좋다",
    "meaning": "좋다",
    "examples": [
      {
        "japanese": "날씨가 좋다.",
        "korean": "날씨가 좋다."
      }
    ]
  },
  {
    "word": "悪い",
    "hiragana": "わるい",
    "meaning": "나쁘다",
    "examples": [
      {
        "japanese": "<ruby>気分<rt>きぶん</rt></ruby>가<ruby>悪<rt>わる</rt></ruby>い。",
        "korean": "기분이 나쁘다."
      }
    ]
  },
  {
    "word": "高い",
    "hiragana": "타카이",
    "meaning": "높다/비싸다",
    "examples": [
      {
        "japanese": "가격이 비싸다.",
        "korean": "가격이 비싸다."
      }
    ]
  },
  {
    "word": "安い",
    "hiragana": "やすい",
    "meaning": "싸다",
    "examples": [
      {
        "japanese": "<ruby>値段<rt>ねだん</rt></ruby>が<ruby>安<rt>やす</rt></ruby>い。",
        "korean": "가격이 싸다."
      }
    ]
  },
  {
    "word": "暑い",
    "hiragana": "아츠이",
    "meaning": "덥다",
    "examples": [
      {
        "japanese": "오늘은 꽤 덥다.",
        "korean": "오늘은 꽤 덥다."
      }
    ]
  },
  {
    "word": "寒い",
    "hiragana": "さむい",
    "meaning": "춥다",
    "examples": [
      {
        "japanese": "<ruby>外<rt>そと</rt></ruby>はとても<ruby>寒<rt>さむ</rt></ruby>い。",
        "korean": "밖은 매우 춥다."
      }
    ]
  },
  {
    "word": "難しい",
    "hiragana": "무즈카시이",
    "meaning": "어렵다",
    "examples": [
      {
        "japanese": "시험은 어렵다.",
        "korean": "시험은 어렵다."
      }
    ]
  },
  {
    "word": "易しい",
    "hiragana": "やさしい",
    "meaning": "쉽다",
    "examples": [
      {
        "japanese": "<ruby>問題<rt>もんだい</rt></ruby>は<ruby>易<rt>やさ</rt></ruby>しい。",
        "korean": "문제는 쉽다."
      }
    ]
  },
  {
    "word": "友達",
    "hiragana": "ともだち",
    "meaning": "친구",
    "examples": [
      {
        "japanese": "<ruby>私<rt>わたし</rt></ruby>たちは<ruby>友達<rt>ともだち</rt></ruby>다。",
        "korean": "우리는 친구다."
      }
    ]
  },
  {
    "word": "先生",
    "hiragana": "せんせい",
    "meaning": "선생님",
    "examples": [
      {
        "japanese": "<ruby>日本語<rt>にほんご</rt></ruby>の<ruby>先生<rt>せんせい</rt></ruby>。",
        "korean": "일본어 선생님."
      }
    ]
  },
  {
    "word": "学生",
    "hiragana": "がくせい",
    "meaning": "학생",
    "examples": [
      {
        "japanese": "<ruby>私<rt>わたし</rt></ruby>は<ruby>学生<rt>がくせい</rt></ruby>です。",
        "korean": "저 학생입니다."
      }
    ]
  },
  {
    "word": "学校",
    "hiragana": "がっこう",
    "meaning": "학교",
    "examples": [
      {
        "japanese": "<ruby>学校<rt>がっこう</rt></ruby>に<ruby>行<rt>い</rt></ruby>く。",
        "korean": "학교에 가다."
      }
    ]
  },
  {
    "word": "日本",
    "hiragana": "にほん",
    "meaning": "일본",
    "examples": [
      {
        "japanese": "<ruby>日本<rt>にほん</rt></ruby>に<ruby>行<rt>い</rt></ruby>きたい。",
        "korean": "일본에 가고 싶다."
      }
    ]
  },
  {
    "word": "韓国",
    "hiragana": "かんこく",
    "meaning": "한국",
    "examples": [
      {
        "japanese": "<ruby>韓国<rt>かんこく</rt></ruby>のソウル。",
        "korean": "한국의 서울."
      }
    ]
  },
  {
    "word": "家",
    "hiragana": "いえ",
    "meaning": "집",
    "examples": [
      {
        "japanese": "<ruby>家<rt>いえ</rt></ruby>に<ruby>帰<rt>かえ</rt></ruby>る。",
        "korean": "집에 돌아가다."
      }
    ]
  },
  {
    "word": "部屋",
    "hiragana": "へや",
    "meaning": "방",
    "examples": [
      {
        "japanese": "<ruby>部屋<rt>へや</rt></ruby>が<ruby>広<rt>ひろ</rt></ruby>い。",
        "korean": "방이 넓다."
      }
    ]
  },
  {
    "word": "時計",
    "hiragana": "とけい",
    "meaning": "시계",
    "examples": [
      {
        "japanese": "<ruby>壁<rt>かべ</rt></ruby>の<ruby>時計<rt>とけい</rt></ruby>。",
        "korean": "벽시계."
      }
    ]
  },
  {
    "word": "電話",
    "hiragana": "でんわ",
    "meaning": "전화",
    "examples": [
      {
        "japanese": "<ruby>電話<rt>でんわ</rt></ruby>をかける。",
        "korean": "전화를 걸다."
      }
    ]
  },
  {
    "word": "傘",
    "hiragana": "かさ",
    "meaning": "우산",
    "examples": [
      {
        "japanese": "<ruby>傘<rt>かさ</rt></ruby>をさす。",
        "korean": "우산을 쓰다."
      }
    ]
  },
  {
    "word": "車",
    "hiragana": "くるま",
    "meaning": "자동차",
    "examples": [
      {
        "japanese": "<ruby>新<rt>あたら</rt></ruby>しい<ruby>車<rt>くるま</rt></ruby>。",
        "korean": "새 차."
      }
    ]
  },
  {
    "word": "自転車",
    "hiragana": "じてんしゃ",
    "meaning": "자전거",
    "examples": [
      {
        "japanese": "<ruby>自転車<rt>じてんしゃ</rt></ruby>に<ruby>乗<rt>の</rt></ruby>る。",
        "korean": "자전거를 타다."
      }
    ]
  },
  {
    "word": "電車",
    "hiragana": "でんしゃ",
    "meaning": "전철",
    "examples": [
      {
        "japanese": "<ruby>電車<rt>でんしゃ</rt></ruby>に<ruby>乗<rt>の</rt></ruby>る。",
        "korean": "전철을 타다."
      }
    ]
  },
  {
    "word": "水",
    "hiragana": "みず",
    "meaning": "물",
    "examples": [
      {
        "japanese": "<ruby>水<rt>みず</rt></ruby>を<ruby>飲<rt>の</rt></ruby>む。",
        "korean": "물을 마시다."
      }
    ]
  },
  {
    "word": "お茶",
    "hiragana": "おちゃ",
    "meaning": "차",
    "examples": [
      {
        "japanese": "<ruby>温<rt>あたた</rt></ruby>かいお<ruby>茶<rt>ちゃ</rt></ruby>。",
        "korean": "따뜻한 차."
      }
    ]
  },
  {
    "word": "朝",
    "hiragana": "あさ",
    "meaning": "아침",
    "examples": [
      {
        "japanese": "<ruby>朝<rt>あさ</rt></ruby><ruby>起<rt>お</rt></ruby>きる。",
        "korean": "아침에 일어나다."
      }
    ]
  },
  {
    "word": "昼",
    "hiragana": "ひる",
    "meaning": "낮",
    "examples": [
      {
        "japanese": "<ruby>昼<rt>ひる</rt></ruby>ご<ruby>飯<rt>はん</rt></ruby>を<ruby>食<rt>た</rt></ruby>べる。",
        "korean": "점심을 먹다."
      }
    ]
  },
  {
    "word": "夜",
    "hiragana": "よる",
    "meaning": "밤",
    "examples": [
      {
        "japanese": "<ruby>夜<rt>よる</rt></ruby><ruby>遅<rt>おそ</rt></ruby>く<ruby>寝<rt>ね</rt></ruby>る。",
        "korean": "밤 늦게 자다."
      }
    ]
  },
  {
    "word": "今日",
    "hiragana": "きょう",
    "meaning": "오늘",
    "examples": [
      {
        "japanese": "<ruby>今日<rt>きょう</rt></ruby>は<ruby>何曜日<rt>なんようび</rt></ruby>？",
        "korean": "오늘은 무슨 요일?"
      }
    ]
  },
  {
    "word": "明日",
    "hiragana": "あした",
    "meaning": "내일",
    "examples": [
      {
        "japanese": "<ruby>明日<rt>あした</rt></ruby><ruby>会<rt>あ</rt></ruby>おう。",
        "korean": "내일 만나자."
      }
    ]
  },
  {
    "word": "昨日",
    "hiragana": "きのう",
    "meaning": "어제",
    "examples": [
      {
        "japanese": "<ruby>昨日<rt>きのう</rt></ruby>あったこと。",
        "korean": "어제 있었던 일."
      }
    ]
  },
  {
    "word": "楽しい",
    "hiragana": "たのしい",
    "meaning": "즐겁다",
    "examples": [
      {
        "japanese": "<ruby>旅行<rt>りょこう</rt></ruby>は<ruby>楽<rt>たの</rt></ruby>しい。",
        "korean": "여행은 즐겁다."
      }
    ]
  },
  {
    "word": "面白い",
    "hiragana": "おもしろい",
    "meaning": "재미있다",
    "examples": [
      {
        "japanese": "<ruby>映画<rt>えいが</rt></ruby>が<ruby>面白<rt>おもしろ</rt></ruby>い。",
        "korean": "영화가 재미있다."
      }
    ]
  },
  {
    "word": "好き",
    "hiragana": "すき",
    "meaning": "좋아하다/좋아함",
    "examples": [
      {
        "japanese": "<ruby>日本料理<rt>にほんりょうり</rt></ruby>が<ruby>好<rt>す</rt></ruby>きだ。",
        "korean": "일본 요리를 좋아한다."
      }
    ]
  },
  {
    "word": "嫌い",
    "hiragana": "きらい",
    "meaning": "싫어하다/싫어함",
    "examples": [
      {
        "japanese": "<ruby>辛<rt>から</rt></ruby>이 <ruby>物<rt>もの</rt></ruby>가 <ruby>嫌<rt>きら</rt></ruby>이다.",
        "korean": "매운 음식을 싫어한다."
      }
    ]
  }
];

function loadTodayRecommendation() {
  const activeArea = document.getElementById('recommend-card-active');
  const emptyArea = document.getElementById('recommend-card-empty');
  const wordEl = document.getElementById('recommend-word');
  const meaningEl = document.getElementById('recommend-meaning');
  const exArea = document.getElementById('recommend-example-area');
  const exJpEl = document.getElementById('recommend-ex-jp');
  const exKoEl = document.getElementById('recommend-ex-ko');
  
  dbGetWords(false)
    .then(savedWords => {
      const savedSet = new Set(savedWords.map(w => w.word));
      const available = JLPT_N5_WORDS.filter(w => !savedSet.has(w.word));
      
      if (available.length === 0) {
        activeArea.classList.add('hidden');
        emptyArea.classList.remove('hidden');
        currentRecommendationWord = null;
        return;
      }
      
      activeArea.classList.remove('hidden');
      emptyArea.classList.add('hidden');
      
      const randIdx = Math.floor(Math.random() * available.length);
      const selectedWord = available[randIdx];
      currentRecommendationWord = selectedWord;
      
      wordEl.innerHTML = buildRubyTag(selectedWord.word, selectedWord.hiragana);
      meaningEl.innerHTML = renderMeaningsHTML(selectedWord.meaning);
      
      if (selectedWord.examples && selectedWord.examples.length > 0) {
        const firstEx = selectedWord.examples[0];
        exJpEl.innerHTML = firstEx.japanese;
        exKoEl.innerText = firstEx.korean;
        exArea.classList.remove('hidden');
      } else {
        exArea.classList.add('hidden');
      }
    })
    .catch(err => {
      console.error("Failed to load today recommendation:", err);
    });
}

function loadTodayDueWord() {
  const activeArea = document.getElementById('due-card-active');
  const emptyArea = document.getElementById('due-card-empty');
  const wordEl = document.getElementById('due-word');
  const meaningEl = document.getElementById('due-meaning');
  const exArea = document.getElementById('due-example-area');
  const exJpEl = document.getElementById('due-ex-jp');
  const exKoEl = document.getElementById('due-ex-ko');
  
  dbGetWords(true) // Get due words only
    .then(words => {
      currentDueWords = words;
      
      if (words.length === 0) {
        activeArea.classList.add('hidden');
        emptyArea.classList.remove('hidden');
        return;
      }
      
      activeArea.classList.remove('hidden');
      emptyArea.classList.add('hidden');
      
      if (currentDueWordIndex >= words.length) {
        currentDueWordIndex = 0;
      }
      
      const selectedWord = words[currentDueWordIndex];
      
      // Build ruby tag
      const rubyHTML = buildRubyTag(selectedWord.word, selectedWord.hiragana);
      wordEl.innerHTML = rubyHTML;
      meaningEl.innerHTML = renderMeaningsHTML(selectedWord.meaning);
      
      if (selectedWord.examples && selectedWord.examples.length > 0) {
        const firstEx = selectedWord.examples[0];
        exJpEl.innerHTML = firstEx.japanese;
        exKoEl.innerText = firstEx.korean;
        exArea.classList.remove('hidden');
      } else {
        exArea.classList.add('hidden');
      }
    })
    .catch(err => {
      console.error("Failed to load today due word:", err);
    });
}
function showToast(message, isSuccess = true) {
  const toast = document.getElementById('toast');
  toast.innerText = message;
  toast.style.backgroundColor = isSuccess ? 'rgba(99, 102, 241, 0.95)' : 'rgba(244, 63, 94, 0.95)';
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 2500);
}

function updateHeaderBadge() {
  dbGetStats()
    .then(data => {
      const headerBadge = document.getElementById('header-due-badge');
      const navDueIndicator = document.getElementById('nav-due-indicator');
      const dueCount = data.due_count;
      
      headerBadge.innerText = `오늘 복습 ${dueCount}`;
      if (dueCount > 0) {
        headerBadge.classList.add('highlight');
        navDueIndicator.classList.remove('hidden');
      } else {
        headerBadge.classList.remove('highlight');
        navDueIndicator.classList.add('hidden');
      }
    })
    .catch(err => console.error("Error updating badges:", err));
}

function speakJapanese(text) {
  if (!('speechSynthesis' in window)) {
    showToast("음성 합성(TTS)이 지원되지 않는 브라우저입니다.", false);
    return;
  }
  window.speechSynthesis.cancel();
  const cleanText = text.replace(/<rt>[\s\S]*?<\/rt>/gi, '').replace(/<[^>]*>/g, '').trim();
  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.lang = 'ja-JP';
  
  const voices = window.speechSynthesis.getVoices();
  const jpVoice = voices.find(v => v.lang === 'ja-JP' || v.lang.startsWith('ja'));
  if (jpVoice) {
    utterance.voice = jpVoice;
  }
  window.speechSynthesis.speak(utterance);
}

function buildRubyTag(word, hiragana) {
  if (!word || !hiragana || word === hiragana) return word;
  
  let i = word.length - 1;
  let j = hiragana.length - 1;
  while (i >= 0 && j >= 0 && word[i] === hiragana[j] && !isKanji(word[i])) {
    i--;
    j--;
  }
  
  const kanjiPart = word.substring(0, i + 1);
  const hiraPart = hiragana.substring(0, j + 1);
  const suffixPart = word.substring(i + 1);
  
  if (kanjiPart && hiraPart) {
    return `<ruby>${kanjiPart}<rt>${hiraPart}</rt></ruby>${suffixPart}`;
  }
  return `<ruby>${word}<rt>${hiragana}</rt></ruby>`;
}

function isKanji(char) {
  const code = char.charCodeAt(0);
  return (code >= 0x4e00 && code <= 0x9faf);
}

function renderMeaningsHTML(meaningStr) {
  if (!meaningStr) return '';
  
  let parts = [];
  if (meaningStr.includes('\n')) {
    parts = meaningStr.split('\n').map(p => p.trim()).filter(Boolean);
  } else {
    parts = meaningStr.split(',').map(p => p.trim()).filter(Boolean);
  }
  
  if (parts.length === 0) return '';
  
  const mainMeaning = parts[0];
  const otherMeanings = parts.slice(1, 4); // Max 3 additional meanings
  
  let html = `<div class="meaning-container">`;
  html += `<div class="main-meaning">${mainMeaning}</div>`;
  
  if (otherMeanings.length > 0) {
    html += `<div class="additional-meanings">`;
    otherMeanings.forEach((m, idx) => {
      html += `<span class="meaning-badge">${idx + 2}. ${m}</span>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  
  return html;
}

/* ========================================================
   SCREEN 1: WORD INPUT & AUTOMATIC SEARCH
   ======================================================== */
function setupSearchEvents() {
  const btnSearch = document.getElementById('btn-search');
  const searchInput = document.getElementById('search-input');
  const btnSaveWord = document.getElementById('btn-save-word');
  
  const handleSearch = () => {
    // 최종 변환을 적용하여 단어 끝의 'n'을 'ん'으로 완료 처리합니다.
    const converted = convertRomajiToHiragana(searchInput.value, true);
    searchInput.value = converted;
    
    const word = converted.trim();
    if (!word) {
      showToast('검색할 일본어 단어를 입력하세요.', false);
      return;
    }
    
    // 검색 시작 시 추천 카드 영역 숨기기
    document.getElementById('input-cards-grid').classList.add('hidden');
    document.getElementById('search-result-area').classList.add('hidden');
    document.getElementById('search-loading').classList.remove('hidden');
    
    fetchNaverDictionaryData(word)
      .then(data => {
        if (!data) throw new Error('Search failed');
        currentSearchData = data;
        renderSearchResult(data);
      })
      .catch(err => {
        showToast('단어 정보를 사전에서 찾지 못했습니다. 직접 입력해주세요.', false);
        // 검색어에 일본어(히라가나/가타카나)가 포함되어 있으면 발음 필드에 기본값으로 설정
        const queryIsJapanese = /[\u3040-\u309F\u30A0-\u30FF]/.test(word);
        renderSearchResult({
          word: word,
          hiragana: queryIsJapanese ? word : '',
          meaning: '',
          examples: []
        });
      })
      .finally(() => {
        document.getElementById('search-loading').classList.add('hidden');
      });
  };

  let debounceTimeout = null;
  let highlightedIndex = -1;
  const dropdown = document.getElementById('suggestions-dropdown');

  const hideDropdown = () => {
    dropdown.classList.add('hidden');
    dropdown.innerHTML = '';
    highlightedIndex = -1;
  };

  btnSearch.addEventListener('click', () => {
    hideDropdown();
    handleSearch();
  });

  searchInput.addEventListener('input', () => {
    const originalValue = searchInput.value;
    const convertedValue = convertRomajiToHiragana(originalValue, false);
    if (originalValue !== convertedValue) {
      searchInput.value = convertedValue;
    }
    
    // 자동완성 API를 호출할 때는 현재 입력값에 대한 최종 변환('n' -> 'ん')을 적용하여 쿼리합니다.
    const query = convertRomajiToHiragana(searchInput.value, true).trim();
    clearTimeout(debounceTimeout);
    
    if (!query) {
      hideDropdown();
      // 검색창이 비면 다시 추천 카드 보이기
      document.getElementById('input-cards-grid').classList.remove('hidden');
      return;
    }
    
    debounceTimeout = setTimeout(() => {
      fetchNaverAutocomplete(query)
        .then(data => {
          if (data.length === 0) {
            hideDropdown();
            return;
          }
          
          dropdown.innerHTML = '';
          dropdown.classList.remove('hidden');
          highlightedIndex = -1;
          
          data.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'suggestion-item';
            row.innerHTML = `
              <div class="suggestion-header">
                <span class="suggestion-word">${item.word}</span>
                <span class="suggestion-hiragana">${item.hiragana}</span>
              </div>
              <div class="suggestion-meaning">${item.meaning}</div>
            `;
            
            row.addEventListener('click', () => {
              searchInput.value = item.word;
              hideDropdown();
              handleSearch();
            });
            
            dropdown.appendChild(row);
          });
        })
        .catch(err => {
          console.error("Error fetching autocomplete suggestions:", err);
        });
    }, 200);
  });
  
  searchInput.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.suggestion-item');
    if (dropdown.classList.contains('hidden') || items.length === 0) {
      if (e.key === 'Enter') {
        handleSearch();
      }
      return;
    }
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightedIndex = (highlightedIndex + 1) % items.length;
      updateHighlight(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightedIndex = (highlightedIndex - 1 + items.length) % items.length;
      updateHighlight(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < items.length) {
        items[highlightedIndex].click();
      } else {
        hideDropdown();
        handleSearch();
      }
    } else if (e.key === 'Escape') {
      hideDropdown();
    }
  });

  const updateHighlight = (items) => {
    items.forEach((item, index) => {
      if (index === highlightedIndex) {
        item.classList.add('highlighted');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('highlighted');
      }
    });
  };
  
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-input-wrapper')) {
      hideDropdown();
    }
  });
  
  // Save Word Action
  btnSaveWord.addEventListener('click', () => {
    const word = document.getElementById('edit-word').value.trim();
    const hiragana = document.getElementById('edit-hiragana').value.trim();
    const mainMeaning = document.getElementById('edit-meaning').value.trim();
    const additionalMeaning = document.getElementById('edit-meaning-additional') 
      ? document.getElementById('edit-meaning-additional').value.trim() 
      : '';
    
    if (!word || !hiragana || !mainMeaning) {
      showToast('단어, 발음, 메인 뜻은 필수 항목입니다.', false);
      return;
    }
    
    let meaning = mainMeaning;
    if (additionalMeaning) {
      const addParts = additionalMeaning.split(',').map(p => p.trim()).filter(Boolean);
      if (addParts.length > 0) {
        meaning = [mainMeaning, ...addParts].join('\n');
      }
    }
    
    const examples = [];
    const exRows = document.querySelectorAll('.example-edit-row');
    exRows.forEach((row, index) => {
      const jp = row.querySelector('.edit-ex-jp').value.trim();
      const ko = row.querySelector('.edit-ex-ko').value.trim();
      if (jp && ko) {
        let jpSaved = jp;
        if (currentSearchData && currentSearchData.examples && currentSearchData.examples[index]) {
          const origJp = currentSearchData.examples[index].japanese;
          if (stripHtmlTags(origJp).trim() === jp) {
            jpSaved = origJp; // Keep the ruby-tagged original Japanese if the user did not edit it
          }
        }
        examples.push({ japanese: jpSaved, korean: ko });
      }
    });
    
    const wordPayload = { word, hiragana, meaning, examples };
    
    dbAddWord(wordPayload)
      .then(data => {
        showToast('단어가 단어장에 성공적으로 추가되었습니다!', true);
        searchInput.value = '';
        document.getElementById('search-result-area').classList.add('hidden');
        currentSearchData = null;
        updateHeaderBadge();
        
        // 추천 카드 리프레시 및 강제 표시
        loadTodayRecommendation();
        loadTodayDueWord();
        document.getElementById('input-cards-grid').classList.remove('hidden');
      })
      .catch(err => {
        showToast('단어 저장에 실패했습니다. 다시 시도해주세요.', false);
        console.error(err);
      });
  });
}

function renderSearchResult(data) {
  const resultArea = document.getElementById('search-result-area');
  resultArea.classList.remove('hidden');
  
  document.getElementById('edit-word').value = data.word || '';
  document.getElementById('edit-hiragana').value = data.hiragana || '';
  
  const meaningStr = data.meaning || '';
  let mainMeaning = meaningStr;
  let additionalMeaning = '';
  
  if (meaningStr.includes('\n')) {
    const parts = meaningStr.split('\n').map(p => p.trim()).filter(Boolean);
    mainMeaning = parts[0] || '';
    additionalMeaning = parts.slice(1).join(', ');
  } else if (meaningStr.includes(',')) {
    const parts = meaningStr.split(',').map(p => p.trim()).filter(Boolean);
    mainMeaning = parts[0] || '';
    additionalMeaning = parts.slice(1).join(', ');
  }
  
  document.getElementById('edit-meaning').value = mainMeaning;
  const additionalInput = document.getElementById('edit-meaning-additional');
  if (additionalInput) {
    additionalInput.value = additionalMeaning;
  }
  
  const examplesContainer = document.getElementById('examples-edit-list');
  examplesContainer.innerHTML = '';
  
  for (let i = 0; i < 3; i++) {
    const ex = data.examples[i] || { japanese: '', korean: '' };
    
    const exRow = document.createElement('div');
    exRow.className = 'example-edit-row';
    const cleanJp = stripHtmlTags(ex.japanese);
    exRow.innerHTML = `
      <input type="text" class="edit-ex-jp" placeholder="예문 ${i+1} (일본어)" value="${cleanJp}">
      <input type="text" class="edit-ex-ko" placeholder="예문 ${i+1} 번역 (한국어)" value="${ex.korean}">
    `;
    examplesContainer.appendChild(exRow);
  }
}

/* ========================================================
   SCREEN 2: STUDY SESSION (FLASHCARDS & SM-2)
   ======================================================== */
function setupStudyEvents() {
  const card = document.getElementById('flashcard');
  const studyActions = document.getElementById('study-actions');
  
  card.addEventListener('click', () => {
    card.classList.toggle('flipped');
    
    if (card.classList.contains('flipped')) {
      studyActions.classList.remove('invisible');
    }
  });
  
  // Study feedback score buttons
  document.getElementById('btn-forgot').addEventListener('click', () => submitReview(1)); // Again
  document.getElementById('btn-good').addEventListener('click', () => submitReview(4));   // Good
  document.getElementById('btn-easy').addEventListener('click', () => submitReview(5));   // Easy
  
  // Study screen mode change events
  const btnModeNormal = document.getElementById('btn-mode-normal');
  const btnModeTest = document.getElementById('btn-mode-test');
  const studyTitle = document.getElementById('study-screen-title');
  const studyDesc = document.getElementById('study-screen-desc');
  
  btnModeNormal.addEventListener('click', () => {
    btnModeNormal.classList.add('active');
    btnModeTest.classList.remove('active');
    currentStudyMode = 'normal';
    studyTitle.innerText = '오늘의 학습 카드';
    studyDesc.innerText = '망각곡선 복습 주기가 도래한 단어들을 외웁니다.';
    loadStudySession();
  });
  
  btnModeTest.addEventListener('click', () => {
    btnModeTest.classList.add('active');
    btnModeNormal.classList.remove('active');
    currentStudyMode = 'test';
    studyTitle.innerText = '전체 랜덤 테스트';
    studyDesc.innerText = '등록한 전체 단어 중 10개를 무작위로 추출하여 실력을 테스트합니다.';
    loadStudySession();
  });

  // Furigana toggle
  const furiganaToggle = document.getElementById('furigana-toggle');
  furiganaToggle.addEventListener('change', () => {
    if (furiganaToggle.checked) {
      document.body.classList.remove('hide-furigana');
    } else {
      document.body.classList.add('hide-furigana');
    }
  });

  // TTS Triggers
  document.getElementById('btn-tts-front').addEventListener('click', (e) => {
    e.stopPropagation();
    const txt = document.getElementById('card-front-word').innerHTML;
    speakJapanese(txt);
  });
  document.getElementById('btn-tts-back').addEventListener('click', (e) => {
    e.stopPropagation();
    const txt = document.getElementById('card-back-word').innerHTML;
    speakJapanese(txt);
  });

  document.querySelectorAll('.btn-go-input').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelector('[data-target="screen-input"]').click();
    });
  });
}

function loadStudySession() {
  document.getElementById('study-active-container').classList.add('hidden');
  document.getElementById('study-empty-state').classList.add('hidden');
  
  const dueOnly = currentStudyMode === 'normal';
  
  dbGetWords(dueOnly)
    .then(data => {
      if (currentStudyMode === 'test') {
        // Shuffle and take max 10
        dueWords = data.sort(() => 0.5 - Math.random()).slice(0, 10);
      } else {
        dueWords = data;
      }
      
      currentCardIndex = 0;
      
      studySessionStats.total = dueWords.length;
      studySessionStats.reviewed = 0;
      studySessionStats.correct = 0;
      
      if (dueWords.length === 0) {
        const emptyText = currentStudyMode === 'test' 
          ? '단어장에 등록된 단어가 없습니다. 새로운 단어를 추가해보세요!'
          : '복습 대기 중인 일본어 단어가 없습니다. 새로운 단어를 추가해보세요!';
        document.querySelector('#study-empty-state p').innerText = emptyText;
        document.getElementById('study-empty-state').classList.remove('hidden');
      } else {
        document.getElementById('study-active-container').classList.remove('hidden');
        renderCurrentCard();
      }
    })
    .catch(err => {
      console.error("Error loading study session:", err);
      showToast("데이터를 불러오지 못했습니다.", false);
    });
}

function renderCurrentCard() {
  const card = document.getElementById('flashcard');
  const studyActions = document.getElementById('study-actions');
  
  card.classList.remove('flipped');
  studyActions.classList.add('invisible');
  
  const currentWord = dueWords[currentCardIndex];
  const rubyHTML = buildRubyTag(currentWord.word, currentWord.hiragana);
  
  document.getElementById('card-front-word').innerHTML = rubyHTML;
  document.getElementById('card-back-word').innerHTML = rubyHTML;
  document.getElementById('card-back-hiragana').innerText = currentWord.hiragana;
  document.getElementById('card-back-meaning').innerHTML = renderMeaningsHTML(currentWord.meaning);
  
  const exList = document.getElementById('card-back-examples');
  exList.innerHTML = '';
  
  if (currentWord.examples && currentWord.examples.length > 0) {
    currentWord.examples.forEach((ex, idx) => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="ex-text-area">
          <p class="ex-jp" id="ex-jp-${idx}">${ex.japanese}</p>
          <p class="ex-ko">${ex.korean}</p>
        </div>
        <button class="tts-btn" onclick="event.stopPropagation(); speakJapanese(document.getElementById('ex-jp-${idx}').innerHTML)" title="예문 발음 듣기">
          <i data-lucide="volume-2"></i>
        </button>
      `;
      exList.appendChild(li);
    });
    lucide.createIcons();
  } else {
    exList.innerHTML = '<li class="ex-ko">등록된 예문이 없습니다.</li>';
  }
  
  document.getElementById('study-progress-text').innerText = `진행도: ${currentCardIndex + 1} / ${studySessionStats.total}`;
  const progressPercent = (currentCardIndex / studySessionStats.total) * 100;
  document.getElementById('study-progress-fill').style.width = `${progressPercent}%`;
  
  const accuracy = studySessionStats.reviewed > 0 
    ? Math.round((studySessionStats.correct / studySessionStats.reviewed) * 100) 
    : 100;
  document.getElementById('study-accuracy-text').innerText = `오늘의 성공: ${accuracy}%`;
}

function submitReview(score) {
  const currentWord = dueWords[currentCardIndex];
  
  studySessionStats.reviewed += 1;
  if (score >= 4) {
    studySessionStats.correct += 1;
  }
  
  const isTest = currentStudyMode === 'test';
  
  dbReviewWord(currentWord.id, score, isTest)
    .then(data => {
      if (score === 1) {
        showToast('처음본다 상태로 학습을 다시 시작합니다.', false);
        // 학습 루프: 틀린 단어는 큐의 맨 뒤에 다시 삽입
        dueWords.push(currentWord);
        studySessionStats.total += 1;
      } else {
        if (isTest) {
          showToast('성공! (테스트 모드는 주기가 변경되지 않습니다)', true);
        } else {
          const stateLabel = data.status === 'memorized' ? '완벽해' : '암기중';
          showToast(`성공! [${stateLabel}] 상태 (다음 복습: ${data.interval}일 후)`, true);
        }
      }
      
      currentCardIndex += 1;
      updateHeaderBadge();
      
      if (currentCardIndex < dueWords.length) {
        setTimeout(() => {
          renderCurrentCard();
        }, 300);
      } else {
        setTimeout(() => {
          document.getElementById('study-progress-fill').style.width = `100%`;
          document.getElementById('study-progress-text').innerText = `진행도: 완료`;
          
          const completionMsg = isTest 
            ? '랜덤 테스트를 모두 완료했습니다!' 
            : '오늘의 모든 단어 학습 카드를 마쳤습니다!';
          showToast(completionMsg, true);
          loadStudySession();
        }, 500);
      }
    })
    .catch(err => {
      showToast('학습 상태 동기화 실패', false);
      console.error(err);
    });
}

/* ========================================================
   SCREEN 3: STATISTICS (PROGRESS RINGS & CHARTS)
   ======================================================== */
function loadStatistics() {
  dbGetStats()
    .then(data => {
      document.getElementById('stats-total').innerText = data.total_count;
      document.getElementById('stats-new').innerText = data.new_count;
      document.getElementById('stats-learning').innerText = data.learning_count;
      document.getElementById('stats-memorized').innerText = data.memorized_count;
      document.getElementById('stats-due').innerText = data.due_count;
      document.getElementById('stats-avg-reviews').innerText = data.avg_reviews_to_memorized.toFixed(1) + '회';
      
      document.getElementById('goal-target').innerText = data.daily_target;
      document.getElementById('goal-reviewed').innerText = data.reviewed_today;
      
      const percentage = data.daily_target > 0 
        ? Math.min(100, Math.round((data.reviewed_today / data.daily_target) * 100))
        : 100;
        
      document.getElementById('goal-percentage-text').innerText = `${percentage}%`;
      
      const circle = document.getElementById('goal-progress-circle');
      const offset = 314.16 - (percentage / 100) * 314.16;
      circle.style.strokeDashoffset = offset;
      
      const desc = document.getElementById('goal-status-desc');
      if (percentage === 0) {
        desc.innerText = '오늘의 복습을 시작하지 않았습니다. 복습 탭으로 가보세요!';
      } else if (percentage < 50) {
        desc.innerText = '목표 달성을 향해 달리는 중입니다. 조금만 더 해보세요!';
      } else if (percentage < 100) {
        desc.innerText = '목표가 눈앞에 있습니다! 마무리 복습을 해보세요.';
      } else {
        desc.innerText = '축하합니다! 오늘의 학습 목표를 100% 완료했습니다!';
      }
      
      drawWeeklyChart(data.history);
    })
    .catch(err => console.error("Error loading statistics:", err));
}

function drawWeeklyChart(history) {
  const chartContainer = document.getElementById('bar-chart');
  chartContainer.innerHTML = '';
  
  let maxVal = 5;
  history.forEach(day => {
    const total = day.reviewed + day.new;
    if (total > maxVal) maxVal = total;
  });
  
  history.forEach(day => {
    const total = day.reviewed + day.new;
    
    const reviewedPercent = total > 0 ? (day.reviewed / maxVal) * 100 : 0;
    const newPercent = total > 0 ? (day.new / maxVal) * 100 : 0;
    
    const dateObj = new Date(day.date);
    const dateStr = `${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')}`;
    
    const barGroup = document.createElement('div');
    barGroup.className = 'chart-bar-group';
    barGroup.innerHTML = `
      <span class="bar-label-value">${total > 0 ? total : ''}</span>
      <div class="bar-stack-container">
        <div class="bar-stack-reviewed" style="height: ${reviewedPercent}%"></div>
        <div class="bar-stack-new" style="height: ${newPercent}%"></div>
      </div>
      <span class="bar-label-date">${dateStr}</span>
    `;
    chartContainer.appendChild(barGroup);
  });
}

/* ========================================================
   SCREEN 4: SETTINGS & BACKUPS
   ======================================================== */
function updateThemeButtonUI() {
  const isLight = document.body.classList.contains('light-theme');
  const btn = document.getElementById('btn-toggle-theme');
  if (!btn) return;
  
  if (isLight) {
    btn.innerHTML = '<i data-lucide="moon"></i> &nbsp; 다크 테마 전환';
  } else {
    btn.innerHTML = '<i data-lucide="sun"></i> &nbsp; 라이트 테마 전환';
  }
  lucide.createIcons();
}

function setupSettingsEvents() {
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const btnExport = document.getElementById('btn-export-data');
  const fileInput = document.getElementById('import-file-input');
  const btnClearDb = document.getElementById('btn-clear-db');
  
  const btnToggleTheme = document.getElementById('btn-toggle-theme');
  btnToggleTheme.addEventListener('click', () => {
    const body = document.body;
    if (body.classList.contains('light-theme')) {
      body.classList.remove('light-theme');
      body.classList.add('dark-theme');
      localStorage.setItem('theme', 'dark');
    } else {
      body.classList.remove('dark-theme');
      body.classList.add('light-theme');
      localStorage.setItem('theme', 'light');
    }
    updateThemeButtonUI();
    showToast("화면 테마가 성공적으로 변경되었습니다.", true);
  });

  // Save Settings
  btnSaveSettings.addEventListener('click', () => {
    const targetVal = document.getElementById('settings-daily-target').value;
    if (!targetVal || targetVal < 1) {
      showToast('올바른 학습 목표 개수를 입력해주세요.', false);
      return;
    }
    
    dbSaveSettings({ daily_target: targetVal })
      .then(() => {
        showToast('설정이 성공적으로 저장되었습니다.', true);
        updateHeaderBadge();
      })
      .catch(err => {
        showToast('설정 저장 실패', false);
        console.error(err);
      });
  });
  
  // Export Data JSON Download
  btnExport.addEventListener('click', () => {
    dbExportData()
      .then(data => {
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        const todayStr = new Date().toISOString().split('T')[0];
        a.download = `japanese_vocabulary_backup_${todayStr}.json`;
        document.body.appendChild(a);
        a.click();
        
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('단어장 백업 파일 다운로드가 시작되었습니다.', true);
      })
      .catch(err => {
        showToast('데이터 백업 실패', false);
        console.error(err);
      });
  });
  
  // Import Data File Upload
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const jsonData = JSON.parse(event.target.result);
        
        if (!Array.isArray(jsonData)) {
          showToast('올바른 백업 형식이 아닙니다 (배열 형태 필요).', false);
          fileInput.value = '';
          return;
        }
        
        if (!confirm(`백업에서 ${jsonData.length}개의 단어를 가져오시겠습니까? 기존 단어는 모두 지워집니다.`)) {
          fileInput.value = '';
          return;
        }
        
        dbImportData(jsonData)
          .then(() => {
            showToast(`가져오기 완료! ${jsonData.length}개의 단어가 복원되었습니다.`, true);
            updateHeaderBadge();
          })
          .catch(err => {
            showToast('데이터 복원 실패. 형식을 확인해주세요.', false);
            console.error(err);
          });
        
      } catch (err) {
        showToast('올바르지 않은 JSON 파일입니다.', false);
      } finally {
        fileInput.value = '';
      }
    };
    reader.readAsText(file);
  });
  
  // Clear Database Action
  btnClearDb.addEventListener('click', () => {
    if (!confirm('정말로 모든 단어와 학습 기록을 초기화하시겠습니까? 복구할 수 없습니다.')) {
      return;
    }
    if (!confirm('정말 삭제하시겠습니까? (최종 확인)')) {
      return;
    }
    
    dbClearDatabase()
      .then(() => {
        showToast('단어장 데이터가 완전히 초기화되었습니다.', true);
        updateHeaderBadge();
      })
      .catch(err => {
        showToast('데이터 초기화 실패', false);
        console.error(err);
      });
  });
}

function loadSettings() {
  dbGetSettings()
    .then(data => {
      document.getElementById('settings-daily-target').value = data.daily_target || 10;
    })
    .catch(err => console.error("Error loading settings:", err));
}

/* ========================================================
   ROMAJI TO HIRAGANA TRANSLITERATION ENGINE
   ======================================================== */
const ROMAJI_MAP = {
  'tsu': 'つ', 'chi': 'ち', 'shi': 'し',
  'sha': 'しゃ', 'shu': 'しゅ', 'sho': 'しょ',
  'cha': 'ちゃ', 'chu': 'ちゅ', 'cho': 'ちょ',
  'kya': 'きゃ', 'kyu': 'きゅ', 'kyo': 'きょ',
  'gya': 'ぎゃ', 'gyu': 'ぎゅ', 'gyo': 'ぎょ',
  'sya': 'しゃ', 'syu': 'しゅ', 'syo': 'しょ',
  'zya': 'じゃ', 'zyu': 'じゅ', 'zyo': 'じょ',
  'tya': 'ちゃ', 'tyu': 'ちゅ', 'tyo': 'ちょ',
  'dya': 'ぢゃ', 'dyu': 'ぢゅ', 'dyo': 'ぢょ',
  'nya': 'にゃ', 'nyu': 'にゅ', 'nyo': 'にょ',
  'hya': 'ひゃ', 'hyu': 'ひゅ', 'hyo': 'ひょ',
  'bya': 'びゃ', 'byu': 'びゅ', 'byo': 'びょ',
  'pya': 'ぴゃ', 'pyu': 'ぴゅ', 'pyo': 'ぴょ',
  'mya': 'みゃ', 'myu': 'みゅ', 'myo': 'みょ',
  'rya': 'りゃ', 'ryu': 'りゅ', 'ryo': 'りょ',
  'dza': 'ざ', 'dzu': 'ず', 'dzo': 'ぞ',
  'ja': 'じゃ', 'ju': 'じゅ', 'jo': 'じょ',

  'ka': 'か', 'ki': 'き', 'ku': 'く', 'ke': 'け', 'ko': 'こ',
  'sa': 'さ', 'si': 'し', 'su': 'す', 'se': '세', 'so': 'そ',
  'ta': 'た', 'ti': 'ち', 'tu': 'つ', 'te': 'て', 'to': 'と',
  'na': 'な', 'ni': 'に', 'nu': 'ぬ', 'ne': 'ね', 'no': 'の',
  'ha': 'は', 'hi': 'ひ', 'fu': 'ふ', 'he': 'へ', 'ho': 'ほ',
  'ma': 'ま', 'mi': 'み', 'mu': 'む', 'me': 'め', 'mo': 'も',
  'ya': 'や', 'yu': 'ゆ', 'yo': 'よ',
  'ra': 'ら', 'ri': 'り', 'ru': 'る', 're': 'れ', 'ro': 'ろ',
  'wa': 'わ', 'wo': 'を',
  'ga': 'が', 'gi': 'ぎ', 'gu': 'ぐ', 'ge': 'げ', 'go': 'ご',
  'za': 'ざ', 'zi': 'じ', 'zu': 'ず', 'ze': 'ぜ', 'zo': 'ぞ',
  'da': 'だ', 'di': 'ぢ', 'du': 'づ', 'de': 'で', 'do': 'ど',
  'ba': 'ば', 'bi': 'び', 'bu': 'ぶ', 'be': 'べ', 'bo': 'ぼ',
  'pa': 'ぱ', 'pi': 'ぴ', 'pu': 'ぷ', 'pe': 'ぺ', 'po': 'ぽ',
  'ji': 'じ', 'hu': 'ふ',

  'a': 'あ', 'i': 'い', 'u': 'う', 'e': 'え', 'o': 'お'
};

function convertRomajiToHiragana(text, isFinal = false) {
  if (!text) return "";
  
  let converted = text.toLowerCase();
  
  // 1. Double consonants (촉음) - n 계열은 여기서 줄이지 않고 그대로 유지
  converted = converted.replace(/([bcdfghjklmpqrstvwxyz])\1/g, (match, p1) => {
    return p1 === 'n' ? 'nn' : 'っ' + p1;
  });
  
  // 2. Extra correction mapping
  const correctedMap = { 
    ...ROMAJI_MAP
  };
  
  // 3. Sort keys by length desc to prevent partial matching
  const sortedKeys = Object.keys(correctedMap).sort((a, b) => b.length - a.length);
  for (let key of sortedKeys) {
    converted = converted.replaceAll(key, correctedMap[key]);
  }
  
  // nn을 ん으로 직접 치환 (na, ni, nu, ne, no 등 모음 결합 처리 완료 후 남은 nn 대상)
  converted = converted.replaceAll('nn', 'ん');
  
  // 4. Handle end 'n' -> 'ん'
  if (isFinal) {
    converted = converted.replace(/n(?![aeiouy])/g, 'ん');
  } else {
    // 실시간 타이핑 시에는 단어 끝의 n을 ん으로 성급하게 변환하지 않음 (모음 입력 대기)
    converted = converted.replace(/n(?![aeiouy]|$)/g, 'ん');
  }
  
  return converted;
}


function setupGridEvents() {
  // 1. 추천 단어장 저장 버튼
  const btnSaveRec = document.getElementById('btn-save-recommend');
  if (btnSaveRec) {
    btnSaveRec.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentRecommendationWord) {
        const payload = {
          word: currentRecommendationWord.word,
          hiragana: currentRecommendationWord.hiragana,
          meaning: currentRecommendationWord.meaning,
          examples: currentRecommendationWord.examples || []
        };
        dbAddWord(payload)
          .then(() => {
            showToast(`'${payload.word}' 단어가 저장되었습니다!`, true);
            updateHeaderBadge();
            loadTodayRecommendation();
            loadTodayDueWord();
          })
          .catch(err => {
            showToast('단어 저장 실패', false);
            console.error(err);
          });
      }
    });
  }

  // 2. 복습 단어 새로고침 버튼
  const btnRefreshDue = document.getElementById('btn-refresh-due');
  if (btnRefreshDue) {
    btnRefreshDue.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentDueWords.length > 0) {
        currentDueWordIndex = (currentDueWordIndex + 1) % currentDueWords.length;
        loadTodayDueWord();
      } else {
        showToast('오늘 복습할 단어가 더 이상 없습니다.', true);
      }
    });
  }

  // 3. 복습 단어 TTS 재생 버튼
  const btnTtsDue = document.getElementById('btn-tts-due');
  if (btnTtsDue) {
    btnTtsDue.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentDueWords.length > 0 && currentDueWordIndex < currentDueWords.length) {
        speakJapanese(currentDueWords[currentDueWordIndex].word);
      }
    });
  }

  // 4. 복습 바로가기 버튼
  const btnQuickStudy = document.getElementById('btn-quick-study');
  if (btnQuickStudy) {
    btnQuickStudy.addEventListener('click', (e) => {
      e.stopPropagation();
      const studyTab = document.querySelector('[data-target="screen-study"]');
      if (studyTab) {
        studyTab.click();
      }
    });
  }
}
