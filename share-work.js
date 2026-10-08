(() => {
  'use strict';
  const PREFIX = 'volunteer-journal:';
  const DB_NAME = 'volunteer-journal-files';
  const DB_STORE = 'files';
  const FORMAT = 'volunteer-journal-work';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    crcTable[n] = value >>> 0;
  }
  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }
  function u16(view, offset, value) { view.setUint16(offset, value, true); }
  function u32(view, offset, value) { view.setUint32(offset, value, true); }

  function makeZip(entries) {
    const local = [], central = [];
    let offset = 0;
    for (const [name, bytes] of entries) {
      const filename = encoder.encode(name), crc = crc32(bytes), localHeader = new Uint8Array(30 + filename.length), localView = new DataView(localHeader.buffer);
      u32(localView, 0, 0x04034b50); u16(localView, 4, 20); u16(localView, 6, 0x0800); u16(localView, 8, 0); u32(localView, 14, crc); u32(localView, 18, bytes.length); u32(localView, 22, bytes.length); u16(localView, 26, filename.length); localHeader.set(filename, 30);
      local.push(localHeader, bytes);
      const centralHeader = new Uint8Array(46 + filename.length), centralView = new DataView(centralHeader.buffer);
      u32(centralView, 0, 0x02014b50); u16(centralView, 4, 20); u16(centralView, 6, 20); u16(centralView, 8, 0x0800); u16(centralView, 10, 0); u32(centralView, 16, crc); u32(centralView, 20, bytes.length); u32(centralView, 24, bytes.length); u16(centralView, 28, filename.length); u32(centralView, 42, offset); centralHeader.set(filename, 46);
      central.push(centralHeader); offset += localHeader.length + bytes.length;
    }
    const centralSize = central.reduce((sum, entry) => sum + entry.length, 0), end = new Uint8Array(22), endView = new DataView(end.buffer);
    u32(endView, 0, 0x06054b50); u16(endView, 8, entries.length); u16(endView, 10, entries.length); u32(endView, 12, centralSize); u32(endView, 16, offset);
    return new Blob([...local, ...central, end], { type: 'application/zip' });
  }

  async function readZip(file) {
    const bytes = new Uint8Array(await file.arrayBuffer()), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error('공유 파일의 압축 형식을 확인해 주세요.');
    const count = view.getUint16(end + 10, true); let cursor = view.getUint32(end + 16, true); const result = new Map();
    for (let i = 0; i < count; i++) {
      if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('공유 파일 목록을 읽지 못했습니다.');
      const method = view.getUint16(cursor + 10, true), crc = view.getUint32(cursor + 16, true), size = view.getUint32(cursor + 24, true), nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true), localOffset = view.getUint32(cursor + 42, true);
      if (method !== 0 || size > 300 * 1024 * 1024) throw new Error('지원하지 않는 압축 방식이거나 파일이 너무 큽니다. 활동일지 앱에서 만든 공유 파일을 선택해 주세요.');
      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('공유 파일 내부 자료를 읽지 못했습니다.');
      const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true), start = localOffset + 30 + localNameLength + localExtraLength;
      const data = bytes.slice(start, start + size);
      if (crc32(data) !== crc) throw new Error('파일이 손상되었거나 전송 중 일부가 누락됐습니다.');
      result.set(name, data); cursor += 46 + nameLength + extraLength + commentLength;
    }
    return result;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('사진 저장 공간을 열지 못했습니다.'));
    });
  }
  async function getAsset(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => { const tx = db.transaction(DB_STORE, 'readonly'), request = tx.objectStore(DB_STORE).get(id); request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error); tx.oncomplete = () => db.close(); });
  }
  async function putAsset(id, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => { const tx = db.transaction(DB_STORE, 'readwrite'); tx.objectStore(DB_STORE).put(blob, id); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error || new Error('사진을 저장하지 못했습니다.')); }; });
  }
  function savedProjects() {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i); if (!key || !key.startsWith(PREFIX)) continue;
      try { const project = JSON.parse(localStorage.getItem(key)); if (project && /^20\d{2}-\d{2}$/.test(project.month) && Array.isArray(project.records) && Array.isArray(project.assets)) items.push({ key, project }); } catch {}
    }
    return items.sort((a, b) => b.project.month.localeCompare(a.project.month) || (a.project.name || '').localeCompare(b.project.name || '', 'ko'));
  }
  function operationsFor(month) {
    return {
      rows: localStorage.getItem(`${PREFIX}operations:${month}`),
      details: localStorage.getItem(`${PREFIX}operations-details:${month}`),
      groups: localStorage.getItem(`${PREFIX}centers`)
    };
  }
  function setStatus(message, isError = false) {
    const status = document.querySelector('#share-work-status'); if (!status) return;
    status.textContent = message; status.dataset.error = isError ? 'true' : 'false';
  }
  function makeFilename(project) {
    const safeName = (project.name || '이름미입력').replace(/[\\/:*?"<>|\s]+/g, '_');
    return `${project.month}_${safeName}_작업공유.vjournal`;
  }
  async function exportProject(project) {
    const storedProject = { ...project, assets: project.assets.map(({ url, ...asset }) => ({ ...asset })) };
    const manifest = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), project: storedProject, operations: operationsFor(project.month) };
    const entries = [['work.json', encoder.encode(JSON.stringify(manifest))]];
    for (const asset of project.assets) {
      const blob = await getAsset(asset.id); if (!blob) throw new Error(`첨부 파일을 찾을 수 없습니다: ${asset.name}`);
      const file = `assets/${asset.id}`; const metadata = storedProject.assets.find(item => item.id === asset.id); metadata.file = file; entries.push([file, new Uint8Array(await blob.arrayBuffer())]);
    }
    const zip = makeZip(entries);
    const output = new Blob([zip], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(output), anchor = document.createElement('a');
    anchor.href = url; anchor.download = makeFilename(project); anchor.style.display = 'none';
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus('공유 파일을 다운로드했습니다. 다운로드한 파일을 카카오톡·이메일·USB 등으로 전달한 뒤, 다른 컴퓨터에서 “받은 작업 파일 가져오기”를 눌러 불러오세요.');
  }
  function validateManifest(manifest) {
    if (!manifest || manifest.format !== FORMAT || manifest.version !== 1 || !manifest.project || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(manifest.project.month) || !Array.isArray(manifest.project.records) || !Array.isArray(manifest.project.assets)) throw new Error('활동일지 앱에서 만든 작업 공유 파일이 아닙니다.');
  }
  async function importProject(file) {
    const entries = await readZip(file), raw = entries.get('work.json'); if (!raw) throw new Error('작업 정보가 들어 있지 않습니다.');
    const manifest = JSON.parse(decoder.decode(raw)); validateManifest(manifest);
    const project = manifest.project, target = savedProjects().find(entry => entry.project.month === project.month && (entry.project.name || '') === (project.name || ''));
    if (target && !confirm(`${project.month} ${project.name || '이름 미입력'} 작업이 이미 있습니다. 기존 활동일지와 운영현황을 공유 파일 내용으로 바꿀까요?`)) return false;
    const idMap = new Map();
    for (const asset of project.assets) {
      if (!asset || typeof asset.id !== 'string' || typeof asset.file !== 'string' || !asset.file.startsWith('assets/')) throw new Error('첨부 파일 정보가 올바르지 않습니다.');
      const data = entries.get(asset.file); if (!data) throw new Error(`공유 파일에 첨부 자료가 없습니다: ${asset.name || asset.id}`);
      const newId = crypto.randomUUID(); idMap.set(asset.id, newId);
      await putAsset(newId, new Blob([data], { type: asset.type || 'application/octet-stream' }));
      asset.id = newId; delete asset.file; asset.url = '';
    }
    project.records = project.records.map(record => ({ ...record, sourceId: idMap.get(record.sourceId) || record.sourceId }));
    localStorage.setItem(`${PREFIX}${project.month}|${encodeURIComponent((project.name || '').trim())}`, JSON.stringify(project));
    const operations = manifest.operations || {};
    if (operations.rows != null) localStorage.setItem(`${PREFIX}operations:${project.month}`, operations.rows); else localStorage.removeItem(`${PREFIX}operations:${project.month}`);
    if (operations.details != null) localStorage.setItem(`${PREFIX}operations-details:${project.month}`, operations.details); else localStorage.removeItem(`${PREFIX}operations-details:${project.month}`);
    if (operations.groups != null) localStorage.setItem(`${PREFIX}centers`, operations.groups); else localStorage.removeItem(`${PREFIX}centers`);
    const monthKey = `${PREFIX}operations:months`;
    try { const months = JSON.parse(localStorage.getItem(monthKey) || '[]'); if (Array.isArray(months) && !months.includes(project.month)) localStorage.setItem(monthKey, JSON.stringify([...months, project.month].sort((a, b) => b.localeCompare(a)))); } catch { localStorage.setItem(monthKey, JSON.stringify([project.month])); }
    return true;
  }

  function install() {
    if (document.querySelector('#share-work-tools')) return;
    const header = document.querySelector('.topbar'), privateLabel = header?.querySelector('.private-label'); if (!header || !privateLabel) return;
    if (!document.querySelector('#share-work-style')) {
      const style = document.createElement('style'); style.id = 'share-work-style'; style.textContent = `.share-work-tools{display:flex;align-items:center}.share-work-button,.share-work-primary,.share-work-secondary{border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#172033;padding:9px 13px;font:600 13px inherit;cursor:pointer}.share-work-button:hover,.share-work-secondary:hover{background:#f1f5f9}.share-work-backdrop[hidden]{display:none}.share-work-backdrop{position:fixed;z-index:10000;inset:0;background:#10182899;display:grid;place-items:center;padding:18px}.share-work-card{position:relative;box-sizing:border-box;width:min(560px,100%);max-height:90vh;overflow:auto;border-radius:16px;background:#fff;padding:28px;box-shadow:0 20px 70px #0003;color:#172033;font:14px/1.55 system-ui,sans-serif}.share-work-card h2{font-size:22px;margin:4px 0 10px}.share-work-card>p{color:#475569}.share-work-close{position:absolute;right:14px;top:10px;border:0;background:transparent;font-size:28px;color:#64748b;cursor:pointer}.share-work-label{display:grid;gap:8px;margin:20px 0 14px;font-weight:600}.share-work-label select{min-width:0;padding:10px;border:1px solid #cbd5e1;border-radius:8px;background:#fff}.share-work-actions{display:flex;flex-wrap:wrap;gap:10px}.share-work-primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}.share-work-primary:disabled{opacity:.6}.share-work-secondary{display:inline-flex;align-items:center}.share-work-card #share-work-status{min-height:22px;margin:16px 0 0;color:#166534}.share-work-card #share-work-status[data-error=true]{color:#b91c1c}@media(max-width:760px){.topbar{flex-wrap:wrap}.share-work-tools{order:3;width:100%}.share-work-button{width:100%}.share-work-card{padding:24px 18px}.share-work-actions{display:grid}.share-work-primary,.share-work-secondary{justify-content:center;min-height:42px}}`; document.head.append(style);
    }
    const tools = document.createElement('div'); tools.id = 'share-work-tools'; tools.className = 'share-work-tools';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'share-work-button'; open.textContent = '작업 공유·가져오기'; open.setAttribute('aria-haspopup', 'dialog');
    tools.append(open); header.insertBefore(tools, privateLabel);
    const modal = document.createElement('section'); modal.id = 'share-work-dialog'; modal.className = 'share-work-backdrop'; modal.hidden = true; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'share-work-title');
    modal.innerHTML = `<div class="share-work-card"><button type="button" class="share-work-close" aria-label="닫기">×</button><p class="eyebrow">작업 파일 공유</p><h2 id="share-work-title">사진과 운영현황까지 한 파일로</h2><p>저장한 월별 활동일지, 원본 PDF·한글파일, 날짜별 사진과 서명, 해당 월의 거점운영현황을 묶습니다. 받은 사람은 이 파일을 불러와 계속 편집한 다음 한글파일·엑셀·PDF로 저장할 수 있습니다.</p><label class="share-work-label">공유할 저장 작업<select id="share-work-project"></select></label><div class="share-work-actions"><button type="button" id="share-work-export" class="share-work-primary">파일 다운로드</button><label for="share-work-file" class="share-work-secondary">받은 작업 파일 가져오기</label><input id="share-work-file" type="file" accept=".vjournal,.zip,application/zip" hidden></div><p id="share-work-status" role="status" aria-live="polite"></p></div>`;
    document.body.append(modal);
    const select = modal.querySelector('#share-work-project');
    function refresh() {
      const selected = select.value, items = savedProjects(); select.replaceChildren();
      for (const item of items) { const option = document.createElement('option'); option.value = item.key; option.textContent = `${item.project.month} · ${item.project.name || '활동가 이름 미입력'} · 사진·파일 ${item.project.assets.length}개`; select.append(option); }
      if (items.some(item => item.key === selected)) select.value = selected;
      if (!items.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '저장한 작업이 없습니다'; select.append(option); }
    }
    const close = () => { modal.hidden = true; };
    open.addEventListener('click', () => { refresh(); modal.hidden = false; modal.querySelector('.share-work-close').focus(); });
    modal.querySelector('.share-work-close').addEventListener('click', close);
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    window.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) close(); });
    modal.querySelector('#share-work-export').addEventListener('click', async () => {
      const item = savedProjects().find(entry => entry.key === select.value); if (!item) { setStatus('먼저 월별 작업의 저장 버튼을 눌러 주세요.', true); return; }
      const button = modal.querySelector('#share-work-export'); button.disabled = true;
      try { await exportProject(item.project); } catch (error) { setStatus(error.message || '공유 파일을 만들지 못했습니다.', true); } finally { button.disabled = false; }
    });
    modal.querySelector('#share-work-file').addEventListener('change', async event => {
      const input = event.currentTarget, file = input.files?.[0]; if (!file) return;
      try { const imported = await importProject(file); if (imported) { setStatus('작업과 사진을 가져왔습니다. 페이지를 새로고침한 뒤 저장된 일지에서 해당 월과 이름을 선택하세요.'); refresh(); } }
      catch (error) { setStatus(error.message || '공유 파일을 가져오지 못했습니다.', true); }
      finally { input.value = ''; }
    });
  }
  const observer = new MutationObserver(install);
  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });
  install();
})();
