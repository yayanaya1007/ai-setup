(() => {
  "use strict";
  const prefix = "volunteer-journal:";
  const buttonClass = "journal-delete-action";

  function readSaved() {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      try {
        const project = JSON.parse(localStorage.getItem(key) || "null");
        if (project && project.month && project.name && Array.isArray(project.records)) {
          items.push({ key, project });
        }
      } catch {}
    }
    return items.sort((a, b) =>
      b.project.month.localeCompare(a.project.month) ||
      a.project.name.localeCompare(b.project.name, "ko")
    );
  }

  function button(label, danger) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = buttonClass;
    el.textContent = label;
    el.style.cssText = "border:1px solid " + (danger ? "#dc2626" : "#cbd5e1") +
      ";border-radius:8px;background:" + (danger ? "#fff7f7" : "#fff") +
      ";color:" + (danger ? "#b91c1c" : "#233b5d") +
      ";padding:8px 11px;font:600 14px/1.3 inherit;cursor:pointer;white-space:nowrap";
    return el;
  }

  const style = document.createElement("style");
  style.textContent = "#journal-delete-manager{width:min(720px,calc(100vw - 24px));max-width:none;max-height:86vh;padding:0;border:0;border-radius:14px;box-shadow:0 18px 60px #10213b55;color:#18304f}#journal-delete-manager::backdrop{background:#101b2b88}.jdm-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px;background:#fff;border-bottom:1px solid #e4eaf2}.jdm-head h2{margin:0;font-size:19px}.jdm-head p{margin:4px 0 0;color:#63738b;font-size:13px}.jdm-body{padding:14px 18px 20px;overflow:auto;max-height:calc(86vh - 90px)}.jdm-card{margin:0 0 12px;padding:14px;border:1px solid #dce4ef;border-radius:11px;background:#fff}.jdm-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.jdm-card-title{font-weight:700}.jdm-days{display:grid;gap:7px;margin-top:12px}.jdm-day{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;background:#f6f8fb;border-radius:8px}.jdm-day span{font-size:14px}.jdm-empty{padding:20px;text-align:center;color:#63738b}.jdm-help{margin:0 0 12px;color:#63738b;font-size:13px;line-height:1.5}@media(max-width:520px){.jdm-card-head,.jdm-day{align-items:flex-start}.jdm-head{padding:15px}.jdm-body{padding:12px}.jdm-day{flex-direction:column}.jdm-day button,.jdm-card-head button{width:100%}}";
  document.head.appendChild(style);

  const dialog = document.createElement("dialog");
  dialog.id = "journal-delete-manager";
  dialog.setAttribute("aria-labelledby", "jdm-title");
  const head = document.createElement("div");
  head.className = "jdm-head";
  const titleWrap = document.createElement("div");
  const title = document.createElement("h2");
  title.id = "jdm-title";
  title.textContent = "저장한 일지 삭제";
  const subtitle = document.createElement("p");
  subtitle.textContent = "잘못 입력한 날짜의 일지나 활동가별 월 자료를 삭제할 수 있습니다.";
  titleWrap.append(title, subtitle);
  const close = button("닫기", false);
  close.addEventListener("click", () => dialog.close());
  head.append(titleWrap, close);
  const body = document.createElement("div");
  body.className = "jdm-body";
  dialog.append(head, body);
  document.body.appendChild(dialog);

  function warnUnsaved() {
    const dirty = Array.from(document.querySelectorAll(".header-actions button"))
      .some(el => (el.textContent || "").includes("작업 저장"));
    return dirty ? "\n저장하지 않은 현재 입력 내용도 새로고침하면 사라집니다." : "";
  }

  function projectKey(project) {
    return prefix + project.month + "|" + encodeURIComponent(project.name.trim());
  }

  function removeUnreferencedFiles(ids) {
    const stillUsed = new Set();
    for (const item of readSaved()) {
      for (const asset of item.project.assets || []) if (asset && asset.id) stillUsed.add(asset.id);
    }
    const remove = [...new Set(ids)].filter(id => id && !stillUsed.has(id));
    if (!remove.length || !window.indexedDB) return Promise.resolve();
    return new Promise(resolve => {
      let req;
      try { req = indexedDB.open("volunteer-journal-files", 1); } catch { resolve(); return; }
      req.onerror = () => resolve();
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("files")) { db.close(); resolve(); return; }
        let tx;
        try {
          tx = db.transaction("files", "readwrite");
          const store = tx.objectStore("files");
          remove.forEach(id => store.delete(id));
        } catch { db.close(); resolve(); return; }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); resolve(); };
      };
    });
  }

  async function finishDelete(fileIds) {
    await removeUnreferencedFiles(fileIds);
    dialog.close();
    alert("삭제했습니다.");
    window.addEventListener("beforeunload", event => event.stopImmediatePropagation(), { capture: true, once: true });
    window.location.reload();
  }

  async function deleteDay(item, record) {
    const project = item.project;
    const unsaved = warnUnsaved();
    if (!window.confirm(project.name + "님 · " + record.date + " 일지를 삭제하시겠습니까?" +
      unsaved + "\n삭제한 일지는 복구할 수 없습니다.")) return;
    const records = project.records.filter(row => row.date !== record.date);
    const usedSources = new Set(records.map(row => row.sourceId).filter(Boolean));
    let assetsToRemove;
    if (!records.length) {
      assetsToRemove = project.assets || [];
      localStorage.removeItem(item.key);
    } else {
      assetsToRemove = (project.assets || []).filter(asset =>
        (asset.kind === "photo" && asset.date === record.date) ||
        (asset.kind === "source" && asset.id === record.sourceId && !usedSources.has(asset.id))
      );
      const removeIds = new Set(assetsToRemove.map(asset => asset.id));
      localStorage.setItem(item.key, JSON.stringify({
        ...project,
        records,
        assets: (project.assets || []).filter(asset => !removeIds.has(asset.id))
      }));
    }
    await finishDelete(assetsToRemove.map(asset => asset.id));
  }

  async function deleteMonth(item) {
    const project = item.project;
    if (!window.confirm(project.name + "님의 " + project.month +
      " 활동일지와 출근부 자료를 모두 삭제하시겠습니까?" + warnUnsaved() +
      "\n삭제한 자료는 복구할 수 없습니다.")) return;
    const ids = (project.assets || []).map(asset => asset.id);
    localStorage.removeItem(item.key);
    await finishDelete(ids);
  }

  function render() {
    body.replaceChildren();
    const help = document.createElement("p");
    help.className = "jdm-help";
    help.textContent = "날짜 하나만 삭제하면 그 날짜 기록만 지워집니다. 월 자료 전체 삭제는 해당 활동가의 그 달 기록과 올린 파일을 함께 지웁니다.";
    body.appendChild(help);
    const items = readSaved();
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "jdm-empty";
      empty.textContent = "저장된 일지가 없습니다.";
      body.appendChild(empty);
      return;
    }
    for (const item of items) {
      const project = item.project;
      const card = document.createElement("section");
      card.className = "jdm-card";
      const cardHead = document.createElement("div");
      cardHead.className = "jdm-card-head";
      const label = document.createElement("div");
      label.className = "jdm-card-title";
      label.textContent = project.name + " · " + project.month + " · " + project.records.length + "일";
      const allButton = button("이 월 자료 전체 삭제", true);
      allButton.addEventListener("click", () => deleteMonth(item));
      cardHead.append(label, allButton);
      card.appendChild(cardHead);
      const days = document.createElement("div");
      days.className = "jdm-days";
      for (const record of [...project.records].sort((a, b) => b.date.localeCompare(a.date))) {
        const row = document.createElement("div");
        row.className = "jdm-day";
        const date = document.createElement("span");
        date.textContent = record.date + (record.name && record.name !== project.name ? " · " + record.name : "");
        const removeButton = button("이 날짜 삭제", true);
        removeButton.addEventListener("click", () => deleteDay(item, record));
        row.append(date, removeButton);
        days.appendChild(row);
      }
      card.appendChild(days);
      body.appendChild(card);
    }
  }

  function attach() {
    const bar = document.querySelector(".saved-journals");
    if (!bar || bar.querySelector("[data-journal-delete-manager]")) return;
    const opener = button("저장 자료 관리·삭제", false);
    opener.setAttribute("data-journal-delete-manager", "true");
    opener.setAttribute("aria-haspopup", "dialog");
    opener.addEventListener("click", () => { render(); dialog.showModal(); });
    const select = bar.querySelector("select");
    if (select) select.insertAdjacentElement("afterend", opener);
  }

  new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true });
  attach();
})();