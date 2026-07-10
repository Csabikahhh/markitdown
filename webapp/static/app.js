/* MarkItDown Web — client logic (vanilla JS, no build step). */
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  var els = {
    dropzone: $("#dropzone"),
    fileInput: $("#file-input"),
    browse: $("#browse"),
    urlInput: $("#url-input"),
    urlBtn: $("#url-btn"),
    keepOriginal: $("#keep-original"),
    search: $("#search"),
    refresh: $("#refresh"),
    list: $("#doc-list"),
    empty: $("#empty"),
    formats: $("#formats"),
    statCount: $("#stat-count"),
    statVer: $("#stat-ver"),
    statusDot: $("#status-dot"),
    // viewer
    viewer: $("#viewer"),
    viewerType: $("#viewer-type"),
    viewerTitle: $("#viewer-title"),
    viewerMeta: $("#viewer-meta"),
    panerev: $("#pane-preview"),
    paneSource: $("#pane-source"),
    copyMd: $("#copy-md"),
    dlMd: $("#dl-md"),
  };

  var state = { docs: [], current: null, currentMd: null, viewerReq: 0, searchTimer: null };

  // ---- helpers ------------------------------------------------------------

  function fmtBytes(n) {
    if (!n && n !== 0) return "—";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " kB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function fmtDate(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      return d.toLocaleString("hu-HU", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
    } catch (e) { return iso; }
  }

  function extLabel(rec) {
    if (rec.source === "url") return "URL";
    var ext = (rec.extension || "").replace(/^\./, "").toUpperCase();
    return ext || "FILE";
  }

  function badgeClass(rec) {
    if (rec.status === "error") return "err";
    if (rec.source === "url") return "url";
    // Restrict to a safe CSS-class charset — the extension is derived from an
    // attacker-influenceable filename and is interpolated into an attribute.
    return (rec.extension || "").replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // SweetAlert2 (vendored, offline) — themed to match the archive aesthetic.
  var SwalToast = Swal.mixin({
    toast: true,
    position: "bottom",
    showConfirmButton: false,
    timerProgressBar: true,
  });

  function toast(msg, kind) {
    var icon = kind === "ok" ? "success" : kind === "err" ? "error" : "info";
    SwalToast.fire({
      icon: icon,
      title: msg,
      timer: kind === "err" ? 5200 : 3200,
      customClass: { popup: "arch-toast arch-toast-" + (kind || "info") },
    });
  }

  function showProgress(text) {
    Swal.fire({
      title: text || "Feldolgozás…",
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      customClass: { popup: "arch-loading" },
      didOpen: function () { Swal.showLoading(); },
    });
  }
  function hideProgress() {
    var p = Swal.getPopup();
    if (p && p.classList.contains("arch-loading")) Swal.close();
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---- API ----------------------------------------------------------------

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          throw new Error(body.detail || ("HTTP " + r.status));
        });
      }
      return r.json();
    });
  }

  function loadHealth() {
    return fetch("/api/health").then(function (r) { return r.json(); })
      .then(function (h) {
        els.statVer.textContent = "v" + h.version;
        els.formats.textContent = (h.formats || []).join(" · ");
        els.statusDot.className = "dot ok";
        els.statusDot.title = "Kapcsolat rendben" + (h.llm_enabled ? " · LLM aktív" : "");
      })
      .catch(function () { els.statusDot.className = "dot bad"; });
  }

  function loadDocs() {
    var q = els.search.value.trim();
    var url = "/api/documents" + (q ? "?q=" + encodeURIComponent(q) : "");
    return api(url).then(function (data) {
      state.docs = data.documents || [];
      renderList();
    }).catch(function (e) { toast("A tár betöltése sikertelen: " + e.message, "err"); });
  }

  // ---- rendering ----------------------------------------------------------

  function renderList() {
    var docs = state.docs;
    els.list.innerHTML = "";
    var total = docs.length;
    els.statCount.textContent = total + (total === 1 ? " dokumentum" : " dokumentum");
    els.empty.hidden = total !== 0 || els.search.value.trim() !== "";

    if (total === 0 && els.search.value.trim() !== "") {
      els.list.innerHTML = '<div class="empty" style="grid-column:1/-1">Nincs találat a keresésre.</div>';
      return;
    }

    docs.forEach(function (rec, idx) {
      var card = document.createElement("article");
      card.className = "doc-card" + (rec.status === "error" ? " error" : "");
      card.style.animationDelay = Math.min(idx * 35, 350) + "ms";

      var isErr = rec.status === "error";
      var title = rec.title || rec.original_name || "(névtelen)";

      var meta = [];
      if (rec.has_original) meta.push("forrás " + fmtBytes(rec.size_bytes));
      if (!isErr) meta.push("md " + fmtBytes(rec.md_size_bytes));

      var actions = "";
      if (!isErr) {
        actions +=
          '<button class="btn tiny" data-act="open">Megnyitás</button>' +
          '<a class="btn tiny ghost" href="/api/documents/' + rec.id + '/download">↓ .md</a>';
      }
      if (rec.has_original) {
        actions += '<a class="btn tiny ghost" href="/api/documents/' + rec.id + '/original">Eredeti</a>';
      }
      actions += '<button class="btn tiny danger" data-act="delete">Törlés</button>';

      card.innerHTML =
        '<div class="card-top">' +
          '<span class="badge ' + badgeClass(rec) + '">' + esc(extLabel(rec)) + "</span>" +
          '<span class="card-date">' + esc(fmtDate(rec.created_at)) + "</span>" +
        "</div>" +
        '<h3 class="card-title" data-act="open">' + esc(title) + "</h3>" +
        (rec.source === "url"
          ? '<div class="card-file">' + esc(rec.source_url || "") + "</div>"
          : '<div class="card-file">' + esc(rec.original_name || "") + "</div>") +
        (isErr
          ? '<div class="card-err">Hiba: ' + esc(rec.error || "ismeretlen") + "</div>"
          : '<div class="card-meta">' + meta.map(function (m) { return "<span>" + esc(m) + "</span>"; }).join("") + "</div>") +
        '<div class="card-actions">' + actions + "</div>";

      card.addEventListener("click", function (ev) {
        var act = ev.target.getAttribute("data-act");
        if (act === "open") { openViewer(rec); }
        else if (act === "delete") { deleteDoc(rec); }
      });

      els.list.appendChild(card);
    });
  }

  // ---- viewer -------------------------------------------------------------

  function openViewer(rec) {
    state.current = rec;
    state.currentMd = null;
    var reqId = ++state.viewerReq;
    els.viewerType.textContent = extLabel(rec) + (rec.source === "url" ? " · webcím" : "");
    els.viewerTitle.textContent = rec.title || rec.original_name || "(névtelen)";
    var meta = [fmtDate(rec.created_at)];
    if (rec.has_original) meta.push("forrás " + fmtBytes(rec.size_bytes));
    meta.push("md " + fmtBytes(rec.md_size_bytes));
    els.viewerMeta.innerHTML = meta.map(function (m) { return "<span>" + esc(m) + "</span>"; }).join("");
    els.dlMd.href = "/api/documents/" + rec.id + "/download";

    els.panerev.innerHTML = '<p style="color:var(--ink-faint)">Betöltés…</p>';
    els.paneSource.textContent = "";
    setTab("preview");
    els.viewer.hidden = false;
    document.body.style.overflow = "hidden";

    fetch("/api/documents/" + rec.id + "/markdown")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (md) {
        if (reqId !== state.viewerReq) return; // a newer document was opened
        state.currentMd = md;
        els.paneSource.textContent = md;
        els.panerev.innerHTML = window.renderMarkdown(md) ||
          '<p style="color:var(--ink-faint)">(üres dokumentum)</p>';
      })
      .catch(function (e) {
        if (reqId !== state.viewerReq) return;
        els.panerev.innerHTML = '<p style="color:var(--danger)">Nem sikerült betölteni: ' + esc(e.message) + "</p>";
      });
  }

  function closeViewer() {
    els.viewer.hidden = true;
    document.body.style.overflow = "";
    state.current = null;
  }

  function setTab(name) {
    var tabs = els.viewer.querySelectorAll(".tab");
    tabs.forEach(function (t) { t.classList.toggle("is-active", t.getAttribute("data-tab") === name); });
    els.panerev.hidden = name !== "preview";
    els.paneSource.hidden = name !== "source";
  }

  // ---- actions ------------------------------------------------------------

  function uploadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    var fd = new FormData();
    files.forEach(function (f) { fd.append("files", f, f.name); });
    fd.append("keep_original", els.keepOriginal.checked ? "true" : "false");

    showProgress(files.length === 1 ? "„" + files[0].name + "” feldolgozása…" : files.length + " fájl feldolgozása…");

    api("/api/convert", { method: "POST", body: fd })
      .then(function (data) {
        hideProgress();
        var docs = data.documents || [];
        var ok = docs.filter(function (d) { return d.status === "ok"; }).length;
        var bad = docs.length - ok;
        if (ok && !bad) toast(ok + " dokumentum konvertálva és elmentve.", "ok");
        else if (ok && bad) toast(ok + " kész, " + bad + " sikertelen.", "err");
        else if (bad) toast(bad + " fájl konvertálása nem sikerült.", "err");
        return loadDocs();
      })
      .then(loadHealth)
      .catch(function (e) { hideProgress(); toast("Feltöltési hiba: " + e.message, "err"); });
  }

  function convertUrl() {
    var url = els.urlInput.value.trim();
    if (!url) { toast("Adj meg egy URL-t.", "err"); return; }
    showProgress("Webcím feldolgozása…");
    api("/api/convert-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url }),
    })
      .then(function (data) {
        hideProgress();
        var d = (data.documents || [])[0];
        if (d && d.status === "ok") { toast("A webcím konvertálva.", "ok"); els.urlInput.value = ""; }
        else { toast("A webcím konvertálása nem sikerült" + (d && d.error ? ": " + d.error : "."), "err"); }
        return loadDocs();
      })
      .then(loadHealth)
      .catch(function (e) { hideProgress(); toast("Hiba: " + e.message, "err"); });
  }

  function deleteDoc(rec) {
    Swal.fire({
      title: "Törlés megerősítése",
      html: "Biztosan törlöd ezt a dokumentumot?<br><strong>" + esc(rec.title || rec.original_name) + "</strong>",
      icon: "warning",
      showCancelButton: true,
      focusCancel: true,
      confirmButtonText: "Törlés",
      cancelButtonText: "Mégse",
      customClass: { popup: "arch-dialog" },
    }).then(function (res) {
      if (!res.isConfirmed) return;
      api("/api/documents/" + rec.id, { method: "DELETE" })
        .then(function () {
          toast("Dokumentum törölve.", "ok");
          if (state.current && state.current.id === rec.id) closeViewer();
          return loadDocs();
        })
        .then(loadHealth)
        .catch(function (e) { toast("Törlés sikertelen: " + e.message, "err"); });
    });
  }

  // ---- events -------------------------------------------------------------

  function wire() {
    els.browse.addEventListener("click", function () { els.fileInput.click(); });
    els.dropzone.addEventListener("click", function (e) {
      if (e.target === els.browse) return;
      els.fileInput.click();
    });
    els.dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
    });
    els.fileInput.addEventListener("change", function () {
      uploadFiles(els.fileInput.files);
      els.fileInput.value = "";
    });

    ["dragenter", "dragover"].forEach(function (ev) {
      els.dropzone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        els.dropzone.classList.add("drag");
      });
    });
    ["dragleave", "dragend"].forEach(function (ev) {
      els.dropzone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        els.dropzone.classList.remove("drag");
      });
    });
    els.dropzone.addEventListener("drop", function (e) {
      e.preventDefault(); e.stopPropagation();
      els.dropzone.classList.remove("drag");
      if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
    });
    // Prevent the browser from opening files dropped outside the zone.
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) { e.preventDefault(); });

    els.urlBtn.addEventListener("click", convertUrl);
    els.urlInput.addEventListener("keydown", function (e) { if (e.key === "Enter") convertUrl(); });

    els.search.addEventListener("input", function () {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(loadDocs, 220);
    });
    els.refresh.addEventListener("click", function () {
      els.refresh.classList.remove("spin");
      void els.refresh.offsetWidth; // restart animation
      els.refresh.classList.add("spin");
      loadDocs(); loadHealth();
    });

    // Viewer
    els.viewer.addEventListener("click", function (e) {
      // Use closest() so clicks on the icon <svg>/<path> inside a button resolve.
      if (e.target.closest("[data-close]")) { closeViewer(); return; }
      var tabEl = e.target.closest("[data-tab]");
      if (tabEl) setTab(tabEl.getAttribute("data-tab"));
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !els.viewer.hidden) closeViewer();
    });
    els.copyMd.addEventListener("click", function () {
      if (state.currentMd == null) { toast("A dokumentum még töltődik…", "err"); return; }
      var text = state.currentMd;
      if (!navigator.clipboard) { toast("A másolás ebben a böngészőben nem érhető el.", "err"); return; }
      navigator.clipboard.writeText(text).then(
        function () { toast("Markdown a vágólapra másolva.", "ok"); },
        function () { toast("A másolás nem sikerült.", "err"); }
      );
    });
  }

  // ---- boot ---------------------------------------------------------------

  wire();
  loadHealth();
  loadDocs();
})();
