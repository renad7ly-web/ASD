let fbDb = null, fbAuth = null;

const LABELS = {in:'دخول', break_out:'بريك', break_in:'رجوع من البريك', out:'انصراف'};
const STATUS = {
  in:      { text:'داخل الحرم',        cls:'st-in' },
  break_in:{ text:'داخل الحرم',        cls:'st-in' },
  break_out:{ text:'في البريك',        cls:'st-break' },
  out:     { text:'منصرف',             cls:'st-out' }
};
let db = null, students = [], selectedId = '';

function todayKey(){ return new Date().toISOString().slice(0,10); }
function fmtTime(ts){
  return new Intl.DateTimeFormat('ar-SA',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}).format(new Date(ts));
}

/* ---------- routing ---------- */
function route(){
  const path = location.hash.replace('#','') || '/';
  document.getElementById('view-home').classList.toggle('show', path === '/');
  document.getElementById('view-attendance').classList.toggle('show', path === '/attendance');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.route === path));
  if (path === '/attendance') renderAttendanceLog();
}
window.addEventListener('hashchange', route);

/* ---------- render: student list + select ---------- */
function renderStudents(){
  const list = document.getElementById('studentList');
  const studentSelect = document.getElementById('studentSelect');
  list.innerHTML = '';
  const prevSelected = studentSelect.value;
  studentSelect.innerHTML = '<option value="">اختر طالب…</option>';

  if (!students.length){
    list.innerHTML = '<p class="empty">ما فيه طلاب مضافين بعد.</p>';
  }
  students.forEach(s => {
    const li = document.createElement('li');
    li.className = 'srow';
    li.innerHTML = `
      <div class="info"><b>${s.name}</b><span>${s.classRoom} · رقم أكاديمي ${s.cardId}</span></div>
      <div class="quick">
        <select class="q-type">
          <option value="in">دخول</option>
          <option value="break_out">بريك</option>
          <option value="break_in">رجوع من البريك</option>
          <option value="out">انصراف</option>
        </select>
        <button class="q-log" type="button">تسجيل</button>
        <button class="q-del" type="button">حذف</button>
        <span class="result"></span>
      </div>`;
    const qSelect = li.querySelector('.q-type');
    const logBtn = li.querySelector('.q-log');
    li.querySelector('.q-del').onclick = async () => {
      if (!confirm('حذف الطالب ' + s.name + '؟')) return;
      try { await db.doc('students/' + s.id).delete(); } catch (err) { alert(dbErrorMessage(err)); }
    };
    const result = li.querySelector('.result');
    logBtn.disabled = !db;
    logBtn.onclick = async () => {
      logBtn.disabled = true;
      qSelect.disabled = true;
      result.textContent = '';
      const type = qSelect.value;
      const label = qSelect.options[qSelect.selectedIndex].text;
      try {
        const time = await recordEvent(s.id, type);
        result.textContent = time ? `تم — ${label} ${fmtTime(time)}` : 'ما تسجّل، حاول مرة ثانية';
      } catch (err) {
        result.textContent = dbErrorMessage(err);
      } finally {
        logBtn.disabled = !db;
        qSelect.disabled = false;
      }
    };
    list.appendChild(li);

    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name;
    studentSelect.appendChild(opt);
  });
  studentSelect.value = selectedId || prevSelected || '';
  onStudentPicked();
}

function onStudentPicked(){
  selectedId = document.getElementById('studentSelect').value;
  renderAttendanceLog();
}
document.getElementById('studentSelect').addEventListener('change', onStudentPicked);

/* ---------- attendance log + current status ---------- */
let unsubLog = null;
function renderAttendanceLog(){
  if (unsubLog) { unsubLog(); unsubLog = null; }
  const body = document.getElementById('logBody');
  const empty = document.getElementById('logEmpty');
  const statusCard = document.getElementById('statusCard');
  const statusBadge = document.getElementById('statusBadge');
  body.innerHTML = '';
  if (!selectedId || !db){ empty.style.display = 'block'; statusCard.style.display = 'none'; return; }
  const ref = db.doc('attendance/' + selectedId + '_' + todayKey());
  unsubLog = ref.onSnapshot(snap => {
    const events = (snap.exists && snap.data().events) || [];
    body.innerHTML = '';
    empty.style.display = events.length ? 'none' : 'block';
    events.slice().reverse().forEach(ev => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><span class="badge">${LABELS[ev.type] || ev.type}</span></td><td>${fmtTime(ev.time)}</td>`;
      body.appendChild(tr);
    });
    if (events.length){
      const last = events[events.length - 1];
      const st = STATUS[last.type] || { text: LABELS[last.type] || last.type, cls: 'st-out' };
      statusBadge.textContent = st.text + ' — ' + fmtTime(last.time);
      statusBadge.className = 'badge-status ' + st.cls;
      statusCard.style.display = 'flex';
    } else {
      statusBadge.textContent = 'لم يسجّل اليوم';
      statusBadge.className = 'badge-status st-out';
      statusCard.style.display = 'flex';
    }
  });
}

async function recordEvent(studentId, type){
  if (!db || !studentId) return null;
  const student = students.find(s => s.id === studentId);
  if (!student) return null;
  const docId = studentId + '_' + todayKey();
  const ref = db.doc('attendance/' + docId);
  const write = async () => {
    if (fbDb){
      // several devices may log at once: do the read-modify-write inside a transaction
      return await fbDb.runTransaction(async t => {
        const snap = await t.get(ref);
        const events = (snap.exists && snap.data().events) ? [...snap.data().events] : [];
        const time = Date.now();
        events.push({ type, time });
        t.set(ref, { studentId, studentName: student.name, date: todayKey(), events });
        return time;
      });
    }
    const snap = await ref.get();
    const events = (snap.exists && snap.data().events) ? [...snap.data().events] : [];
    const time = Date.now();
    events.push({ type, time });
    await ref.set({ studentId, studentName: student.name, date: todayKey(), events });
    return time;
  };
  try {
    return await write();
  } catch (err) {
    if (err && err.code === 'unavailable') {
      await new Promise(r => setTimeout(r, 400 + Math.random() * 400));
      return await write(); // one retry, per the platform's own guidance for transient errors
    }
    throw err;
  }
}

function dbErrorMessage(err){
  const code = err && err.code;
  switch (code) {
    case 'permission-denied': return 'ما عندك صلاحية — تأكد إنك مسجّل دخول وإن قواعد الأمان في Firebase مضبوطة.';
    case 'quota_exceeded':   return 'وصل عدد السجلات للحد الأقصى — تواصل مع الدعم لحذف سجلات قديمة.';
    case 'resource_exhausted': return 'الضغط على النظام عالي حالياً، جرب بعد شوي.';
    case 'revoked':           return 'ما عاد عندك صلاحية وصول لهذي الصفحة، أعد فتحها.';
    case 'invalid_argument':  return 'صار خطأ في البيانات المرسلة — ما بينحل بإعادة المحاولة.';
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed': return 'التخزين مو مفعّل لهذي النسخة من الصفحة.';
    default:                  return 'صار خطأ أثناء الحفظ (' + (code || 'غير معروف') + ')، حاول مرة ثانية.';
  }
}

/* ---------- new day at midnight ---------- */
let dayRolloverTimer = null;
function msUntilNextMidnight(){
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  return next - now;
}
function scheduleDayRollover(){
  clearTimeout(dayRolloverTimer);
  dayRolloverTimer = setTimeout(() => {
    renderAttendanceLog(); // re-reads today's date, moves the view to the new day's document
    scheduleDayRollover();
  }, msUntilNextMidnight());
}
// a timer alone can be delayed if the tab was in the background across midnight,
// so also re-check the moment the tab becomes visible again
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') renderAttendanceLog();
});

/* ---------- add student ---------- */
document.getElementById('addForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!db) return;
  const name = document.getElementById('f-name').value.trim();
  const classRoom = document.getElementById('f-class').value.trim();
  const cardId = document.getElementById('f-card').value.trim();
  if (!name || !classRoom || !cardId) return;
  await db.collection('students').add({ name, classRoom, cardId, addedAt: Date.now() });
  e.target.reset();
});

/* ---------- local fallback storage (used outside the Claude artifact runtime) ---------- */
function makeLocalDb(){
  const KEY = 'attendance-system-v1';
  let state = { students: {}, attendance: {} };
  try { const raw = JSON.parse(localStorage.getItem(KEY)); if (raw) state = raw; } catch(e){}
  state.students = state.students || {}; state.attendance = state.attendance || {};
  function persist(){ try { localStorage.setItem(KEY, JSON.stringify(state)); } catch(e){} }

  const collListeners = {}; // coll -> [fn]
  const docListeners = {};  // "coll/id" -> [fn]
  function notifyColl(coll){ (collListeners[coll]||[]).forEach(fn => fn()); }
  function notifyDoc(path){ (docListeners[path]||[]).forEach(fn => fn()); }

  function docApi(coll, id){
    const path = coll + '/' + id;
    return {
      id,
      get: async () => ({ exists: !!state[coll][id], data: () => state[coll][id] }),
      set: async (data) => {
        state[coll][id] = JSON.parse(JSON.stringify(data)); persist();
        notifyDoc(path); notifyColl(coll);
      },
      delete: async () => {
        delete state[coll][id]; persist();
        notifyDoc(path); notifyColl(coll);
      },
      onSnapshot: (next) => {
        const emit = () => next({ exists: !!state[coll][id], data: () => state[coll][id] });
        emit();
        (docListeners[path] = docListeners[path] || []).push(emit);
        return () => { docListeners[path] = (docListeners[path]||[]).filter(f => f !== emit); };
      }
    };
  }
  function collSnapshot(coll){
    return { docs: Object.entries(state[coll]).map(([id,data]) => ({ id, data: () => data })) };
  }
  function collQuery(coll){
    return {
      get: async () => collSnapshot(coll),
      onSnapshot: (next) => {
        const emit = () => next(collSnapshot(coll));
        emit();
        (collListeners[coll] = collListeners[coll] || []).push(emit);
        return () => { collListeners[coll] = (collListeners[coll]||[]).filter(f => f !== emit); };
      }
    };
  }
  return {
    collection: (coll) => ({
      doc: (id) => docApi(coll, id || 'id' + Date.now() + Math.random().toString(36).slice(2)),
      add: async (data) => {
        const id = 'id' + Date.now() + Math.random().toString(36).slice(2);
        state[coll][id] = JSON.parse(JSON.stringify(data)); persist(); notifyColl(coll);
        return docApi(coll, id);
      },
      get: () => collQuery(coll).get(),
      onSnapshot: (next) => collQuery(coll).onSnapshot(next),
      orderBy: () => ({
        get: async () => ({ docs: collSnapshot(coll).docs
          .sort((a,b) => (a.data().addedAt||0) - (b.data().addedAt||0)) }),
        onSnapshot: (next) => {
          const emit = () => next({ docs: Object.entries(state[coll])
            .sort((a,b) => (a[1].addedAt||0) - (b[1].addedAt||0))
            .map(([id,data]) => ({ id, data: () => data })) });
          emit();
          (collListeners[coll] = collListeners[coll] || []).push(emit);
          return () => { collListeners[coll] = (collListeners[coll]||[]).filter(f => f !== emit); };
        }
      })
    }),
    doc: (path) => { const i = path.indexOf('/'); return docApi(path.slice(0,i), path.slice(i+1)); }
  };
}

/* ---------- card scanner ---------- */
let scanStream = null, scanTimer = null, lastScan = {code:'', at:0};
const scanMsg = document.getElementById('scanMsg');
function showScanMsg(text, ok){ scanMsg.textContent = text; scanMsg.className = 'scan-msg ' + (ok ? 'ok' : 'err'); }

// next event is picked from the student's status today: none/out -> in, in/break_in -> out, break_out -> break_in
async function nextTypeFor(studentId){
  const snap = await db.doc('attendance/' + studentId + '_' + todayKey()).get();
  const events = (snap.exists && snap.data().events) || [];
  const last = events.length ? events[events.length - 1].type : 'out';
  return last === 'break_out' ? 'break_in' : (last === 'in' || last === 'break_in') ? 'out' : 'in';
}

let seenAt = {};   // studentId -> last time this card was seen by the camera
async function acceptStudent(student){
  const now = Date.now();
  const prev = seenAt[student.id] || 0;
  seenAt[student.id] = now;
  if (now - prev < 6000) return; // card is still in front of the camera: don't toggle in/out again
  try {
    const type = await nextTypeFor(student.id);
    const time = await recordEvent(student.id, type);
    if (!time){ showScanMsg('ما تسجّل، حاول مرة ثانية.', false); return; }
    document.getElementById('studentSelect').value = student.id;
    onStudentPicked();
    showScanMsg(student.name + ' — ' + LABELS[type] + ' ' + fmtTime(time), true);
    setScanStatus('✓ ' + student.name + ' — ' + LABELS[type]);
    if (navigator.vibrate) navigator.vibrate(120);
  } catch (err) {
    showScanMsg(dbErrorMessage(err), false);
  }
}

async function handleScan(raw){
  const code = String(raw || '').trim();
  if (!code || !db) return;
  const student = students.find(s => String(s.cardId).trim() === code);
  if (student){ await acceptStudent(student); return; }
  const now = Date.now();
  if (code === lastScan.code && now - lastScan.at < 4000) return;
  lastScan = { code, at: now };
  showScanMsg('البطاقة (' + code + ') غير مسجّلة في النظام.', false);
}

function setScanStatus(t){ const el = document.getElementById('scanStatus'); if (el) el.textContent = t; }

/* ---------- reading the printed text on the card (OCR) ---------- */
const AR_D = '٠١٢٣٤٥٦٧٨٩', FA_D = '۰۱۲۳۴۵۶۷۸۹';
function normDigits(t){
  return String(t).replace(/[٠-٩]/g, d => AR_D.indexOf(d)).replace(/[۰-۹]/g, d => FA_D.indexOf(d));
}
function normAr(t){
  return normDigits(t)
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\u0621-\u064Aa-zA-Z0-9\s]/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
// finds the registered student whose academic number and/or name appears in the text read from the card
function matchStudentFromText(text){
  const norm = normAr(text);
  if (!norm) return null;
  const allDigits = norm.replace(/[^0-9]/g, '');
  let best = null, bestScore = 0, tie = false;
  students.forEach(st => {
    const id = normDigits(st.cardId).replace(/\D/g, '');
    const idHit = id.length >= 4 && allDigits.includes(id);
    const tokens = normAr(st.name).split(' ').filter(t => t.length >= 2);
    const hits = tokens.filter(t => norm.includes(t)).length;
    const nameHit = tokens.length && hits >= Math.min(2, tokens.length) && hits / tokens.length >= 0.6;
    if (!idHit && !nameHit) return;
    const score = (idHit ? 100 : 0) + hits;
    if (score > bestScore){ best = st; bestScore = score; tie = false; }
    else if (score === bestScore){ tie = true; }
  });
  return tie ? null : best;
}


// pulls the university number, name and major out of the text read from a card
const CARD_STOP = ['جامعه','جامعة','الجامعي','الجامعيه','رقم','بطاقه','بطاقة','طالب','طالبه','طالبة','كليه','كلية','قسم','تخصص','المملكه','العربيه','السعوديه','وزاره','التعليم','الطلاب','عماده','شؤون','هويه','الرقم','الاكاديمي','صالحه','تنتهي','تاريخ','الاسم','انتساب','الدراسه','مستوى'];
function parseCardText(text){
  const fixed = normDigits(text);
  const runs = (fixed.match(/\d[\d ]{4,12}\d/g) || []).map(r => r.replace(/ /g, '')).filter(r => r.length >= 6 && r.length <= 11);
  let cardId = '';
  for (const len of [9, 8, 10, 7, 11, 6]){ const f = runs.find(r => r.length === len); if (f){ cardId = f; break; } }
  const lines = String(text).split(/\n+/).map(l => l.trim()).filter(Boolean);
  let name = '', major = '';
  let bestWords = 0;
  lines.forEach(line => {
    const afterLabel = line.match(/الاسم\s*[:：]?\s*(.+)/);
    const cand = (afterLabel ? afterLabel[1] : line).replace(/[^\u0621-\u064A\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = cand.split(' ').filter(w => w.length >= 2);
    if (words.length < 2 || words.length > 6) return;
    const norm = normAr(cand).split(' ');
    if (norm.some(w => CARD_STOP.includes(w))) return;
    if (afterLabel || words.length > bestWords){ name = words.join(' '); bestWords = afterLabel ? 99 : words.length; }
  });
  const mj = lines.find(l => /(كليه|كلية|تخصص|قسم)/.test(l));
  if (mj) major = mj.replace(/[^\u0621-\u064A\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return { cardId, name, major };
}

let pendingCard = null, justAdded = {};
async function autoAddStudent(info){
  const { cardId, name } = info;
  const major = info.major || 'غير محدد';
  await db.collection('students').add({ name, classRoom: major, cardId, addedAt: Date.now() });
  justAdded[cardId] = Date.now();
  showScanMsg('تمت إضافة الطالب: ' + name + ' — رقم ' + cardId + ' (راجع البيانات، وتقدر تحذفه لو فيه خطأ)', true);
  setScanStatus('✓ تمت إضافة ' + name);
  if (navigator.vibrate) navigator.vibrate(120);
}

let ocrWorkerPromise = null;
function getOcrWorker(){
  if (!ocrWorkerPromise){
    ocrWorkerPromise = (async () => {
      if (typeof Tesseract === 'undefined')
        await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
      const w = await Tesseract.createWorker(['ara', 'eng']);
      try { await w.setParameters({ tessedit_pageseg_mode: '11' }); } catch (e) {} // sparse text: better for cards
      return w;
    })().catch(e => { ocrWorkerPromise = null; throw e; });
  }
  return ocrWorkerPromise;
}

function frameToCanvas(video){
  const maxW = 1500;
  const scale = Math.min(1, maxW / video.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(video.videoWidth * scale); c.height = Math.round(video.videoHeight * scale);
  const ctx = c.getContext('2d', { willReadFrequently:true });
  ctx.drawImage(video, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let i = 0; i < d.length; i += 4){           // grayscale + contrast boost helps text recognition
    let g = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
    g = (g - 128) * 1.35 + 128;
    d[i] = d[i+1] = d[i+2] = g < 0 ? 0 : g > 255 ? 255 : g;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function ocrLoop(video){
  let worker;
  try {
    setScanStatus('جاري تجهيز قارئ النصوص… (أول مرة ياخذ شوي)');
    worker = await getOcrWorker();
  } catch (e) {
    setScanStatus('قراءة النص غير متاحة الآن — مسح الباركود/QR شغّال');
    const dbg = document.getElementById('ocrDebug'); dbg.classList.add('on');
    dbg.textContent = 'تعذّر تحميل قارئ النصوص (غالبًا الإنترنت أو حجب المكتبة).';
    return;
  }
  while (scanStream){
    try {
      if (video.videoWidth){
        setScanStatus('جاري قراءة البطاقة…');
        const { data } = await worker.recognize(frameToCanvas(video));
        if (!scanStream) break;
        const txt = (data.text || '').replace(/\s+/g, ' ').trim();
        const dbg = document.getElementById('ocrDebug');
        dbg.classList.add('on');
        dbg.textContent = 'اللي قرأته من البطاقة: ' + (txt || '— ما قرأت نص —');
        const student = matchStudentFromText(data.text || '');
        if (student){
          if (justAdded[student.cardId] && Date.now() - justAdded[student.cardId] < 15000) { setScanStatus('✓ تمت إضافة ' + student.name); }
          else await acceptStudent(student);
        } else {
          const info = parseCardText(data.text || '');
          dbg.textContent += '\nالاسم: ' + (info.name || '—') + ' | الرقم: ' + (info.cardId || '—');
          if (info.cardId && info.name){
            // add only after the same number is read twice in a row, to avoid OCR mistakes
            if (pendingCard && pendingCard.cardId === info.cardId){
              if (info.name.length > pendingCard.name.length) pendingCard.name = info.name;
              const toAdd = pendingCard; pendingCard = null;
              if (!students.some(x => String(x.cardId).trim() === toAdd.cardId)) await autoAddStudent({ ...toAdd, major: info.major || toAdd.major });
            } else { pendingCard = { ...info }; setScanStatus('تأكيد القراءة… ثبّت البطاقة'); }
          } else { pendingCard = null; setScanStatus('وجّه البطاقة للكاميرا وثبّتها'); }
        }
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 400));
  }
}

function loadScript(src){
  return new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src; el.onload = res; el.onerror = () => rej(new Error('load'));
    document.head.appendChild(el);
  });
}

async function startScanner(){
  const view = document.getElementById('scanView');
  const video = document.getElementById('scanVideo');
  const toggle = document.getElementById('scanToggle');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1920 }, height:{ ideal:1080 } }, audio:false });
  } catch (err) {
    showScanMsg('ما قدرت أفتح الكاميرا — اسمح للموقع باستخدامها من إعدادات المتصفح.', false);
    return;
  }
  video.srcObject = scanStream;
  await video.play();
  view.classList.add('on');
  toggle.textContent = 'إيقاف الكاميرا';

  let detect;
  if ('BarcodeDetector' in window){
    const detector = new BarcodeDetector();
    detect = async () => { const r = await detector.detect(video); return r.length ? r[0].rawValue : null; };
  } else {
    // browsers without BarcodeDetector (e.g. Safari): QR codes only, via jsQR
    // tries a copy next to this file first (most reliable), then several CDNs
    const sources = [
      './jsQR.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js',
      'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
      'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js'
    ];
    let loaded = false;
    for (const src of sources){
      try { await loadScript(src); if (typeof jsQR === 'function'){ loaded = true; break; } } catch (e) {}
    }
    if (!loaded){ showScanMsg('تعذّر تحميل مكتبة القراءة — تأكد من الإنترنت وجرّب مرة ثانية، أو استخدم الإدخال اليدوي.', false); stopScanner(); return; }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently:true });
    detect = async () => {
      if (!video.videoWidth) return null;
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const r = jsQR(img.data, img.width, img.height);
      return r ? r.data : null;
    };
  }
  scanTimer = setInterval(async () => {
    try { const code = await detect(); if (code) handleScan(code); } catch (e) {}
  }, 300);
  ocrLoop(video);
}

function stopScanner(){
  clearInterval(scanTimer); scanTimer = null;
  if (scanStream){ scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  document.getElementById('scanView').classList.remove('on');
  document.getElementById('scanToggle').textContent = 'فتح الكاميرا';
}

document.getElementById('scanToggle').addEventListener('click', () => scanStream ? stopScanner() : startScanner());
function submitManual(){
  const input = document.getElementById('scanInput');
  const v = input.value; input.value = '';
  lastScan = { code:'', at:0 }; seenAt = {};
  handleScan(v);
  input.focus();
}
document.getElementById('scanGo').addEventListener('click', submitManual);
document.getElementById('scanInput').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); submitManual(); } });
window.addEventListener('hashchange', () => { if ((location.hash.replace('#','') || '/') !== '/') stopScanner(); });

/* ---------- boot ---------- */
function loadScriptSrc(src){
  return new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src; el.onload = res; el.onerror = () => rej(new Error('load ' + src));
    document.head.appendChild(el);
  });
}

async function initFirebase(){
  const v = '10.14.1', base = 'https://www.gstatic.com/firebasejs/' + v + '/';
  await loadScriptSrc(base + 'firebase-app-compat.js');
  await Promise.all([loadScriptSrc(base + 'firebase-auth-compat.js'), loadScriptSrc(base + 'firebase-firestore-compat.js')]);
  firebase.initializeApp(FIREBASE_CONFIG);
  fbAuth = firebase.auth();
  fbDb = firebase.firestore();
  const overlay = document.getElementById('loginOverlay');
  const err = document.getElementById('loginErr');
  const doLogin = async () => {
    err.style.display = 'none';
    try {
      await fbAuth.signInWithEmailAndPassword(document.getElementById('loginEmail').value.trim(), document.getElementById('loginPass').value);
    } catch (e) {
      const m = { 'auth/invalid-credential':'البريد أو كلمة المرور غير صحيحة.', 'auth/invalid-email':'صيغة البريد غير صحيحة.', 'auth/too-many-requests':'محاولات كثيرة، انتظر شوي وحاول.', 'auth/network-request-failed':'ما فيه اتصال بالإنترنت.' };
      err.textContent = m[e.code] || ('تعذّر تسجيل الدخول (' + (e.code || 'خطأ') + ')');
      err.style.display = 'block';
    }
  };
  document.getElementById('loginBtn').onclick = doLogin;
  document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  return new Promise(resolve => {
    let done = false;
    fbAuth.onAuthStateChanged(user => {
      if (user){ overlay.style.display = 'none'; if (!done){ done = true; resolve(user); } }
      else if (done){ location.reload(); }
      else { overlay.style.display = 'flex'; }
    });
  });
}

async function boot(){
  route();
  let cloudDb = null;
  const notice = document.getElementById('notice');

  if (FIREBASE_CONFIG.apiKey){
    try {
      const user = await initFirebase();
      db = fbDb;
      notice.textContent = 'متصل بقاعدة البيانات — ' + user.email + ' · ';
      const out = document.createElement('a');
      out.href = '#'; out.textContent = 'تسجيل الخروج';
      out.onclick = e => { e.preventDefault(); fbAuth.signOut(); };
      notice.appendChild(out);
      notice.classList.add('info'); notice.style.display = 'block';
    } catch (err) {
      fbDb = null;
      db = makeLocalDb();
      notice.textContent = 'تعذّر الاتصال بقاعدة البيانات (تأكد من الإنترنت) — الحفظ الآن محلي على هذا المتصفح فقط.';
      notice.classList.add('info'); notice.style.display = 'block';
    }
  } else {
    try { cloudDb = (window.claude && await window.claude.use('db')) || null; } catch (err) { cloudDb = null; }
    if (cloudDb){
      db = cloudDb;
    } else {
      db = makeLocalDb();
      notice.textContent = 'الحفظ محلي على هذا المتصفح فقط — البيانات ما تنعرض على أجهزة ثانية.';
      notice.classList.add('info');
      notice.style.display = 'block';
    }
  }

  db.collection('students').orderBy('addedAt', 'asc').onSnapshot(snap => {
    students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderStudents();
  });
  scheduleDayRollover();
}
boot();
