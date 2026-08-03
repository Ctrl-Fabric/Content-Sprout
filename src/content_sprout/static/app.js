/**
 * Content-sprout — project workspace, asset library, and post editor.
 */

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtTime = (iso) => new Date(iso).toLocaleString();
const uid = () => Math.random().toString(36).slice(2, 14);

const SORT_CREATED = "created";
const SORT_MODIFIED = "modified";
const PROJECT_SORT_KEY = "content-sprout.projectSort";
const POST_SORT_KEY = "content-sprout.postSort";

function loadSortPref(key, fallback = SORT_CREATED) {
  try {
    const v = localStorage.getItem(key);
    if (v === SORT_CREATED || v === SORT_MODIFIED) return v;
  } catch (_) { /* ignore */ }
  return fallback;
}

function saveSortPref(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* ignore */ }
}

let projectSort = loadSortPref(PROJECT_SORT_KEY, SORT_CREATED);
let postSort = loadSortPref(POST_SORT_KEY, SORT_CREATED);

function sortByDateField(items, mode) {
  const field = mode === SORT_MODIFIED ? "updated_at" : "created_at";
  return [...(items || [])].sort((a, b) => {
    const av = a?.[field] || a?.created_at || "";
    const bv = b?.[field] || b?.created_at || "";
    if (av === bv) return String(a?.name || "").localeCompare(String(b?.name || ""));
    return av < bv ? 1 : -1; // newest first
  });
}

function syncSortSelect(id, value) {
  const el = $(id);
  if (el && el.value !== value) el.value = value;
}

// ---------- Toast & confirm (shared) ----------
const toast = (msg, kind = "info") => {
  const t = $("toast");
  const box = t.firstElementChild;
  box.className = "glass border rounded-xl px-4 py-3 text-sm shadow-2xl " +
    (kind === "error" ? "border-red-400/30 text-red-200"
      : kind === "ok" ? "border-emerald-400/30 text-emerald-200"
        : "border-white/10 text-slate-200");
  box.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2800);
};

const confirmDialog = ({
  title = "Are you sure?",
  message = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false,
  footnote = "Please confirm — this action cannot be undone.",
} = {}) => {
  return new Promise((resolve) => {
    const dlg = $("confirmDialog");
    const okBtn = $("confirmOk");
    const cancelBtn = $("confirmCancel");
    if (!dlg || !okBtn || !cancelBtn) {
      resolve(window.confirm(`${title}\n\n${message}`));
      return;
    }
    $("confirmTitle").textContent = title;
    $("confirmMessage").textContent = message;
    const note = $("confirmFootnote");
    if (note) {
      note.textContent = footnote || "";
      note.classList.toggle("hidden", !footnote);
    }
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    okBtn.className = "text-sm px-4 py-2 rounded-lg border transition " +
      (danger ? "bg-red-500/15 border-red-400/40 text-red-100 hover:bg-red-500/25"
        : "bg-indigo-500/10 border-indigo-400/30 text-indigo-200 hover:bg-indigo-500/20");
    cancelBtn.className = "text-sm px-4 py-2 rounded-lg border border-white/10 text-slate-300 hover:text-white hover:border-white/20 transition";
    const openedAt = Date.now();
    const lastFocus = document.activeElement;
    const cleanup = (result) => {
      dlg.classList.add("hidden");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dlg.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
      if (lastFocus?.focus) try { lastFocus.focus(); } catch (_) {}
      resolve(result);
    };
    const onOk = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup(true);
    };
    const onCancel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup(false);
    };
    const onBackdrop = (e) => { if (e.target === dlg) cleanup(false); };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(false);
        return;
      }
      // Ignore Enter briefly after open so the key that triggered Delete
      // cannot also confirm the dialog (common accidental-delete path).
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() - openedAt < 400) return;
        // For destructive confirms, require an explicit click — not Enter.
        if (danger) return;
        cleanup(true);
      }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dlg.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey, true);
    dlg.classList.remove("hidden");
    // Prefer Cancel focus on destructive actions.
    setTimeout(() => {
      try { (danger ? cancelBtn : okBtn).focus(); } catch (_) {}
    }, 0);
  });
};

/** In-app multi-choice dialog. Resolves to the chosen ``id``, or ``null`` if cancelled. */
const choiceDialog = ({
  title = "Choose",
  message = "",
  footnote = "",
  cancelText = "Cancel",
  choices = [],
} = {}) => {
  return new Promise((resolve) => {
    const dlg = $("choiceDialog");
    const actions = $("choiceActions");
    if (!dlg || !actions || !choices.length) {
      resolve(null);
      return;
    }
    $("choiceTitle").textContent = title;
    $("choiceMessage").textContent = message || "";
    const note = $("choiceFootnote");
    if (note) {
      note.textContent = footnote || "";
      note.classList.toggle("hidden", !footnote);
    }
    const lastFocus = document.activeElement;
    const buttons = [];
    const cleanup = (result) => {
      dlg.classList.add("hidden");
      buttons.forEach(({ el, handler }) => el.removeEventListener("click", handler));
      dlg.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
      actions.innerHTML = "";
      if (lastFocus?.focus) try { lastFocus.focus(); } catch (_) {}
      resolve(result);
    };
    const onBackdrop = (e) => { if (e.target === dlg) cleanup(null); };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(null);
      }
    };
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = cancelText;
    cancelBtn.className = "text-sm px-4 py-2 rounded-lg border border-white/10 text-slate-300 hover:text-white hover:border-white/20 transition";
    const onCancel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup(null);
    };
    cancelBtn.addEventListener("click", onCancel);
    buttons.push({ el: cancelBtn, handler: onCancel });
    actions.appendChild(cancelBtn);

    let focusBtn = cancelBtn;
    choices.forEach((choice, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = choice.label || choice.id;
      const danger = !!choice.danger;
      const primary = !!choice.primary || (!danger && idx === choices.length - 1);
      btn.className = "text-sm px-4 py-2 rounded-lg border transition " +
        (danger
          ? "bg-red-500/15 border-red-400/40 text-red-100 hover:bg-red-500/25"
          : primary
            ? "bg-indigo-500/10 border-indigo-400/30 text-indigo-200 hover:bg-indigo-500/20"
            : "bg-white/5 border-white/15 text-slate-200 hover:bg-white/10");
      const onPick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        cleanup(choice.id);
      };
      btn.addEventListener("click", onPick);
      buttons.push({ el: btn, handler: onPick });
      actions.appendChild(btn);
      if (primary && !danger) focusBtn = btn;
      if (danger) focusBtn = cancelBtn;
    });

    dlg.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey, true);
    dlg.classList.remove("hidden");
    setTimeout(() => {
      try { focusBtn.focus(); } catch (_) {}
    }, 0);
  });
};

/** In-app text prompt. Resolves to the entered string, or ``null`` if cancelled. */
const promptDialog = ({
  title = "Input",
  message = "",
  defaultValue = "",
  confirmText = "OK",
  cancelText = "Cancel",
  placeholder = "",
  multiline = false,
  maxLength = null,
} = {}) => {
  return new Promise((resolve) => {
    const dlg = $("promptDialog");
    const form = $("promptForm");
    const okBtn = $("promptOk");
    const cancelBtn = $("promptCancel");
    const input = $("promptInput");
    const textarea = $("promptTextarea");
    if (!dlg || !form || !okBtn || !cancelBtn || !input || !textarea) {
      resolve(window.prompt(message || title, defaultValue));
      return;
    }
    $("promptTitle").textContent = title;
    const msgEl = $("promptMessage");
    if (msgEl) {
      msgEl.textContent = message || "";
      msgEl.classList.toggle("hidden", !message);
    }
    const field = multiline ? textarea : input;
    const other = multiline ? input : textarea;
    other.classList.add("hidden");
    field.classList.remove("hidden");
    field.value = defaultValue ?? "";
    field.placeholder = placeholder || "";
    if (maxLength != null) field.maxLength = maxLength;
    else field.removeAttribute("maxLength");
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    const lastFocus = document.activeElement;
    const cleanup = (result) => {
      dlg.classList.add("hidden");
      form.removeEventListener("submit", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
      dlg.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
      if (lastFocus?.focus) try { lastFocus.focus(); } catch (_) {}
      resolve(result);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup(field.value);
    };
    const onCancel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup(null);
    };
    const onBackdrop = (e) => { if (e.target === dlg) cleanup(null); };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(null);
      }
    };
    form.addEventListener("submit", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
    dlg.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey, true);
    dlg.classList.remove("hidden");
    setTimeout(() => {
      try {
        field.focus();
        if (typeof field.select === "function") field.select();
      } catch (_) { /* ignore */ }
    }, 0);
  });
};

// ---------- App state ----------
let config = { formats: ["square", "portrait", "landscape", "story"] };
let projects = [];
let currentProject = null;
let currentPost = null;
let activeTab = "hub"; // "hub" | "editor"
let activeFeature = "post-creator"; // "post-creator" | "media-manager"
let editorSideTab = "project-assets"; // "project-assets" | "post-assets"
let assetLibraryTab = "image"; // "image" | "video" | "audio" | "logos"
let assetPaletteTab = "image"; // "image" | "video" | "audio"
let assetGroupFilter = "__all__"; // "__all__" | group name | "__ungrouped__"
let activeSceneId = null;
let selectedLayerId = null;
let propsOverlayOpen = false;
let ttsVoicesCache = null;
let saveTimer = null;
let dragAssetId = null;

// Free assets browser
let freeAssetsType = "all";
let freeAssetsPage = 1;
let freeAssetsQuery = "";
let freeAssetsCaps = null;
let freeAssetsLastTotal = 0;

// Media Manager
let mmTab = "local"; // "local" | "publish"
let mmFolders = [];
let mmActiveFolderId = null;
let mmFiles = [];
let mmSelectedPaths = new Set();
let mmPlatforms = [];
let mmPackages = [];
let mmSearchTimer = null;
let mmBrowsePath = "";
let mmBrowseParent = null;
/** @type {null | { path: string, name?: string, type?: string }} */
let mmPreviewEditFile = null;

const BACKGROUND_ID = "__background__";
const FORMAT_ASPECT = {
  square: "1 / 1",
  portrait: "4 / 5",
  landscape: "1080 / 566",
  story: "9 / 16",
};
/** width / height for fitting the editor stage inside the frame */
const FORMAT_ASPECT_RATIO = {
  square: 1,
  portrait: 4 / 5,
  landscape: 1080 / 566,
  story: 9 / 16,
};
let canvasDrag = null;
/** @type {string | null} */
let selectedMaskId = null;
let maskDrawMode = false;
/** @type {null | { mode: string, layerId: string, maskId?: string, handle?: string, startLocal: {x:number,y:number}, orig?: object }} */
let maskDrag = null;
let previewTimeS = 0;
let previewAbsS = 0;
let previewPlaying = false;
let previewZoom = 1; // 0.5 … 3 — scales the editor stage for edge placement
const PREVIEW_ZOOM_MIN = 0.5;
const PREVIEW_ZOOM_MAX = 3;
const PREVIEW_ZOOM_STEP = 0.25;
let previewPlayLastTs = 0;
let previewPlayRaf = 0;
/** @type {Map<string, { audio: HTMLAudioElement, url: string, startAbs: number, duration: number, volume: number }>} */
const previewAudioPlayers = new Map();
/** @type {Map<string, HTMLVideoElement>} */
const previewVideoEls = new Map();

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Load an image URL and return width/height aspect (w/h). */
function measureImageAspect(url) {
  if (!url) return Promise.resolve(1);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 1;
      const h = img.naturalHeight || 1;
      resolve(w / Math.max(1, h));
    };
    img.onerror = () => resolve(1);
    img.src = url;
  });
}

function measureVideoAspect(url) {
  if (!url) return Promise.resolve(16 / 9);
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        v.removeAttribute("src");
        v.load();
      } catch (_) { /* ignore */ }
      resolve(value);
    };
    v.onloadedmetadata = () => {
      const w = v.videoWidth || 1;
      const h = v.videoHeight || 1;
      finish(w / Math.max(1, h));
    };
    v.onerror = () => finish(16 / 9);
    setTimeout(() => finish(16 / 9), 4000);
    v.src = url;
  });
}

/**
 * Aspect ratio for an image asset as it will appear on the canvas.
 * Processed Instagram formats use the format aspect; otherwise measure pixels.
 */
function resolveImageLayerAspect(asset, format) {
  if (!asset) return Promise.resolve(1);
  const fmt = format || "original";
  if (fmt !== "original" && asset.processed_formats?.[fmt] && FORMAT_ASPECT_RATIO[fmt]) {
    return Promise.resolve(FORMAT_ASPECT_RATIO[fmt]);
  }
  const url = getAssetPreviewUrl(asset, fmt)
    || (asset.original_path ? assetFileUrl(currentProject.id, asset.original_path) : null);
  return measureImageAspect(url);
}

function resolveMediaLayerAspect(layer) {
  const asset = getAssetById(layer?.asset_id);
  if (!asset) return Promise.resolve(1);
  if (layer.type === "video" || asset.type === "video") {
    return measureVideoAspect(getAssetPreviewUrl(asset));
  }
  return resolveImageLayerAspect(asset, layer.use_format || getTargetFormat());
}

/** Fit a width×height % box to `aspect` inside a maxPct×maxPct area (or full canvas). */
function layerSizeFromAspect(aspect, { maxPct = 40, asBottom = false } = {}) {
  const ar = Math.max(0.05, Number(aspect) || 1);
  if (asBottom) return { width: 100, height: 100 };
  let width = maxPct;
  let height = width / ar;
  if (height > maxPct) {
    height = maxPct;
    width = height * ar;
  }
  // Keep odd floats out of post.json / number inputs.
  return {
    width: Math.round(width * 10) / 10,
    height: Math.round(height * 10) / 10,
  };
}

/**
 * Keep at least `minVisible` percent of the layer overlapping the canvas so
 * layers can hang off-screen but remain selectable.
 */
function clampLayerVisibility(layer, minVisible = 8) {
  if (!layer) return;
  const w = Math.max(1, Number(layer.width) || 1);
  const h = Math.max(1, Number(layer.height) || 1);
  const mvW = Math.min(minVisible, w);
  const mvH = Math.min(minVisible, h);
  layer.x = clamp(Number(layer.x) || 0, mvW - w, 100 - mvW);
  layer.y = clamp(Number(layer.y) || 0, mvH - h, 100 - mvH);
}

/** Resize an image/video layer box to the asset aspect, keeping the visual center. */
async function fitMediaLayerToAsset(layer, { maxPct = null, preserveCenter = true, asBottom = false } = {}) {
  if (!layer || (layer.type !== "image" && layer.type !== "video") || !layer.asset_id || !currentProject) {
    return;
  }
  const aspect = await resolveMediaLayerAspect(layer);
  const cx = (Number(layer.x) || 0) + (Number(layer.width) || 0) / 2;
  const cy = (Number(layer.y) || 0) + (Number(layer.height) || 0) / 2;
  if (asBottom) {
    layer.x = 0;
    layer.y = 0;
    layer.width = 100;
    layer.height = 100;
    return;
  }
  const cap = maxPct != null
    ? maxPct
    : Math.max(layer.width, layer.height, 20);
  const size = layerSizeFromAspect(aspect, { maxPct: Math.min(100, cap) });
  layer.width = size.width;
  layer.height = size.height;
  if (preserveCenter) {
    layer.x = cx - layer.width / 2;
    layer.y = cy - layer.height / 2;
  }
  clampLayerVisibility(layer);
}

async function fitImageLayerToAsset(layer, opts = {}) {
  return fitMediaLayerToAsset(layer, opts);
}

function getTargetFormat() {
  return $("targetFormat")?.value || currentPost?.target_format || "portrait";
}

function getBackgroundInfo() {
  if (!currentPost) return { assetId: null, format: "portrait" };
  if (currentPost.type === "video") {
    const scene = getActiveScene();
    return {
      assetId: scene?.background_asset_id || null,
      format: scene?.background_format || getTargetFormat(),
    };
  }
  return {
    assetId: currentPost.background_asset_id || null,
    format: currentPost.background_format || getTargetFormat(),
  };
}

function getAssetById(assetId) {
  return currentProject?.assets?.find((a) => a.id === assetId) || null;
}

function downloadProjectAsset(assetId) {
  if (!currentProject) return;
  const asset = getAssetById(assetId);
  if (!asset?.original_path) {
    toast("No file available to download", "error");
    return;
  }
  if (asset.locked) {
    toast("Locked stock assets cannot be downloaded outside the app", "error");
    return;
  }
  const a = document.createElement("a");
  a.href = `/api/projects/${encodeURIComponent(currentProject.id)}/assets/${encodeURIComponent(assetId)}/download`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function downloadAllProjectAssets() {
  if (!currentProject) return;
  const assets = projectSharedAssets().filter((a) => a.original_path);
  if (!assets.length) {
    toast("No shared project assets to download", "info");
    return;
  }
  const btn = $("downloadAllAssetsBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/assets/zip`);
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(detailMessage(data, `HTTP ${r.status}`));
    }
    const blob = await r.blob();
    const cd = r.headers.get("Content-Disposition") || "";
    const match = /filename="([^"]+)"/i.exec(cd);
    const filename = match?.[1] || `${currentProject.name || "project"}-assets.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`Downloaded ${assets.length} asset${assets.length === 1 ? "" : "s"}`, "ok");
  } catch (e) {
    toast(`Download failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Download all"; }
  }
}

/** Project-level assets + assets owned by the given post (default: current post). */
function visibleAssets(postId = currentPost?.id || null) {
  return (currentProject?.assets || []).filter((a) => {
    if (!a.post_id) return true;
    return !!postId && a.post_id === postId;
  });
}

function assetScopeBadge(asset) {
  if (!asset?.post_id) {
    return `<span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-400 shrink-0">Project</span>`;
  }
  const post = (currentProject?.posts || []).find((p) => p.id === asset.post_id);
  const name = post?.name || "Post";
  const mine = currentPost?.id && asset.post_id === currentPost.id;
  return `<span class="text-[9px] px-1.5 py-0.5 rounded shrink-0 ${
    mine ? "bg-indigo-500/20 text-indigo-200" : "bg-amber-500/15 text-amber-200/90"
  }" title="Post-scoped asset">${escapeHtml(mine ? "This post" : name)}</span>`;
}

function getAssetPreviewUrl(asset, format) {
  if (!asset || !currentProject) return null;
  let rel = null;
  if (asset.type === "image") {
    // Prefer processed format when ready; otherwise fall back to original so
    // backgrounds still preview while (or if) processing is in flight.
    // "original" is used for branding logos that skip Instagram format processing.
    if (format === "original") {
      rel = asset.original_path;
    } else if (asset.status === "ready") {
      rel = asset.processed_formats?.[format]
        || asset.processed_formats?.portrait
        || asset.processed_formats?.thumb
        || asset.original_path;
    } else {
      rel = asset.original_path
        || asset.processed_formats?.[format]
        || asset.processed_formats?.thumb;
    }
  } else if (asset.type === "video") {
    rel = asset.original_path;
  }
  if (!rel) return null;
  const bust = asset.updated_at ? `&t=${encodeURIComponent(asset.updated_at)}` : "";
  return `${assetFileUrl(currentProject.id, rel)}${bust}`;
}

function getAssetThumbUrl(asset) {
  if (!asset || !currentProject) return null;
  if (asset.type === "image") {
    const rel = asset.processed_formats?.thumb
      || asset.processed_formats?.portrait
      || asset.processed_formats?.square
      || asset.original_path;
    if (!rel) return null;
    return assetFileUrl(currentProject.id, rel);
  }
  if (asset.type === "video") {
    const rel = asset.processed_formats?.thumb;
    if (!rel) return null;
    const bust = asset.updated_at ? `&t=${encodeURIComponent(asset.updated_at)}` : "";
    return `${assetFileUrl(currentProject.id, rel)}${bust}`;
  }
  return null;
}

function availableImageFormats(asset) {
  const all = config.formats || ["square", "portrait", "landscape", "story"];
  const ready = all.filter((f) => asset?.processed_formats?.[f]);
  if (ready.length) return ready;
  // Branding logos (and any image without IG variants) stay usable via original.
  if (asset?.original_path) return ["original"];
  return [];
}

function dismissAssetFormatMenu() {
  document.getElementById("assetFormatMenu")?.remove();
  document.removeEventListener("keydown", onFormatMenuKeydown, true);
}

function onFormatMenuKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    dismissAssetFormatMenu();
  }
}

/** Show a floating format picker. Resolves with format string or null if cancelled. */
function pickImageFormat(asset, clientX, clientY) {
  const formats = availableImageFormats(asset);
  if (asset?.status === "ready" && formats.length > 1) {
    return new Promise((resolve) => {
      dismissAssetFormatMenu();
      const menu = document.createElement("div");
      menu.id = "assetFormatMenu";
      menu.className = "asset-format-menu";
      const hints = {
        square: "1:1",
        portrait: "4:5",
        landscape: "1.91:1",
        story: "9:16",
        original: "as uploaded",
      };
      menu.innerHTML = `
        <div class="asset-format-menu-title">Choose format</div>
        ${formats.map((f) => `
          <button type="button" data-format="${f}">
            <span>${f}</span>
            <span class="fmt-hint">${hints[f] || ""}</span>
          </button>`).join("")}
        <button type="button" class="asset-format-menu-cancel" data-format="">Cancel</button>`;
      document.body.appendChild(menu);
      const pad = 8;
      const rect = menu.getBoundingClientRect();
      let left = clientX;
      let top = clientY;
      if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
      if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
      left = Math.max(pad, left);
      top = Math.max(pad, top);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;

      const finish = (value) => {
        dismissAssetFormatMenu();
        document.removeEventListener("mousedown", onDocDown, true);
        resolve(value);
      };
      const onDocDown = (ev) => {
        if (!menu.contains(ev.target)) finish(null);
      };
      menu.querySelectorAll("button[data-format]").forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const fmt = btn.dataset.format;
          finish(fmt || null);
        });
      });
      document.addEventListener("mousedown", onDocDown, true);
      document.addEventListener("keydown", onFormatMenuKeydown, true);
    });
  }
  if (formats.length === 1) return Promise.resolve(formats[0]);
  return Promise.resolve(getTargetFormat());
}

function selectLayer(layerId) {
  // Persist in-progress property edits before tearing down / switching layers.
  flushLayerPropsFromDom();
  selectedLayerId = layerId;
  selectedMaskId = null;
  setMaskDrawMode(false);
  propsOverlayOpen = layerId != null;
  if (layerId != null) closeAiPanel();
  renderLayerList();
  renderLayerProperties();
  renderLayerOverlays();
  if (currentPost?.type === "video") renderSceneGantt();
  // Preview stays put; left column may have swapped — reflow stage sizing.
  requestAnimationFrame(() => fitEditorStage());
}

function closeLayerPropsOverlay() {
  flushLayerPropsFromDom();
  propsOverlayOpen = false;
  selectedLayerId = null;
  selectedMaskId = null;
  setMaskDrawMode(false);
  const overlay = $("layerPropsOverlay");
  if (overlay) overlay.classList.add("hidden");
  syncLeftColumnMode(false);
  renderLayerList();
  renderLayerOverlays();
  if (currentPost?.type === "video") renderSceneGantt();
  requestAnimationFrame(() => fitEditorStage());
}

/** Swap timeline column props open/closed — keep the gantt visible so mask timing stays editable. */
function syncLeftColumnMode(showProps) {
  const main = $("editorLeftMain");
  const overlay = $("layerPropsOverlay");
  const col = main?.closest(".editor-timeline-column") || overlay?.closest(".editor-timeline-column");
  if (main) main.classList.remove("hidden");
  if (overlay) overlay.classList.toggle("hidden", !showProps);
  col?.classList.toggle("has-props", !!showProps);
}

function syncPropsOverlayVisibility(hasContent) {
  const show = propsOverlayOpen && hasContent;
  syncLeftColumnMode(show);
}

function getSceneDuration() {
  const scene = getActiveScene();
  return scene?.duration_s ?? 5;
}

function defaultLayerTiming() {
  const dur = getSceneDuration();
  return { start_s: 0, duration_s: dur };
}

function layerEffectiveDuration(layer, sceneDur = null) {
  const sceneLen = Math.max(
    0.5,
    Number(sceneDur != null ? sceneDur : getSceneDuration()) || 5,
  );
  const start = Math.max(0, Number(layer?.start_s) || 0);
  const raw = layer?.duration_s;
  if (raw != null && Number.isFinite(Number(raw))) {
    return Math.max(0.1, Number(raw));
  }
  return Math.max(0.1, sceneLen - start);
}

/** Mask length in parent-layer local seconds (None duration = until layer ends). */
function maskEffectiveDuration(mask, layerDur) {
  const layerLen = Math.max(0.1, Number(layerDur) || 0.1);
  const start = Math.max(0, Number(mask?.start_s) || 0);
  const raw = mask?.duration_s;
  if (raw != null && Number.isFinite(Number(raw))) {
    return Math.max(0.1, Number(raw));
  }
  return Math.max(0.1, layerLen - start);
}

/** True when the hole is active at parent-layer local time. */
function maskActiveAt(mask, layerLocalT, layerDur) {
  const start = Math.max(0, Number(mask?.start_s) || 0);
  const end = start + maskEffectiveDuration(mask, layerDur);
  return layerLocalT >= start && layerLocalT < end;
}

function maskDisplayTitle(mask, index = 0) {
  const custom = String(mask?.title || "").trim();
  if (custom) return custom.slice(0, 40);
  return `Mask ${index + 1}`;
}

/** Rough speech length (~150 wpm) used before Generate sets the real audio duration. */
function estimateSpeechDurationS(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.0, Math.round((words / 2.5) * 10) / 10);
}

/** Compact type glyph for layer list / timeline titles. */
function layerTypeIcon(type) {
  if (type === "tts") return "volume_up";
  if (type === "audio") return "music_note";
  if (type === "video") return "movie";
  if (type === "text") return "text_fields";
  return "image";
}

/** Layer label for list/timeline — custom title when set, else a type fallback. */
function layerDisplayTitle(layer) {
  const custom = String(layer.title || "").trim();
  if (custom) return custom.slice(0, 40);
  if (layer.type === "text") {
    const t = String(layer.text || "").trim();
    return t ? t.slice(0, 24) : "Text";
  }
  if (layer.type === "tts") {
    const t = String(layer.text || "").trim()
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/<\/?[^>]+>/g, "");
    return t ? t.slice(0, 24) : (layer.asset_id ? "Voice" : "Voice · generate");
  }
  if (layer.type === "audio") {
    const asset = (currentProject?.assets || []).find((a) => a.id === layer.asset_id);
    return asset?.name ? String(asset.name).slice(0, 24) : "Audio";
  }
  if (layer.type === "video") {
    const asset = (currentProject?.assets || []).find((a) => a.id === layer.asset_id);
    return asset?.name ? String(asset.name).slice(0, 24) : "Video";
  }
  return "Image";
}

function layerDefaultTitle(type) {
  if (type === "tts") return "Voice";
  if (type === "audio") return "Audio";
  if (type === "video") return "Video";
  if (type === "text") return "Text";
  return "Image";
}

function isLayerVisibleAt(layer, t) {
  const start = layer.start_s || 0;
  return start <= t && t < start + layerEffectiveDuration(layer);
}

/** Match export timing: base opacity × fade-in / fade-out at scene time t. */
function layerOpacityAt(layer, t) {
  if (!isLayerVisibleAt(layer, t)) return 0;
  let base = Number(layer.opacity);
  if (!Number.isFinite(base)) base = 1;
  const start = layer.start_s || 0;
  const dur = layerEffectiveDuration(layer);
  const fadeD = Math.min(0.5, dur / 4);
  const rel = t - start;
  if (layer.transition_in === "fade-in" && fadeD > 0 && rel < fadeD) {
    base *= rel / fadeD;
  }
  if (layer.transition_out === "fade-out" && fadeD > 0 && rel > dur - fadeD) {
    base *= (dur - rel) / fadeD;
  }
  return Math.max(0, Math.min(1, base));
}

function syncPreviewTimeControls() {
  const wrap = $("previewTimeControls");
  if (!wrap) return;
  const isVideo = currentPost?.type === "video";
  // Controls live inside the timeline (always shown when gantt is visible).
  if (!isVideo) return;
  const total = getTotalDuration();
  const slider = $("previewTime");
  if (slider) {
    slider.max = Math.max(0.1, total);
    slider.step = 0.05;
    if (previewAbsS > total) previewAbsS = 0;
    slider.value = previewAbsS;
  }
  const row = sceneRowAtAbsoluteTime(previewAbsS) || getSceneTimeline()[0];
  if (row) {
    if (row.scene.id !== activeSceneId) {
      activeSceneId = row.scene.id;
      if ($("sceneDuration")) {
        $("sceneDuration").value = row.duration;
        $("sceneDuration").readOnly = isSceneRef(row.scene);
      }
      renderLayerList();
      renderInteractiveCanvas();
    }
    previewTimeS = clamp(previewAbsS - row.start, 0, row.duration);
  }
  const label = $("previewTimeLabel");
  if (label) label.textContent = `${previewAbsS.toFixed(1)}s / ${total.toFixed(1)}s`;
}

function syncPropInputs(layer) {
  const map = {
    propX: layer.x, propY: layer.y, propW: layer.width, propH: layer.height,
    propOpacity: layer.opacity, propStartS: layer.start_s ?? 0, propDurationS: layerEffectiveDuration(layer),
  };
  for (const [id, val] of Object.entries(map)) {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = val;
  }
}

// ---------- API helpers ----------
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
  if (!r.ok) {
    const detail = data?.detail;
    const msg = Array.isArray(detail)
      ? detail.map((d) => d.msg || JSON.stringify(d)).join("; ")
      : (detail || `HTTP ${r.status}`);
    throw new Error(msg);
  }
  return data;
}

/** Build `/api/projects/{id}/...` with a safely encoded project id. */
function projectApi(projectId, ...parts) {
  const segs = [encodeURIComponent(projectId), ...parts.map((p) => String(p))];
  return `/api/projects/${segs.join("/")}`;
}

function assetFileUrl(projectId, relPath) {
  return `${projectApi(projectId, "file")}?path=${encodeURIComponent(relPath)}`;
}

// ---------- Views ----------
const FEATURE_VIEWS = {
  "post-creator": null, // uses viewNoProject / viewProject
  "media-manager": "viewMediaManager",
};

const FEATURE_PAGE_META = {
  "post-creator": { title: "Post Creator", subtitle: "Posts & assets in this project" },
  "media-manager": { title: "Media Manager", subtitle: "Folders · preview · import · stock packages" },
};

const FEATURES_NEED_PROJECT = new Set([
  "post-creator",
]);

function syncHeaderProject() {
  const label = $("headerProjectLabel");
  if (label) {
    label.textContent = currentProject?.name || "Select project";
  }
  const btn = $("headerProjectBtn");
  if (btn) {
    btn.title = currentProject
      ? `Current project: ${currentProject.name} — click to switch`
      : "Select a project";
    btn.classList.toggle("border-indigo-400/35", !!currentProject);
    btn.classList.toggle("bg-indigo-500/10", !!currentProject);
    btn.classList.toggle("border-amber-400/35", !currentProject);
    btn.classList.toggle("bg-amber-500/10", !currentProject);
    btn.classList.toggle("text-indigo-100", !!currentProject);
    btn.classList.toggle("text-amber-100", !currentProject);
  }
}

function syncHeaderAppNav() {
  const postsActive = activeFeature === "post-creator";
  const mediaActive = activeFeature === "media-manager";
  const postsBtn = $("headerPostsBtn");
  const mediaBtn = $("headerMediaBtn");
  if (postsBtn) {
    postsBtn.classList.toggle("border-indigo-400/40", postsActive);
    postsBtn.classList.toggle("bg-indigo-500/15", postsActive);
    postsBtn.classList.toggle("text-indigo-100", postsActive);
    postsBtn.classList.toggle("border-white/10", !postsActive);
    postsBtn.classList.toggle("text-slate-300", !postsActive);
    postsBtn.setAttribute("aria-current", postsActive ? "page" : "false");
  }
  if (mediaBtn) {
    mediaBtn.classList.toggle("border-indigo-400/40", mediaActive);
    mediaBtn.classList.toggle("bg-indigo-500/15", mediaActive);
    mediaBtn.classList.toggle("text-indigo-100", mediaActive);
    mediaBtn.classList.toggle("border-white/10", !mediaActive);
    mediaBtn.classList.toggle("text-slate-300", !mediaActive);
    mediaBtn.setAttribute("aria-current", mediaActive ? "page" : "false");
  }
  const mmBadge = $("mmProjectBadge");
  if (mmBadge) {
    mmBadge.textContent = currentProject?.name
      ? `Using project · ${currentProject.name}`
      : "Select a project in the header to browse folders and import";
  }
}

function showView(name) {
  const hasProject = !!currentProject;
  const showMedia = activeFeature === "media-manager";
  $("viewNoProject")?.classList.toggle("hidden", hasProject || showMedia);
  const showProjectWorkspace = hasProject && activeFeature === "post-creator";
  $("viewProject")?.classList.toggle("hidden", !showProjectWorkspace);
  Object.entries(FEATURE_VIEWS).forEach(([feature, viewId]) => {
    if (!viewId) return;
    if (feature === "media-manager") {
      $(viewId)?.classList.toggle("hidden", activeFeature !== feature);
    } else {
      $(viewId)?.classList.toggle("hidden", !(hasProject && activeFeature === feature));
    }
  });
  syncHeaderProject();
  syncHeaderAppNav();
}

function syncPageTitle(feature) {
  const meta = FEATURE_PAGE_META[feature] || FEATURE_PAGE_META["post-creator"];
  const titleEl = $("appPageTitle");
  const subtitleEl = $("appPageSubtitle");
  if (titleEl) titleEl.textContent = meta.title;
  if (subtitleEl) {
    if (feature === "media-manager") {
      subtitleEl.textContent = currentProject
        ? `${meta.subtitle} · ${currentProject.name}`
        : meta.subtitle;
    } else {
      subtitleEl.textContent = currentProject
        ? `${meta.subtitle} · ${currentProject.name}`
        : "Select a project in the header to continue";
    }
  }
}

function clearCurrentProject() {
  stopProjectPoll();
  resetFeatureStateForProjectChange();
  currentProject = null;
  currentPost = null;
  syncPageTitle(activeFeature);
  showView("noproject");
}

function leaveProjectToList() {
  clearCurrentProject();
  void openProjectsBrowser();
}

function setActiveFeature(feature, { force = false } = {}) {
  const next = FEATURE_VIEWS[feature] !== undefined ? feature : "post-creator";

  // Media Manager is app-level — open without requiring a project.
  if (next === "media-manager") {
    activeFeature = next;
    syncPageTitle(next);
    showView(null);
    onMediaManagerShown();
    return;
  }

  if (!currentProject && FEATURES_NEED_PROJECT.has(next) && !force) {
    const switched = next !== activeFeature;
    activeFeature = next;
    syncPageTitle(next);
    showView("noproject");
    if (switched) toast("Select or create a project in the header first", "info");
    return;
  }
  const prev = activeFeature;
  activeFeature = next;
  syncPageTitle(next);
  if (!currentProject) {
    showView("noproject");
    return;
  }
  if (next === "post-creator") {
    if (prev === "post-creator" && currentPost && activeTab === "editor") {
      showView("project");
      renderProjectHeader();
      renderProjectTabs();
      renderEditor();
    } else {
      showProjectHub();
    }
  } else {
    showView(null);
  }
}

function fillAssetScopeSelect(selectEl, {
  selected = "",
  includeInherit = false,
  inheritLabel = "Same as source",
} = {}) {
  if (!selectEl) return;
  const posts = currentProject?.posts || [];
  const opts = [];
  if (includeInherit) {
    opts.push(`<option value="__inherit__">${escapeHtml(inheritLabel)}</option>`);
  }
  opts.push(`<option value="">Project (shared)</option>`);
  for (const p of posts) {
    opts.push(`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`);
  }
  selectEl.innerHTML = opts.join("");
  const valid = new Set(
    [...selectEl.options].map((o) => o.value)
  );
  selectEl.value = valid.has(selected) ? selected : (includeInherit ? "__inherit__" : "");
}

function readAssetScopeValue(selectId, { fallback = null } = {}) {
  const raw = $(selectId)?.value;
  if (raw === undefined || raw === null) return fallback;
  if (raw === "__inherit__") return undefined; // caller decides inherit
  if (raw === "") return null;
  return raw;
}

// ---------- Free assets (open licenses) ----------
function freeAssetsQuotaLabel() {
  const lim = freeAssetsCaps?.daily_download_limit;
  if (lim == null) return "";
  if (Number(lim) <= 0) return "Unlimited imports today";
  const used = freeAssetsCaps?.downloads_used_today ?? 0;
  const rem = freeAssetsCaps?.downloads_remaining_today;
  if (rem == null) return `${used} imported today`;
  return `${used}/${lim} imports today · ${rem} left`;
}

function setFreeAssetsType(type) {
  freeAssetsType = type || "all";
  document.querySelectorAll(".free-assets-type").forEach((btn) => {
    const active = btn.dataset.type === freeAssetsType;
    btn.classList.toggle("border-emerald-400/40", active);
    btn.classList.toggle("bg-emerald-500/15", active);
    btn.classList.toggle("text-emerald-100", active);
    btn.classList.toggle("border-white/10", !active);
    btn.classList.toggle("text-slate-400", !active);
  });
}

async function loadFreeAssetsCapabilities() {
  try {
    freeAssetsCaps = await api("/api/stock/capabilities");
  } catch (_) {
    freeAssetsCaps = null;
  }
  const hint = $("freeAssetsCapHint");
  if (!hint) return;
  const px = freeAssetsCaps?.pixabay;
  const quota = freeAssetsQuotaLabel();
  const base = px?.enabled ? "Openverse + Pixabay" : "Openverse · Pixabay key for video";
  hint.textContent = quota ? `${base} · ${quota}` : base;
}

async function searchFreeAssets({ resetPage = false } = {}) {
  const q = ($("freeAssetsQuery")?.value || "").trim();
  freeAssetsQuery = q;
  if (resetPage) freeAssetsPage = 1;
  const status = $("freeAssetsStatus");
  const grid = $("freeAssetsGrid");
  if (!q) {
    if (status) status.textContent = "Enter a search to browse free media.";
    if (grid) grid.innerHTML = "";
    updateFreeAssetsPager(0);
    return;
  }
  if (status) status.textContent = "Searching…";
  if (grid) grid.innerHTML = `<div class="col-span-full text-xs text-slate-500 py-8 text-center">Searching open libraries…</div>`;
  try {
    const params = new URLSearchParams({
      q,
      media_type: freeAssetsType,
      page: String(freeAssetsPage),
      page_size: "24",
    });
    const data = await api(`/api/stock/search?${params.toString()}`);
    freeAssetsCaps = data.capabilities || freeAssetsCaps;
    freeAssetsLastTotal = data.approximate_total || 0;
    const results = data.results || [];
    const sources = (data.sources_used || []).join(", ") || "—";
    if (status) {
      status.textContent = results.length
        ? `${results.length} result${results.length === 1 ? "" : "s"} · ${sources}`
        : freeAssetsType === "video" && !freeAssetsCaps?.pixabay?.enabled
          ? "Video needs a Pixabay API key (Settings)."
          : "No results. Try another query.";
    }
    renderFreeAssetsGrid(results);
    updateFreeAssetsPager(freeAssetsLastTotal);
  } catch (e) {
    if (status) status.textContent = e.message || "Search failed";
    if (grid) grid.innerHTML = `<div class="col-span-full text-xs text-rose-300/90 py-6 text-center">${escapeHtml(e.message || "Search failed")}</div>`;
    updateFreeAssetsPager(0);
  }
}

function updateFreeAssetsPager(total) {
  const pageSize = 24;
  const maxPage = Math.max(1, Math.ceil((total || 0) / pageSize) || 1);
  const prev = $("freeAssetsPrevBtn");
  const next = $("freeAssetsNextBtn");
  const label = $("freeAssetsPageLabel");
  if (label) label.textContent = freeAssetsQuery ? `Page ${freeAssetsPage}` : "";
  if (prev) prev.disabled = !freeAssetsQuery || freeAssetsPage <= 1;
  if (next) next.disabled = !freeAssetsQuery || freeAssetsPage >= maxPage || (total || 0) <= pageSize;
}

function renderFreeAssetsGrid(items) {
  const grid = $("freeAssetsGrid");
  if (!grid) return;
  grid.innerHTML = "";
  if (!items.length) return;

  const canImport = !!(currentProject && currentProject.id);

  for (const item of items) {
    const card = document.createElement("article");
    card.className = "rounded-xl border border-white/5 bg-black/25 overflow-hidden flex flex-col";
    const type = item.type || "image";
    const thumb = item.thumb_url || item.preview_url || "";
    let mediaHtml = "";
    if (type === "audio") {
      mediaHtml = `
        <div class="aspect-[4/3] bg-black/40 flex flex-col items-center justify-center gap-2 p-3">
          <span class="text-[10px] uppercase tracking-wider text-slate-500">Audio</span>
          <audio controls preload="none" class="w-full h-8" src="${escapeHtml(item.preview_url || item.download_url || "")}"></audio>
        </div>`;
    } else if (type === "video") {
      mediaHtml = thumb
        ? `<div class="aspect-[4/3] bg-black/50 relative overflow-hidden">
             <img src="${escapeHtml(thumb)}" alt="" class="w-full h-full object-cover" loading="lazy" />
             <span class="absolute bottom-2 left-2 text-[10px] px-1.5 py-0.5 rounded bg-black/60 text-slate-200">Video</span>
           </div>`
        : `<div class="aspect-[4/3] bg-black/40 flex items-center justify-center text-xs text-slate-500">Video</div>`;
    } else {
      mediaHtml = thumb
        ? `<div class="aspect-[4/3] bg-black/40 overflow-hidden"><img src="${escapeHtml(thumb)}" alt="" class="w-full h-full object-cover" loading="lazy" /></div>`
        : `<div class="aspect-[4/3] bg-black/40 flex items-center justify-center text-xs text-slate-500">Photo</div>`;
    }

    const creator = item.creator ? escapeHtml(item.creator) : "Unknown";
    const license = escapeHtml(item.license || "open license");
    const title = escapeHtml(item.title || "Untitled");
    const source = escapeHtml(item.source || "");
    const pageUrl = escapeHtml(item.page_url || "#");
    const quotaBlocked =
      freeAssetsCaps
      && Number(freeAssetsCaps.daily_download_limit) > 0
      && Number(freeAssetsCaps.downloads_remaining_today) <= 0;
    const importDisabled = !canImport || quotaBlocked;
    const importLabel = quotaBlocked ? "Daily limit reached" : "Add to project";

    card.innerHTML = `
      ${mediaHtml}
      <div class="p-2.5 flex flex-col gap-2 flex-1">
        <div class="min-w-0">
          <h3 class="text-sm font-medium text-slate-100 truncate" title="${title}">${title}</h3>
          <p class="text-[10px] text-slate-500 mt-0.5 truncate">${source} · ${license} · ${creator}</p>
        </div>
        <div class="flex flex-wrap gap-1.5 mt-auto">
          <a href="${pageUrl}" target="_blank" rel="noopener" class="text-[10px] px-2 py-1 rounded-lg border border-white/10 text-slate-400 hover:text-white">Source</a>
          ${canImport ? `<button type="button" data-action="import" class="text-[10px] px-2 py-1 rounded-lg border border-indigo-400/30 text-indigo-200 hover:bg-indigo-500/15 disabled:opacity-40 disabled:cursor-not-allowed" ${importDisabled ? "disabled" : ""}>${importLabel}</button>` : ""}
        </div>
      </div>`;

    card.querySelector('[data-action="import"]')?.addEventListener("click", async () => {
      if (!currentProject?.id) {
        toast("Open a project first to import assets", "error");
        return;
      }
      if (quotaBlocked) {
        toast("Daily stock import limit reached. Resets at midnight.", "error");
        return;
      }
      try {
        toast("Importing…", "ok");
        const result = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/assets/from-stock`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            download_url: item.download_url,
            title: item.title,
            type: item.type,
            source: item.source,
            license: item.license,
            creator: item.creator,
            attribution: item.attribution,
            page_url: item.page_url,
            post_id: currentPost?.id || null,
          }),
        });
        if (result?.quota && freeAssetsCaps) {
          freeAssetsCaps = { ...freeAssetsCaps, ...result.quota };
          await loadFreeAssetsCapabilities();
        }
        toast(
          currentPost?.id
            ? `Added “${item.title || "asset"}” to this post`
            : `Added “${item.title || "asset"}” to project`,
          "ok",
        );
        await refreshProject({ reloadPost: false });
      } catch (e) {
        toast(`Import failed: ${e.message}`, "error");
        await loadFreeAssetsCapabilities();
      }
    });
    grid.appendChild(card);
  }
}

async function openFreeAssetsDialog() {
  const dlg = $("freeAssetsDialog");
  if (!dlg) return;
  dlg.classList.remove("hidden");
  setFreeAssetsType(freeAssetsType);
  await loadFreeAssetsCapabilities();
  if (freeAssetsQuery && $("freeAssetsQuery")) {
    $("freeAssetsQuery").value = freeAssetsQuery;
    await searchFreeAssets();
  } else {
    $("freeAssetsQuery")?.focus();
  }
}

function closeFreeAssetsDialog() {
  $("freeAssetsDialog")?.classList.add("hidden");
}

// ---------- Projects ----------
async function loadConfig() {
  try {
    config = await api("/api/config");
  } catch (_) {
    /* keep defaults */
  }
  const meta = $("meta");
  if (meta) meta.textContent = "";
}

async function loadProjects() {
  const data = await api("/api/projects");
  projects = data.projects || [];
  renderProjectList();
}

function openCreateProjectDialog() {
  $("projectsBrowserDialog")?.classList.add("hidden");
  $("createProjectDialog")?.classList.remove("hidden");
  $("newProjectName")?.focus();
}

function closeCreateProjectDialog() {
  $("createProjectDialog")?.classList.add("hidden");
}

async function openProjectsBrowser() {
  try {
    await loadProjects();
  } catch (e) {
    toast(`Could not load projects: ${e.message}`, "error");
  }
  $("projectsBrowserDialog")?.classList.remove("hidden");
}

function closeProjectsBrowser() {
  $("projectsBrowserDialog")?.classList.add("hidden");
}

function renderProjectList() {
  const ul = $("projectList");
  if (!ul) return;
  ul.innerHTML = "";
  syncSortSelect("projectSort", projectSort);
  if ($("projectCount")) {
    $("projectCount").textContent = `${projects.length} project${projects.length === 1 ? "" : "s"}`;
  }
  if (!projects.length) {
    ul.className = "grid grid-cols-1";
    ul.innerHTML = `<li class="rounded-xl border border-white/5 px-6 py-12 text-center text-sm text-slate-500">No projects yet. Create one to get started.</li>`;
    return;
  }
  ul.className = "grid grid-cols-1 sm:grid-cols-2 gap-3";
  const ordered = sortByDateField(projects, projectSort);
  ordered.forEach((p, index) => {
    const li = document.createElement("li");
    const posts = p.post_count ?? 0;
    const assets = p.asset_count ?? 0;
    const when = projectSort === SORT_MODIFIED ? p.updated_at : p.created_at;
    const whenLabel = projectSort === SORT_MODIFIED ? "Modified" : "Created";
    const isCurrent = currentProject?.id === p.id;
    li.innerHTML = `
      <button type="button" class="project-card w-full h-full text-left glass rounded-2xl border p-4 flex flex-col gap-3.5 group ${isCurrent ? "border-indigo-400/50 bg-indigo-500/10" : "border-white/10"}" data-id="${p.id}" style="animation-delay:${Math.min(index, 12) * 40}ms">
        <div class="flex items-start gap-3 min-w-0">
          <span class="card-icon card-icon--project" aria-hidden="true"><span class="material-icons">folder_open</span></span>
          <div class="min-w-0 flex-1">
            <div class="font-medium text-slate-100 truncate leading-snug flex items-center gap-2" title="${escapeHtml(p.name)}">
              <span class="truncate">${escapeHtml(p.name)}</span>
              ${isCurrent ? '<span class="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-indigo-400/40 text-indigo-200">Current</span>' : ""}
            </div>
            <div class="text-[11px] text-slate-500 mt-1">${whenLabel} ${fmtTime(when)}</div>
          </div>
        </div>
        <div class="flex items-center gap-3 pt-1 border-t border-white/5">
          <span class="card-stat"><span class="material-icons" aria-hidden="true">article</span>${posts} post${posts === 1 ? "" : "s"}</span>
          <span class="card-stat"><span class="material-icons" aria-hidden="true">inventory_2</span>${assets} asset${assets === 1 ? "" : "s"}</span>
        </div>
      </button>`;
    li.querySelector("button").addEventListener("click", async () => {
      closeProjectsBrowser();
      if (currentProject?.id === p.id) return;
      await openProject(p.id);
    });
    ul.appendChild(li);
  });
}

async function createProject() {
  const name = $("newProjectName").value.trim();
  if (!name) { toast("Enter a project name", "error"); return; }
  try {
    const data = await api("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    closeCreateProjectDialog();
    closeProjectsBrowser();
    $("newProjectName").value = "";
    toast(`Created "${name}"`, "ok");
    await openProject(data.project.id, data.project);
  } catch (e) {
    toast(`Create failed: ${e.message}`, "error");
  }
}

async function createPost() {
  if (!currentProject) return;
  const name = $("newPostName").value.trim();
  const type = $("newPostType").value;
  const targetFormat = $("newPostTargetFormat")?.value || "portrait";
  const isReusable = type === "video" && !!$("newPostReusable")?.checked;
  if (!name) { toast("Enter a post name", "error"); return; }
  try {
    const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type, target_format: targetFormat, is_reusable: isReusable }),
    });
    $("createPostDialog").classList.add("hidden");
    $("newPostName").value = "";
    if ($("newPostReusable")) $("newPostReusable").checked = false;
    currentProject = data.project;
    toast(`Created post "${name}"`, "ok");
    await openPost(data.post.id);
  } catch (e) {
    toast(`Create post failed: ${e.message}`, "error");
  }
}

async function openProject(id, prefetched = null) {
  try {
    let project = prefetched;
    if (!project) {
      const data = await api(projectApi(id));
      project = data.project;
    }
    const resumeFeature = FEATURE_VIEWS[activeFeature] !== undefined
      ? activeFeature
      : "post-creator";
    resetFeatureStateForProjectChange();
    currentProject = project;
    currentPost = null;
    activeSceneId = null;
    selectedLayerId = null;
    closeProjectsBrowser();
    activeFeature = resumeFeature;
    syncPageTitle(resumeFeature);
    if (resumeFeature === "media-manager") {
      showView(null);
      onMediaManagerShown();
    } else if (resumeFeature === "post-creator") {
      showProjectHub();
    } else {
      showView(null);
    }
    startProjectPoll();
  } catch (e) {
    toast(`Could not open project: ${e.message}`, "error");
  }
}

async function openPost(postId) {
  if (!currentProject) return;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${postId}`);
    currentPost = data.post;
    // Keep post in project.posts in sync
    const idx = (currentProject.posts || []).findIndex((p) => p.id === postId);
    if (idx >= 0) currentProject.posts[idx] = currentPost;
    else currentProject.posts = [...(currentProject.posts || []), currentPost];
    activeSceneId = currentPost.scenes?.[0]?.id || null;
    selectedLayerId = null;
    propsOverlayOpen = false;
    previewTimeS = 0;
    previewAbsS = 0;
    stopPreviewPlayback();
    disposePreviewAudio();
    normalizeVideoPostOwnership(currentPost);
    if (currentPost.type === "video" && currentPost.scenes?.[0]) {
      activeSceneId = currentPost.scenes[0].id;
    }
    activeTab = "editor";
    renderProjectHeader();
    renderProjectTabs();
    renderEditor();
    refreshExportSizeHint();
  } catch (e) {
    toast(`Could not open post: ${e.message}`, "error");
  }
}

async function refreshProject({ reloadPost = false } = {}) {
  if (!currentProject) return;
  const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}`);
  const editingPostId = currentPost?.id || null;
  currentProject = data.project;
  // While editing, keep local composition (avoids poll/asset refresh wiping
  // an unsaved background). Only reload the post when explicitly requested.
  if (editingPostId && reloadPost) {
    try {
      const postData = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${editingPostId}`);
      currentPost = postData.post;
    } catch {
      currentPost = null;
      activeTab = "hub";
    }
  } else if (editingPostId && !(currentProject.posts || []).some((p) => p.id === editingPostId)) {
    currentPost = null;
    activeTab = "hub";
  }
  renderProjectHeader();
  renderProjectTabs();
  const pIdx = projects.findIndex((p) => p.id === currentProject.id);
  if (pIdx >= 0) {
    projects[pIdx] = {
      ...projects[pIdx],
      asset_count: (currentProject.assets || []).length,
      post_count: (currentProject.posts || []).length,
      name: currentProject.name,
      updated_at: currentProject.updated_at,
    };
  }
  if (activeTab === "hub") {
    renderPosts();
    renderAssets();
  } else if (currentPost) {
    renderAssetPalette();
    renderInteractiveCanvas();
  }
}

function postTypeBadgeHtml(isVideo) {
  return isVideo
    ? "text-[10px] px-2 py-0.5 rounded-full bg-fuchsia-500/20 text-fuchsia-200 border border-fuchsia-400/30"
    : "text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-200 border border-indigo-400/30";
}

function updatePostTypeBadges() {
  if (!currentPost || activeTab !== "editor") {
    $("postTypeBadge")?.classList.add("hidden");
    return;
  }
  const isVideo = currentPost.type === "video";
  const label = isVideo ? "Video" : "Image";
  const cls = postTypeBadgeHtml(isVideo);
  const editorBadge = $("postTypeBadge");
  if (editorBadge) {
    editorBadge.textContent = label;
    editorBadge.className = cls;
    editorBadge.classList.remove("hidden");
  }
}

function renderProjectHeader() {
  if (!currentProject) return;
  const crumbProject = $("crumbProject");
  const crumbPost = $("crumbPost");
  const crumbPostSep = $("crumbPostSep");
  if (crumbProject) {
    crumbProject.textContent = currentProject.name;
    crumbProject.title = currentProject.name;
  }
  const showPost = !!(currentPost && activeTab === "editor");
  if (crumbPost) {
    crumbPost.textContent = showPost ? (currentPost.name || "Post") : "";
    crumbPost.title = showPost ? (currentPost.name || "") : "";
    crumbPost.classList.toggle("hidden", !showPost);
  }
  crumbPostSep?.classList.toggle("hidden", !showPost);
  updatePostTypeBadges();
  syncAiScriptTabVisibility();

  const editing = showPost;
  $("exportImageBtn")?.classList.toggle("hidden", !editing);
  $("exportVideoBtn")?.classList.toggle("hidden", !(editing && currentPost?.type === "video"));
  $("deletePostBtn")?.classList.toggle("hidden", !editing);
  $("deleteProjectBtn")?.classList.toggle("hidden", editing);
  $("paletteAudioTab")?.classList.toggle("hidden", !(editing && currentPost?.type === "video"));
}

function renderProjectTabs() {
  const editing = activeTab === "editor" && !!currentPost;
  const hub = $("panelHub");
  const editor = $("panelEditor");
  if (hub) hub.classList.toggle("hidden", editing);
  if (editor) editor.classList.toggle("hidden", !editing);
}

function showProjectHub() {
  activeTab = "hub";
  stopPreviewPlayback();
  disposePreviewAudio();
  currentPost = null;
  showView("project");
  renderProjectHeader();
  renderProjectTabs();
  renderHub();
}

function renderHub() {
  renderPosts();
  renderAssets();
  renderProjectLogos();
}

function projectLogoUrl(relPath) {
  if (!currentProject || !relPath) return null;
  const bust = currentProject.updated_at ? `&t=${encodeURIComponent(currentProject.updated_at)}` : "";
  return `${projectApi(currentProject.id, "file")}?path=${encodeURIComponent(relPath)}${bust}`;
}

const PROJECT_LOGO_SLOTS = [
  { kind: "dark_short", pathKey: "logo_dark_short_path", previewId: "projectLogoDarkShortPreview", clearId: "clearLogoDarkShortBtn", label: "Dark short" },
  { kind: "dark_full", pathKey: "logo_dark_full_path", previewId: "projectLogoDarkFullPreview", clearId: "clearLogoDarkFullBtn", label: "Dark full" },
  { kind: "light_short", pathKey: "logo_light_short_path", previewId: "projectLogoLightShortPreview", clearId: "clearLogoLightShortBtn", label: "Light short" },
  { kind: "light_full", pathKey: "logo_light_full_path", previewId: "projectLogoLightFullPreview", clearId: "clearLogoLightFullBtn", label: "Light full" },
];

function renderProjectLogos() {
  if (!currentProject) return;
  const darkShort = currentProject.logo_dark_short_path || "";
  const lightShort = currentProject.logo_light_short_path || "";
  const source = $("projectLogoSource");
  if (source) {
    if (darkShort || lightShort) {
      source.textContent = "Project short logos for watermarks";
      source.className = "text-[10px] text-emerald-400/90";
    } else {
      source.textContent = "App watermark default";
      source.className = "text-[10px] text-slate-500";
    }
  }

  const fillPreview = (elId, path) => {
    const el = $(elId);
    if (!el) return;
    if (!path) {
      el.innerHTML = `<span class="text-[10px] text-slate-500">Not set</span>`;
      return;
    }
    const url = projectLogoUrl(path);
    el.innerHTML = `<img src="${url}" class="max-h-full max-w-full object-contain p-1" alt="">`;
  };

  for (const slot of PROJECT_LOGO_SLOTS) {
    const path = currentProject[slot.pathKey] || "";
    fillPreview(slot.previewId, path);
    $(slot.clearId)?.classList.toggle("hidden", !path);
  }
}

async function uploadProjectLogo(kind, file) {
  if (!currentProject || !file) return;
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(
    `/api/projects/${encodeURIComponent(currentProject.id)}/logos/${encodeURIComponent(kind)}`,
    { method: "POST", body: fd },
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
  if (data.project) currentProject = data.project;
  renderProjectLogos();
  renderAssets();
  const slot = PROJECT_LOGO_SLOTS.find((s) => s.kind === kind);
  toast(`${slot?.label || kind} logo saved as asset`, "ok");
}

async function clearProjectLogo(kind) {
  if (!currentProject) return;
  const body = { [`clear_${kind}`]: true };
  const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/logos`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (data.project) currentProject = data.project;
  renderProjectLogos();
  const slot = PROJECT_LOGO_SLOTS.find((s) => s.kind === kind);
  toast(`${slot?.label || kind} logo unlinked from project`, "ok");
}

const FORMAT_DISPLAY = {
  square: { title: "Square", ratio: "1:1" },
  portrait: { title: "Portrait", ratio: "4:5" },
  landscape: { title: "Landscape", ratio: "1.91:1" },
  story: { title: "Story", ratio: "9:16" },
};

function formatDisplayLabel(fmt) {
  const key = String(fmt || "portrait").trim() || "portrait";
  const meta = FORMAT_DISPLAY[key];
  if (meta) return `${meta.title} · ${meta.ratio}`;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function groupPostsByFormat(posts) {
  const order = config.formats || ["square", "portrait", "landscape", "story"];
  const buckets = new Map();
  for (const post of posts) {
    const fmt = String(post.target_format || "portrait").trim() || "portrait";
    if (!buckets.has(fmt)) buckets.set(fmt, []);
    buckets.get(fmt).push(post);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
  return keys.map((fmt) => ({ format: fmt, posts: buckets.get(fmt) }));
}

function appendPostCard(parent, post, index = 0) {
  const li = document.createElement("li");
  const isVideo = post.type === "video";
  const sceneCount = isVideo ? (post.scenes || []).length : 0;
  const layerCount = isVideo
    ? (post.scenes || []).reduce((sum, s) => sum + ((s.layers || []).length || 0), 0)
    : ((post.layers || []).length || 0);
  const totalDurS = isVideo ? computePostDuration(post) : 0;
  const typeLabel = isVideo ? "Video" : "Image";
  const iconName = isVideo ? "movie" : "image";
  const iconCls = isVideo ? "card-icon--video" : "card-icon--image";
  const when = postSort === SORT_MODIFIED ? post.updated_at : post.created_at;
  const detail = isVideo
    ? `${sceneCount} scene${sceneCount === 1 ? "" : "s"} · ${layerCount} layer${layerCount === 1 ? "" : "s"}${
        post.is_reusable ? " · Reusable" : ""
      }`
    : (post.is_reusable ? "Reusable image" : "Image post");
  const durBit = isVideo ? `${Number(totalDurS).toFixed(1)}s · ` : "";
  li.innerHTML = `
    <div class="post-card glass rounded-xl border border-white/10 flex flex-col h-full group" style="animation-delay:${Math.min(index, 16) * 35}ms">
      <button type="button" class="post-open text-left flex-1 min-w-0 p-3 flex items-start gap-2.5" data-id="${post.id}" title="${escapeHtml(post.name)} · ${typeLabel}">
        <span class="card-icon ${iconCls}" aria-hidden="true"><span class="material-icons">${iconName}</span></span>
        <div class="min-w-0 flex-1">
          <div class="text-xs font-medium text-slate-100 truncate leading-snug">${escapeHtml(post.name)}</div>
          <div class="text-[10px] text-slate-500 mt-1 truncate leading-snug">${escapeHtml(detail)}</div>
          <div class="flex items-center gap-2.5 mt-2 flex-wrap">
            <span class="card-stat"><span class="material-icons" aria-hidden="true">${iconName}</span>${typeLabel}</span>
            <span class="card-stat"><span class="material-icons" aria-hidden="true">schedule</span>${durBit}${fmtTime(when)}</span>
          </div>
        </div>
      </button>
      <button type="button" class="post-del text-[10px] py-1.5 border-t border-white/5 text-red-300/80 hover:bg-red-500/10 hover:text-red-200" data-id="${post.id}" title="Delete post">Delete</button>
    </div>`;
  li.querySelector(".post-open").addEventListener("click", () => openPost(post.id));
  li.querySelector(".post-del").addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirmDialog({
      title: `Delete post “${post.name}”?`,
      message: "This permanently removes the post composition and its exports. Project assets are kept. This cannot be undone.",
      confirmText: "Delete post",
      cancelText: "Keep post",
      danger: true,
    });
    if (!ok) return;
    try {
      const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${post.id}`, { method: "DELETE" });
      currentProject = data.project;
      if (currentPost?.id === post.id) currentPost = null;
      toast("Post deleted", "ok");
      showProjectHub();
    } catch (err) {
      toast(`Delete failed: ${err.message}`, "error");
    }
  });
  parent.appendChild(li);
}

function renderPosts() {
  const ul = $("postList");
  if (!ul || !currentProject) return;
  ul.innerHTML = "";
  syncSortSelect("postSort", postSort);
  const posts = sortByDateField(currentProject.posts || [], postSort);
  if (!posts.length) {
    ul.className = "flex flex-col gap-3";
    ul.innerHTML = `<li class="glass rounded-xl border border-white/5 px-4 py-10 text-center text-sm text-slate-500">No posts yet. Create an image or video post to start editing.</li>`;
    return;
  }
  ul.className = "flex flex-col gap-4";
  for (const group of groupPostsByFormat(posts)) {
    const section = document.createElement("li");
    section.className = "space-y-2 min-w-0";
    const count = group.posts.length;
    section.innerHTML = `
      <div class="flex items-baseline justify-between gap-2 px-0.5">
        <h4 class="text-xs font-medium text-slate-400 tracking-wide uppercase">${escapeHtml(formatDisplayLabel(group.format))}</h4>
        <span class="text-[10px] text-slate-500 tabular-nums">${count}</span>
      </div>
      <ul class="post-format-grid grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5 gap-2.5"></ul>`;
    const grid = section.querySelector(".post-format-grid");
    group.posts.forEach((post, i) => appendPostCard(grid, post, i));
    ul.appendChild(section);
  }
}

async function refreshExportSizeHint() {
  const el = $("exportSizeHint");
  if (!el || !currentProject || !currentPost) return;
  if (currentPost.type !== "video") {
    el.textContent = "";
    return;
  }
  try {
    const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/export-size`);
    el.textContent = `Export ≈ ${data.width}×${data.height}`;
  } catch {
    el.textContent = "";
  }
}

// ---------- Assets ----------
const ASSET_TYPE_GROUPS = [
  { type: "image", label: "Images", icon: "photo" },
  { type: "video", label: "Videos", icon: "movie" },
  { type: "audio", label: "Audio", icon: "music_note" },
];

function assetsOfType(type, { forPost = false, scope = null } = {}) {
  let pool;
  if (scope === "project") {
    pool = (currentProject?.assets || []).filter((a) => !a.post_id);
  } else if (scope === "post") {
    const postId = currentPost?.id;
    pool = postId
      ? (currentProject?.assets || []).filter((a) => a.post_id === postId)
      : [];
  } else if (forPost) {
    pool = visibleAssets();
  } else {
    // Default: project-shared only (post-private assets stay in the post editor).
    pool = (currentProject?.assets || []).filter((a) => !a.post_id);
  }
  return pool.filter((a) => a.type === type);
}

function projectSharedAssets() {
  return (currentProject?.assets || []).filter((a) => !a.post_id);
}

function assetScopeSelectHtml(asset) {
  const posts = currentProject?.posts || [];
  const opts = [
    `<option value="" ${!asset.post_id ? "selected" : ""}>Project (shared)</option>`,
    ...posts.map((p) =>
      `<option value="${escapeHtml(p.id)}" ${asset.post_id === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`
    ),
  ];
  return `<select class="asset-scope-select asset-mini-select" data-id="${asset.id}" title="Move to post or keep shared">${opts.join("")}</select>`;
}

function assetGroupLabel(asset) {
  const g = (asset?.group || "").trim();
  return g || "Ungrouped";
}

function collectAssetGroupNames(assets = currentProject?.assets || []) {
  const names = new Set();
  for (const g of currentProject?.asset_groups || []) {
    const cleaned = (g || "").trim();
    if (cleaned) names.add(cleaned);
  }
  for (const a of assets) {
    const g = (a.group || "").trim();
    if (g) names.add(g);
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function syncUploadGroupSelect() {
  const sel = $("uploadAssetGroup");
  if (!sel) return;
  const prev = sel.value;
  const names = collectAssetGroupNames();
  sel.innerHTML = `<option value="">Ungrouped</option>`
    + names.map((n) => `<option value="${n.replace(/"/g, "&quot;")}">${n}</option>`).join("");
  if (prev && (prev === "" || names.includes(prev))) sel.value = prev;
  else sel.value = "";
}

function openUploadAssetsDialog() {
  const dlg = $("uploadAssetsDialog");
  if (!dlg) return;
  syncUploadGroupSelect();
  // Hub uploads are always project-shared; post-private uploads happen in the editor.
  const scopeSel = $("uploadAssetScope");
  if (scopeSel) {
    scopeSel.innerHTML = `<option value="">Project (shared)</option>`;
    scopeSel.value = "";
    scopeSel.disabled = true;
  }
  const status = $("assetUploadStatus");
  if (status && !status.textContent?.startsWith("Uploading")) status.textContent = "";
  dlg.classList.remove("hidden");
}

function closeUploadAssetsDialog() {
  $("uploadAssetsDialog")?.classList.add("hidden");
}

function openAssetGroupsDialog() {
  const dlg = $("assetGroupsDialog");
  if (!dlg) return;
  renderAssetGroupManager();
  dlg.classList.remove("hidden");
}

function closeAssetGroupsDialog() {
  $("assetGroupsDialog")?.classList.add("hidden");
}

async function deleteAssetGroupByName(name) {
  if (!currentProject || !name) return false;
  const count = (currentProject.assets || []).filter((a) => (a.group || "").trim() === name).length;
  const ok = await confirmDialog({
    title: `Delete group “${name}”?`,
    message: count
      ? `${count} asset${count === 1 ? "" : "s"} will become Ungrouped. The files themselves are not deleted.`
      : "This group has no assets. It will be removed from the project.",
    confirmText: "Delete group",
    danger: true,
  });
  if (!ok) return false;
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(currentProject.id)}/asset-groups/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
    if (data.project) currentProject = data.project;
    if (assetGroupFilter === name) assetGroupFilter = "__all__";
    toast(`Deleted group “${name}”`, "ok");
    renderAssets();
    renderAssetGroupManager();
    return true;
  } catch (e) {
    toast(e.message || "Could not delete group", "error");
    return false;
  }
}

function renderAssetGroupManager() {
  const ul = $("assetGroupManageList");
  if (!ul) return;
  const names = collectAssetGroupNames();
  syncUploadGroupSelect();
  if (!names.length) {
    ul.innerHTML = `<li class="text-[11px] text-slate-500 px-2 py-6 text-center">No groups yet. Create one like “Branding” — then assign assets from the list or when uploading.</li>`;
    return;
  }
  ul.innerHTML = "";
  for (const name of names) {
    const count = (currentProject?.assets || []).filter((a) => (a.group || "").trim() === name).length;
    const li = document.createElement("li");
    li.className = "flex items-center gap-2 rounded-xl border border-white/5 bg-black/25 px-3 py-2.5";
    li.innerHTML = `
      <span class="material-icons text-[18px] text-slate-500 shrink-0" aria-hidden="true">folder</span>
      <div class="min-w-0 flex-1">
        <div class="text-sm text-slate-200 truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="text-[10px] text-slate-500">${count} asset${count === 1 ? "" : "s"}</div>
      </div>
      <button type="button" class="filter-asset-group text-[10px] px-2 py-1 rounded border border-white/10 text-slate-400 hover:text-white hover:border-indigo-400/40 shrink-0" data-name="${name.replace(/"/g, "&quot;")}" title="Show this group in the library">View</button>
      <button type="button" class="delete-asset-group text-[10px] px-2 py-1 rounded border border-red-400/25 text-red-300 hover:bg-red-500/10 shrink-0" data-name="${name.replace(/"/g, "&quot;")}">Delete</button>`;
    ul.appendChild(li);
  }
  ul.querySelectorAll(".filter-asset-group").forEach((btn) => {
    btn.addEventListener("click", () => {
      assetGroupFilter = btn.dataset.name || "__all__";
      closeAssetGroupsDialog();
      renderAssets();
    });
  });
  ul.querySelectorAll(".delete-asset-group").forEach((btn) => {
    btn.addEventListener("click", () => deleteAssetGroupByName(btn.dataset.name));
  });
}

async function createAssetGroupPrompt() {
  if (!currentProject) return;
  const name = await promptDialog({
    title: "New group",
    message: "Name for the asset group:",
    defaultValue: "Branding",
    confirmText: "Create",
    maxLength: 80,
  });
  if (name == null) return;
  const cleaned = name.trim();
  if (!cleaned) {
    toast("Group name cannot be empty", "error");
    return;
  }
  try {
    const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/asset-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: cleaned }),
    });
    if (data.project) currentProject = data.project;
    toast(`Created group “${cleaned}”`, "ok");
    assetGroupFilter = cleaned;
    renderAssets();
    renderAssetGroupManager();
  } catch (e) {
    toast(`Could not create group: ${e.message}`, "error");
  }
}

function partitionByGroup(items) {
  const map = new Map();
  for (const a of items) {
    const key = assetGroupLabel(a);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a === "Ungrouped") return 1;
    if (b === "Ungrouped") return -1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
  return keys.map((name) => ({ name, items: map.get(name) }));
}

function filterItemsByGroup(items, filter = assetGroupFilter) {
  if (!filter || filter === "__all__") return items;
  if (filter === "__ungrouped__") return items.filter((a) => !(a.group || "").trim());
  return items.filter((a) => (a.group || "").trim() === filter);
}

function syncAssetGroupFilterSelect(selectId, assetsForType) {
  const sel = $(selectId);
  if (!sel) return;
  const names = collectAssetGroupNames(assetsForType);
  const prev = assetGroupFilter;
  sel.innerHTML = `<option value="__all__">All groups</option>`
    + (names.length ? names.map((n) => `<option value="${n.replace(/"/g, "&quot;")}">${n}</option>`).join("") : "")
    + `<option value="__ungrouped__">Ungrouped</option>`;
  const valid = prev === "__all__" || prev === "__ungrouped__" || names.includes(prev);
  assetGroupFilter = valid ? prev : "__all__";
  sel.value = assetGroupFilter;
}

function groupSelectHtml(asset, allGroupNames) {
  const current = (asset.group || "").trim();
  const opts = [
    `<option value="" ${!current ? "selected" : ""}>Ungrouped</option>`,
    ...allGroupNames.map((n) =>
      `<option value="${n.replace(/"/g, "&quot;")}" ${n === current ? "selected" : ""}>${n}</option>`
    ),
    `<option value="__new__">+ New group…</option>`,
  ];
  return `<select class="asset-group-select asset-mini-select" data-id="${asset.id}" title="Group">${opts.join("")}</select>`;
}

function assetStatusDot(asset) {
  if (asset.status === "processing" || asset.status === "pending") {
    return `<span class="asset-status-dot is-busy" title="Processing"><span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span></span>`;
  }
  if (asset.status === "failed") {
    return `<span class="asset-status-dot is-failed" title="${escapeHtml(asset.error || "Failed")}"></span>`;
  }
  if (asset.status === "ready") {
    return `<span class="asset-status-dot is-ready" title="Ready"></span>`;
  }
  return `<span class="asset-status-dot is-pending" title="Pending"></span>`;
}

function assetScopeChip(asset) {
  if (!asset?.post_id) return `<span class="asset-chip" title="Shared with project">Project</span>`;
  const post = (currentProject?.posts || []).find((p) => p.id === asset.post_id);
  const name = post?.name || "Post";
  const mine = currentPost?.id && asset.post_id === currentPost.id;
  return `<span class="asset-chip ${mine ? "is-post" : ""}" title="Post-scoped">${escapeHtml(mine ? "This post" : name)}</span>`;
}

function formatBytesShort(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatFps(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return "";
  const rounded = Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${rounded} fps`;
}

/** Compact media summary for video/audio assets (probe fields from the server). */
function formatAssetMediaSummary(asset, { compact = false } = {}) {
  if (!asset || (asset.type !== "video" && asset.type !== "audio")) return "";
  const parts = [];
  if (asset.container) parts.push(String(asset.container).toUpperCase());
  if (asset.type === "video" && asset.video_codec) parts.push(asset.video_codec);
  if (asset.type === "video" && asset.width && asset.height) {
    parts.push(`${asset.width}×${asset.height}`);
  }
  if (asset.type === "video") {
    const fpsLabel = formatFps(asset.fps);
    if (fpsLabel) parts.push(fpsLabel);
  }
  if (!compact && asset.duration_s != null && Number.isFinite(Number(asset.duration_s))) {
    const d = Number(asset.duration_s);
    parts.push(d >= 60 ? `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, "0")}` : `${d.toFixed(1)}s`);
  }
  if (!compact && asset.bitrate_kbps) parts.push(`${asset.bitrate_kbps} kbps`);
  // Always show size for videos so large uploads are obvious.
  const size = formatBytesShort(asset.file_size_bytes);
  if (size) parts.push(size);
  if (!compact && asset.has_audio === false) parts.push("no audio");
  else if (!compact && asset.type === "audio" && asset.audio_codec) parts.push(asset.audio_codec);
  return parts.join(" · ");
}

const AI_VIDEO_DESCRIBE_MAX_BYTES = 20 * 1024 * 1024;

function videoNeedsManualDescription(asset) {
  return (
    asset?.type === "video"
    && Number(asset.file_size_bytes) > AI_VIDEO_DESCRIBE_MAX_BYTES
    && !(asset.description || "").trim()
  );
}

async function saveAssetDescription(assetId, description) {
  if (!currentProject || !assetId) return false;
  const cleaned = String(description || "").trim().slice(0, 500);
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(currentProject.id)}/assets/${encodeURIComponent(assetId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: cleaned }),
      },
    );
    if (data.project) currentProject = data.project;
    else if (data.asset) {
      const idx = (currentProject.assets || []).findIndex((a) => a.id === assetId);
      if (idx >= 0) currentProject.assets[idx] = { ...currentProject.assets[idx], ...data.asset };
    }
    return true;
  } catch (e) {
    toast(e.message || "Could not save description", "error");
    return false;
  }
}

/** Ask for a catalog description (used when AI analysis is skipped, or to edit later). */
async function promptManualVideoDescription(asset, { reason = "large" } = {}) {
  if (!asset?.id) return false;
  const size = formatBytesShort(asset.file_size_bytes);
  let message;
  if (reason === "large" || videoNeedsManualDescription(asset) || Number(asset.file_size_bytes) > AI_VIDEO_DESCRIBE_MAX_BYTES) {
    message = `"${asset.name}"${size ? ` is ${size}` : ""} — too large for AI analysis (limit 20 MB).\n\n`
      + "Enter a short description so AI features can use this video later:";
  } else {
    message = `Description for "${asset.name}"${size ? ` (${size})` : ""}:`;
  }
  const next = await promptDialog({
    title: "Video description",
    message,
    defaultValue: asset.description || "",
    confirmText: "Save",
    multiline: true,
    maxLength: 500,
    placeholder: "e.g. silk fabric close-up under soft light",
  });
  if (next == null) return false;
  const cleaned = next.trim();
  if (!cleaned) {
    toast("No description saved — you can add one later from the asset library", "info");
    return false;
  }
  const ok = await saveAssetDescription(asset.id, cleaned);
  if (ok) toast("Description saved", "ok");
  return ok;
}

async function setAssetGroup(assetId, groupValue) {
  let group = groupValue;
  if (group === "__new__") {
    const name = await promptDialog({
      title: "New group",
      message: "Name for the asset group:",
      defaultValue: "Branding",
      confirmText: "Create",
      maxLength: 80,
    });
    if (name == null) return false;
    group = name.trim();
    if (!group) {
      toast("Group name cannot be empty", "error");
      return false;
    }
  }
  try {
    await api(`/api/projects/${encodeURIComponent(currentProject.id)}/assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group }),
    });
    await refreshProject({ reloadPost: false });
    return true;
  } catch (e) {
    toast(`Could not update group: ${e.message}`, "error");
    return false;
  }
}

function bindAssetGroupSelects(root) {
  (root || document).querySelectorAll(".asset-group-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const ok = await setAssetGroup(sel.dataset.id, sel.value);
      if (!ok) renderAssets();
    });
  });
}

function bindAssetScopeSelects(root) {
  (root || document).querySelectorAll(".asset-scope-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      try {
        await api(`/api/projects/${encodeURIComponent(currentProject.id)}/assets/${sel.dataset.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ post_id: sel.value || null }),
        });
        toast(
          sel.value
            ? "Moved to post — only visible in that post’s editor"
            : "Shared with project",
          "ok",
        );
        await refreshProject({ reloadPost: false });
      } catch (err) {
        toast(err.message, "error");
        renderAssets();
        renderAssetPalette();
      }
    });
  });
}

function syncAssetTypeTabs(containerSelector, activeType, counts) {
  document.querySelectorAll(containerSelector).forEach((btn) => {
    const type = btn.dataset.assetTypeTab || btn.dataset.paletteTypeTab;
    const active = type === activeType;
    const count = counts?.[type] ?? 0;
    const baseLabel = ASSET_TYPE_GROUPS.find((g) => g.type === type)?.label
      || (type === "logos" ? "Logos" : type);
    btn.textContent = count ? `${baseLabel} (${count})` : baseLabel;
    btn.classList.toggle("border-indigo-400", active);
    btn.classList.toggle("text-indigo-200", active);
    btn.classList.toggle("border-transparent", !active);
    btn.classList.toggle("text-slate-400", !active);
  });
}

function setAssetLibraryTab(type) {
  if (!["image", "video", "audio", "logos"].includes(type)) type = "image";
  assetLibraryTab = type;
  assetGroupFilter = "__all__";
  renderAssets();
}

function syncProjectTtsPanel() {
  const btn = $("openProjectTtsDialogBtn");
  if (!btn) return;
  btn.classList.toggle("hidden", assetLibraryTab !== "audio");
}

function openProjectTtsDialog() {
  const dlg = $("projectTtsDialog");
  if (!dlg) return;
  clearTtsPreview("project");
  fillAssetScopeSelect($("projectTtsScope"), { selected: "" });
  const ttsScope = $("projectTtsScope");
  if (ttsScope) {
    // Hub speech stays project-shared; post-private TTS is created in the editor.
    ttsScope.innerHTML = `<option value="">Project (shared)</option>`;
    ttsScope.value = "";
    ttsScope.disabled = true;
  }
  dlg.classList.remove("hidden");
  if ($("projectTtsStatus")) $("projectTtsStatus").textContent = "";
  fillProjectTtsVoiceSelect();
  $("projectTtsText")?.focus();
}

function closeProjectTtsDialog() {
  clearTtsPreview("project");
  $("projectTtsDialog")?.classList.add("hidden");
}

let projectTtsPreviewUrl = null;
let layerTtsPreviewUrl = null;

function clearTtsPreview(kind = "project") {
  if (kind === "project") {
    const audio = $("projectTtsPreviewAudio");
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (projectTtsPreviewUrl) {
      URL.revokeObjectURL(projectTtsPreviewUrl);
      projectTtsPreviewUrl = null;
    }
    $("projectTtsPreviewWrap")?.classList.add("hidden");
    if ($("projectTtsPreviewMeta")) $("projectTtsPreviewMeta").textContent = "";
    return;
  }
  const audio = $("propTtsPreviewAudio");
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (layerTtsPreviewUrl) {
    URL.revokeObjectURL(layerTtsPreviewUrl);
    layerTtsPreviewUrl = null;
  }
  $("propTtsPreviewWrap")?.classList.add("hidden");
  if ($("propTtsPreviewMeta")) $("propTtsPreviewMeta").textContent = "";
}

async function fetchTtsPreviewBlob({ text, voice, mood }) {
  if (!currentProject) throw new Error("Open a project first");
  const script = String(text || "").trim();
  if (!script) throw new Error("Enter text to speak before previewing");
  const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/tts/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: script,
      voice: voice || null,
      mood: mood || "neutral",
    }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(detailMessage(data, `HTTP ${r.status}`));
  }
  const blob = await r.blob();
  const durationHeader = r.headers.get("X-Duration-S");
  const duration = durationHeader != null ? Number(durationHeader) : null;
  return { blob, duration: Number.isFinite(duration) ? duration : null };
}

async function previewProjectTtsAsset() {
  if (!currentProject) return;
  const btn = $("projectTtsPreviewBtn");
  const status = $("projectTtsStatus");
  if (btn) { btn.disabled = true; btn.textContent = "Previewing…"; }
  if (status) status.textContent = "Synthesizing preview…";
  try {
    const { blob, duration } = await fetchTtsPreviewBlob({
      text: $("projectTtsText")?.value,
      voice: $("projectTtsVoice")?.value,
      mood: $("projectTtsMood")?.value || "neutral",
    });
    clearTtsPreview("project");
    projectTtsPreviewUrl = URL.createObjectURL(blob);
    const wrap = $("projectTtsPreviewWrap");
    const audio = $("projectTtsPreviewAudio");
    const meta = $("projectTtsPreviewMeta");
    if (audio) {
      audio.src = projectTtsPreviewUrl;
      audio.load();
      audio.play().catch(() => { /* user can press play */ });
    }
    wrap?.classList.remove("hidden");
    if (meta) {
      meta.textContent = duration != null ? `${duration.toFixed(1)}s · not saved` : "Not saved";
    }
    if (status) status.textContent = "Preview ready — save to assets when you like it.";
  } catch (e) {
    toast(`Preview failed: ${e.message}`, "error");
    if (status) status.textContent = "";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Preview"; }
  }
}

async function previewSelectedTtsLayer() {
  if (!currentProject || !currentPost) return;
  flushLayerPropsFromDom();
  const layer = getLayerById(selectedLayerId);
  if (!layer || layer.type !== "tts") return;
  const btn = $("propTtsPreview");
  if (btn) { btn.disabled = true; btn.textContent = "Previewing…"; }
  try {
    const { blob, duration } = await fetchTtsPreviewBlob({
      text: layer.text,
      voice: layer.tts_voice || $("propTtsVoice")?.value,
      mood: layer.tts_mood || $("propTtsMood")?.value || "neutral",
    });
    clearTtsPreview("layer");
    layerTtsPreviewUrl = URL.createObjectURL(blob);
    const wrap = $("propTtsPreviewWrap");
    const audio = $("propTtsPreviewAudio");
    const meta = $("propTtsPreviewMeta");
    if (audio) {
      audio.src = layerTtsPreviewUrl;
      audio.load();
      audio.play().catch(() => {});
    }
    wrap?.classList.remove("hidden");
    if (meta) {
      meta.textContent = duration != null ? `${duration.toFixed(1)}s · not saved` : "Not saved";
    }
    toast("Preview ready", "ok");
  } catch (e) {
    toast(`Preview failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Preview"; }
  }
}

function syncProjectVideoGenPanel() {
  const btn = $("openProjectVideoGenDialogBtn");
  if (!btn) return;
  btn.classList.toggle("hidden", assetLibraryTab !== "video");
}

function openProjectVideoGenDialog() {
  const dlg = $("projectVideoGenDialog");
  if (!dlg) return;
  fillAssetScopeSelect($("projectVideoGenScope"), { selected: "" });
  const vgScope = $("projectVideoGenScope");
  if (vgScope) {
    vgScope.innerHTML = `<option value="">Project (shared)</option>`;
    vgScope.value = "";
    vgScope.disabled = true;
  }
  dlg.classList.remove("hidden");
  if ($("projectVideoGenStatus")) $("projectVideoGenStatus").textContent = "";
  const hint = $("projectVideoGenDisabledHint");
  const genBtn = $("projectVideoGenBtn");
  const ready = !!aiCapabilities.video_gen;
  if (hint) hint.classList.toggle("hidden", ready);
  if (genBtn) genBtn.disabled = !ready;
  $("projectVideoGenPrompt")?.focus();
}

function closeProjectVideoGenDialog() {
  $("projectVideoGenDialog")?.classList.add("hidden");
}

async function generateProjectVideoAsset() {
  if (!currentProject) return;
  if (!aiCapabilities.video_gen) {
    toast("Enable ComfyUI video generation in Settings", "info");
    return;
  }
  const prompt = ($("projectVideoGenPrompt")?.value || "").trim();
  if (!prompt) {
    toast("Enter a prompt to generate a clip", "info");
    return;
  }
  const btn = $("projectVideoGenBtn");
  const status = $("projectVideoGenStatus");
  if (btn) { btn.disabled = true; btn.textContent = "Queuing…"; }
  if (status) status.textContent = "Sending prompt to ComfyUI…";

  const payload = {
    prompt,
    name: `Video ${prompt.slice(0, 40)}`,
    post_id: readAssetScopeValue("projectVideoGenScope", { fallback: null }),
  };
  const size = $("projectVideoGenSize")?.value || "default";
  if (size.includes("x")) {
    const [w, h] = size.split("x").map((n) => parseInt(n, 10));
    if (Number.isFinite(w) && Number.isFinite(h)) {
      payload.width = w;
      payload.height = h;
    }
  }

  try {
    const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/video/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (data.project) currentProject = data.project;
    toast("Video generation queued — this can take several minutes", "ok");
    if (status) {
      status.textContent = data.asset?.name
        ? `Generating “${data.asset.name}”… watch Videos for Ready`
        : "Generating… watch Videos for Ready";
    }
    if ($("projectVideoGenPrompt")) $("projectVideoGenPrompt").value = "";
    renderAssets();
    startProjectPoll();
    closeProjectVideoGenDialog();
  } catch (e) {
    toast(`Video generate failed: ${e.message}`, "error");
    if (status) status.textContent = "";
  } finally {
    if (btn) {
      btn.disabled = !aiCapabilities.video_gen;
      btn.textContent = "Generate clip";
    }
  }
}

let ttsRegionFilter = null; // last UI region filter (session); null = derive from selection

function voiceRegionCode(voice) {
  if (!voice) return "XX";
  if (voice.region) return voice.region;
  const loc = String(voice.locale || "");
  if (loc.includes("_")) return loc.split("_").pop();
  return loc || "XX";
}

function rememberPostTtsVoice(voiceId) {
  if (!currentPost || !voiceId) return;
  if (currentPost.default_tts_voice === voiceId) return;
  currentPost.default_tts_voice = voiceId;
  scheduleSavePost();
}

const TTS_MOOD_OPTIONS = [
  { id: "neutral", label: "Neutral" },
  { id: "excited", label: "Excited" },
  { id: "happy", label: "Happy" },
  { id: "angry", label: "Angry" },
  { id: "sad", label: "Sad" },
  { id: "calm", label: "Calm" },
  { id: "serious", label: "Serious" },
  { id: "whisper", label: "Whisper" },
];

function ttsMoodOptionsHtml(selected) {
  const cur = String(selected || "neutral").toLowerCase();
  const moods = (ttsVoicesCache?.moods?.length ? ttsVoicesCache.moods : TTS_MOOD_OPTIONS);
  return moods.map((m) => {
    const id = m.id || m;
    const label = m.label || id;
    return `<option value="${escapeHtml(id)}" ${id === cur ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

function preferredTtsVoiceId(data, { prefer = null } = {}) {
  const voices = data?.voices || [];
  const ids = new Set(voices.map((v) => v.id));
  const candidates = [
    prefer,
    currentPost?.default_tts_voice,
    data?.default_voice,
    voices[0]?.id,
  ];
  for (const id of candidates) {
    if (id && ids.has(id)) return id;
  }
  return null;
}

function regionOptionsHtml(data, selectedRegion) {
  const voices = data.voices || [];
  const regions = data.regions || [];
  const counts = {};
  for (const v of voices) {
    const c = voiceRegionCode(v);
    counts[c] = (counts[c] || 0) + 1;
  }
  const opts = [`<option value="__all__">All regions (${voices.length})</option>`];
  for (const r of regions) {
    const id = r.id || r;
    const label = r.label || id;
    const n = counts[id] || 0;
    opts.push(
      `<option value="${escapeHtml(id)}" ${id === selectedRegion ? "selected" : ""}>${escapeHtml(label)} (${n})</option>`,
    );
  }
  return opts.join("");
}

function voicesForRegion(voices, region) {
  if (!region || region === "__all__") return voices;
  return voices.filter((v) => voiceRegionCode(v) === region);
}

/**
 * Bind region + voice selects. Keeps the selected voice visible even if the
 * region filter would hide it (auto-switches region when needed).
 */
function bindTtsVoicePicker({
  regionEl,
  voiceEl,
  data,
  selectedVoiceId = null,
  onVoiceChange = null,
}) {
  if (!voiceEl || !data) return;
  const voices = data.voices || [];
  const chosen = preferredTtsVoiceId(data, { prefer: selectedVoiceId });
  const chosenVoice = voices.find((v) => v.id === chosen) || null;

  let region = ttsRegionFilter;
  if (region == null) {
    if (chosenVoice) region = voiceRegionCode(chosenVoice);
    else region = (data.regions || []).find((r) => r.id === "US")?.id || "__all__";
  }
  if (chosenVoice && region !== "__all__" && voiceRegionCode(chosenVoice) !== region) {
    region = voiceRegionCode(chosenVoice);
  }
  ttsRegionFilter = region;

  if (regionEl) {
    regionEl.innerHTML = regionOptionsHtml(data, region);
    regionEl.value = region;
  }

  const fillVoices = (regionCode, keepVoiceId) => {
    let list = voicesForRegion(voices, regionCode);
    let pick = keepVoiceId && list.some((v) => v.id === keepVoiceId)
      ? keepVoiceId
      : (list[0]?.id || "");
    if (!list.length) {
      list = voices;
      pick = keepVoiceId && voices.some((v) => v.id === keepVoiceId)
        ? keepVoiceId
        : (voices[0]?.id || "");
    }
    voiceEl.innerHTML = list.length
      ? list.map((v) =>
        `<option value="${escapeHtml(v.id)}" ${v.id === pick ? "selected" : ""}>${escapeHtml(v.name)}</option>`
      ).join("")
      : `<option value="">No voices</option>`;
    if (pick) voiceEl.value = pick;
    return pick;
  };

  const current = fillVoices(region, chosen);

  if (regionEl) {
    regionEl.onchange = () => {
      ttsRegionFilter = regionEl.value || "__all__";
      const prev = voiceEl.value;
      const next = fillVoices(ttsRegionFilter, prev);
      // Only apply when the previous voice isn't in the new region.
      if (next && next !== prev && onVoiceChange) onVoiceChange(next);
    };
  }
  voiceEl.onchange = () => {
    const id = voiceEl.value;
    if (!id) return;
    if (onVoiceChange) onVoiceChange(id);
  };

  return current;
}

async function fillProjectTtsVoiceSelect() {
  const sel = $("projectTtsVoice");
  const regionEl = $("projectTtsRegion");
  if (!sel) return;
  try {
    const data = await ensureTtsVoices();
    bindTtsVoicePicker({
      regionEl,
      voiceEl: sel,
      data,
      selectedVoiceId: sel.value || null,
    });
  } catch {
    sel.innerHTML = `<option value="">Voices unavailable</option>`;
  }
}

async function generateProjectTtsAsset() {
  if (!currentProject) return;
  const text = ($("projectTtsText")?.value || "").trim();
  if (!text) {
    toast("Enter a script to generate speech", "info");
    return;
  }
  const btn = $("projectTtsGenerateBtn");
  const status = $("projectTtsStatus");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  if (status) status.textContent = "Saving speech asset…";
  try {
    const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/tts/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: $("projectTtsVoice")?.value || null,
        mood: $("projectTtsMood")?.value || "neutral",
        name: `TTS ${text.slice(0, 32)}`,
        post_id: readAssetScopeValue("projectTtsScope", { fallback: null }),
      }),
    });
    if (data.project) currentProject = data.project;
    toast(
      data.duration_s
        ? `Speech asset ready · ${Number(data.duration_s).toFixed(1)}s`
        : "Speech asset ready",
      "ok",
    );
    if ($("projectTtsText")) $("projectTtsText").value = "";
    closeProjectTtsDialog();
    renderAssets();
  } catch (e) {
    toast(`Speech failed: ${e.message}`, "error");
    if (status) status.textContent = "";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save to assets"; }
  }
}

async function deleteProjectAsset(assetId, { reloadPost = true } = {}) {
  if (!currentProject || !assetId) return false;
  const ok = await confirmDialog({
    title: "Delete asset?",
    message: "Removes the file and clears any layer or background that used it. This cannot be undone.",
    confirmText: "Delete",
    danger: true,
  });
  if (!ok) return false;
  const data = await api(
    `/api/projects/${encodeURIComponent(currentProject.id)}/assets/${encodeURIComponent(assetId)}`,
    { method: "DELETE" },
  );
  if (data.project) currentProject = data.project;
  toast("Asset deleted", "ok");
  await refreshProject({ reloadPost: !!currentPost && reloadPost });
  return true;
}

async function renameProjectAsset(assetId) {
  if (!currentProject || !assetId) return false;
  const asset = getAssetById(assetId);
  if (!asset) {
    toast("Asset not found", "error");
    return false;
  }
  const next = await promptDialog({
    title: "Rename asset",
    message: "New name for this asset:",
    defaultValue: asset.name || "",
    confirmText: "Rename",
    maxLength: 120,
  });
  if (next == null) return false;
  const cleaned = next.trim().slice(0, 120);
  if (!cleaned) {
    toast("Name cannot be empty", "error");
    return false;
  }
  if (cleaned === asset.name) return false;
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(currentProject.id)}/assets/${encodeURIComponent(assetId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: cleaned }),
      },
    );
    if (data.asset) {
      const idx = (currentProject.assets || []).findIndex((a) => a.id === assetId);
      if (idx >= 0) currentProject.assets[idx] = { ...currentProject.assets[idx], ...data.asset };
    } else {
      await refreshProject({ reloadPost: false });
    }
    toast("Asset renamed", "ok");
    if (activeTab === "hub") renderAssets();
    if (activeTab === "editor") {
      renderAssetPalette();
      if (currentPost?.type === "video") renderSceneGantt();
    }
    return true;
  } catch (err) {
    toast(err.message || "Could not rename asset", "error");
    return false;
  }
}

// ---------- Crop asset (creates a new derivative) ----------
let cropState = null;

function closeCropAssetDialog() {
  const dlg = $("cropAssetDialog");
  dlg?.classList.add("hidden");
  if (cropState?.img) {
    cropState.img.onload = null;
    cropState.img.onerror = null;
    cropState.img.src = "";
  }
  cropState = null;
}

function cropNormBox() {
  if (!cropState) return [0, 0, 1, 1];
  const { box, natW, natH } = cropState;
  return [
    clamp(box.x / natW, 0, 1),
    clamp(box.y / natH, 0, 1),
    clamp((box.x + box.w) / natW, 0, 1),
    clamp((box.y + box.h) / natH, 0, 1),
  ];
}

function updateCropStatus() {
  const el = $("cropAssetStatus");
  if (!el || !cropState) return;
  const [l, t, r, b] = cropNormBox();
  const pw = Math.round((r - l) * cropState.natW);
  const ph = Math.round((b - t) * cropState.natH);
  el.textContent = `${pw}×${ph}px · ${Math.round((r - l) * 100)}% × ${Math.round((b - t) * 100)}%`;
}

function setCropAspect(ratio) {
  if (!cropState) return;
  cropState.aspect = ratio; // null = free, else width/height
  document.querySelectorAll(".crop-aspect-btn").forEach((btn) => {
    const val = btn.dataset.cropAspect;
    const active = (ratio == null && val === "free")
      || (ratio != null && Number(val) === ratio);
    btn.classList.toggle("border-indigo-400", active);
    btn.classList.toggle("text-indigo-200", active);
    btn.classList.toggle("bg-indigo-500/10", active);
    btn.classList.toggle("border-white/10", !active);
    btn.classList.toggle("text-slate-300", !active);
  });
  // Image metrics aren't known until load — skip box geometry until then.
  if (!cropState.img?.naturalWidth || !cropState.natW || !cropState.natH) return;
  if (ratio != null) {
    // Fit a max rect of the chosen aspect inside the image.
    const { natW, natH } = cropState;
    let w = natW;
    let h = w / ratio;
    if (h > natH) {
      h = natH;
      w = h * ratio;
    }
    cropState.box = {
      x: (natW - w) / 2,
      y: (natH - h) / 2,
      w,
      h,
    };
  }
  drawCropCanvas();
}

function resetCropBox() {
  if (!cropState || !cropState.natW || !cropState.natH) return;
  cropState.box = { x: 0, y: 0, w: cropState.natW, h: cropState.natH };
  if (cropState.aspect != null) setCropAspect(cropState.aspect);
  else drawCropCanvas();
}

function layoutCropCanvas() {
  if (!cropState?.img?.naturalWidth) return;
  const canvas = $("cropCanvas");
  const wrap = $("cropCanvasWrap");
  if (!canvas || !wrap) return;
  const natW = cropState.img.naturalWidth;
  const natH = cropState.img.naturalHeight;
  cropState.natW = natW;
  cropState.natH = natH;
  // Dialog may still be laying out; fall back so we never get a 0×0 canvas.
  const maxW = Math.max(240, wrap.clientWidth || wrap.offsetWidth || 640);
  const maxH = Math.max(180, wrap.clientHeight || wrap.offsetHeight || 360);
  const scale = Math.min(maxW / natW, maxH / natH, 1);
  cropState.scale = scale;
  canvas.width = Math.max(1, Math.round(natW * scale));
  canvas.height = Math.max(1, Math.round(natH * scale));
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;
  if (!cropState.box) {
    cropState.box = { x: 0, y: 0, w: natW, h: natH };
  }
  // Re-apply locked aspect now that natural size is known.
  if (cropState.aspect != null) setCropAspect(cropState.aspect);
  else drawCropCanvas();
}

function drawCropCanvas() {
  const canvas = $("cropCanvas");
  if (!canvas || !cropState?.img?.naturalWidth) return;
  if (!cropState.box) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { img, box, scale } = cropState;
  if (!canvas.width || !canvas.height) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const sx = box.x * scale;
  const sy = box.y * scale;
  const sw = box.w * scale;
  const sh = box.h * scale;

  // Dim outside selection
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, canvas.width, sy);
  ctx.fillRect(0, sy + sh, canvas.width, canvas.height - (sy + sh));
  ctx.fillRect(0, sy, sx, sh);
  ctx.fillRect(sx + sw, sy, canvas.width - (sx + sw), sh);

  ctx.strokeStyle = "rgba(129, 140, 248, 0.95)";
  ctx.lineWidth = 2;
  ctx.strokeRect(sx + 1, sy + 1, Math.max(0, sw - 2), Math.max(0, sh - 2));

  // Rule-of-thirds guides
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 2; i++) {
    const gx = sx + (sw * i) / 3;
    const gy = sy + (sh * i) / 3;
    ctx.beginPath();
    ctx.moveTo(gx, sy);
    ctx.lineTo(gx, sy + sh);
    ctx.moveTo(sx, gy);
    ctx.lineTo(sx + sw, gy);
    ctx.stroke();
  }

  // Corner handles
  const hs = 7;
  ctx.fillStyle = "rgba(199, 210, 254, 0.95)";
  [
    [sx, sy], [sx + sw, sy], [sx, sy + sh], [sx + sw, sy + sh],
  ].forEach(([hx, hy]) => {
    ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
  });

  updateCropStatus();
}

function cropPointerToImage(clientX, clientY) {
  const canvas = $("cropCanvas");
  if (!canvas || !cropState) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * cropState.natW;
  const y = ((clientY - rect.top) / rect.height) * cropState.natH;
  return {
    x: clamp(x, 0, cropState.natW),
    y: clamp(y, 0, cropState.natH),
  };
}

function cropHitHandle(pt) {
  if (!cropState?.box) return null;
  const { box } = cropState;
  const tol = 14 / (cropState.scale || 1);
  const corners = {
    nw: { x: box.x, y: box.y },
    ne: { x: box.x + box.w, y: box.y },
    sw: { x: box.x, y: box.y + box.h },
    se: { x: box.x + box.w, y: box.y + box.h },
  };
  for (const [name, c] of Object.entries(corners)) {
    if (Math.abs(pt.x - c.x) <= tol && Math.abs(pt.y - c.y) <= tol) return name;
  }
  if (
    pt.x >= box.x && pt.x <= box.x + box.w
    && pt.y >= box.y && pt.y <= box.y + box.h
  ) return "move";
  return null;
}

function applyCropAspectConstraint(box, anchor, aspect) {
  if (aspect == null) return box;
  let { x, y, w, h } = box;
  if (w / h > aspect) {
    const nw = h * aspect;
    if (anchor.includes("e")) x = x + w - nw;
    w = nw;
  } else {
    const nh = w / aspect;
    if (anchor.includes("s")) y = y + h - nh;
    h = nh;
  }
  return { x, y, w, h };
}

function clampCropBox(box) {
  const { natW, natH } = cropState;
  let { x, y, w, h } = box;
  w = Math.max(8, Math.min(w, natW));
  h = Math.max(8, Math.min(h, natH));
  x = clamp(x, 0, natW - w);
  y = clamp(y, 0, natH - h);
  return { x, y, w, h };
}

function onCropPointerDown(e) {
  if (!cropState) return;
  e.preventDefault();
  const pt = cropPointerToImage(e.clientX, e.clientY);
  const hit = cropHitHandle(pt);
  cropState.drag = {
    mode: hit || "new",
    start: pt,
    orig: { ...cropState.box },
  };
  if (!hit) {
    cropState.box = { x: pt.x, y: pt.y, w: 1, h: 1 };
  }
  $("cropCanvas")?.setPointerCapture?.(e.pointerId);
  drawCropCanvas();
}

function onCropPointerMove(e) {
  if (!cropState?.drag) return;
  e.preventDefault();
  const pt = cropPointerToImage(e.clientX, e.clientY);
  const { mode, start, orig } = cropState.drag;
  const aspect = cropState.aspect;
  let box = { ...cropState.box };

  if (mode === "new") {
    let x = Math.min(start.x, pt.x);
    let y = Math.min(start.y, pt.y);
    let w = Math.abs(pt.x - start.x);
    let h = Math.abs(pt.y - start.y);
    if (aspect != null) {
      if (w / Math.max(h, 1) > aspect) h = w / aspect;
      else w = h * aspect;
      if (pt.x < start.x) x = start.x - w;
      if (pt.y < start.y) y = start.y - h;
    }
    box = clampCropBox({ x, y, w, h });
  } else if (mode === "move") {
    box = clampCropBox({
      x: orig.x + (pt.x - start.x),
      y: orig.y + (pt.y - start.y),
      w: orig.w,
      h: orig.h,
    });
  } else {
    let { x, y, w, h } = orig;
    if (mode.includes("e")) w = pt.x - x;
    if (mode.includes("s")) h = pt.y - y;
    if (mode.includes("w")) {
      w = x + w - pt.x;
      x = pt.x;
    }
    if (mode.includes("n")) {
      h = y + h - pt.y;
      y = pt.y;
    }
    if (w < 8) { w = 8; if (mode.includes("w")) x = orig.x + orig.w - 8; }
    if (h < 8) { h = 8; if (mode.includes("n")) y = orig.y + orig.h - 8; }
    box = clampCropBox(applyCropAspectConstraint({ x, y, w, h }, mode, aspect));
  }
  cropState.box = box;
  drawCropCanvas();
}

function onCropPointerUp(e) {
  if (!cropState) return;
  cropState.drag = null;
  try { $("cropCanvas")?.releasePointerCapture?.(e.pointerId); } catch (_) { /* ignore */ }
}

async function openCropAssetDialog(assetId) {
  // Prefer the full Image Editor (crop + color + resize).
  return openImageEditorModal(assetId);
}

async function saveCroppedAsset() {
  if (!cropState || !currentProject) return;
  const btn = $("cropAssetSave");
  const [left, top, right, bottom] = cropNormBox();
  if (right - left < 0.02 || bottom - top < 0.02) {
    toast("Crop region is too small", "info");
    return;
  }
  const name = ($("cropAssetName")?.value || "").trim() || undefined;
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(currentProject.id)}/assets/${encodeURIComponent(cropState.assetId)}/crop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ box: [left, top, right, bottom], name }),
      },
    );
    if (data.project) currentProject = data.project;
    toast(`Created “${data.asset?.name || "crop"}”`, "ok");
    closeCropAssetDialog();
    await refreshProject({ reloadPost: false });
    startProjectPoll();
    if (activeTab === "editor") {
      renderAssetPalette();
    }
  } catch (err) {
    toast(err.message || "Crop failed", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save as new asset"; }
  }
}

function setAssetPaletteTab(type) {
  const allowed = currentPost?.type === "video" ? ["image", "video", "audio"] : ["image", "video"];
  if (!allowed.includes(type)) type = "image";
  assetPaletteTab = type;
  renderAssetPalette();
}

function appendGroupHeader(ul, groupName, count) {
  const header = document.createElement("li");
  header.className = "list-none pt-2 first:pt-0";
  const isNamed = groupName && groupName !== "Ungrouped";
  header.innerHTML = `
    <div class="flex items-center gap-2 px-1 py-1.5">
      <span class="text-[10px] uppercase tracking-wider text-slate-500 font-medium">${escapeHtml(groupName)}</span>
      <span class="text-[10px] text-slate-600 tabular-nums">${count}</span>
      <div class="flex-1 h-px bg-white/5"></div>
      ${isNamed ? `<button type="button" class="delete-asset-group-header text-[10px] text-red-300/80 hover:text-red-200 shrink-0" data-name="${String(groupName).replace(/"/g, "&quot;")}" title="Delete group (assets become Ungrouped)">Delete group</button>` : ""}
    </div>`;
  ul.appendChild(header);
  header.querySelector(".delete-asset-group-header")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    deleteAssetGroupByName(groupName);
  });
}

function syncAssetAudioToggleUi(root, playingId = null) {
  (root || document).querySelectorAll(".asset-audio-toggle").forEach((btn) => {
    const active = playingId && btn.dataset.id === playingId;
    const icon = btn.querySelector(".material-icons");
    if (icon) {
      icon.textContent = active ? "pause" : "play_arrow";
    } else if (btn.tagName === "BUTTON") {
      btn.textContent = active ? "Pause" : "Play";
    }
    btn.classList.toggle("is-playing", !!active);
    btn.title = active ? "Pause" : "Play";
  });
}

function bindAssetAudioPlayers(root) {
  if (!root) return;
  const players = [...root.querySelectorAll("audio.asset-audio-player")];
  const syncFromPlayer = (player) => {
    const playing = player && !player.paused && !player.ended;
    syncAssetAudioToggleUi(root, playing ? player.dataset.id : null);
  };
  players.forEach((player) => {
    player.addEventListener("play", () => {
      players.forEach((other) => {
        if (other !== player && !other.paused) other.pause();
      });
      syncFromPlayer(player);
    });
    player.addEventListener("pause", () => syncFromPlayer(player));
    player.addEventListener("ended", () => syncFromPlayer(player));
  });
  root.querySelectorAll(".asset-audio-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.id;
      const player = root.querySelector(`audio.asset-audio-player[data-id="${CSS.escape(id)}"]`);
      if (!player) return;
      if (player.paused) {
        players.forEach((other) => {
          if (other !== player && !other.paused) other.pause();
        });
        player.play().catch((err) => toast(`Playback failed: ${err.message || err}`, "error"));
      } else {
        player.pause();
      }
    });
  });
}

function renderAssets() {
  const ul = $("assetList");
  if (!ul) return;
  renderAssetGroupManager();
  syncProjectTtsPanel();
  syncProjectVideoGenPanel();
  const assets = projectSharedAssets();
  const logoSetCount = PROJECT_LOGO_SLOTS.filter(
    (slot) => !!(currentProject?.[slot.pathKey]),
  ).length;
  const counts = {
    image: assetsOfType("image", { scope: "project" }).length,
    video: assetsOfType("video", { scope: "project" }).length,
    audio: assetsOfType("audio", { scope: "project" }).length,
    logos: logoSetCount,
  };
  syncAssetTypeTabs(".asset-type-tab", assetLibraryTab, counts);

  const isLogos = assetLibraryTab === "logos";
  $("hubProjectLogosPanel")?.classList.toggle("hidden", !isLogos);
  $("hubLocalAssetsToolbar")?.classList.toggle("hidden", isLogos);
  ul.classList.toggle("hidden", isLogos);
  if (isLogos) {
    ul.innerHTML = "";
    renderProjectLogos();
    return;
  }

  ul.innerHTML = "";

  if (!assets.length) {
    ul.innerHTML = `<li class="px-4 py-8 text-center text-xs text-slate-500">No shared project assets yet. Upload photos, videos, or music — or move assets here from a post.</li>`;
    syncAssetGroupFilterSelect("assetGroupFilter", []);
    return;
  }

  const typeMeta = ASSET_TYPE_GROUPS.find((g) => g.type === assetLibraryTab) || ASSET_TYPE_GROUPS[0];
  const typed = assetsOfType(typeMeta.type, { scope: "project" });
  syncAssetGroupFilterSelect("assetGroupFilter", assets);
  const items = filterItemsByGroup(typed);
  const allGroupNames = collectAssetGroupNames(assets);

  if (!typed.length) {
    ul.innerHTML = `<li class="px-4 py-8 text-center text-xs text-slate-500">No shared ${typeMeta.label.toLowerCase()} yet.</li>`;
    return;
  }
  if (!items.length) {
    ul.innerHTML = `<li class="px-4 py-8 text-center text-xs text-slate-500">No assets in this group.</li>`;
    return;
  }

  const sections = partitionByGroup(items);
  let cardIndex = 0;
  for (const section of sections) {
    if (assetGroupFilter === "__all__") appendGroupHeader(ul, section.name, section.items.length);
    for (const a of section.items) {
      const li = document.createElement("li");
      const statusCls = a.status === "processing" || a.status === "pending" ? "pulse-row" : "";
      const failedCls = a.status === "failed" ? "is-failed" : "";
      const thumbSrc = getAssetThumbUrl(a) || "";
      const audioUrl = a.type === "audio" ? getAudioAssetUrl(a) : null;
      const groupName = assetGroupLabel(a);
      const tipParts = [
        a.name,
        a.original_filename,
        formatAssetMediaSummary(a),
        a.description,
        a.error,
        a.type === "image" ? `Variants: ${availableImageFormats(a).join(", ") || "—"}` : "",
      ].filter(Boolean);
      const canPreview = (a.type === "image" || a.type === "video") && !!(getAssetPreviewUrl(a) || thumbSrc);
      const thumb = (a.type === "image" || a.type === "video") && thumbSrc
        ? `<img src="${thumbSrc}" class="asset-thumb-img" alt="" onerror="this.style.display='none'">`
        : a.type === "audio" && audioUrl
          ? `<button type="button" class="asset-audio-toggle asset-thumb-play" data-id="${a.id}" title="Play / pause">
              <span class="material-icons" aria-hidden="true">play_arrow</span>
            </button>`
          : `<span class="material-icons asset-thumb-fallback" aria-hidden="true">${typeMeta.icon}</span>`;
      const delay = Math.min(cardIndex, 16) * 30;
      cardIndex += 1;
      const mediaSummary = formatAssetMediaSummary(a, { compact: true });
      li.className = `asset-card ${failedCls} ${statusCls}`;
      li.style.animationDelay = `${delay}ms`;
      li.title = tipParts.join(" · ");
      const thumbWrap = canPreview
        ? `<button type="button" class="asset-thumb is-previewable preview-asset" data-id="${a.id}" title="Preview">${thumb}</button>`
        : `<div class="asset-thumb">${thumb}</div>`;
      const hasVideoThumb = a.type === "video" && !!a.processed_formats?.thumb;
      li.innerHTML = `
        ${thumbWrap}
        <div class="asset-card-body min-w-0 flex-1">
          <div class="flex items-center gap-2 min-w-0">
            <button type="button" class="asset-card-title truncate rename-asset text-left" data-id="${a.id}" title="Rename">${escapeHtml(a.name)}</button>
            ${assetStatusDot(a)}
          </div>
          <div class="asset-card-meta truncate">
            ${assetScopeChip(a)}
            <span class="asset-meta-sep">·</span>
            <span>${escapeHtml(groupName)}</span>
            ${mediaSummary ? `<span class="asset-meta-sep">·</span><span title="${escapeHtml(formatAssetMediaSummary(a))}">${escapeHtml(mediaSummary)}</span>` : ""}
          </div>
          <div class="asset-card-controls">
            ${groupSelectHtml(a, allGroupNames)}
            ${assetScopeSelectHtml(a)}
          </div>
          ${audioUrl ? `<audio class="asset-audio-player sr-only" data-id="${a.id}" src="${escapeHtml(audioUrl)}" preload="metadata"></audio>` : ""}
          ${a.error ? `<div class="asset-card-error truncate">${escapeHtml(a.error)}</div>` : ""}
        </div>
        <div class="asset-card-actions">
          ${canPreview ? `<button type="button" class="asset-icon-btn preview-asset" data-id="${a.id}" title="Preview"><span class="material-icons" aria-hidden="true">visibility</span></button>` : ""}
          ${a.type === "video" ? `<button type="button" class="asset-icon-btn video-thumb-asset ${hasVideoThumb ? "" : "is-on"}" data-id="${a.id}" title="${hasVideoThumb ? "Regenerate thumbnail" : "Generate thumbnail"}"><span class="material-icons" aria-hidden="true">photo_camera</span></button>` : ""}
          ${a.type === "image" ? `
            <label class="asset-icon-btn ${a.apply_logo ? "is-on" : ""}" title="Apply logo watermark">
              <input type="checkbox" class="logo-toggle sr-only" data-id="${a.id}" ${a.apply_logo ? "checked" : ""} />
              <span class="material-icons" aria-hidden="true">branding_watermark</span>
            </label>` : ""}
          ${a.status === "failed" && a.type === "image" ? `<button type="button" class="asset-icon-btn retry-asset" data-id="${a.id}" title="Retry"><span class="material-icons" aria-hidden="true">refresh</span></button>` : ""}
          ${a.type === "image" ? `<button type="button" class="asset-icon-btn crop-asset" data-id="${a.id}" title="Edit image"><span class="material-icons" aria-hidden="true">photo_settings</span></button>` : ""}
          ${a.type === "image" ? `<button type="button" class="asset-icon-btn ai-edit-asset" data-id="${a.id}" title="Edit with AI"><span class="material-icons" aria-hidden="true">auto_fix</span></button>` : ""}
          ${a.type === "video" && a.original_path ? `<button type="button" class="asset-icon-btn edit-video-asset" data-id="${a.id}" title="Edit video"><span class="material-icons" aria-hidden="true">video_settings</span></button>` : ""}
          ${a.type === "video" ? `
            <button type="button" class="asset-icon-btn edit-asset-description ${!(a.description || "").trim() ? "is-on" : ""}" data-id="${a.id}" title="${(a.description || "").trim() ? "Edit description" : "Add description (needed for AI when file is over 20 MB)"}">
              <span class="material-icons" aria-hidden="true">notes</span>
            </button>` : ""}
          ${audioUrl ? `<button type="button" class="asset-icon-btn asset-audio-toggle" data-id="${a.id}" title="Play"><span class="material-icons" aria-hidden="true">play_arrow</span></button>` : ""}
          ${a.original_path && !a.locked ? `<button type="button" class="asset-icon-btn download-asset" data-id="${a.id}" title="Download"><span class="material-icons" aria-hidden="true">download</span></button>` : ""}
          ${a.locked ? `<span class="asset-icon-btn is-on" title="Locked stock asset — app use only"><span class="material-icons" aria-hidden="true">lock</span></span>` : ""}
          <button type="button" class="asset-icon-btn rename-asset" data-id="${a.id}" title="Rename"><span class="material-icons" aria-hidden="true">edit</span></button>
          <button type="button" class="asset-icon-btn is-danger delete-asset" data-id="${a.id}" title="Delete"><span class="material-icons" aria-hidden="true">delete</span></button>
        </div>`;
      ul.appendChild(li);
    }
  }
  bindAssetGroupSelects(ul);
  bindAssetScopeSelects(ul);
  bindAssetAudioPlayers(ul);
  ul.querySelectorAll(".preview-asset").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const asset = getAssetById(btn.dataset.id);
      if (asset) openAssetPreview(asset);
    });
  });
  ul.querySelectorAll(".video-thumb-asset").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await generateVideoThumb(btn.dataset.id);
    });
  });
  ul.querySelectorAll(".rename-asset").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      renameProjectAsset(btn.dataset.id);
    });
  });
  ul.querySelectorAll(".edit-asset-description").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const asset = getAssetById(btn.dataset.id);
      if (!asset) return;
      await promptManualVideoDescription(asset, { reason: "edit" });
      if (activeTab === "hub") renderAssets();
    });
  });
  ul.querySelectorAll(".download-asset").forEach((btn) => {
    btn.addEventListener("click", () => downloadProjectAsset(btn.dataset.id));
  });
  ul.querySelectorAll(".ai-edit-asset").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!currentPost) {
        toast("Open a post in the editor to edit photos with AI", "info");
        return;
      }
      openAiPanel("photo");
      const sel = $("aiPhotoTarget");
      if (sel) sel.value = `asset:${btn.dataset.id}`;
    });
  });
  ul.querySelectorAll(".crop-asset").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openImageEditorModal(btn.dataset.id);
    });
  });
  ul.querySelectorAll(".edit-video-asset").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openVideoEditorModal(btn.dataset.id);
    });
  });
  ul.querySelectorAll(".logo-toggle").forEach((cb) => {
    cb.addEventListener("change", async (e) => {
      try {
        await api(`/api/projects/${encodeURIComponent(currentProject.id)}/assets/${e.target.dataset.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apply_logo: e.target.checked }),
        });
        toast("Reprocessing with new logo setting…", "info");
        await refreshProject();
      } catch (err) { toast(err.message, "error"); }
    });
  });
  ul.querySelectorAll(".delete-asset").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await deleteProjectAsset(btn.dataset.id);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
  ul.querySelectorAll(".retry-asset").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/projects/${encodeURIComponent(currentProject.id)}/assets/${btn.dataset.id}/process`, {
          method: "POST",
        });
        toast("Re-processing…", "info");
        await refreshProject({ reloadPost: false });
        startProjectPoll();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });
}

async function uploadAssets(files, { postId = undefined } = {}) {
  const list = Array.from(files);
  if (!list.length || !currentProject) return;
  const resolvedPostId = postId !== undefined
    ? postId
    : readAssetScopeValue("uploadAssetScope", { fallback: null });
  const statusEl = postId ? $("paletteUploadStatus") : $("assetUploadStatus");
  if (statusEl) statusEl.textContent = `Uploading ${list.length} file(s)…`;
  const group = (postId ? $("paletteUploadGroup")?.value : $("uploadAssetGroup")?.value)?.trim() || "";
  const applyLogo = postId
    ? !!$("paletteApplyLogo")?.checked
    : !!$("uploadApplyLogo")?.checked;
  let ok = 0;
  let hadVideo = false;
  const mediaNotes = [];
  const needManual = [];
  for (const f of list) {
    const clientSize = formatBytesShort(f.size);
    if (statusEl && /\.(mp4|mov|mkv|webm|avi|m4v|mts|m2ts|ts|wmv|flv|mpg|mpeg|3gp|ogv|mxf)$/i.test(f.name || "")) {
      statusEl.textContent = `Uploading ${f.name}${clientSize ? ` (${clientSize})` : ""}…`;
    }
    const fd = new FormData();
    fd.append("file", f);
    fd.append("apply_logo", applyLogo ? "true" : "false");
    if (group) fd.append("group", group);
    if (resolvedPostId) fd.append("post_id", resolvedPostId);
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/assets`, { method: "POST", body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
      if (data.project) currentProject = data.project;
      ok++;
      const uploaded = data.asset;
      if (uploaded?.type === "video") hadVideo = true;
      if (uploaded && (uploaded.type === "video" || uploaded.type === "audio")) {
        const summary = formatAssetMediaSummary(uploaded);
        if (summary) mediaNotes.push(`${uploaded.name}: ${summary}`);
      }
      if (data.needs_manual_description || videoNeedsManualDescription(uploaded)) {
        needManual.push(uploaded);
      }
    } catch (_) {}
  }
  if (statusEl) {
    const base = `Uploaded ${ok}/${list.length}`;
    statusEl.textContent = mediaNotes.length
      ? `${base} — ${mediaNotes.slice(0, 3).join("; ")}${mediaNotes.length > 3 ? "…" : ""}`
      : base;
  }
  toast(
    resolvedPostId
      ? `Uploaded ${ok} asset(s) to the selected post`
      : `Uploaded ${ok} project asset(s)`,
    "ok",
  );
  for (const asset of needManual) {
    await promptManualVideoDescription(asset);
  }
  await refreshProject({ reloadPost: false });
  // Video thumbs are generated in the background — refresh once they land.
  if (hadVideo) {
    setTimeout(() => { refreshProject({ reloadPost: false }).catch(() => {}); }, 2000);
    setTimeout(() => { refreshProject({ reloadPost: false }).catch(() => {}); }, 5000);
  }
  if (!postId) {
    const input = $("assetFileInput");
    if (input) input.value = "";
  }
}

// ---------- Editor ----------
function getActiveLayers() {
  if (!currentProject || !currentPost) return [];
  if (currentPost.type === "video") {
    const scene = getActiveScene();
    return scene?.layers || [];
  }
  return currentPost.layers || [];
}

function getActiveScene() {
  if (!currentProject || currentPost?.type !== "video") return null;
  const scenes = currentPost.scenes || [];
  if (!scenes.length) return null;
  return scenes.find((s) => s.id === activeSceneId) || scenes[0];
}

/**
 * Resolve the scene that should own a newly added layer.
 * Prefer an explicit id, else the scene under the playhead, else the active scene.
 * Creates a default scene when the video post has none.
 */
function ensureSceneForLayers(preferredSceneId = null) {
  if (!currentPost || currentPost.type !== "video") return null;
  if (!Array.isArray(currentPost.scenes)) currentPost.scenes = [];
  if (!currentPost.scenes.length) {
    const fmt = getTargetFormat();
    currentPost.scenes.push({
      id: uid(),
      name: "Scene 1",
      duration_s: 5,
      gap_before_s: 0,
      background_asset_id: null,
      background_format: fmt,
      layers: [],
      ref_post_id: null,
    });
  }
  let sceneId = preferredSceneId;
  if (!sceneId) {
    const row = sceneRowAtAbsoluteTime(previewAbsS);
    sceneId = row?.scene?.id || activeSceneId || currentPost.scenes[0].id;
  }
  let scene =
    currentPost.scenes.find((s) => s.id === sceneId) || currentPost.scenes[0];
  if (isSceneRef(scene)) {
    // Prefer the nearest non-ref scene; otherwise create a new scene after the ref.
    const nonRef = currentPost.scenes.find((s) => !isSceneRef(s));
    if (nonRef) {
      scene = nonRef;
    } else {
      const fmt = getTargetFormat();
      scene = {
        id: uid(),
        name: `Scene ${(currentPost.scenes.length || 0) + 1}`,
        duration_s: 5,
        gap_before_s: 0,
        background_asset_id: null,
        background_format: fmt,
        layers: [],
        ref_post_id: null,
      };
      currentPost.scenes.push(scene);
    }
  }
  if (!Array.isArray(scene.layers)) scene.layers = [];
  activeSceneId = scene.id;
  return scene;
}

/** Move any top-level video post.layers into the first scene (legacy / mistakes). */
function normalizeVideoPostOwnership(post = currentPost) {
  if (!post || post.type !== "video") return;
  if (!Array.isArray(post.scenes)) post.scenes = [];
  if (!post.scenes.length) {
    const fmt = post.target_format || "portrait";
    post.scenes.push({
      id: uid(),
      name: "Scene 1",
      duration_s: 5,
      gap_before_s: 0,
      background_asset_id: null,
      background_format: fmt,
      layers: [],
    });
  }
  if (Array.isArray(post.layers) && post.layers.length) {
    const scene = post.scenes[0];
    if (!Array.isArray(scene.layers)) scene.layers = [];
    scene.layers = [...scene.layers, ...post.layers];
    post.layers = [];
  }
  for (const scene of post.scenes) {
    if (!Array.isArray(scene.layers)) scene.layers = [];
  }
}

function appendLayerToScene(scene, layer, { asBottom = false } = {}) {
  if (!scene) return;
  if (!Array.isArray(scene.layers)) scene.layers = [];
  if (asBottom) {
    const bumped = scene.layers.map((l) => ({ ...l, z_index: (l.z_index || 0) + 1 }));
    scene.layers = [layer, ...bumped];
  } else {
    scene.layers = [...scene.layers, layer];
  }
}

function setActiveLayers(layers) {
  if (currentPost?.type === "video") {
    const scene = ensureSceneForLayers(activeSceneId);
    if (scene) scene.layers = layers;
  } else {
    currentPost.layers = layers;
  }
}

function scheduleSavePost() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePost, 600);
}

async function savePost() {
  if (!currentProject || !currentPost) return;
  flushLayerPropsFromDom();
  normalizeVideoPostOwnership(currentPost);
  const editingLayerId = selectedLayerId;
  const draftText = $("propText")?.value;
  const draftVoice = $("propTtsVoice")?.value;
  try {
    const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post: currentPost }),
    });
    // Keep any edits typed while the request was in flight.
    flushLayerPropsFromDom();
    if (data.post) currentPost = data.post;
    if (data.project) currentProject = data.project;
    const live = editingLayerId ? getLayerById(editingLayerId) : null;
    if (live) {
      if (draftText != null && (live.type === "text" || live.type === "tts")) {
        const newest = $("propText")?.value;
        live.text = newest != null ? newest : draftText;
      }
      if (draftVoice && live.type === "tts") {
        const newestVoice = $("propTtsVoice")?.value;
        live.tts_voice = newestVoice || draftVoice;
      }
    }
    $("saveStatus").textContent = "Saved";
    setTimeout(() => { if ($("saveStatus").textContent === "Saved") $("saveStatus").textContent = ""; }, 2000);
    renderInteractiveCanvas();
  } catch (e) {
    $("saveStatus").textContent = "Save failed";
  }
}

function renderEditor() {
  if (!currentProject || !currentPost) return;
  updatePostTypeBadges();
  // Apply the initial display format before we render the preview/canvas
  // so the editor-stage aspect ratio matches immediately.
  if ($("targetFormat")) $("targetFormat").value = currentPost.target_format || "portrait";
  syncPostReusableToggle();
  renderSceneGantt();
  setEditorSideTab(editorSideTab);
  renderLayerProperties();
  updateCanvasPreview();
  $("addTtsLayerBtn")?.classList.toggle("hidden", currentPost?.type !== "video");
  $("paletteAudioTab")?.classList.toggle("hidden", currentPost?.type !== "video");
  if (currentPost?.type === "video") {
    const scene = getActiveScene();
    const durEl = $("sceneDuration");
    if (scene && durEl) {
      const isRef = isSceneRef(scene);
      durEl.value = sceneEffectiveDuration(scene);
      durEl.readOnly = isRef;
      durEl.title = isRef
        ? "Duration follows the reusable post"
        : "Active scene duration (s)";
    }
    syncPreviewTimeControls();
  } else {
    stopPreviewPlayback();
  }
  renderProjectHeader();
  syncAiScriptTabVisibility();
}

function getSceneTimeline() {
  const scenes = currentPost?.scenes || [];
  let t = 0;
  return scenes.map((s) => {
    const gap = Math.max(0, Number(s.gap_before_s) || 0);
    t += gap;
    const duration = sceneEffectiveDuration(s);
    // Keep stored duration in sync for save/export metadata.
    if (s.ref_post_id) s.duration_s = duration;
    const start = t;
    t += duration;
    return { scene: s, start, duration, end: t, gap };
  });
}

function findProjectPost(postId) {
  if (!postId) return null;
  if (currentPost?.id === postId) return currentPost;
  return (currentProject?.posts || []).find((p) => p.id === postId) || null;
}

function isSceneRef(scene) {
  return !!(scene && String(scene.ref_post_id || "").trim());
}

function computePostDuration(post, stack = null) {
  if (!post || post.type !== "video") return 0.5;
  const seen = stack || new Set();
  if (seen.has(post.id)) return 0.5;
  seen.add(post.id);
  let t = 0;
  const scenes = post.scenes || [];
  if (!scenes.length) return 0.5;
  for (const scene of scenes) {
    t += Math.max(0, Number(scene.gap_before_s) || 0);
    const refId = String(scene.ref_post_id || "").trim();
    if (refId) {
      t += computePostDuration(findProjectPost(refId), seen);
    } else {
      t += Math.max(0.5, Number(scene.duration_s) || 0.5);
    }
  }
  return Math.max(0.5, t);
}

function sceneEffectiveDuration(scene) {
  const refId = String(scene?.ref_post_id || "").trim();
  if (refId) {
    const ref = findProjectPost(refId);
    if (ref) return computePostDuration(ref, new Set([currentPost?.id].filter(Boolean)));
    return Math.max(0.5, Number(scene.duration_s) || 0.5);
  }
  return Math.max(0.5, Number(scene?.duration_s) || 5);
}

function listReusablePosts() {
  return (currentProject?.posts || []).filter(
    (p) => p.type === "video" && p.is_reusable && p.id !== currentPost?.id,
  );
}

function insertReusablePost(sourcePostId) {
  if (currentPost?.type !== "video") {
    toast("Reusable clips are for video posts", "error");
    return;
  }
  const src = findProjectPost(sourcePostId);
  if (!src || src.type !== "video") {
    toast("Reusable post not found", "error");
    return;
  }
  if (!src.is_reusable) {
    toast("That post is not marked reusable", "error");
    return;
  }
  if (src.id === currentPost.id) {
    toast("A post cannot embed itself", "error");
    return;
  }
  const dur = computePostDuration(src, new Set([currentPost.id]));
  const scene = {
    id: uid(),
    name: src.name || "Reusable post",
    duration_s: dur,
    gap_before_s: 0,
    background_asset_id: null,
    background_format: getTargetFormat(),
    layers: [],
    ref_post_id: src.id,
  };
  currentPost.scenes = currentPost.scenes || [];
  currentPost.scenes.push(scene);
  activeSceneId = scene.id;
  selectedLayerId = null;
  propsOverlayOpen = false;
  previewTimeS = 0;
  const row = getSceneTimeline().find((r) => r.scene.id === scene.id);
  previewAbsS = row?.start || 0;
  scheduleSavePost();
  renderEditor();
  toast(`Inserted “${src.name}”`, "ok");
}

function openInsertReusableDialog() {
  const dlg = $("insertReusableDialog");
  const sel = $("insertReusableSelect");
  const empty = $("insertReusableEmpty");
  const confirmBtn = $("insertReusableConfirm");
  if (!dlg || !sel) return;
  const items = listReusablePosts();
  sel.innerHTML = items
    .map((p) => {
      const dur = computePostDuration(p).toFixed(1);
      return `<option value="${p.id}">${escapeHtml(p.name)} · ${dur}s</option>`;
    })
    .join("");
  empty?.classList.toggle("hidden", items.length > 0);
  sel.classList.toggle("hidden", !items.length);
  if (confirmBtn) confirmBtn.disabled = !items.length;
  dlg.classList.remove("hidden");
}

function syncPostReusableToggle() {
  const wrap = $("postReusableToggleWrap");
  const cb = $("postReusableToggle");
  if (!wrap || !cb) return;
  const show = currentPost?.type === "video";
  wrap.classList.toggle("hidden", !show);
  wrap.classList.toggle("flex", show);
  if (show) cb.checked = !!currentPost.is_reusable;
}

function getTotalDuration() {
  const timeline = getSceneTimeline();
  if (!timeline.length) return 5;
  return Math.max(0.5, timeline[timeline.length - 1].end);
}

/** Minimum scene length so every timed layer still fits. */
function sceneMinDuration(scene) {
  let min = 0.5;
  for (const layer of scene?.layers || []) {
    if (layer.duration_s == null) continue;
    const end = Math.max(0, Number(layer.start_s) || 0) + Math.max(0.1, Number(layer.duration_s));
    if (end > min) min = end;
  }
  return min;
}

/**
 * Grow scene so the layer fits. Following scenes shift later by the same delta
 * (sequential timeline + gaps). Returns seconds added.
 */
function ensureSceneFitsLayer(scene, layer) {
  if (!scene || layer?.duration_s == null) return 0;
  const needed = Math.max(0, Number(layer.start_s) || 0) + Math.max(0.1, Number(layer.duration_s));
  const cur = Math.max(0.5, Number(scene.duration_s) || 5);
  if (needed <= cur + 1e-9) return 0;
  const delta = needed - cur;
  scene.duration_s = needed;
  return delta;
}

function setSceneDuration(scene, nextDur) {
  if (!scene || isSceneRef(scene)) return;
  scene.duration_s = Math.max(sceneMinDuration(scene), Math.min(120, Number(nextDur) || 0.5));
  if ($("sceneDuration") && scene.id === activeSceneId) {
    $("sceneDuration").value = scene.duration_s;
  }
}

function niceTickSeconds(total) {
  if (total <= 8) return 1;
  if (total <= 20) return 2;
  if (total <= 45) return 5;
  if (total <= 90) return 10;
  return 15;
}

let ganttDrag = null;
/** @type {null | { track: Element }} */
let ganttSeek = null;

function renderSceneGantt() {
  const wrap = $("sceneGantt");
  const body = $("ganttBody");
  const leftMain = $("editorLeftMain");
  const imageHint = $("imageTimelineHint");
  if (!wrap || !body) return;
  const isVideo = currentPost?.type === "video";
  leftMain?.classList.toggle("is-image-post", !isVideo);
  imageHint?.classList.toggle("hidden", isVideo);
  if (!isVideo) {
    wrap.classList.add("hidden");
    body.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");

  const timeline = getSceneTimeline();
  const total = Math.max(0.5, (timeline.length ? timeline[timeline.length - 1].end : 5));
  const pxPerSec = Math.max(28, Math.min(72, 640 / total));
  const trackW = Math.max(320, Math.ceil(total * pxPerSec));
  const tickEvery = niceTickSeconds(total);
  const segments = Math.max(1, Math.round(total / tickEvery));

  if ($("ganttTotalLabel")) {
    const gapTotal = timeline.reduce((sum, r) => sum + (r.gap || 0), 0);
    const gapNote = gapTotal > 0.01 ? ` · ${gapTotal.toFixed(1)}s gaps` : "";
    $("ganttTotalLabel").textContent = `${total.toFixed(1)}s total · ${timeline.length} scene${timeline.length === 1 ? "" : "s"}${gapNote}`;
  }

  const activeAbs = (() => {
    const row = timeline.find((r) => r.scene.id === activeSceneId) || timeline[0];
    return row ? row.start + clamp(previewTimeS, 0, row.duration) : 0;
  })();

  const pct = (sec) => `${(sec / total) * 100}%`;

  let rulerTicks = "";
  for (let t = 0; t <= total + 0.001; t += tickEvery) {
    const left = (Math.min(t, total) / total) * 100;
    rulerTicks += `<span class="gantt-tick" style="left:${left}%">${t.toFixed(t % 1 ? 1 : 0)}s</span>`;
  }

  let labelsHtml = `<div class="gantt-label gantt-label-ruler">Time</div>`;
  let tracksHtml = `<div class="gantt-ruler-track" style="width:${trackW}px">${rulerTicks}</div>`;

  labelsHtml += `<div class="gantt-label">Scenes</div>`;
  tracksHtml += `
    <div class="gantt-track" data-gantt-track="scenes" style="width:${trackW}px; --gantt-segments:${segments}">
      <div class="gantt-playhead" style="left:${pct(activeAbs)}"></div>`;

  for (const row of timeline) {
    const active = row.scene.id === activeSceneId;
    const isRef = isSceneRef(row.scene);
    const gapHint = row.gap > 0.01 ? ` · gap ${row.gap.toFixed(1)}s before` : "";
    const refCls = isRef ? " scene-ref" : "";
    tracksHtml += `
      <div class="gantt-bar scene ${active ? "active" : ""}${refCls}"
           data-kind="scene" data-id="${row.scene.id}" data-ref="${isRef ? "1" : "0"}"
           style="left:${pct(row.start)}; width:${pct(row.duration)}"
           title="${escapeHtml(row.scene.name)} · ${row.duration.toFixed(1)}s${isRef ? " · reusable" : ""}${gapHint}">
        ${isRef ? "" : `<span class="gantt-bar-handle left" data-handle="left"></span>`}
        <span class="gantt-bar-label truncate pr-5">${isRef ? "◎ " : ""}${escapeHtml(row.scene.name)} <span class="opacity-70">${row.duration.toFixed(1)}s</span></span>
        <button type="button" class="gantt-bar-del" data-gantt-scene-del="${row.scene.id}" title="Delete">${isRef ? "×" : "×"}</button>
        ${isRef ? "" : `<span class="gantt-bar-handle right" data-handle="right"></span>`}
      </div>`;
  }
  tracksHtml += `</div>`;

  // All scenes' layers on the absolute timeline (Gantt placement across the video)
  const layerEntries = [];
  for (const row of timeline) {
    if (isSceneRef(row.scene)) continue;
    for (const layer of [...(row.scene.layers || [])].sort((a, b) => a.z_index - b.z_index)) {
      layerEntries.push({ row, layer });
    }
  }

  if (!layerEntries.length) {
    const dropScene = getActiveScene() || getSceneTimeline()[0]?.scene;
    const dropSceneId = dropScene?.id || "";
    labelsHtml += `<div class="gantt-label">Layers</div>`;
    tracksHtml += `
      <div class="gantt-track" data-gantt-track="layer" data-scene-id="${dropSceneId}" style="width:${trackW}px; --gantt-segments:${segments}">
        <div class="gantt-playhead" style="left:${pct(activeAbs)}"></div>
        <div class="absolute inset-0 flex items-center justify-center text-[10px] text-slate-600 pointer-events-none">
          Drop assets onto a scene to add layers
        </div>
      </div>`;
  } else {
    for (const { row, layer } of layerEntries) {
      const startLocal = clamp(
        Number(layer.start_s) || 0,
        0,
        Math.max(0, row.duration - 0.1),
      );
      const speechLocked = layer.type === "tts" && layer.asset_id;
      // After Generate, show the full speech length (scene is grown to fit on synthesize).
      const effective = layerEffectiveDuration(layer, row.duration);
      const dur = speechLocked
        ? effective
        : Math.min(effective, Math.max(0.1, row.duration - startLocal));
      const absStart = row.start + startLocal;
      // Prefer px widths so bars stay visible even if % math goes weird.
      const leftPx = Math.max(0, (absStart / total) * trackW);
      const widthPx = Math.max(10, (Math.max(0.1, dur) / total) * trackW);
      const icon = layerTypeIcon(layer.type);
      const title = layerDisplayTitle(layer);
      const typeCls = layer.type === "tts" ? "layer-tts"
        : layer.type === "audio" ? "layer-audio"
          : layer.type === "video" ? "layer-video"
            : layer.type === "text" ? "layer-text" : "layer-image";
      const selected = layer.id === selectedLayerId && !selectedMaskId && row.scene.id === activeSceneId ? "active" : "";
      const dim = row.scene.id !== activeSceneId ? "opacity-60" : "";
      const escTitle = escapeHtml(`${row.scene.name}: ${title}`);
      const tip = escapeHtml(
        `${row.scene.name} · ${title} · ${startLocal.toFixed(1)}s–${(startLocal + dur).toFixed(1)}s${
          speechLocked ? " · length from speech" : ""
        }`,
      );
      const canMask = layer.type === "image" || layer.type === "video";
      const maskCount = canMask ? ensureLayerMasks(layer).length : 0;
      labelsHtml += `<div class="gantt-label ${dim}" title="${escTitle}"><span class="layer-type-icon"><span class="material-icons" aria-hidden="true">${icon}</span></span> ${escapeHtml(title)}</div>`;
      tracksHtml += `
        <div class="gantt-track ${dim}" data-gantt-track="layer" data-scene-id="${row.scene.id}" style="width:${trackW}px; --gantt-segments:${segments}">
          <div class="gantt-playhead" style="left:${pct(activeAbs)}"></div>
          <div class="gantt-bar ${typeCls} ${selected}"
               data-kind="layer" data-id="${layer.id}" data-scene-id="${row.scene.id}"
               style="left:${leftPx}px; width:${widthPx}px"
               title="${tip}">
            ${speechLocked ? "" : '<span class="gantt-bar-handle left" data-handle="left"></span>'}
            <span class="gantt-bar-label truncate pr-5"><span class="material-icons" aria-hidden="true">${icon}</span> ${escapeHtml(title)} <span class="opacity-70">${dur.toFixed(1)}s</span></span>
            ${canMask ? `<button type="button" class="gantt-bar-mask-btn" data-gantt-mask-layer="${layer.id}" data-scene-id="${row.scene.id}" title="${maskCount ? `${maskCount} mask${maskCount === 1 ? "" : "s"}` : "Add transparency mask"}"><span class="material-icons" aria-hidden="true">texture</span></button>` : ""}
            <button type="button" class="gantt-bar-del" data-gantt-del="${layer.id}" data-scene-id="${row.scene.id}" title="Delete layer">×</button>
            ${speechLocked ? "" : '<span class="gantt-bar-handle right" data-handle="right"></span>'}
          </div>
        </div>`;

      if (canMask) {
        ensureLayerMasks(layer).forEach((mask, mi) => {
          const layerDur = dur;
          const maskStartLocal = clamp(
            Number(mask.start_s) || 0,
            0,
            Math.max(0, layerDur - 0.1),
          );
          const maskDur = Math.min(
            maskEffectiveDuration(mask, layerDur),
            Math.max(0.1, layerDur - maskStartLocal),
          );
          const maskAbsStart = absStart + maskStartLocal;
          const mLeftPx = Math.max(0, (maskAbsStart / total) * trackW);
          const mWidthPx = Math.max(10, (Math.max(0.1, maskDur) / total) * trackW);
          const mTitle = maskDisplayTitle(mask, mi);
          const mSelected = mask.id === selectedMaskId && layer.id === selectedLayerId
            && row.scene.id === activeSceneId ? "active" : "";
          const mTip = escapeHtml(
            `${title} · ${mTitle} · layer-local ${maskStartLocal.toFixed(1)}s–${(maskStartLocal + maskDur).toFixed(1)}s`,
          );
          labelsHtml += `<div class="gantt-label gantt-label-mask ${dim}" title="${escapeHtml(mTitle)}"><span class="layer-type-icon"><span class="material-icons" aria-hidden="true">texture</span></span> ${escapeHtml(mTitle)}</div>`;
          tracksHtml += `
            <div class="gantt-track ${dim}" data-gantt-track="mask" data-scene-id="${row.scene.id}" style="width:${trackW}px; --gantt-segments:${segments}">
              <div class="gantt-playhead" style="left:${pct(activeAbs)}"></div>
              <div class="gantt-bar layer-mask ${mSelected}"
                   data-kind="mask" data-id="${mask.id}" data-layer-id="${layer.id}" data-scene-id="${row.scene.id}"
                   style="left:${mLeftPx}px; width:${mWidthPx}px"
                   title="${mTip}">
                <span class="gantt-bar-handle left" data-handle="left"></span>
                <span class="gantt-bar-label truncate pr-5"><span class="material-icons" aria-hidden="true">texture</span> ${escapeHtml(mTitle)} <span class="opacity-70">${maskDur.toFixed(1)}s</span></span>
                <button type="button" class="gantt-bar-del" data-gantt-mask-del="${mask.id}" data-layer-id="${layer.id}" data-scene-id="${row.scene.id}" title="Delete mask">×</button>
                <span class="gantt-bar-handle right" data-handle="right"></span>
              </div>
            </div>`;
        });
      }
    }
  }

  body.innerHTML = `
    <div class="gantt-fixed-labels">${labelsHtml}</div>
    <div class="gantt-tracks-scroll scrollbar-thin">
      <div class="gantt-tracks-inner" style="width:${trackW}px">${tracksHtml}</div>
    </div>`;
  body.style.width = "";

  body.querySelectorAll(".gantt-bar").forEach((bar) => {
    bar.addEventListener("mousedown", onGanttBarDown);
    if (bar.dataset.kind === "layer") {
      bar.addEventListener("contextmenu", (e) => {
        if (e.target.closest(".gantt-bar-del") || e.target.closest(".gantt-bar-mask-btn")
            || e.target.closest(".gantt-bar-handle")) return;
        const sceneId = bar.dataset.sceneId;
        const layerId = bar.dataset.id;
        const scene = (currentPost?.scenes || []).find((s) => s.id === sceneId);
        const layer = scene?.layers?.find((l) => l.id === layerId);
        if (!layer || layer.type !== "video") return;
        const abs = ganttAbsTimeFromClientX(e.clientX, bar.parentElement);
        openGanttCtxMenu(e, { sceneId, layerId, clickAbsS: abs });
      });
    }
  });
  body.querySelectorAll(".gantt-bar-del").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.ganttSceneDel) {
        void deleteScene(btn.dataset.ganttSceneDel);
        return;
      }
      if (btn.dataset.ganttMaskDel) {
        const scene = (currentPost?.scenes || []).find((s) => s.id === btn.dataset.sceneId);
        const layer = scene?.layers?.find((l) => l.id === btn.dataset.layerId)
          || getLayerById(btn.dataset.layerId);
        if (layer) deleteTransparencyMask(layer, btn.dataset.ganttMaskDel);
        return;
      }
      deleteLayer(btn.dataset.ganttDel, btn.dataset.sceneId);
    });
  });
  body.querySelectorAll(".gantt-bar-mask-btn").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLayerMaskFromUi(btn.dataset.ganttMaskLayer, btn.dataset.sceneId);
    });
  });

  // Click / drag on the ruler or empty track area to move the playhead.
  body.querySelectorAll(".gantt-ruler-track, .gantt-track").forEach((track) => {
    track.addEventListener("mousedown", onGanttSeekPointerDown);
  });
}

function onGanttSeekPointerDown(e) {
  if (e.button !== 0 || currentPost?.type !== "video") return;
  if (e.target.closest(".gantt-bar, .gantt-bar-handle, .gantt-bar-del, .gantt-bar-mask-btn")) return;
  const track = e.currentTarget;
  if (!track) return;
  e.preventDefault();
  e.stopPropagation();
  stopPreviewPlayback();
  ganttSeek = { track };
  setPreviewAbsTime(ganttAbsTimeFromClientX(e.clientX, track), {
    render: false,
    forceSeek: true,
  });
}

function onGanttBarDown(e) {
  if (e.target.closest(".gantt-bar-del") || e.target.closest(".gantt-bar-mask-btn")) return;
  const bar = e.currentTarget;
  const kind = bar.dataset.kind;
  const id = bar.dataset.id;
  const handle = e.target.closest(".gantt-bar-handle")?.dataset.handle || null;
  const track = bar.parentElement;
  const trackRect = track.getBoundingClientRect();
  const clickAbs = () => ganttAbsTimeFromClientX(e.clientX, track);

  if (kind === "scene") {
    if (id !== activeSceneId) {
      activeSceneId = id;
      selectedLayerId = null;
      selectedMaskId = null;
      if (!handle) {
        e.preventDefault();
        stopPreviewPlayback();
        setPreviewAbsTime(clickAbs(), { forceSeek: true });
        return;
      }
    } else if (!handle) {
      stopPreviewPlayback();
      setPreviewAbsTime(clickAbs(), { render: false, forceSeek: true });
    }
  } else if (kind === "mask") {
    const sceneId = bar.dataset.sceneId;
    const layerId = bar.dataset.layerId;
    if (sceneId && sceneId !== activeSceneId) {
      activeSceneId = sceneId;
    }
    // Select without rebuilding the gantt — that would destroy this bar mid-mousedown.
    if (layerId && id) {
      selectMask(layerId, id, { rebuildOverlays: false, skipGantt: true });
    }
    if (!handle) {
      stopPreviewPlayback();
      setPreviewAbsTime(clickAbs(), { render: false, forceSeek: true });
    }
    // Fall through so body click can move and edge handles can trim.
  } else if (kind === "layer") {
    const sceneId = bar.dataset.sceneId;
    if (sceneId && sceneId !== activeSceneId) {
      activeSceneId = sceneId;
      selectedLayerId = id;
      selectedMaskId = null;
      if (!handle) {
        e.preventDefault();
        stopPreviewPlayback();
        setPreviewAbsTime(clickAbs(), { forceSeek: true });
        selectLayer(id);
        return;
      }
    } else if (!handle) {
      selectLayer(id);
      stopPreviewPlayback();
      setPreviewAbsTime(clickAbs(), { render: false, forceSeek: true });
    }
  }

  if (!trackRect.width) return;
  e.preventDefault();
  e.stopPropagation();

  const timeline = getSceneTimeline();
  const total = Math.max(0.5, (timeline.length ? timeline[timeline.length - 1].end : 5));

  if (kind === "scene") {
    const row = timeline.find((r) => r.scene.id === id);
    if (!row) return;
    // Reusable slots: allow reorder (move) only — duration follows the source post.
    if (isSceneRef(row.scene) && handle && handle !== "move") return;
    ganttDrag = {
      kind: "scene",
      id,
      handle: handle || "move",
      trackWidth: trackRect.width,
      total,
      startClientX: e.clientX,
      origStart: row.start,
      origDuration: row.duration,
      sceneIndex: timeline.findIndex((r) => r.scene.id === id),
    };
  } else if (kind === "mask") {
    const sceneId = bar.dataset.sceneId;
    const layerId = bar.dataset.layerId;
    const sceneRow = timeline.find((r) => r.scene.id === sceneId);
    const layer = sceneRow?.scene.layers?.find((l) => l.id === layerId);
    const mask = layer ? getMaskById(layer, id) : null;
    if (!sceneRow || !layer || !mask) return;
    const layerStart = Math.max(0, Number(layer.start_s) || 0);
    const layerDur = layerEffectiveDuration(layer, sceneRow.duration);
    ganttDrag = {
      kind: "mask",
      id,
      layerId,
      sceneId,
      handle: handle || "move",
      trackWidth: trackRect.width,
      total,
      sceneStart: sceneRow.start,
      layerStart,
      layerDuration: layerDur,
      startClientX: e.clientX,
      origStart: Math.max(0, Number(mask.start_s) || 0),
      origDuration: maskEffectiveDuration(mask, layerDur),
    };
  } else {
    const sceneId = bar.dataset.sceneId;
    const sceneRow = timeline.find((r) => r.scene.id === sceneId);
    const layer = sceneRow?.scene.layers?.find((l) => l.id === id);
    if (!sceneRow || !layer) return;
    ganttDrag = {
      kind: "layer",
      id,
      sceneId,
      handle: handle || "move",
      trackWidth: trackRect.width,
      total,
      sceneStart: sceneRow.start,
      sceneDuration: sceneRow.duration,
      startClientX: e.clientX,
      origStart: Math.max(0, Number(layer.start_s) || 0),
      origDuration: layerEffectiveDuration(layer, sceneRow.duration),
      origSourceStart: Math.max(0, Number(layer.source_start_s) || 0),
    };
  }
}

function onGanttPointerMove(e) {
  if (ganttSeek) {
    setPreviewAbsTime(ganttAbsTimeFromClientX(e.clientX, ganttSeek.track), {
      render: false,
      forceSeek: true,
    });
    return;
  }
  if (!ganttDrag || !currentPost) return;
  const dxPx = e.clientX - ganttDrag.startClientX;
  const dxSec = (dxPx / ganttDrag.trackWidth) * ganttDrag.total;

  if (ganttDrag.kind === "scene") {
    const scenes = currentPost.scenes || [];
    const scene = scenes.find((s) => s.id === ganttDrag.id);
    if (!scene) return;
    if (ganttDrag.handle === "right") {
      setSceneDuration(scene, ganttDrag.origDuration + dxSec);
    } else if (ganttDrag.handle === "left") {
      // Shrinking from left shortens duration (scenes are sequential; start is fixed by order + gaps)
      setSceneDuration(scene, ganttDrag.origDuration - dxSec);
    } else if (ganttDrag.handle === "move") {
      // Reorder: swap with neighbor when dragged past midpoint
      const idx = ganttDrag.sceneIndex;
      const threshold = ganttDrag.origDuration * 0.45;
      if (dxSec > threshold && idx < scenes.length - 1) {
        const tmp = scenes[idx];
        scenes[idx] = scenes[idx + 1];
        scenes[idx + 1] = tmp;
        ganttDrag.sceneIndex = idx + 1;
        ganttDrag.startClientX = e.clientX;
        ganttDrag.origDuration = scenes[idx + 1].duration_s;
        renderSceneGantt();
        renderLayerList();
        return;
      }
      if (dxSec < -threshold && idx > 0) {
        const tmp = scenes[idx];
        scenes[idx] = scenes[idx - 1];
        scenes[idx - 1] = tmp;
        ganttDrag.sceneIndex = idx - 1;
        ganttDrag.startClientX = e.clientX;
        ganttDrag.origDuration = scenes[idx - 1].duration_s;
        renderSceneGantt();
        renderLayerList();
        return;
      }
      return; // no visual update until reorder
    }
    syncPreviewTimeControls();
    renderSceneGantt();
    renderLayerList();
    return;
  }

  if (ganttDrag.kind === "mask") {
    const scene = (currentPost.scenes || []).find((s) => s.id === ganttDrag.sceneId);
    const layer = scene?.layers?.find((l) => l.id === ganttDrag.layerId);
    const mask = layer ? getMaskById(layer, ganttDrag.id) : null;
    if (!mask) return;
    const maxStart = Math.max(0, ganttDrag.layerDuration - 0.1);
    if (ganttDrag.handle === "move") {
      mask.start_s = clamp(ganttDrag.origStart + dxSec, 0, maxStart);
      if (mask.duration_s != null) {
        const room = Math.max(0.1, ganttDrag.layerDuration - mask.start_s);
        mask.duration_s = Math.min(Math.max(0.1, Number(mask.duration_s)), room);
      }
    } else if (ganttDrag.handle === "left") {
      const newStart = clamp(
        ganttDrag.origStart + dxSec,
        0,
        ganttDrag.origStart + ganttDrag.origDuration - 0.1,
      );
      const delta = newStart - ganttDrag.origStart;
      mask.start_s = newStart;
      mask.duration_s = Math.max(0.1, ganttDrag.origDuration - delta);
    } else if (ganttDrag.handle === "right") {
      const room = Math.max(0.1, ganttDrag.layerDuration - ganttDrag.origStart);
      mask.start_s = ganttDrag.origStart;
      mask.duration_s = clamp(ganttDrag.origDuration + dxSec, 0.1, room);
    }
    renderSceneGantt();
    renderLayerList();
    renderLayerOverlays();
    if (selectedMaskId === mask.id) syncMaskPropInputs(mask, layer);
    return;
  }

  // layer
  const scene = (currentPost.scenes || []).find((s) => s.id === ganttDrag.sceneId);
  const layer = scene?.layers?.find((l) => l.id === ganttDrag.id);
  if (!layer) return;
  const speechLocked = layer.type === "tts" && layer.asset_id;
  if (ganttDrag.handle === "move") {
    if (speechLocked) {
      const speechDur = Math.max(0.1, Number(layer.duration_s) || ganttDrag.origDuration);
      layer.start_s = Math.max(0, ganttDrag.origStart + dxSec);
      layer.duration_s = speechDur;
      ensureSceneFitsLayer(scene, layer);
    } else {
      layer.start_s = Math.max(0, ganttDrag.origStart + dxSec);
      if (layer.duration_s != null) {
        ensureSceneFitsLayer(scene, layer);
      }
    }
  } else if (!speechLocked && ganttDrag.handle === "left") {
    const newStart = Math.max(0, Math.min(
      ganttDrag.origStart + ganttDrag.origDuration - 0.1,
      ganttDrag.origStart + dxSec,
    ));
    const delta = newStart - ganttDrag.origStart;
    layer.start_s = newStart;
    layer.duration_s = Math.max(0.1, ganttDrag.origDuration - delta);
    if (layer.type === "video") {
      layer.source_start_s = Math.max(0, (ganttDrag.origSourceStart || 0) + delta);
    }
    ensureSceneFitsLayer(scene, layer);
  } else if (!speechLocked && ganttDrag.handle === "right") {
    layer.duration_s = Math.max(0.1, ganttDrag.origDuration + dxSec);
    ensureSceneFitsLayer(scene, layer);
  }
  renderSceneGantt();
  renderLayerList();
  renderLayerOverlays();
  if (selectedLayerId === layer.id) syncPropInputs(layer);
}

function endGanttDrag() {
  if (ganttSeek) {
    ganttSeek = null;
    setPreviewAbsTime(previewAbsS, { render: true, forceSeek: true });
    return;
  }
  if (!ganttDrag) return;
  ganttDrag = null;
  flushLayerPropsFromDom();
  scheduleSavePost();
  renderSceneGantt();
  renderLayerList();
  renderLayerOverlays();
  syncPreviewTimeControls();
}

function addScene() {
  const n = (currentPost.scenes?.length || 0) + 1;
  const fmt = getTargetFormat();
  const scene = {
    id: uid(),
    name: `Scene ${n}`,
    duration_s: 5,
    gap_before_s: 0,
    background_asset_id: null,
    background_format: fmt,
    layers: [],
    ref_post_id: null,
  };
  currentPost.scenes.push(scene);
  activeSceneId = scene.id;
  selectedLayerId = null;
  previewTimeS = 0;
  const row = getSceneTimeline().find((r) => r.scene.id === scene.id);
  previewAbsS = row?.start || 0;
  scheduleSavePost();
  renderEditor();
}

async function deleteScene(id) {
  if (currentPost?.type !== "video") return;
  const scenes = currentPost.scenes || [];
  const scene = scenes.find((s) => s.id === id);
  if (!scene) return;
  if (scenes.length <= 1) {
    toast("A video post needs at least one scene", "error");
    return;
  }
  const removedLayers = [...(scene.layers || [])];
  const layerCount = removedLayers.length;
  const removedIds = new Set(removedLayers.map((l) => l.id));
  const ok = await confirmDialog({
    title: `Delete “${scene.name}”?`,
    message: layerCount
      ? `This removes the scene and its ${layerCount} layer${layerCount === 1 ? "" : "s"}. This cannot be undone.`
      : "This removes the scene from the timeline. This cannot be undone.",
    confirmText: "Delete scene",
    danger: true,
  });
  if (!ok) return;

  const idx = scenes.findIndex((s) => s.id === id);
  // Layers live on the scene — clear them, then drop the scene.
  scene.layers = [];
  currentPost.scenes = scenes.filter((s) => s.id !== id);

  if (selectedLayerId && removedIds.has(selectedLayerId)) {
    selectedLayerId = null;
    propsOverlayOpen = false;
  }
  if (activeSceneId === id) {
    const next = currentPost.scenes[Math.max(0, idx - 1)] || currentPost.scenes[0];
    activeSceneId = next?.id || null;
    selectedLayerId = null;
    propsOverlayOpen = false;
    previewTimeS = 0;
    const row = getSceneTimeline().find((r) => r.scene.id === activeSceneId);
    previewAbsS = row?.start || 0;
  }
  scheduleSavePost();
  renderEditor();
  toast(
    layerCount
      ? `Deleted ${scene.name} and ${layerCount} layer${layerCount === 1 ? "" : "s"}`
      : `Deleted ${scene.name}`,
    "ok",
  );
}

function renderMusicControls() {
  // Legacy no-op: music is an audio layer on the timeline.
}

function setEditorSideTab(tab) {
  if (tab === "assets" || tab === "layers") tab = "project-assets"; // legacy
  if (!["project-assets", "post-assets"].includes(tab)) tab = "project-assets";
  editorSideTab = tab;
  const isPostAssets = editorSideTab === "post-assets";

  const syncSideTabBtn = (el, active) => {
    if (!el) return;
    el.classList.toggle("border-indigo-400", active);
    el.classList.toggle("text-indigo-200", active);
    el.classList.toggle("border-transparent", !active);
    el.classList.toggle("text-slate-400", !active);
  };
  syncSideTabBtn($("editorTabProjectAssets"), !isPostAssets);
  syncSideTabBtn($("editorTabPostAssets"), isPostAssets);

  $("paletteUploadWrap")?.classList.toggle("hidden", !isPostAssets);
  renderAssetPalette();
}

function renderLayerList() {
  const ul = $("layerList");
  if (!ul) return;
  ul.innerHTML = "";

  if (currentPost?.type !== "video") {
    renderFlatLayerList(ul, getActiveLayers());
    return;
  }

  const timeline = getSceneTimeline();
  if (!timeline.length) {
    ul.innerHTML = `<li class="px-3 py-4 text-xs text-slate-500 text-center">No scenes yet. Add a scene on the timeline.</li>`;
    return;
  }

  for (const row of timeline) {
    const scene = row.scene;
    const isRef = isSceneRef(scene);
    const layers = isRef
      ? []
      : [...(scene.layers || [])].sort((a, b) => {
        const as = Number(a.start_s) || 0;
        const bs = Number(b.start_s) || 0;
        if (as !== bs) return as - bs;
        return (a.z_index || 0) - (b.z_index || 0);
      });
    const active = scene.id === activeSceneId;
    const header = document.createElement("li");
    header.className = `layer-tree-scene rounded-lg border ${
      active
        ? (isRef ? "border-teal-400/40 bg-teal-500/10" : "border-indigo-400/40 bg-indigo-500/10")
        : (isRef ? "border-teal-400/20 bg-teal-500/5" : "border-white/5 bg-black/20")
    }`;
    header.dataset.sceneId = scene.id;
    const gapVal = Math.max(0, Number(scene.gap_before_s) || 0);
    const refNote = isRef
      ? `<div class="text-[10px] text-teal-300/90 mt-0.5">Reusable post · edit the source to change content</div>`
      : "";
    header.innerHTML = `
      <div class="layer-tree-scene-head flex items-center gap-2 px-2.5 py-2 cursor-pointer">
        <span class="text-[10px] text-slate-500 shrink-0">${isRef ? "◎" : "▸"}</span>
        <div class="min-w-0 flex-1">
          <div class="text-sm text-slate-100 truncate font-medium">${escapeHtml(scene.name)}${
            isRef ? ` <span class="text-[10px] font-normal text-teal-300">reusable</span>` : ""
          }</div>
          <div class="text-[10px] text-slate-500 tabular-nums">
            ${row.start.toFixed(1)}–${row.end.toFixed(1)}s · ${row.duration.toFixed(1)}s
            ${layers.length ? ` · ${layers.length} layer${layers.length === 1 ? "" : "s"}` : ""}
          </div>
          ${refNote}
        </div>
        <div class="flex items-center gap-1 shrink-0" data-scene-controls>
          ${isRef ? `<button type="button" class="scene-open-ref text-[10px] text-teal-200 hover:text-teal-100 px-1" data-ref-id="${scene.ref_post_id}" title="Open source post">Open</button>` : ""}
          <label class="flex items-center gap-1 text-[10px] text-slate-500" title="Gap before this scene (scenes never overlap)">
            Gap
            <input type="number" class="scene-gap-input w-12 rounded bg-black/40 border border-white/10 px-1 py-0.5 text-[10px] text-slate-300"
              min="0" max="60" step="0.1" value="${gapVal.toFixed(1)}" data-scene-id="${scene.id}" />
            s
          </label>
          <button type="button" class="scene-up text-xs text-slate-500 hover:text-white px-1" data-scene-id="${scene.id}" title="Move earlier">↑</button>
          <button type="button" class="scene-down text-xs text-slate-500 hover:text-white px-1" data-scene-id="${scene.id}" title="Move later">↓</button>
        </div>
      </div>
      <ul class="layer-tree-children space-y-0.5 px-1 pb-1.5 ${layers.length ? "" : "hidden"}"></ul>
      ${isRef
        ? `<p class="px-3 pb-2 text-[10px] text-slate-600">Content comes from the reusable post.</p>`
        : (layers.length ? "" : `<p class="px-3 pb-2 text-[10px] text-slate-600">No layers in this scene</p>`)}`;
    const childUl = header.querySelector(".layer-tree-children");
    for (const layer of layers) {
      appendLayerWithMasks(childUl, layer, { sceneId: scene.id, nested: true });
    }
    header.querySelector(".layer-tree-scene-head")?.addEventListener("click", (e) => {
      if (e.target.closest("[data-scene-controls]")) return;
      activeSceneId = scene.id;
      selectedLayerId = null;
      propsOverlayOpen = false;
      previewTimeS = 0;
      previewAbsS = row.start;
      if ($("sceneDuration")) {
        $("sceneDuration").value = row.duration;
        $("sceneDuration").readOnly = isRef;
        $("sceneDuration").title = isRef
          ? "Duration follows the reusable post"
          : "Active scene duration (s)";
      }
      scheduleSavePost();
      renderEditor();
    });
    ul.appendChild(header);
  }

  ul.querySelectorAll(".layer-del").forEach((b) =>
    b.addEventListener("click", () => deleteLayer(b.dataset.id, b.dataset.sceneId || null)));
  ul.querySelectorAll(".layer-up").forEach((b) =>
    b.addEventListener("click", () => moveLayer(b.dataset.id, 1, b.dataset.sceneId || null)));
  ul.querySelectorAll(".layer-down").forEach((b) =>
    b.addEventListener("click", () => moveLayer(b.dataset.id, -1, b.dataset.sceneId || null)));
  bindMaskListItemHandlers(ul);
  ul.querySelectorAll(".scene-up").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); moveScene(b.dataset.sceneId, -1); }));
  ul.querySelectorAll(".scene-down").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); moveScene(b.dataset.sceneId, 1); }));
  ul.querySelectorAll(".scene-open-ref").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.dataset.refId) openPost(b.dataset.refId);
    }));
  ul.querySelectorAll(".scene-gap-input").forEach((inp) => {
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("change", () => {
      const scene = (currentPost.scenes || []).find((s) => s.id === inp.dataset.sceneId);
      if (!scene) return;
      scene.gap_before_s = clamp(Number(inp.value) || 0, 0, 60);
      scheduleSavePost();
      syncPreviewTimeControls();
      renderSceneGantt();
      renderLayerList();
    });
  });
}

function renderFlatLayerList(ul, layersIn) {
  const layers = [...(layersIn || [])].sort((a, b) => (a.z_index || 0) - (b.z_index || 0));
  if (!layers.length) {
    ul.innerHTML = `<li class="px-3 py-4 text-xs text-slate-500 text-center">No layers. Add text or drag assets onto the canvas.</li>`;
    return;
  }
  for (const l of layers) {
    appendLayerWithMasks(ul, l, { nested: false });
  }
  ul.querySelectorAll(".layer-del").forEach((b) => b.addEventListener("click", () => deleteLayer(b.dataset.id)));
  ul.querySelectorAll(".layer-up").forEach((b) => b.addEventListener("click", () => moveLayer(b.dataset.id, 1)));
  ul.querySelectorAll(".layer-down").forEach((b) => b.addEventListener("click", () => moveLayer(b.dataset.id, -1)));
  bindMaskListItemHandlers(ul);
}

function appendLayerWithMasks(parent, layer, opts) {
  parent.appendChild(buildLayerListItem(layer, opts));
  if (layer.type === "image" || layer.type === "video") {
    ensureLayerMasks(layer).forEach((mask, i) => {
      parent.appendChild(buildMaskListItem(layer, mask, i, opts));
    });
  }
}

function bindMaskListItemHandlers(root) {
  root.querySelectorAll(".mask-list-item").forEach((li) => {
    li.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const sceneId = li.dataset.sceneId || null;
      const layerId = li.dataset.layerId;
      const maskId = li.dataset.maskId;
      if (sceneId && sceneId !== activeSceneId) {
        activeSceneId = sceneId;
        const row = getSceneTimeline().find((r) => r.scene.id === sceneId);
        const layer = getLayerById(layerId);
        if (row && layer) {
          const layerStart = Number(layer.start_s) || 0;
          const maskStart = Number(getMaskById(layer, maskId)?.start_s) || 0;
          previewAbsS = row.start + layerStart + maskStart;
          previewTimeS = layerStart + maskStart;
          if ($("sceneDuration")) $("sceneDuration").value = row.scene.duration_s;
        }
      }
      selectMask(layerId, maskId);
    });
  });
  root.querySelectorAll(".mask-list-del").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const layer = getLayerById(b.dataset.layerId);
      if (layer) deleteTransparencyMask(layer, b.dataset.maskId);
    });
  });
}

function buildMaskListItem(layer, mask, index, { sceneId = null, nested = false } = {}) {
  const li = document.createElement("li");
  const title = maskDisplayTitle(mask, index);
  const layerDur = layerEffectiveDuration(layer);
  const maskDur = maskEffectiveDuration(mask, layerDur);
  const timing = currentPost?.type === "video"
    ? `<span class="text-[10px] text-slate-500">${(Number(mask.start_s) || 0).toFixed(1)}s · ${maskDur.toFixed(1)}s</span>`
    : "";
  const selected = mask.id === selectedMaskId && layer.id === selectedLayerId;
  li.className = `mask-list-item px-2.5 py-1 flex items-center justify-between gap-2 cursor-pointer rounded-md layer-tree-mask ${
    nested ? "" : "ml-2"
  } ${
    selected ? "selected border border-amber-400/40" : "hover:bg-amber-500/5 border border-transparent"
  }`;
  if (sceneId) li.dataset.sceneId = sceneId;
  li.dataset.layerId = layer.id;
  li.dataset.maskId = mask.id;
  li.innerHTML = `
    <div class="min-w-0 flex-1 flex items-start gap-2">
      <span class="layer-type-icon shrink-0 mt-0.5" title="Transparency mask"><span class="material-icons" aria-hidden="true">texture</span></span>
      <div class="min-w-0 flex-1">
        <div class="text-xs truncate text-amber-100/90">${escapeHtml(title)}</div>
        ${timing}
      </div>
    </div>
    <div class="flex gap-1 shrink-0">
      <button type="button" class="mask-list-del text-xs text-red-400 hover:text-red-200 px-1" data-mask-id="${mask.id}" data-layer-id="${layer.id}" title="Delete mask">×</button>
    </div>`;
  return li;
}

function buildLayerListItem(l, { sceneId = null, nested = false } = {}) {
  const li = document.createElement("li");
  const icon = layerTypeIcon(l.type);
  const title = layerDisplayTitle(l);
  const timing = currentPost?.type === "video"
    ? `<span class="text-[10px] text-slate-500">${(l.start_s || 0).toFixed(1)}s · ${layerEffectiveDuration(l).toFixed(1)}s</span>`
    : "";
  const canMask = l.type === "image" || l.type === "video";
  const maskCount = canMask ? ensureLayerMasks(l).length : 0;
  li.className = `px-2.5 py-1.5 flex items-center justify-between gap-2 cursor-pointer rounded-md ${
    nested ? "ml-3 border-l border-white/10 pl-2.5" : ""
  } ${
    l.id === selectedLayerId && !selectedMaskId ? "bg-indigo-500/15 border border-indigo-400/30" : "hover:bg-white/5 border border-transparent"
  }`;
  if (sceneId) li.dataset.sceneId = sceneId;
  li.innerHTML = `
    <div class="min-w-0 flex-1 flex items-start gap-2">
      <span class="layer-type-icon shrink-0 mt-0.5" title="${escapeHtml(l.type)}"><span class="material-icons" aria-hidden="true">${icon}</span></span>
      <div class="min-w-0 flex-1">
        <div class="text-sm truncate">${escapeHtml(title)}</div>
        ${timing}
      </div>
    </div>
    <div class="flex gap-1 shrink-0">
      ${canMask ? `<button type="button" class="layer-mask-open text-xs text-amber-300/90 hover:text-amber-100 px-1" data-id="${l.id}" ${sceneId ? `data-scene-id="${sceneId}"` : ""} title="${maskCount ? `${maskCount} mask${maskCount === 1 ? "" : "s"}` : "Add mask"}"><span class="material-icons text-[14px] leading-none">texture</span></button>` : ""}
      <button class="layer-up text-xs text-slate-500 hover:text-white px-1" data-id="${l.id}" ${sceneId ? `data-scene-id="${sceneId}"` : ""}>↑</button>
      <button class="layer-down text-xs text-slate-500 hover:text-white px-1" data-id="${l.id}" ${sceneId ? `data-scene-id="${sceneId}"` : ""}>↓</button>
      <button class="layer-del text-xs text-red-400 hover:text-red-200 px-1" data-id="${l.id}" ${sceneId ? `data-scene-id="${sceneId}"` : ""}>×</button>
    </div>`;
  li.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (sceneId && sceneId !== activeSceneId) {
      activeSceneId = sceneId;
      const row = getSceneTimeline().find((r) => r.scene.id === sceneId);
      if (row) {
        previewAbsS = row.start + (Number(l.start_s) || 0);
        previewTimeS = Number(l.start_s) || 0;
        if ($("sceneDuration")) $("sceneDuration").value = row.scene.duration_s;
      }
    }
    selectLayer(l.id);
    if (currentPost?.type === "video") {
      renderLayerList();
      renderSceneGantt();
    }
  });
  li.querySelector(".layer-mask-open")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openLayerMaskFromUi(l.id, sceneId);
  });
  return li;
}

function moveScene(id, dir) {
  if (currentPost?.type !== "video") return;
  const scenes = currentPost.scenes || [];
  const idx = scenes.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const swap = idx + (dir > 0 ? 1 : -1);
  if (swap < 0 || swap >= scenes.length) return;
  const tmp = scenes[idx];
  scenes[idx] = scenes[swap];
  scenes[swap] = tmp;
  scheduleSavePost();
  syncPreviewTimeControls();
  renderSceneGantt();
  renderLayerList();
}

function deleteLayer(id, sceneId = null) {
  if (currentPost?.type === "video") {
    const sid = sceneId || activeSceneId;
    const scene = (currentPost.scenes || []).find((s) => s.id === sid)
      || (currentPost.scenes || []).find((s) => (s.layers || []).some((l) => l.id === id));
    if (!scene) return;
    const layer = (scene.layers || []).find((l) => l.id === id);
    if (layer?.type === "video") {
      rippleDeleteVideoSection(scene, layer);
    } else {
      scene.layers = (scene.layers || []).filter((l) => l.id !== id);
    }
    if (scene.id !== activeSceneId) activeSceneId = scene.id;
  } else {
    currentPost.layers = (currentPost.layers || []).filter((l) => l.id !== id);
  }
  if (selectedLayerId === id) {
    propsOverlayOpen = false;
    selectedLayerId = null;
    selectedMaskId = null;
  }
  scheduleSavePost();
  renderLayerList();
  renderLayerProperties();
  renderLayerOverlays();
  if (currentPost?.type === "video") renderSceneGantt();
}

/** Remove a video section and ripple later pieces in the same clip group left. */
function rippleDeleteVideoSection(scene, layer) {
  if (!scene || !layer) return;
  const sceneDur = Math.max(0.5, Number(scene.duration_s) || 0.5);
  const start = Math.max(0, Number(layer.start_s) || 0);
  const dur = layerEffectiveDuration(layer, sceneDur);
  const end = start + dur;
  const groupId = (layer.clip_group_id || "").trim() || null;
  scene.layers = (scene.layers || []).filter((l) => l.id !== layer.id);
  if (!groupId) return;
  for (const other of scene.layers) {
    if (other.type !== "video") continue;
    if ((other.clip_group_id || "") !== groupId) continue;
    const os = Math.max(0, Number(other.start_s) || 0);
    if (os + 1e-3 >= end) {
      other.start_s = Math.max(0, os - dur);
    }
  }
}

function cloneLayerForSplit(layer) {
  const copy = JSON.parse(JSON.stringify(layer));
  copy.id = uid();
  return copy;
}

/**
 * Split a video layer at scene-local time T into left + right pieces.
 * @returns {boolean}
 */
function splitVideoLayerAt(sceneId, layerId, splitLocalS) {
  const scene = (currentPost?.scenes || []).find((s) => s.id === sceneId);
  if (!scene) return false;
  const layer = (scene.layers || []).find((l) => l.id === layerId);
  if (!layer || layer.type !== "video") return false;
  const sceneDur = Math.max(0.5, Number(scene.duration_s) || 0.5);
  const start = Math.max(0, Number(layer.start_s) || 0);
  const dur = layerEffectiveDuration(layer, sceneDur);
  const end = start + dur;
  const t = Number(splitLocalS);
  if (!Number.isFinite(t) || t <= start + 0.1 || t >= end - 0.1) {
    toast("Move closer to the middle of the clip to split", "info");
    return false;
  }
  const leftDur = t - start;
  const rightDur = end - t;
  const srcStart = Math.max(0, Number(layer.source_start_s) || 0);
  const groupId = (layer.clip_group_id || "").trim() || uid();

  layer.duration_s = leftDur;
  layer.clip_group_id = groupId;
  layer.source_start_s = srcStart;

  const right = cloneLayerForSplit(layer);
  right.start_s = t;
  right.duration_s = rightDur;
  right.source_start_s = srcStart + leftDur;
  right.clip_group_id = groupId;
  // Masks stay relative to each piece's local clock (v1: leave as copied).

  const idx = scene.layers.findIndex((l) => l.id === layer.id);
  scene.layers.splice(idx + 1, 0, right);
  ensureSceneFitsLayer(scene, layer);
  ensureSceneFitsLayer(scene, right);
  selectLayer(right.id);
  scheduleSavePost();
  renderLayerList();
  renderLayerProperties();
  renderLayerOverlays();
  renderSceneGantt();
  syncPreviewTimeControls();
  toast("Clip split", "ok");
  return true;
}

/** Absolute timeline seconds from a clientX over a gantt track. */
function ganttAbsTimeFromClientX(clientX, trackEl) {
  const timeline = getSceneTimeline();
  const total = Math.max(0.5, (timeline.length ? timeline[timeline.length - 1].end : 5));
  const track = trackEl?.closest?.(".gantt-track, .gantt-ruler-track") || trackEl;
  if (!track) return 0;
  const rect = track.getBoundingClientRect();
  if (rect.width < 1) return 0;
  return clamp(((clientX - rect.left) / rect.width) * total, 0, total);
}

function updateGanttPlayheads() {
  const total = Math.max(0.5, getTotalDuration());
  const left = `${(clamp(previewAbsS, 0, total) / total) * 100}%`;
  document.querySelectorAll(".gantt-playhead").forEach((el) => {
    el.style.left = left;
  });
}

let ganttCtxState = null;

function closeGanttCtxMenu() {
  const menu = $("ganttCtxMenu");
  if (menu) menu.classList.add("hidden");
  ganttCtxState = null;
}

function openGanttCtxMenu(e, { sceneId, layerId, clickAbsS }) {
  const scene = (currentPost?.scenes || []).find((s) => s.id === sceneId);
  const layer = scene?.layers?.find((l) => l.id === layerId);
  if (!layer || layer.type !== "video") return;
  e.preventDefault();
  e.stopPropagation();

  const timeline = getSceneTimeline();
  const row = timeline.find((r) => r.scene.id === sceneId);
  const sceneDur = Math.max(0.5, Number(scene.duration_s) || 0.5);
  const start = Math.max(0, Number(layer.start_s) || 0);
  const dur = layerEffectiveDuration(layer, sceneDur);
  const end = start + dur;

  const clickLocal = clickAbsS != null && row
    ? clickAbsS - row.start
    : start + dur / 2;
  const playheadLocal = (() => {
    if (!row || row.scene.id !== activeSceneId) {
      // Convert absolute playhead into this scene's local time if playhead is in range.
      const abs = previewAbsS;
      if (row && abs >= row.start && abs < row.end) return abs - row.start;
      return null;
    }
    return previewTimeS;
  })();

  const canSplitHere = clickLocal > start + 0.1 && clickLocal < end - 0.1;
  const canSplitPlayhead =
    playheadLocal != null
    && playheadLocal > start + 0.1
    && playheadLocal < end - 0.1;

  ganttCtxState = {
    sceneId,
    layerId,
    splitHereLocal: canSplitHere ? clickLocal : null,
    splitPlayheadLocal: canSplitPlayhead ? playheadLocal : null,
  };

  const menu = $("ganttCtxMenu");
  const splitHere = $("ganttCtxSplitHere");
  const splitPh = $("ganttCtxSplitPlayhead");
  if (!menu) return;
  if (splitHere) splitHere.disabled = !canSplitHere;
  if (splitPh) splitPh.disabled = !canSplitPlayhead;

  menu.classList.remove("hidden");
  const pad = 8;
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 120;
  let left = e.clientX;
  let top = e.clientY;
  if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;
  if (top + mh > window.innerHeight - pad) top = window.innerHeight - mh - pad;
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;
}

function wireGanttCtxMenu() {
  $("ganttCtxSplitHere")?.addEventListener("click", () => {
    const st = ganttCtxState;
    closeGanttCtxMenu();
    if (st?.sceneId && st?.layerId && st.splitHereLocal != null) {
      splitVideoLayerAt(st.sceneId, st.layerId, st.splitHereLocal);
    }
  });
  $("ganttCtxSplitPlayhead")?.addEventListener("click", () => {
    const st = ganttCtxState;
    closeGanttCtxMenu();
    if (st?.sceneId && st?.layerId && st.splitPlayheadLocal != null) {
      splitVideoLayerAt(st.sceneId, st.layerId, st.splitPlayheadLocal);
    }
  });
  $("ganttCtxDelete")?.addEventListener("click", () => {
    const st = ganttCtxState;
    closeGanttCtxMenu();
    if (st?.sceneId && st?.layerId) {
      deleteLayer(st.layerId, st.sceneId);
      toast("Section deleted", "ok");
    }
  });
  document.addEventListener("mousedown", (e) => {
    const menu = $("ganttCtxMenu");
    if (!menu || menu.classList.contains("hidden")) return;
    if (menu.contains(e.target)) return;
    closeGanttCtxMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeGanttCtxMenu();
  });
}

function moveLayer(id, dir, sceneId = null) {
  if (currentPost?.type === "video" && sceneId) {
    const scene = (currentPost.scenes || []).find((s) => s.id === sceneId);
    if (!scene) return;
    const layers = [...(scene.layers || [])].sort((a, b) => (a.z_index || 0) - (b.z_index || 0));
    const idx = layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const swap = idx + (dir > 0 ? 1 : -1);
    if (swap < 0 || swap >= layers.length) return;
    const tmp = layers[idx].z_index;
    layers[idx].z_index = layers[swap].z_index;
    layers[swap].z_index = tmp;
    scene.layers = layers;
    activeSceneId = scene.id;
  } else {
    const layers = [...getActiveLayers()].sort((a, b) => a.z_index - b.z_index);
    const idx = layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const swap = idx + (dir > 0 ? 1 : -1);
    if (swap < 0 || swap >= layers.length) return;
    const tmp = layers[idx].z_index;
    layers[idx].z_index = layers[swap].z_index;
    layers[swap].z_index = tmp;
    setActiveLayers(layers);
  }
  scheduleSavePost();
  renderEditor();
}

function renderAssetPalette() {
  const ul = $("assetPalette");
  if (!ul || !currentProject) return;
  ul.innerHTML = "";
  syncPaletteUploadGroups();

  const scope = editorSideTab === "post-assets" ? "post" : "project";
  const counts = {
    image: assetsOfType("image", { scope }).length,
    video: assetsOfType("video", { scope }).length,
    audio: assetsOfType("audio", { scope }).length,
  };
  syncAssetTypeTabs(".palette-type-tab", assetPaletteTab, counts);

  const typeMeta = ASSET_TYPE_GROUPS.find((g) => g.type === assetPaletteTab) || ASSET_TYPE_GROUPS[0];
  const items = assetsOfType(typeMeta.type, { scope });
  const hint = $("assetPaletteHint");
  if (hint) {
    hint.textContent = scope === "post"
      ? "Private to this post — preview, then drag onto the timeline or canvas."
      : "Shared project assets — preview, then drag onto the timeline or canvas.";
  }
  $("paletteUploadWrap")?.classList.toggle("hidden", scope !== "post");

  if (!items.length) {
    ul.innerHTML = scope === "post"
      ? `<li class="px-2 py-6 text-center text-xs text-slate-500">No ${typeMeta.label.toLowerCase()} for this post yet. Upload above to keep files private here.</li>`
      : `<li class="px-2 py-6 text-center text-xs text-slate-500">No project ${typeMeta.label.toLowerCase()} yet. Upload from the project hub to share across posts.</li>`;
    return;
  }
  const sections = partitionByGroup(items);
  for (const section of sections) {
    appendGroupHeader(ul, section.name, section.items.length);
    for (const a of section.items) {
      const li = document.createElement("li");
      li.draggable = true;
      li.dataset.assetId = a.id;
      const failed = a.status === "failed";
      li.className = `px-2 py-2 rounded-lg border ${failed ? "border-red-400/25 bg-red-500/5" : "border-white/5 bg-black/20"} cursor-grab hover:border-indigo-400/30 text-xs flex items-center gap-2`;
      const thumbUrl = getAssetThumbUrl(a);
      const previewUrl = a.type === "audio" ? getAudioAssetUrl(a) : getAssetPreviewUrl(a);
      const canPreview = !!(previewUrl || thumbUrl);
      const statusDot = a.status === "ready" ? ""
        : a.status === "failed" ? `<span class="text-[9px] text-red-300 shrink-0">failed</span>`
          : a.status === "processing" || a.status === "pending" ? `<span class="spinner shrink-0" style="width:10px;height:10px;border-width:1.5px"></span>`
            : "";
      const downloadBtn = a.locked
        ? `<span class="text-[10px] text-amber-300/80 shrink-0 px-1" title="Locked stock — app use only">lock</span>`
        : `<button type="button" class="palette-download-asset text-[10px] text-emerald-300 hover:text-emerald-200 shrink-0 px-1" data-id="${a.id}" title="Download">↓</button>`;
      const thumbInner = thumbUrl
        ? `<img src="${thumbUrl}" class="w-8 h-8 rounded object-cover shrink-0 pointer-events-none" alt="">`
        : `<span class="shrink-0 material-icons pointer-events-none" aria-hidden="true">${typeMeta.icon}</span>`;
      const thumb = canPreview
        ? `<button type="button" class="palette-preview-asset shrink-0 rounded p-0 border-0 bg-transparent cursor-zoom-in hover:ring-2 hover:ring-indigo-400/50" data-id="${a.id}" title="Preview">${thumbInner}</button>`
        : thumbInner;
      const previewBtn = canPreview
        ? `<button type="button" class="palette-preview-asset shrink-0 px-0.5 text-indigo-300 hover:text-indigo-200 inline-flex" data-id="${a.id}" title="Preview"><span class="material-icons text-[14px] leading-none" aria-hidden="true">visibility</span></button>`
        : "";
      const thumbBtn = a.type === "video"
        ? `<button type="button" class="palette-video-thumb text-[10px] ${a.processed_formats?.thumb ? "text-slate-400 hover:text-indigo-200" : "text-amber-300 hover:text-amber-200"} shrink-0 px-0.5 inline-flex" data-id="${a.id}" title="${a.processed_formats?.thumb ? "Regenerate thumbnail" : "Generate thumbnail"}"><span class="material-icons text-[14px] leading-none" aria-hidden="true">photo_camera</span></button>`
        : "";
      const cropBtn = a.type === "image"
        ? `<button type="button" class="palette-crop-asset text-[10px] text-sky-300 hover:text-sky-200 shrink-0 px-0.5 inline-flex" data-id="${a.id}" title="Edit image"><span class="material-icons text-[14px] leading-none" aria-hidden="true">photo_settings</span></button>`
        : "";
      const editVideoBtn = a.type === "video" && a.original_path
        ? `<button type="button" class="palette-edit-video text-[10px] text-fuchsia-300 hover:text-fuchsia-200 shrink-0 px-0.5 inline-flex" data-id="${a.id}" title="Edit video"><span class="material-icons text-[14px] leading-none" aria-hidden="true">video_settings</span></button>`
        : "";
      const shareBtn = scope === "post"
        ? `<button type="button" class="palette-share-project text-[10px] text-slate-400 hover:text-indigo-200 shrink-0 px-1" data-id="${a.id}" title="Move to project assets">↗</button>`
        : "";
      li.innerHTML = `${thumb}<span class="truncate flex-1 rename-asset cursor-pointer hover:text-indigo-200" data-id="${a.id}" title="Rename">${escapeHtml(a.name)}</span>${statusDot}${previewBtn}${thumbBtn}${editVideoBtn}${cropBtn}${shareBtn}<button type="button" class="palette-rename-asset text-[10px] text-slate-400 hover:text-indigo-200 shrink-0 px-1" data-id="${a.id}" title="Rename">✎</button>${downloadBtn}<button type="button" class="palette-delete-asset text-[10px] text-red-300 hover:text-red-200 shrink-0 px-1" data-id="${a.id}" title="Delete asset">✕</button>`;
      li.title = a.error || `${a.name} · preview · drag onto timeline · double-click to add · click name to rename`;
      li.addEventListener("dragstart", (e) => {
        if (e.target.closest("button")) {
          e.preventDefault();
          return;
        }
        dragAssetId = a.id;
        e.dataTransfer.setData("text/plain", a.id);
      });
      li.querySelectorAll(".palette-preview-asset").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          openAssetPreview(a);
        });
      });
      li.querySelector(".palette-video-thumb")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        await generateVideoThumb(a.id);
      });
      li.querySelectorAll(".rename-asset, .palette-rename-asset").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          renameProjectAsset(a.id);
        });
      });
      li.querySelector(".palette-crop-asset")?.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        openImageEditorModal(a.id, { postId: a.post_id || currentPost?.id || null });
      });
      li.querySelector(".palette-edit-video")?.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        openVideoEditorModal(a.id, { postId: a.post_id || currentPost?.id || null });
      });
      li.querySelector(".palette-share-project")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        try {
          await api(`/api/projects/${encodeURIComponent(currentProject.id)}/assets/${encodeURIComponent(a.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ post_id: null }),
          });
          toast("Moved to project assets", "ok");
          await refreshProject({ reloadPost: false });
          renderAssetPalette();
        } catch (err) {
          toast(err.message || "Could not move asset", "error");
        }
      });
      li.querySelector(".palette-download-asset")?.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        downloadProjectAsset(a.id);
      });
      li.querySelector(".palette-delete-asset")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        e.preventDefault();
        try {
          await deleteProjectAsset(a.id);
          renderAssetPalette();
          renderLayerList();
          renderInteractiveCanvas();
          if (currentPost?.type === "video") renderSceneGantt();
        } catch (err) {
          toast(err.message, "error");
        }
      });
      li.addEventListener("dblclick", async (e) => {
        if (e.target.closest("button, .rename-asset")) return;
        if (a.type === "audio") {
          addAudioLayer(a.id);
          return;
        }
        if (a.type === "video") {
          await addVideoLayer(a.id);
          return;
        }
        if (a.type === "image") {
          const format = await pickImageFormat(a, e.clientX, e.clientY);
          if (!format) return;
          addImageLayer(a.id, null, { format });
          return;
        }
        addImageLayer(a.id);
      });
      ul.appendChild(li);
    }
  }
}

function syncPaletteUploadGroups() {
  const sel = $("paletteUploadGroup");
  if (!sel || !currentProject) return;
  const prev = sel.value;
  const groups = collectAssetGroupNames(currentProject.assets || []);
  sel.innerHTML = `<option value="">Ungrouped</option>` +
    groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function addTextLayer() {
  const scene = currentPost?.type === "video" ? ensureSceneForLayers() : null;
  const layers = scene ? scene.layers : getActiveLayers();
  const timing = currentPost?.type === "video" ? defaultLayerTiming() : {};
  const layer = {
    id: uid(), type: "text", title: "Text", x: 10, y: 40, width: 80, height: 20,
    z_index: layers.length, text: "Your text here", font_size: 48, color: "#ffffff",
    font_weight: "bold", opacity: 1, transition_in: "none", transition_out: "none",
    ...timing,
  };
  if (scene) appendLayerToScene(scene, layer);
  else setActiveLayers([...layers, layer]);
  selectLayer(layer.id);
  scheduleSavePost();
  renderInteractiveCanvas();
  if (currentPost?.type === "video") renderSceneGantt();
}

async function ensureTtsVoices() {
  if (ttsVoicesCache) return ttsVoicesCache;
  const r = await fetch("/api/tts/voices");
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
  ttsVoicesCache = data;
  return data;
}

function addAudioLayer(assetId, opts = {}) {
  if (currentPost?.type !== "video") {
    toast("Audio layers are only available on video posts", "error");
    return;
  }
  const scene = ensureSceneForLayers(opts.sceneId || null);
  if (!scene) {
    toast("No scene to add audio to", "error");
    return;
  }
  const layers = scene.layers;
  const sceneDur = Math.max(0.5, Number(scene.duration_s) || 5);
  const start = clamp(Number(opts.start_s) || 0, 0, Math.max(0, sceneDur - 0.1));
  const dur = Math.max(0.5, sceneDur - start);
  const asset = (currentProject?.assets || []).find((a) => a.id === assetId);
  const layer = {
    id: uid(),
    type: "audio",
    title: asset?.name ? String(asset.name).slice(0, 40) : "Audio",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    z_index: layers.length,
    asset_id: assetId,
    opacity: 1,
    transition_in: "none",
    transition_out: "none",
    tts_volume: 0.8,
    start_s: start,
    duration_s: dur,
  };
  appendLayerToScene(scene, layer);
  selectLayer(layer.id);
  if (opts.seekPreview !== false) {
    const row = getSceneTimeline().find((r) => r.scene.id === scene.id);
    previewTimeS = start;
    previewAbsS = (row?.start || 0) + start;
  }
  scheduleSavePost();
  renderInteractiveCanvas();
  renderSceneGantt();
  syncPreviewTimeControls();
}

/** Probe media duration (seconds) from a URL; null if unknown. */
function probeVideoDurationS(url) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        v.removeAttribute("src");
        v.load();
      } catch (_) { /* ignore */ }
      resolve(value);
    };
    v.onloadedmetadata = () => {
      const d = Number(v.duration);
      finish(Number.isFinite(d) && d > 0 ? d : null);
    };
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 4000);
    v.src = url;
  });
}

async function addVideoLayer(assetId, opts = {}) {
  if (currentPost?.type !== "video") {
    toast("Video layers are only available on video posts", "error");
    return;
  }
  const scene = ensureSceneForLayers(opts.sceneId || null);
  if (!scene) {
    toast("No scene to add video to", "error");
    return;
  }
  const layers = scene.layers;
  const sceneDur = Math.max(0.5, Number(scene.duration_s) || 5);
  const start = clamp(Number(opts.start_s) || 0, 0, Math.max(0, sceneDur - 0.1));
  const requested = opts.duration_s != null ? Number(opts.duration_s) : NaN;
  const asset = getAssetById(assetId);
  let dur;
  if (Number.isFinite(requested)) {
    dur = Math.max(0.1, requested);
  } else {
    const probed = await probeVideoDurationS(getAssetPreviewUrl(asset));
    dur = probed != null ? Math.max(0.1, probed) : Math.max(0.5, sceneDur - start);
  }
  const asBottom = !!opts.asBottom;
  const layer = {
    id: uid(),
    type: "video",
    title: asset?.name ? String(asset.name).slice(0, 40) : "Video",
    x: asBottom ? 0 : (opts.position?.x ?? 10),
    y: asBottom ? 0 : (opts.position?.y ?? 10),
    width: asBottom ? 100 : 80,
    height: asBottom ? 100 : 45,
    z_index: asBottom ? 0 : layers.length,
    asset_id: assetId,
    opacity: 1,
    transition_in: "none",
    transition_out: "none",
    tts_volume: 1,
    start_s: start,
    duration_s: dur,
    source_start_s: 0,
    clip_group_id: null,
  };
  if (!asBottom && opts.position && Number.isFinite(opts.position.x) && Number.isFinite(opts.position.y)) {
    layer.x = opts.position.x - layer.width / 2;
    layer.y = opts.position.y - layer.height / 2;
  }
  appendLayerToScene(scene, layer, { asBottom });
  await fitMediaLayerToAsset(layer, {
    maxPct: asBottom ? 100 : 80,
    preserveCenter: !asBottom,
    asBottom,
  });
  ensureSceneFitsLayer(scene, layer);
  selectLayer(layer.id);
  if (opts.seekPreview !== false) {
    const row = getSceneTimeline().find((r) => r.scene.id === scene.id);
    previewTimeS = start;
    previewAbsS = (row?.start || 0) + start;
  }
  scheduleSavePost();
  renderInteractiveCanvas();
  renderSceneGantt();
  syncPreviewTimeControls();
}

async function addTtsLayer() {
  if (currentPost?.type !== "video") {
    toast("Voice layers are only available on video posts", "error");
    return;
  }
  let defaultVoice = null;
  try {
    const voices = await ensureTtsVoices();
    if (!voices.available) {
      toast("No speech engine found. On Mac, the built-in Speech feature is used.", "error");
      return;
    }
    defaultVoice = preferredTtsVoiceId(voices);
  } catch (e) {
    toast(`Could not load voices: ${e.message}`, "error");
    return;
  }
  const scene = ensureSceneForLayers();
  if (!scene) {
    toast("No scene to add voice to", "error");
    return;
  }
  const layers = scene.layers;
  const script = "Say something for your reel…";
  const layer = {
    id: uid(),
    type: "tts",
    title: "Voice",
    x: 8,
    y: 78,
    width: 84,
    height: 14,
    z_index: layers.length,
    text: script,
    font_size: 28,
    color: "#ffffff",
    font_weight: "bold",
    opacity: 1,
    transition_in: "none",
    transition_out: "none",
    tts_voice: defaultVoice,
    tts_volume: 1,
    tts_mood: "neutral",
    show_caption: false,
    asset_id: null,
    // Duration is content-driven: estimate until Generate, then exact audio length.
    start_s: 0,
    duration_s: estimateSpeechDurationS(script),
  };
  appendLayerToScene(scene, layer);
  if (defaultVoice) rememberPostTtsVoice(defaultVoice);
  selectLayer(layer.id);
  scheduleSavePost();
  renderInteractiveCanvas();
  renderSceneGantt();
}

async function synthesizeSelectedTts() {
  const layer = getLayerById(selectedLayerId);
  const scene = getActiveScene();
  if (!layer || layer.type !== "tts" || !scene) return;
  const btn = $("propTtsGenerate");
  if (btn) { btn.disabled = true; btn.textContent = "Generating…"; }
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/tts/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        post_id: currentPost.id,
        scene_id: scene.id,
        layer_id: layer.id,
        text: layer.text,
        voice: layer.tts_voice,
        volume: layer.tts_volume,
        mood: layer.tts_mood || $("propTtsMood")?.value || "neutral",
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
    if (data.project) currentProject = data.project;
    if (data.post) currentPost = data.post;
    selectedLayerId = layer.id;
    const sceneAfter = getActiveScene();
    if (sceneAfter && $("sceneDuration")) $("sceneDuration").value = sceneAfter.duration_s;
    toast(
      data.duration_s
        ? `Voice ready · ${Number(data.duration_s).toFixed(1)}s (from speech)`
        : "Voice ready",
      "ok",
    );
    renderEditor();
  } catch (e) {
    toast(`Speech failed: ${e.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      const live = getLayerById(selectedLayerId);
      btn.textContent = live?.asset_id ? "Regenerate audio" : "Generate audio";
    }
  }
}

function addImageLayer(assetId, position = null, opts = {}) {
  const scene = currentPost?.type === "video"
    ? ensureSceneForLayers(opts.sceneId || null)
    : null;
  const layers = scene ? scene.layers : getActiveLayers();
  let timing = {};
  if (currentPost?.type === "video") {
    if (!scene) {
      toast("No scene to add the layer to", "error");
      return;
    }
    const sceneDur = Math.max(0.5, Number(scene.duration_s) || 5);
    const start = clamp(Number(opts.start_s) || 0, 0, Math.max(0, sceneDur - 0.1));
    const requested = opts.duration_s != null ? Number(opts.duration_s) : NaN;
    const dur = Number.isFinite(requested)
      ? clamp(requested, 0.1, Math.max(0.1, sceneDur - start))
      : Math.max(0.5, sceneDur - start);
    timing = { start_s: start, duration_s: dur };
    if (opts.seekPreview !== false) {
      previewTimeS = start;
      const row = getSceneTimeline().find((r) => r.scene.id === scene.id);
      if (row) previewAbsS = row.start + start;
    }
  }
  const asBottom = !!opts.asBottom;
  const asset = getAssetById(assetId);
  const format = opts.format || getTargetFormat();
  // Provisional size; refined to the asset aspect as soon as dimensions are known.
  let provisional = { width: asBottom ? 100 : 40, height: asBottom ? 100 : 40 };
  if (!asBottom && format && FORMAT_ASPECT_RATIO[format] && asset?.processed_formats?.[format]) {
    provisional = layerSizeFromAspect(FORMAT_ASPECT_RATIO[format], { maxPct: 40 });
  }
  const layer = {
    id: uid(),
    type: "image",
    title: asset?.name ? String(asset.name).slice(0, 40) : "Image",
    x: asBottom ? 0 : (position?.x ?? 20),
    y: asBottom ? 0 : (position?.y ?? 20),
    width: provisional.width,
    height: provisional.height,
    z_index: asBottom ? 0 : layers.length,
    asset_id: assetId,
    use_format: format,
    opacity: 1,
    transition_in: "none",
    transition_out: "none",
    ...timing,
  };
  // Keep the drop point as the center of the box when placing interactively.
  if (!asBottom && position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
    layer.x = position.x - layer.width / 2;
    layer.y = position.y - layer.height / 2;
  }
  if (scene) appendLayerToScene(scene, layer, { asBottom });
  else if (asBottom) {
    const bumped = layers.map((l) => ({ ...l, z_index: (l.z_index || 0) + 1 }));
    setActiveLayers([layer, ...bumped]);
  } else {
    setActiveLayers([...layers, layer]);
  }
  selectLayer(layer.id);
  scheduleSavePost();
  renderInteractiveCanvas();
  if (currentPost?.type === "video") {
    renderSceneGantt();
    syncPreviewTimeControls();
  }

  fitMediaLayerToAsset(layer, {
    maxPct: asBottom ? 100 : 40,
    preserveCenter: !asBottom,
    asBottom,
  }).then(() => {
    const live = getLayerById(layer.id);
    if (!live) return;
    // Keep timing fields if a stale save response ever dropped them.
    if (live.duration_s == null || !Number.isFinite(Number(live.duration_s))) {
      live.start_s = Number.isFinite(Number(live.start_s)) ? Number(live.start_s) : 0;
      live.duration_s = timing.duration_s ?? layerEffectiveDuration(live);
    }
    scheduleSavePost();
    renderInteractiveCanvas();
    if (currentPost?.type === "video") renderSceneGantt();
    if (selectedLayerId === layer.id) {
      syncPropInputs(live);
      renderLayerList();
    }
  });
}

function setSceneBackgroundAsset(sceneId, assetId, format = null) {
  const scene = (currentPost?.scenes || []).find((s) => s.id === sceneId);
  if (!scene) return;
  activeSceneId = sceneId;
  scene.background_asset_id = assetId;
  scene.background_format = format || getTargetFormat();
  scheduleSavePost();
  renderInteractiveCanvas();
  renderSceneGantt();
}

function clearGanttDropHighlights() {
  document.querySelectorAll(".gantt-drop-active").forEach((el) => el.classList.remove("gantt-drop-active"));
}

function ganttAbsoluteTimeFromClientX(clientX, trackEl) {
  const rect = trackEl.getBoundingClientRect();
  const total = getTotalDuration();
  if (rect.width <= 0) return 0;
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 0.999);
  return ratio * total;
}

function sceneRowAtAbsoluteTime(absSec) {
  const timeline = getSceneTimeline();
  if (!timeline.length) return null;
  for (const row of timeline) {
    if (absSec >= row.start && absSec < row.end) return row;
  }
  // Absolute time falls in a gap (or past the end) — snap to the next scene,
  // or the last scene if past the end.
  for (let i = 0; i < timeline.length; i++) {
    const row = timeline[i];
    const gapStart = i === 0 ? 0 : timeline[i - 1].end;
    if (absSec >= gapStart && absSec < row.start) return row;
  }
  return timeline[timeline.length - 1];
}

async function handleGanttAssetDrop(e) {
  if (currentPost?.type !== "video") return false;
  e.preventDefault();
  e.stopPropagation();
  clearGanttDropHighlights();

  const assetId = e.dataTransfer?.getData("text/plain") || dragAssetId;
  dragAssetId = null;
  if (!assetId || !currentProject) return true;

  const asset = (currentProject.assets || []).find((a) => a.id === assetId);
  if (!asset) {
    toast("Unknown asset", "error");
    return true;
  }
  if (asset.post_id && asset.post_id !== currentPost.id) {
    toast("That asset belongs to another post", "error");
    return true;
  }

  const track = e.target.closest("[data-gantt-track]");
  const sceneBar = e.target.closest('.gantt-bar[data-kind="scene"]');
  const trackEl = track || $("ganttBody")?.querySelector("[data-gantt-track]");
  if (!trackEl) return true;

  const absSec = ganttAbsoluteTimeFromClientX(e.clientX, trackEl);
  let row = sceneBar
    ? getSceneTimeline().find((r) => r.scene.id === sceneBar.dataset.id)
    : sceneRowAtAbsoluteTime(absSec);
  if (track?.dataset.sceneId) {
    row = getSceneTimeline().find((r) => r.scene.id === track.dataset.sceneId) || row;
  }
  if (!row) {
    toast("No scene to drop into", "error");
    return true;
  }
  if (isSceneRef(row.scene)) {
    toast("Drop onto a normal scene — reusable clips are edited in their source post", "info");
    return true;
  }

  const trackKind = track?.dataset.ganttTrack || (sceneBar ? "scenes" : "layer");
  const localStart = clamp(absSec - row.start, 0, Math.max(0, row.duration - 0.1));
  const dropX = e.clientX;
  const dropY = e.clientY;

  if (asset.type === "audio") {
    addAudioLayer(asset.id, {
      sceneId: row.scene.id,
      start_s: localStart,
      seekPreview: false,
    });
    toast(`Audio layer on ${row.scene.name} at ${localStart.toFixed(1)}s`, "ok");
    return true;
  }

  // Scene row / scene bar → full-bleed bottom image/video layer
  if (trackKind === "scenes" || sceneBar) {
    if (asset.type === "image") {
      const format = await pickImageFormat(asset, dropX, dropY);
      if (!format) return true;
      addImageLayer(asset.id, null, {
        sceneId: row.scene.id,
        start_s: 0,
        duration_s: row.duration,
        format,
        asBottom: true,
        seekPreview: false,
      });
      toast(`Base layer (${format}) on ${row.scene.name}`, "ok");
      return true;
    }
    if (asset.type === "video") {
      await addVideoLayer(asset.id, {
        sceneId: row.scene.id,
        start_s: 0,
        asBottom: true,
        seekPreview: false,
      });
      toast(`Video layer on ${row.scene.name}`, "ok");
      return true;
    }
    toast("Drop an image or video onto the scene", "error");
    return true;
  }

  // Layer tracks → timed overlay
  if (asset.type === "video") {
    await addVideoLayer(asset.id, {
      sceneId: row.scene.id,
      start_s: localStart,
      position: { x: 50, y: 40 },
      seekPreview: false,
    });
    toast(`Video layer on ${row.scene.name} at ${localStart.toFixed(1)}s`, "ok");
    return true;
  }
  if (asset.type !== "image") {
    toast("Only images or videos can be added as timeline layers", "error");
    return true;
  }

  const format = await pickImageFormat(asset, dropX, dropY);
  if (!format) return true;
  addImageLayer(asset.id, { x: 20, y: 20 }, {
    sceneId: row.scene.id,
    start_s: localStart,
    format,
    seekPreview: false,
  });
  toast(`Added ${format} to ${row.scene.name} at ${localStart.toFixed(1)}s`, "ok");
  return true;
}

function bindGanttAssetDropTargets(root) {
  if (!root) return;
  const onOver = (e) => {
    if (currentPost?.type !== "video") return;
    if (!dragAssetId && !(e.dataTransfer?.types || []).includes("text/plain")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    clearGanttDropHighlights();
    const bar = e.target.closest(".gantt-bar");
    const track = e.target.closest("[data-gantt-track]");
    (bar || track)?.classList.add("gantt-drop-active");
  };
  const onLeave = (e) => {
    const related = e.relatedTarget;
    if (related && root.contains(related)) return;
    clearGanttDropHighlights();
  };
  root.addEventListener("dragover", onOver);
  root.addEventListener("dragleave", onLeave);
  root.addEventListener("drop", (e) => {
    void handleGanttAssetDrop(e);
  });
}

function syncMaskPropInputs(mask, layer) {
  const map = {
    propMaskX: Number(mask.x).toFixed(1),
    propMaskY: Number(mask.y).toFixed(1),
    propMaskW: Number(mask.width).toFixed(1),
    propMaskH: Number(mask.height).toFixed(1),
    propMaskStartS: (Number(mask.start_s) || 0).toFixed(1),
    propMaskDurationS: maskEffectiveDuration(mask, layerEffectiveDuration(layer)).toFixed(1),
  };
  for (const [id, val] of Object.entries(map)) {
    const el = $(id);
    if (el && document.activeElement !== el) el.value = val;
  }
}

function renderMaskProperties(layer, mask) {
  const panel = $("layerProps");
  const title = $("layerPropsTitle");
  if (!panel) return;
  const masks = ensureLayerMasks(layer);
  const index = Math.max(0, masks.findIndex((m) => m.id === mask.id));
  const display = maskDisplayTitle(mask, index);
  if (title) title.textContent = display;

  const layerDur = layerEffectiveDuration(layer);
  const maskDur = maskEffectiveDuration(mask, layerDur);
  const isVideo = currentPost?.type === "video";

  panel.innerHTML = `
    <div class="space-y-3 text-sm">
      <button type="button" id="propMaskBack" class="text-[11px] text-slate-400 hover:text-slate-200 transition">← ${escapeHtml(layerDisplayTitle(layer))}</button>
      <p class="text-[10px] text-amber-200/80 uppercase tracking-wider flex items-center gap-1">
        <span class="material-icons text-[14px]">texture</span> Transparency mask
      </p>
      <div>
        <label class="text-[10px] text-slate-500 uppercase" for="propMaskTitle">Title</label>
        <input type="text" id="propMaskTitle" maxlength="80" placeholder="Mask ${index + 1}"
          value="${escapeHtml(mask.title || "")}"
          class="w-full rounded bg-black/30 border border-white/10 px-2 py-1.5 text-sm mt-0.5"/>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div><label class="text-[10px] text-slate-500 uppercase">X %</label>
          <input type="number" id="propMaskX" value="${Number(mask.x).toFixed(1)}" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Y %</label>
          <input type="number" id="propMaskY" value="${Number(mask.y).toFixed(1)}" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
        <div><label class="text-[10px] text-slate-500 uppercase">W %</label>
          <input type="number" id="propMaskW" value="${Number(mask.width).toFixed(1)}" min="1" max="100" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
        <div><label class="text-[10px] text-slate-500 uppercase">H %</label>
          <input type="number" id="propMaskH" value="${Number(mask.height).toFixed(1)}" min="1" max="100" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
      </div>
      ${isVideo ? `
      <div class="grid grid-cols-2 gap-2 pt-2 border-t border-white/5">
        <div><label class="text-[10px] text-slate-500 uppercase">Start in layer (s)</label>
          <input type="number" id="propMaskStartS" value="${(Number(mask.start_s) || 0).toFixed(1)}" min="0" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Duration (s)</label>
          <input type="number" id="propMaskDurationS" value="${maskDur.toFixed(1)}" min="0.1" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
      </div>
      <p class="text-[11px] text-slate-500 -mt-1">Timing is relative to the parent layer. Drag the amber bar on the timeline to trim.</p>
      ` : ""}
      <div class="flex gap-1.5 flex-wrap pt-1">
        <button type="button" id="propMaskDraw" class="text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-amber-400/40 hover:text-amber-100 transition">Draw new square</button>
        <button type="button" id="propMaskDelete" class="text-xs px-2.5 py-1.5 rounded-lg border border-red-400/30 text-red-300 hover:bg-red-500/10 transition">Delete mask</button>
      </div>
    </div>`;

  $("propMaskBack")?.addEventListener("click", () => {
    selectedMaskId = null;
    setMaskDrawMode(false);
    renderLayerProperties();
    renderLayerOverlays();
    if (currentPost?.type === "video") renderSceneGantt();
    renderLayerList();
  });
  const titleEl = $("propMaskTitle");
  if (titleEl) {
    titleEl.addEventListener("input", () => {
      mask.title = titleEl.value.slice(0, 80);
      const hdr = $("layerPropsTitle");
      if (hdr) hdr.textContent = maskDisplayTitle(mask, index);
      scheduleSavePost();
      renderLayerList();
      if (currentPost?.type === "video") renderSceneGantt();
    });
  }
  const bindGeom = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => {
      mask[key] = +el.value;
      clampMaskRect(mask);
      scheduleSavePost();
      renderLayerOverlays();
    });
    el.addEventListener("change", () => {
      clampMaskRect(mask);
      syncMaskPropInputs(mask, layer);
      scheduleSavePost();
      renderLayerOverlays();
    });
  };
  bindGeom("propMaskX", "x");
  bindGeom("propMaskY", "y");
  bindGeom("propMaskW", "width");
  bindGeom("propMaskH", "height");
  if (isVideo) {
    $("propMaskStartS")?.addEventListener("input", (e) => {
      mask.start_s = Math.max(0, +e.target.value);
      const room = Math.max(0.1, layerDur - mask.start_s);
      if (mask.duration_s != null) mask.duration_s = Math.min(Math.max(0.1, Number(mask.duration_s)), room);
      scheduleSavePost();
      renderLayerOverlays();
      renderSceneGantt();
      renderLayerList();
    });
    $("propMaskDurationS")?.addEventListener("input", (e) => {
      const room = Math.max(0.1, layerDur - (Number(mask.start_s) || 0));
      mask.duration_s = clamp(+e.target.value, 0.1, room);
      scheduleSavePost();
      renderLayerOverlays();
      renderSceneGantt();
      renderLayerList();
    });
  }
  $("propMaskDraw")?.addEventListener("click", () => {
    setMaskDrawMode(!maskDrawMode);
    if (maskDrawMode) toast("Drag on the layer to draw a new square hole", "info");
  });
  if (maskDrawMode) setMaskDrawMode(true);
  $("propMaskDelete")?.addEventListener("click", () => {
    deleteTransparencyMask(layer, mask.id);
  });
  syncPropsOverlayVisibility(true);
}

function renderLayerProperties() {
  const panel = $("layerProps");
  const title = $("layerPropsTitle");
  if (!panel) return;

  // Capture edits from the current panel before we rebuild it.
  flushLayerPropsFromDom();

  if (!propsOverlayOpen || selectedLayerId == null) {
    syncPropsOverlayVisibility(false);
    panel.innerHTML = "";
    return;
  }

  if (selectedLayerId === BACKGROUND_ID) {
    // Background is not a selectable layer — clear selection.
    selectedLayerId = null;
    propsOverlayOpen = false;
    syncPropsOverlayVisibility(false);
    panel.innerHTML = "";
    return;
  }

  const layer = getLayerById(selectedLayerId);
  if (!layer) {
    syncPropsOverlayVisibility(false);
    panel.innerHTML = "";
    return;
  }

  if (selectedMaskId) {
    const mask = getMaskById(layer, selectedMaskId);
    if (mask) {
      renderMaskProperties(layer, mask);
      return;
    }
    selectedMaskId = null;
  }

  if (title) {
    title.textContent = layerDisplayTitle(layer);
  }

  panel.innerHTML = `
    <div class="space-y-3 text-sm">
      <p class="text-[10px] text-slate-500 uppercase tracking-wider">${
        layer.type === "tts" ? "voice" : layer.type
      } layer${layer.type === "audio" || layer.type === "tts" ? "" : " · drag on preview to position"}</p>
      <div>
        <label class="text-[10px] text-slate-500 uppercase" for="propLayerTitle">Title</label>
        <input type="text" id="propLayerTitle" maxlength="80" placeholder="${escapeHtml(layerDefaultTitle(layer.type))}"
          value="${escapeHtml(layer.title || "")}"
          class="w-full rounded bg-black/30 border border-white/10 px-2 py-1.5 text-sm mt-0.5"/>
        <p class="text-[10px] text-slate-500 mt-1">Shown in the layer list and timeline. Leave blank for an automatic label.</p>
      </div>
      ${layer.type !== "tts" && layer.type !== "audio" ? `
      <div class="grid grid-cols-2 gap-2">
        <div><label class="text-[10px] text-slate-500 uppercase">X %</label>
          <input type="number" id="propX" value="${Number(layer.x).toFixed(1)}" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Y %</label>
          <input type="number" id="propY" value="${Number(layer.y).toFixed(1)}" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
        <div><label class="text-[10px] text-slate-500 uppercase">W %</label>
          <input type="number" id="propW" value="${Number(layer.width).toFixed(1)}" min="1" max="400" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
        <div><label class="text-[10px] text-slate-500 uppercase">H %</label>
          <input type="number" id="propH" value="${Number(layer.height).toFixed(1)}" min="1" max="400" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
      </div>
      <div><label class="text-[10px] text-slate-500 uppercase">Opacity</label>
        <input type="range" id="propOpacity" min="0" max="1" step="0.05" value="${layer.opacity}" class="w-full"/></div>
      <div class="grid grid-cols-2 gap-2">
        <div><label class="text-[10px] text-slate-500 uppercase">Transition in</label>
          <select id="propTransIn" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm">
            <option value="none" ${layer.transition_in === "none" ? "selected" : ""}>None</option>
            <option value="fade-in" ${layer.transition_in === "fade-in" ? "selected" : ""}>Fade in</option>
          </select></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Transition out</label>
          <select id="propTransOut" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm">
            <option value="none" ${layer.transition_out === "none" ? "selected" : ""}>None</option>
            <option value="fade-out" ${layer.transition_out === "fade-out" ? "selected" : ""}>Fade out</option>
          </select></div>
      </div>
      ` : ""}
      ${currentPost?.type === "video" ? `
      <div class="grid grid-cols-2 gap-2 ${layer.type === "tts" || layer.type === "audio" ? "" : "pt-2 border-t border-white/5"}">
        <div><label class="text-[10px] text-slate-500 uppercase">Start (s)</label>
          <input type="number" id="propStartS" value="${(layer.start_s ?? 0).toFixed(1)}" min="0" step="0.1" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
        <div><label class="text-[10px] text-slate-500 uppercase">${
          layer.type === "tts" ? "Duration (from speech)" : "Duration (s)"
        }</label>
          <input type="number" id="propDurationS" value="${layerEffectiveDuration(layer).toFixed(1)}" min="0.1" step="0.1"
            ${layer.type === "tts" && layer.asset_id ? "readonly" : ""}
            class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm ${
              layer.type === "tts" && layer.asset_id ? "opacity-70 cursor-default" : ""
            }"/></div>
      </div>
      ${layer.type === "tts" ? `
        <p class="text-[11px] text-slate-500 -mt-1">
          ${layer.asset_id
            ? "Length matches the generated audio. Edit the script and regenerate to change it."
            : "Estimated from the script until you generate audio."}
        </p>
      ` : ""}
      ` : ""}
      ${layer.type === "text" ? `
        <div><label class="text-[10px] text-slate-500 uppercase">Text</label>
          <textarea id="propText" rows="2" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm">${escapeHtml(layer.text || "")}</textarea></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Font size</label>
          <input type="number" id="propFontSize" value="${layer.font_size}" min="8" max="200" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm"/></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Color</label>
          <input type="color" id="propColor" value="${layer.color}" class="w-full h-8 rounded cursor-pointer"/></div>
      ` : layer.type === "audio" ? `
        <div><label class="text-[10px] text-slate-500 uppercase">Audio asset</label>
          <select id="propAudioAsset" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm">
            ${(visibleAssets()).filter((a) => a.type === "audio").map((a) =>
              `<option value="${a.id}" ${a.id === layer.asset_id ? "selected" : ""}>${escapeHtml(a.name)}${a.post_id ? " · post" : ""}</option>`).join("")}
          </select></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Volume</label>
          <input type="range" id="propTtsVolume" min="0" max="1.5" step="0.05" value="${layer.tts_volume ?? 0.8}" class="w-full"/></div>
        <p class="text-[11px] text-slate-500">Timed on the timeline and mixed into the video export.</p>
      ` : layer.type === "video" ? `
        <div><label class="text-[10px] text-slate-500 uppercase">Video asset</label>
          <select id="propVideoAsset" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm">
            ${(visibleAssets()).filter((a) => a.type === "video").map((a) =>
              `<option value="${a.id}" ${a.id === layer.asset_id ? "selected" : ""}>${escapeHtml(a.name)}${a.post_id ? " · post" : ""}</option>`).join("")}
          </select></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Volume</label>
          <input type="range" id="propTtsVolume" min="0" max="1.5" step="0.05" value="${layer.tts_volume ?? 1}" class="w-full"/></div>
        <button type="button" id="propFitMedia" class="w-full text-xs px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-indigo-400/40 hover:text-white transition">Fit box to video</button>
        <button type="button" id="propFillCanvas" class="w-full text-xs px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-indigo-400/40 hover:text-white transition">Fill canvas</button>
        <div class="pt-2 border-t border-white/5 space-y-2">
          <p class="text-[10px] text-slate-500 uppercase tracking-wider">Transparency masks</p>
          <p class="text-[11px] text-slate-500">Each mask is its own timed hole on the timeline under this layer.</p>
          <div class="flex gap-1.5 flex-wrap">
            <button type="button" id="propMaskAdd" class="text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-amber-400/40 hover:text-amber-100 transition">+ Square</button>
            <button type="button" id="propMaskDraw" class="text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-amber-400/40 hover:text-amber-100 transition">Draw square mask</button>
          </div>
          <ul id="propMaskList" class="space-y-1">${
            ensureLayerMasks(layer).length
              ? ensureLayerMasks(layer).map((m, i) => `
                <li class="flex items-center gap-1.5 text-xs rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
                  <button type="button" class="prop-mask-select flex-1 text-left truncate text-slate-200" data-mask-id="${m.id}">
                    <span class="material-icons text-[12px] align-middle text-amber-300/90 mr-1">texture</span>${escapeHtml(maskDisplayTitle(m, i))}
                  </button>
                  <button type="button" class="prop-mask-del text-red-300 hover:text-red-200 px-1" data-mask-id="${m.id}" title="Delete mask">✕</button>
                </li>`).join("")
              : `<li class="text-[11px] text-slate-500 py-1">No masks yet</li>`
          }</ul>
        </div>
        <p class="text-[11px] text-slate-500">Timed on the timeline like audio. Drag partly off-canvas; resize corners (Shift = free stretch). Fill canvas uses the full stage.</p>
      ` : layer.type === "tts" ? `
        <div><label class="text-[10px] text-slate-500 uppercase">Script</label>
          <textarea id="propText" rows="3" placeholder="Use **bold** or HTML strong/em to stress words" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm font-mono">${escapeHtml(layer.text || "")}</textarea>
          <p class="text-[10px] text-slate-500 mt-1">Markdown/HTML: **word**, &lt;strong&gt;, &lt;em&gt; — stressed in speech.</p>
        </div>
        <div><label class="text-[10px] text-slate-500 uppercase">Mood</label>
          <select id="propTtsMood" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm">
            ${ttsMoodOptionsHtml(layer.tts_mood)}
          </select></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Voice</label>
          <div class="grid grid-cols-[minmax(0,7.5rem)_1fr] gap-1.5">
            <select id="propTtsRegion" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm" title="Filter by region">
              <option value="__all__">All regions</option>
            </select>
            <select id="propTtsVoice" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm">
              <option value="">Loading voices…</option>
            </select>
          </div></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Volume</label>
          <input type="range" id="propTtsVolume" min="0" max="1.5" step="0.05" value="${layer.tts_volume ?? 1}" class="w-full"/></div>
        <p class="text-[11px] text-slate-500">${layer.asset_id ? "Audio generated and will be mixed into the export. Script is not shown on the video." : "Preview first, then save audio to the post. Script is not shown on the video."}</p>
        <div id="propTtsPreviewWrap" class="hidden rounded-lg border border-amber-400/20 bg-black/30 p-2 space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-[10px] text-amber-100/90">Preview (not saved)</span>
            <span id="propTtsPreviewMeta" class="text-[10px] text-slate-500"></span>
          </div>
          <audio id="propTtsPreviewAudio" class="w-full h-8" controls preload="metadata"></audio>
        </div>
        <button type="button" id="propTtsPreview" class="w-full text-xs px-3 py-2 rounded-lg border border-amber-400/30 text-amber-100 hover:bg-amber-500/10 transition">Preview</button>
        <button type="button" id="propTtsGenerate" class="w-full text-xs px-3 py-2 rounded-lg bg-amber-500/15 border border-amber-400/30 text-amber-100 hover:bg-amber-500/25 transition">${layer.asset_id ? "Regenerate & save" : "Save audio"}</button>
        ${layer.asset_id ? `<button type="button" id="propTtsDeleteAsset" class="w-full text-xs px-3 py-2 rounded-lg border border-red-400/30 text-red-300 hover:bg-red-500/10 transition">Delete generated audio</button>` : ""}
      ` : `
        <div><label class="text-[10px] text-slate-500 uppercase">Asset</label>
          <select id="propAsset" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm">
            ${visibleAssets().filter((a) => a.type === "image" || a.type === "video").map((a) =>
              `<option value="${a.id}" ${a.id === layer.asset_id ? "selected" : ""}>${escapeHtml(a.name)}${a.post_id ? " · post" : ""}</option>`).join("")}
          </select></div>
        <div><label class="text-[10px] text-slate-500 uppercase">Format</label>
          <select id="propFormat" class="w-full rounded bg-black/30 border border-white/10 px-2 py-1 text-sm">
            ${(config.formats || []).map((f) => `<option value="${f}" ${layer.use_format === f ? "selected" : ""}>${f}</option>`).join("")}
          </select></div>
        <button type="button" id="propFitImage" class="w-full text-xs px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-indigo-400/40 hover:text-white transition">Fit box to image</button>
        <button type="button" id="propFillCanvas" class="w-full text-xs px-3 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-indigo-400/40 hover:text-white transition">Fill canvas</button>
        <div class="pt-2 border-t border-white/5 space-y-2">
          <p class="text-[10px] text-slate-500 uppercase tracking-wider">Transparency masks</p>
          <p class="text-[11px] text-slate-500">Each mask is its own entity — open one to edit size, title, and timing.</p>
          <div class="flex gap-1.5 flex-wrap">
            <button type="button" id="propMaskAdd" class="text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-amber-400/40 hover:text-amber-100 transition">+ Square</button>
            <button type="button" id="propMaskDraw" class="text-xs px-2.5 py-1.5 rounded-lg border border-white/10 text-slate-300 hover:border-amber-400/40 hover:text-amber-100 transition">Draw square mask</button>
          </div>
          <ul id="propMaskList" class="space-y-1">${
            ensureLayerMasks(layer).length
              ? ensureLayerMasks(layer).map((m, i) => `
                <li class="flex items-center gap-1.5 text-xs rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
                  <button type="button" class="prop-mask-select flex-1 text-left truncate text-slate-200" data-mask-id="${m.id}">
                    <span class="material-icons text-[12px] align-middle text-amber-300/90 mr-1">texture</span>${escapeHtml(maskDisplayTitle(m, i))}
                  </button>
                  <button type="button" class="prop-mask-del text-red-300 hover:text-red-200 px-1" data-mask-id="${m.id}" title="Delete mask">✕</button>
                </li>`).join("")
              : `<li class="text-[11px] text-slate-500 py-1">No masks yet</li>`
          }</ul>
        </div>
        <p class="text-[10px] text-slate-500">Corner resize keeps aspect (hold Shift to stretch). Drag partly off-canvas. Fill canvas covers the stage.</p>
      `}
    </div>`;

  const bind = (id, key, parse = (v) => v, rerender = true) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => {
      layer[key] = parse(el.type === "number" || el.type === "range" ? +el.value : el.value);
      scheduleSavePost();
      if (rerender) renderLayerOverlays();
    });
  };
  const titleEl = $("propLayerTitle");
  if (titleEl) {
    titleEl.addEventListener("input", () => {
      layer.title = titleEl.value.slice(0, 80);
      const hdr = $("layerPropsTitle");
      if (hdr) hdr.textContent = layerDisplayTitle(layer);
      scheduleSavePost();
      renderLayerList();
      if (currentPost?.type === "video") renderSceneGantt();
    });
  }
  bind("propX", "x", Number);
  bind("propY", "y", Number);
  bind("propW", "width", Number);
  bind("propH", "height", Number);
  ["propX", "propY", "propW", "propH"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", () => {
      clampLayerVisibility(layer);
      syncPropInputs(layer);
      scheduleSavePost();
      renderLayerOverlays();
    });
  });
  bind("propOpacity", "opacity", Number);
  bind("propTransIn", "transition_in", (v) => v, true);
  bind("propTransOut", "transition_out", (v) => v, true);
  if (currentPost?.type === "video") {
    const startEl = $("propStartS");
    if (startEl) {
      startEl.addEventListener("input", () => {
        layer.start_s = Math.max(0, +startEl.value);
        const scene = getActiveScene();
        if (scene) ensureSceneFitsLayer(scene, layer);
        scheduleSavePost();
        renderLayerOverlays();
        syncPreviewTimeControls();
        renderSceneGantt();
        renderLayerList();
      });
    }
    const durEl = $("propDurationS");
    if (durEl && !(layer.type === "tts" && layer.asset_id)) {
      durEl.addEventListener("input", () => {
        layer.duration_s = Math.max(0.1, +durEl.value);
        const scene = getActiveScene();
        if (scene) ensureSceneFitsLayer(scene, layer);
        if ($("sceneDuration") && scene) $("sceneDuration").value = scene.duration_s;
        scheduleSavePost();
        renderLayerOverlays();
        renderLayerList();
        renderSceneGantt();
      });
    }
  }
  if (layer.type === "text") {
    bind("propText", "text");
    bind("propFontSize", "font_size", Number);
    bind("propColor", "color");
  } else if (layer.type === "tts") {
    const textEl = $("propText");
    if (textEl) {
      textEl.addEventListener("input", () => {
        layer.text = textEl.value;
        // Before audio exists, keep the timeline bar in sync with script length.
        if (!layer.asset_id) {
          layer.duration_s = estimateSpeechDurationS(layer.text);
          const scene = getActiveScene();
          if (scene) ensureSceneFitsLayer(scene, layer);
          const durEl = $("propDurationS");
          if (durEl) durEl.value = layer.duration_s.toFixed(1);
          renderSceneGantt();
          renderLayerList();
        }
        scheduleSavePost();
      });
    }
    bind("propTtsVolume", "tts_volume", Number, false);
    bind("propTtsMood", "tts_mood", (v) => v || "neutral", false);
    $("propTtsPreview")?.addEventListener("click", () => previewSelectedTtsLayer());
    $("propTtsGenerate")?.addEventListener("click", () => {
      flushLayerPropsFromDom();
      clearTtsPreview("layer");
      synthesizeSelectedTts();
    });
    $("propTtsDeleteAsset")?.addEventListener("click", async () => {
      const assetId = layer.asset_id;
      if (!assetId) return;
      try {
        const deleted = await deleteProjectAsset(assetId);
        if (!deleted) return;
        const live = getLayerById(layer.id);
        if (live) {
          live.asset_id = null;
          live.duration_s = estimateSpeechDurationS(live.text || "");
          const scene = getActiveScene();
          if (scene) ensureSceneFitsLayer(scene, live);
        }
        scheduleSavePost();
        renderEditor();
      } catch (err) {
        toast(err.message, "error");
      }
    });
    ensureTtsVoices().then((data) => {
      const sel = $("propTtsVoice");
      const regionEl = $("propTtsRegion");
      // Ignore stale callbacks if the user switched layers meanwhile.
      if (!sel || selectedLayerId !== layer.id) return;
      const live = getLayerById(layer.id) || layer;
      const picked = bindTtsVoicePicker({
        regionEl,
        voiceEl: sel,
        data,
        selectedVoiceId: live.tts_voice || null,
        onVoiceChange: (voiceId) => {
          flushLayerPropsFromDom();
          const target = getLayerById(selectedLayerId);
          if (!target || target.type !== "tts") return;
          target.tts_voice = voiceId;
          rememberPostTtsVoice(voiceId);
          scheduleSavePost();
        },
      });
      if (picked && !live.tts_voice) {
        live.tts_voice = picked;
        rememberPostTtsVoice(picked);
        scheduleSavePost();
      }
    }).catch(() => {
      const sel = $("propTtsVoice");
      if (sel && selectedLayerId === layer.id) {
        sel.innerHTML = `<option value="">Could not load voices</option>`;
      }
    });
  } else if (layer.type === "audio") {
    bind("propTtsVolume", "tts_volume", Number, false);
    $("propAudioAsset")?.addEventListener("change", (e) => {
      layer.asset_id = e.target.value || null;
      scheduleSavePost();
      renderLayerList();
      renderSceneGantt();
    });
  } else if (layer.type === "video") {
    bind("propTtsVolume", "tts_volume", Number, false);
    $("propVideoAsset")?.addEventListener("change", (e) => {
      layer.asset_id = e.target.value || null;
      const asset = getAssetById(layer.asset_id);
      if (asset?.name) layer.title = String(asset.name).slice(0, 40);
      previewVideoEls.delete(layer.id);
      scheduleSavePost();
      renderInteractiveCanvas();
      renderLayerList();
      renderSceneGantt();
      const hdr = $("layerPropsTitle");
      if (hdr) hdr.textContent = layerDisplayTitle(layer);
    });
    $("propFitMedia")?.addEventListener("click", async () => {
      await fitMediaLayerToAsset(layer, {
        maxPct: Math.max(layer.width, layer.height, 40),
        preserveCenter: true,
      });
      scheduleSavePost();
      renderInteractiveCanvas();
      syncPropInputs(layer);
      toast("Layer sized to video aspect", "ok");
    });
    $("propFillCanvas")?.addEventListener("click", () => {
      layer.x = 0;
      layer.y = 0;
      layer.width = 100;
      layer.height = 100;
      scheduleSavePost();
      renderInteractiveCanvas();
      syncPropInputs(layer);
      toast("Layer fills the canvas", "ok");
    });
    bindMaskPropControls(layer);
  } else {
    $("propAsset")?.addEventListener("change", async (e) => {
      layer.asset_id = e.target.value || null;
      const asset = getAssetById(layer.asset_id);
      if (asset?.name) layer.title = String(asset.name).slice(0, 40);
      await fitMediaLayerToAsset(layer, { maxPct: Math.max(layer.width, layer.height, 40), preserveCenter: true });
      scheduleSavePost();
      renderInteractiveCanvas();
      renderLayerList();
      syncPropInputs(layer);
      const hdr = $("layerPropsTitle");
      if (hdr) hdr.textContent = layerDisplayTitle(layer);
    });
    $("propFormat")?.addEventListener("change", async (e) => {
      layer.use_format = e.target.value || getTargetFormat();
      await fitMediaLayerToAsset(layer, { maxPct: Math.max(layer.width, layer.height, 40), preserveCenter: true });
      scheduleSavePost();
      renderInteractiveCanvas();
      syncPropInputs(layer);
    });
    $("propFitImage")?.addEventListener("click", async () => {
      await fitMediaLayerToAsset(layer, { maxPct: Math.max(layer.width, layer.height, 40), preserveCenter: true });
      scheduleSavePost();
      renderInteractiveCanvas();
      syncPropInputs(layer);
      toast("Layer sized to image aspect", "ok");
    });
    $("propFillCanvas")?.addEventListener("click", () => {
      layer.x = 0;
      layer.y = 0;
      layer.width = 100;
      layer.height = 100;
      scheduleSavePost();
      renderInteractiveCanvas();
      syncPropInputs(layer);
      toast("Layer fills the canvas", "ok");
    });
    if (layer.type === "image") bindMaskPropControls(layer);
  }
  syncPropsOverlayVisibility(true);
}

function applyLayerStyle(el, layer) {
  el.style.left = `${layer.x}%`;
  el.style.top = `${layer.y}%`;
  el.style.width = `${layer.width}%`;
  el.style.height = `${layer.height}%`;
  el.style.opacity = layer.opacity;
  el.style.zIndex = layer.z_index;
}

function ensureLayerMasks(layer) {
  if (!layer) return [];
  if (!Array.isArray(layer.masks)) layer.masks = [];
  return layer.masks;
}

function getMaskById(layer, maskId) {
  return ensureLayerMasks(layer).find((m) => m.id === maskId) || null;
}

function clampMaskRect(mask) {
  mask.width = clamp(Number(mask.width) || 1, 1, 100);
  mask.height = clamp(Number(mask.height) || 1, 1, 100);
  mask.x = clamp(Number(mask.x) || 0, 0, 100 - mask.width);
  mask.y = clamp(Number(mask.y) || 0, 0, 100 - mask.height);
}

/** CSS mask-image that punches transparency holes (layer-local %). */
function layerTransparencyMaskCss(layer) {
  const layerDur = layerEffectiveDuration(layer);
  const layerLocalT = currentPost?.type === "video"
    ? Math.max(0, previewTimeS - (Number(layer.start_s) || 0))
    : null;
  const masks = ensureLayerMasks(layer).filter((m) => {
    if ((m.type || "rect") !== "rect" || (m.kind || "transparency") !== "transparency") return false;
    if (!(Number(m.width) > 0 && Number(m.height) > 0)) return false;
    if (layerLocalT == null) return true;
    return maskActiveAt(m, layerLocalT, layerDur);
  });
  if (!masks.length) return null;
  // White = keep, black = punch. Applied with mask-mode: luminance in applyMediaTransparencyMask.
  const holes = masks.map((m) =>
    `<rect x="${Number(m.x)}" y="${Number(m.y)}" width="${Number(m.width)}" height="${Number(m.height)}" fill="black"/>`
  ).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><rect width="100" height="100" fill="white"/>${holes}</svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

function clearMediaTransparencyMask(mediaEl) {
  if (!mediaEl?.style) return;
  mediaEl.style.maskImage = "";
  mediaEl.style.webkitMaskImage = "";
  mediaEl.style.maskSize = "";
  mediaEl.style.webkitMaskSize = "";
  mediaEl.style.maskRepeat = "";
  mediaEl.style.webkitMaskRepeat = "";
  mediaEl.style.maskMode = "";
  mediaEl.style.webkitMaskSourceType = "";
}

function applyMediaTransparencyMask(mediaEl, layer) {
  if (!mediaEl) return;
  const css = layerTransparencyMaskCss(layer);
  if (!css) {
    clearMediaTransparencyMask(mediaEl);
    return;
  }
  mediaEl.style.maskImage = css;
  mediaEl.style.webkitMaskImage = css;
  mediaEl.style.maskSize = "100% 100%";
  mediaEl.style.webkitMaskSize = "100% 100%";
  mediaEl.style.maskRepeat = "no-repeat";
  mediaEl.style.webkitMaskRepeat = "no-repeat";
  mediaEl.style.maskMode = "luminance";
  mediaEl.style.webkitMaskSourceType = "luminance";
}

function stagePointToLayerLocal(layer, stageX, stageY) {
  const w = Math.max(0.01, Number(layer.width) || 0.01);
  const h = Math.max(0.01, Number(layer.height) || 0.01);
  return {
    x: ((stageX - Number(layer.x)) / w) * 100,
    y: ((stageY - Number(layer.y)) / h) * 100,
  };
}

function setMaskDrawMode(on) {
  maskDrawMode = !!on;
  $("editorStage")?.classList.toggle("mask-draw-mode", maskDrawMode);
  const btn = $("propMaskDraw");
  if (btn) {
    btn.classList.toggle("border-amber-400/50", maskDrawMode);
    btn.classList.toggle("text-amber-100", maskDrawMode);
    btn.classList.toggle("bg-amber-500/15", maskDrawMode);
    btn.textContent = maskDrawMode ? "Drawing… (drag on layer)" : "Draw square mask";
  }
}

function addTransparencyMask(layer, rect = null) {
  if (!layer || (layer.type !== "image" && layer.type !== "video")) return null;
  const masks = ensureLayerMasks(layer);
  const mask = {
    id: uid(),
    type: "rect",
    kind: "transparency",
    title: "",
    x: rect?.x ?? 30,
    y: rect?.y ?? 30,
    width: rect?.width ?? 40,
    height: rect?.height ?? 40,
    start_s: 0,
    duration_s: null,
  };
  clampMaskRect(mask);
  masks.push(mask);
  // Seek into the mask window so the hole is visible in the preview immediately.
  if (currentPost?.type === "video") {
    const layerStart = Math.max(0, Number(layer.start_s) || 0);
    previewTimeS = layerStart + Math.max(0, Number(mask.start_s) || 0);
    const row = getSceneTimeline().find((r) => r.scene.id === activeSceneId);
    if (row) previewAbsS = row.start + previewTimeS;
    syncPreviewTimeControls();
  }
  selectMask(layer.id, mask.id);
  setMaskDrawMode(false);
  scheduleSavePost();
  return mask;
}

function deleteTransparencyMask(layer, maskId) {
  if (!layer || !maskId) return;
  layer.masks = ensureLayerMasks(layer).filter((m) => m.id !== maskId);
  if (selectedMaskId === maskId) selectedMaskId = null;
  scheduleSavePost();
  renderLayerProperties();
  renderLayerOverlays();
  renderLayerList();
  if (currentPost?.type === "video") renderSceneGantt();
}

/** Open mask properties for an existing mask, or create one if the layer has none. */
function openLayerMaskFromUi(layerId, sceneId = null) {
  if (sceneId && sceneId !== activeSceneId) {
    activeSceneId = sceneId;
    const row = getSceneTimeline().find((r) => r.scene.id === sceneId);
    if (row) {
      previewAbsS = row.start;
      previewTimeS = 0;
    }
  }
  const layer = getLayerById(layerId);
  if (!layer || (layer.type !== "image" && layer.type !== "video")) return;
  const masks = ensureLayerMasks(layer);
  if (masks.length) {
    selectMask(layer.id, masks[0].id);
  } else {
    addTransparencyMask(layer);
    toast("Transparency mask added — edit its properties", "ok");
  }
}

function selectMask(layerId, maskId, { rebuildOverlays = true, skipGantt = false } = {}) {
  flushLayerPropsFromDom();
  selectedLayerId = layerId || null;
  selectedMaskId = maskId || null;
  propsOverlayOpen = selectedLayerId != null;
  setMaskDrawMode(false);
  if (selectedLayerId != null) closeAiPanel();
  renderLayerList();
  renderLayerProperties();
  if (rebuildOverlays) renderLayerOverlays();
  if (!skipGantt && currentPost?.type === "video") renderSceneGantt();
  requestAnimationFrame(() => fitEditorStage());
}

function bindMaskPropControls(layer) {
  $("propMaskAdd")?.addEventListener("click", () => {
    addTransparencyMask(layer);
    toast("Transparency mask added — drag to place", "ok");
  });
  $("propMaskDraw")?.addEventListener("click", () => {
    setMaskDrawMode(!maskDrawMode);
    if (maskDrawMode) toast("Drag on the layer to draw a square hole", "info");
  });
  if (maskDrawMode) setMaskDrawMode(true); // refresh button styling after rebuild
  $("propMaskList")?.querySelectorAll(".prop-mask-select").forEach((btn) => {
    btn.addEventListener("click", () => selectMask(layer.id, btn.dataset.maskId));
  });
  $("propMaskList")?.querySelectorAll(".prop-mask-del").forEach((btn) => {
    btn.addEventListener("click", () => deleteTransparencyMask(layer, btn.dataset.maskId));
  });
}

function fitEditorStage() {
  const frame = $("canvasDropzone");
  const stage = $("editorStage");
  if (!frame || !stage) return;
  const fmt = getTargetFormat();
  const ar = FORMAT_ASPECT_RATIO[fmt] || FORMAT_ASPECT_RATIO.portrait;
  // Account for scroll padding so "fit" leaves room to grab edge handles.
  const padX = 88;
  const padY = 88;
  const maxW = Math.max(120, (frame.clientWidth || 320) - padX);
  const frameH = frame.clientHeight || 0;
  const maxH = Math.max(120, (frameH > 80 ? frameH : window.innerHeight * 0.7) - padY);
  let w = maxW;
  let h = w / ar;
  if (h > maxH) {
    h = maxH;
    w = h * ar;
  }
  if (w > maxW) {
    w = maxW;
    h = w / ar;
  }
  const zoom = clamp(previewZoom, PREVIEW_ZOOM_MIN, PREVIEW_ZOOM_MAX);
  stage.style.width = `${Math.max(80, Math.floor(w * zoom))}px`;
  stage.style.height = `${Math.max(80, Math.floor(h * zoom))}px`;
  stage.style.aspectRatio = "auto";
  stage.style.maxWidth = "none";
  stage.style.maxHeight = "none";
  syncPreviewZoomUi();
}

function syncPreviewZoomUi() {
  const btn = $("previewZoomResetBtn");
  if (btn) btn.textContent = `${Math.round(previewZoom * 100)}%`;
}

function setPreviewZoom(next, { anchorClientX = null, anchorClientY = null } = {}) {
  const frame = $("canvasDropzone");
  const stage = $("editorStage");
  const prev = previewZoom;
  previewZoom = clamp(Math.round(next / PREVIEW_ZOOM_STEP) * PREVIEW_ZOOM_STEP, PREVIEW_ZOOM_MIN, PREVIEW_ZOOM_MAX);
  if (Math.abs(previewZoom - prev) < 1e-6) {
    syncPreviewZoomUi();
    return;
  }

  // Keep the point under the cursor stable while zooming (when possible).
  let relX = 0.5;
  let relY = 0.5;
  let scrollLeft = frame?.scrollLeft || 0;
  let scrollTop = frame?.scrollTop || 0;
  if (frame && stage && anchorClientX != null && anchorClientY != null) {
    const fr = frame.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const stageX = anchorClientX - sr.left;
    const stageY = anchorClientY - sr.top;
    relX = sr.width ? stageX / sr.width : 0.5;
    relY = sr.height ? stageY / sr.height : 0.5;
    scrollLeft = frame.scrollLeft + (anchorClientX - fr.left) - frame.clientWidth / 2;
    scrollTop = frame.scrollTop + (anchorClientY - fr.top) - frame.clientHeight / 2;
  }

  fitEditorStage();
  renderLayerOverlays();

  if (frame && stage) {
    const newW = stage.offsetWidth;
    const newH = stage.offsetHeight;
    const fr = frame.getBoundingClientRect();
    // Center the anchored stage point in the viewport after zoom.
    if (anchorClientX != null) {
      const targetX = relX * newW;
      const targetY = relY * newH;
      // Stage is centered via flex; compute offset of stage within scroll content.
      const contentW = frame.scrollWidth;
      const contentH = frame.scrollHeight;
      const stageLeft = Math.max(0, (contentW - newW) / 2);
      const stageTop = Math.max(0, (contentH - newH) / 2);
      frame.scrollLeft = stageLeft + targetX - frame.clientWidth / 2;
      frame.scrollTop = stageTop + targetY - frame.clientHeight / 2;
    } else {
      // Preserve relative scroll position when using buttons.
      const ratio = previewZoom / prev;
      frame.scrollLeft = (scrollLeft + frame.clientWidth / 2) * ratio - frame.clientWidth / 2;
      frame.scrollTop = (scrollTop + frame.clientHeight / 2) * ratio - frame.clientHeight / 2;
    }
  }
}

function zoomPreviewBy(delta, opts = {}) {
  setPreviewZoom(previewZoom + delta, opts);
}

function renderLayerOverlays() {
  const overlay = $("layerOverlay");
  if (!overlay || !currentProject) return;
  overlay.innerHTML = "";
  const layers = [...getActiveLayers()].sort((a, b) => a.z_index - b.z_index);
  const isVideo = currentPost?.type === "video";
  const stage = $("editorStage");
  const fontScale = Math.max(0.2, (stage?.clientWidth || 400) / 1080);
  const usedVideoIds = new Set();
  for (const layer of layers) {
    // Voice/audio are timeline-only — never draw script or chips on the preview.
    if (layer.type === "tts" || layer.type === "audio") continue;

    let displayOpacity = Number(layer.opacity);
    if (!Number.isFinite(displayOpacity)) displayOpacity = 1;
    if (isVideo) {
      displayOpacity = layerOpacityAt(layer, previewTimeS);
      // While editing (paused), keep the selected layer faintly visible even
      // outside its window so it can still be positioned.
      const ghostSelected = !previewPlaying
        && layer.id === selectedLayerId
        && displayOpacity <= 0.001;
      if (displayOpacity <= 0.001 && !ghostSelected) {
        // Video clips stay mounted (opacity 0) so Play can seek without reloading.
        if (layer.type === "video") displayOpacity = 0;
        else continue;
      }
      if (ghostSelected) displayOpacity = 0.35;
    }

    const el = document.createElement("div");
    el.className = "layer-item" + (layer.id === selectedLayerId ? " selected" : "");
    el.dataset.layerId = layer.id;
    applyLayerStyle(el, layer);
    el.style.opacity = String(displayOpacity);

    if (layer.type === "text") {
      const text = document.createElement("div");
      text.className = "layer-text";
      text.style.color = layer.color || "#ffffff";
      text.style.fontSize = `${Math.max(12, (layer.font_size || 28) * fontScale)}px`;
      text.style.fontWeight = layer.font_weight || "bold";
      text.style.textShadow = "0 1px 2px rgba(0,0,0,0.65)";
      text.textContent = layer.text || "Text";
      el.appendChild(text);
    } else if (layer.type === "video") {
      const asset = getAssetById(layer.asset_id);
      const url = asset ? getAssetPreviewUrl(asset) : null;
      if (url) {
        let video = previewVideoEls.get(layer.id);
        if (!video || video.dataset.assetId !== String(layer.asset_id || "")) {
          if (video) {
            try { video.pause(); } catch (_) { /* ignore */ }
          }
          video = document.createElement("video");
          video.className = "layer-img";
          video.playsInline = true;
          video.preload = "auto";
          video.muted = true;
          video.dataset.assetId = String(layer.asset_id || "");
          video.src = url;
          previewVideoEls.set(layer.id, video);
        }
        applyMediaTransparencyMask(video, layer);
        el.appendChild(video);
        usedVideoIds.add(layer.id);
      }
    } else {
      const asset = getAssetById(layer.asset_id);
      const url = asset ? getAssetPreviewUrl(asset, layer.use_format || getTargetFormat()) : null;
      if (url) {
        const img = document.createElement("img");
        img.className = "layer-img";
        img.src = url;
        img.alt = "";
        applyMediaTransparencyMask(img, layer);
        el.appendChild(img);
      }
    }

    if (layer.id === selectedLayerId && (layer.type === "image" || layer.type === "video")) {
      const layerDur = layerEffectiveDuration(layer);
      const layerLocalT = currentPost?.type === "video"
        ? Math.max(0, previewTimeS - (Number(layer.start_s) || 0))
        : null;
      const toolbar = document.createElement("div");
      toolbar.className = "layer-mask-toolbar";
      const maskBtn = document.createElement("button");
      maskBtn.type = "button";
      maskBtn.title = ensureLayerMasks(layer).length
        ? "Edit transparency masks"
        : "Add transparency mask";
      maskBtn.innerHTML = `<span class="material-icons" aria-hidden="true">texture</span>`;
      maskBtn.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
      });
      maskBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        openLayerMaskFromUi(layer.id);
      });
      toolbar.appendChild(maskBtn);
      el.appendChild(toolbar);

      for (const mask of ensureLayerMasks(layer)) {
        const active = layerLocalT == null || maskActiveAt(mask, layerLocalT, layerDur);
        const maskEl = document.createElement("div");
        maskEl.className = "layer-mask-item"
          + (mask.id === selectedMaskId ? " selected" : "")
          + (!active && mask.id !== selectedMaskId ? " inactive" : "");
        maskEl.dataset.maskId = mask.id;
        maskEl.style.left = `${mask.x}%`;
        maskEl.style.top = `${mask.y}%`;
        maskEl.style.width = `${mask.width}%`;
        maskEl.style.height = `${mask.height}%`;
        maskEl.title = active
          ? "Transparency mask"
          : "Mask inactive at this time (edit timing on timeline)";
        if (mask.id === selectedMaskId) {
          for (const corner of ["nw", "ne", "sw", "se"]) {
            const handle = document.createElement("div");
            handle.className = `mask-resize-handle ${corner}`;
            handle.dataset.handle = corner;
            handle.addEventListener("mousedown", (e) => {
              e.stopPropagation();
              e.preventDefault();
              startMaskDrag(e, layer.id, mask.id, "resize", corner);
            });
            maskEl.appendChild(handle);
          }
        }
        maskEl.addEventListener("mousedown", (e) => {
          if (e.target.classList.contains("mask-resize-handle")) return;
          e.stopPropagation();
          e.preventDefault();
          selectMask(layer.id, mask.id, { rebuildOverlays: false });
          startMaskDrag(e, layer.id, mask.id, "move");
          document.querySelectorAll(".layer-mask-item").forEach((node) => {
            node.classList.toggle("selected", node.dataset.maskId === mask.id);
            node.classList.toggle("inactive", false);
          });
        });
        el.appendChild(maskEl);
      }
    }

    if (layer.id === selectedLayerId) {
      for (const corner of ["nw", "ne", "sw", "se"]) {
        const handle = document.createElement("div");
        handle.className = `resize-handle ${corner}`;
        handle.dataset.handle = corner;
        handle.addEventListener("mousedown", (e) => {
          e.stopPropagation();
          startCanvasDrag(e, layer.id, "resize", corner);
        });
        el.appendChild(handle);
      }
    }

    el.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("resize-handle")) return;
      if (e.target.closest(".layer-mask-item")) return;
      if (e.target.closest(".layer-mask-toolbar")) return;
      e.stopPropagation();
      selectLayer(layer.id);
      if (maskDrawMode && (layer.type === "image" || layer.type === "video")) {
        startMaskDrag(e, layer.id, null, "draw");
        return;
      }
      startCanvasDrag(e, layer.id, "move");
    });
    overlay.appendChild(el);
  }

  for (const [id, video] of [...previewVideoEls.entries()]) {
    if (usedVideoIds.has(id)) continue;
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (_) { /* ignore */ }
    previewVideoEls.delete(id);
  }

  const ring = $("bgSelectRing");
  if (ring) ring.classList.add("hidden");

  syncPreviewVideos(previewAbsS, { playing: previewPlaying });
}

function renderInteractiveCanvas() {
  if (!currentProject || !currentPost) return;
  fitEditorStage();

  const bgImg = $("canvasBackground");
  const bgVideo = $("canvasBackgroundVideo");
  const placeholder = $("canvasPlaceholder");
  const activeScene = getActiveScene();
  if (isSceneRef(activeScene)) {
    bgImg?.classList.add("hidden");
    bgImg?.removeAttribute("src");
    bgVideo?.classList.add("hidden");
    bgVideo?.removeAttribute("src");
    if (placeholder) {
      placeholder.classList.remove("hidden");
      placeholder.textContent = `Reusable: ${activeScene.name || "clip"} — open the source post to edit, or use Preview for a frame`;
    }
    const overlay = $("layerOverlay");
    if (overlay) overlay.innerHTML = "";
    return;
  }
  if (placeholder && placeholder.dataset.defaultText == null) {
    placeholder.dataset.defaultText = placeholder.textContent || "Add text or drag assets onto the canvas";
  }

  const { assetId, format } = getBackgroundInfo();
  const asset = assetId ? getAssetById(assetId) : null;
  const url = asset ? getAssetPreviewUrl(asset, format) : null;
  const hasVisualLayers = getActiveLayers().some(
    (l) => l.type === "text" || l.type === "image" || l.type === "video",
  );

  if (url && asset?.type === "video" && bgVideo) {
    bgImg?.classList.add("hidden");
    bgImg?.removeAttribute("src");
    if (bgVideo.getAttribute("src") !== url) {
      bgVideo.src = url;
      try { bgVideo.load(); } catch (_) { /* ignore */ }
    }
    bgVideo.loop = false;
    bgVideo.autoplay = false;
    bgVideo.muted = true;
    bgVideo.classList.remove("hidden");
  } else if (url && bgImg) {
    bgVideo?.classList.add("hidden");
    bgVideo?.removeAttribute("src");
    if (bgImg.getAttribute("src") !== url) bgImg.src = url;
    bgImg.classList.remove("hidden");
  } else {
    bgImg?.classList.add("hidden");
    bgImg?.removeAttribute("src");
    bgVideo?.classList.add("hidden");
    bgVideo?.removeAttribute("src");
  }
  if (placeholder) {
    placeholder.textContent = placeholder.dataset.defaultText || "Add text or drag assets onto the canvas";
    placeholder.classList.toggle("hidden", !!(url || hasVisualLayers));
  }

  renderLayerOverlays();
}

function updateCanvasPreview() {
  renderInteractiveCanvas();
}

function getStagePoint(clientX, clientY, { clampToStage = true } = {}) {
  const stage = $("editorStage");
  if (!stage) return { x: 0, y: 0, rect: { width: 1, height: 1, left: 0, top: 0 } };
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: 0, y: 0, rect };
  let x = ((clientX - rect.left) / rect.width) * 100;
  let y = ((clientY - rect.top) / rect.height) * 100;
  if (clampToStage) {
    x = clamp(x, 0, 100);
    y = clamp(y, 0, 100);
  }
  return { x, y, rect };
}

function getLayerById(layerId) {
  if (!layerId || !currentPost) return null;
  if (currentPost.type === "video") {
    for (const scene of currentPost.scenes || []) {
      const found = (scene.layers || []).find((l) => l.id === layerId);
      if (found) return found;
    }
    return null;
  }
  return (currentPost.layers || []).find((l) => l.id === layerId) || null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Write open property-panel fields onto the live layer in currentPost. */
function flushLayerPropsFromDom() {
  const layer = getLayerById(selectedLayerId);
  if (!layer) return;
  const maskTitleEl = $("propMaskTitle");
  if (maskTitleEl && selectedMaskId) {
    const mask = getMaskById(layer, selectedMaskId);
    if (mask) mask.title = maskTitleEl.value.slice(0, 80);
  }
  const titleEl = $("propLayerTitle");
  if (titleEl) {
    layer.title = titleEl.value.slice(0, 80);
  }
  const textEl = $("propText");
  if (textEl && (layer.type === "text" || layer.type === "tts")) {
    layer.text = textEl.value;
  }
  const voiceEl = $("propTtsVoice");
  if (voiceEl && layer.type === "tts" && voiceEl.value) {
    layer.tts_voice = voiceEl.value;
  }
  const moodEl = $("propTtsMood");
  if (moodEl && layer.type === "tts") {
    layer.tts_mood = moodEl.value || "neutral";
  }
  const volEl = $("propTtsVolume");
  if (volEl && (layer.type === "tts" || layer.type === "audio" || layer.type === "video")) {
    layer.tts_volume = +volEl.value;
  }
  const fontEl = $("propFontSize");
  if (fontEl && (layer.type === "text" || layer.type === "tts")) {
    layer.font_size = +fontEl.value;
  }
  const colorEl = $("propColor");
  if (colorEl && (layer.type === "text" || layer.type === "tts")) {
    layer.color = colorEl.value;
  }
}

function startMaskDrag(e, layerId, maskId, mode, handle = null) {
  e.preventDefault();
  const layer = getLayerById(layerId);
  if (!layer) return;
  const pt = getStagePoint(e.clientX, e.clientY, { clampToStage: false });
  const local = stagePointToLayerLocal(layer, pt.x, pt.y);
  if (mode === "draw") {
    maskDrag = {
      mode: "draw",
      layerId,
      startLocal: { x: local.x, y: local.y },
      currentLocal: { x: local.x, y: local.y },
    };
    return;
  }
  const mask = getMaskById(layer, maskId);
  if (!mask) return;
  maskDrag = {
    mode,
    handle,
    layerId,
    maskId,
    startLocal: local,
    orig: { x: mask.x, y: mask.y, width: mask.width, height: mask.height },
  };
}

function onMaskPointerMove(e) {
  if (!maskDrag) return;
  const layer = getLayerById(maskDrag.layerId);
  if (!layer) return;
  const pt = getStagePoint(e.clientX, e.clientY, { clampToStage: false });
  const local = stagePointToLayerLocal(layer, pt.x, pt.y);

  if (maskDrag.mode === "draw") {
    maskDrag.currentLocal = local;
    const x = Math.min(maskDrag.startLocal.x, local.x);
    const y = Math.min(maskDrag.startLocal.y, local.y);
    const width = Math.abs(local.x - maskDrag.startLocal.x);
    const height = Math.abs(local.y - maskDrag.startLocal.y);
    let preview = document.getElementById("maskDrawPreview");
    const layerEl = document.querySelector(`.layer-item[data-layer-id="${layer.id}"]`);
    if (!layerEl) return;
    if (!preview) {
      preview = document.createElement("div");
      preview.id = "maskDrawPreview";
      preview.className = "layer-mask-item selected";
      preview.style.pointerEvents = "none";
      layerEl.appendChild(preview);
    }
    preview.style.left = `${x}%`;
    preview.style.top = `${y}%`;
    preview.style.width = `${Math.max(width, 0.5)}%`;
    preview.style.height = `${Math.max(height, 0.5)}%`;
    return;
  }

  const mask = getMaskById(layer, maskDrag.maskId);
  if (!mask) return;
  const o = maskDrag.orig;
  const dx = local.x - maskDrag.startLocal.x;
  const dy = local.y - maskDrag.startLocal.y;

  if (maskDrag.mode === "move") {
    mask.x = o.x + dx;
    mask.y = o.y + dy;
    clampMaskRect(mask);
  } else if (maskDrag.mode === "resize") {
    const h = maskDrag.handle || "se";
    let x = o.x;
    let y = o.y;
    let width = o.width;
    let height = o.height;
    if (h.includes("e")) width = o.width + dx;
    if (h.includes("s")) height = o.height + dy;
    if (h.includes("w")) {
      width = o.width - dx;
      x = o.x + dx;
    }
    if (h.includes("n")) {
      height = o.height - dy;
      y = o.y + dy;
    }
    if (width < 1) {
      if (h.includes("w")) x = o.x + o.width - 1;
      width = 1;
    }
    if (height < 1) {
      if (h.includes("n")) y = o.y + o.height - 1;
      height = 1;
    }
    mask.x = x;
    mask.y = y;
    mask.width = width;
    mask.height = height;
    clampMaskRect(mask);
  }

  const maskEl = document.querySelector(`.layer-mask-item[data-mask-id="${mask.id}"]`);
  if (maskEl) {
    maskEl.style.left = `${mask.x}%`;
    maskEl.style.top = `${mask.y}%`;
    maskEl.style.width = `${mask.width}%`;
    maskEl.style.height = `${mask.height}%`;
  }
  const media = document.querySelector(`.layer-item[data-layer-id="${layer.id}"] .layer-img`);
  applyMediaTransparencyMask(media, layer);
}

function endMaskDrag() {
  if (!maskDrag) return;
  const drag = maskDrag;
  maskDrag = null;
  document.getElementById("maskDrawPreview")?.remove();

  const layer = getLayerById(drag.layerId);
  if (!layer) return;

  if (drag.mode === "draw") {
    const a = drag.startLocal;
    const b = drag.currentLocal || a;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const width = Math.abs(b.x - a.x);
    const height = Math.abs(b.y - a.y);
    if (width < 2 || height < 2) {
      toast("Drag a larger square for the mask", "info");
      setMaskDrawMode(false);
      return;
    }
    addTransparencyMask(layer, { x, y, width, height });
    toast("Transparency mask added", "ok");
    return;
  }

  scheduleSavePost();
  renderLayerOverlays();
  if (selectedLayerId === layer.id) renderLayerProperties();
  if (currentPost?.type === "video") renderSceneGantt();
  renderLayerList();
}

function startCanvasDrag(e, layerId, mode, handle = null) {
  e.preventDefault();
  const layer = getLayerById(layerId);
  if (!layer) return;
  const pt = getStagePoint(e.clientX, e.clientY);
  canvasDrag = {
    mode,
    handle,
    layerId,
    startX: pt.x,
    startY: pt.y,
    orig: { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
  };
}

function onCanvasPointerMove(e) {
  if (!canvasDrag) return;
  const layer = getLayerById(canvasDrag.layerId);
  if (!layer) return;
  // Unclamped so layers can be dragged/resized partly off the stage.
  const pt = getStagePoint(e.clientX, e.clientY, { clampToStage: false });
  const dx = pt.x - canvasDrag.startX;
  const dy = pt.y - canvasDrag.startY;
  const o = canvasDrag.orig;

  if (canvasDrag.mode === "move") {
    layer.x = o.x + dx;
    layer.y = o.y + dy;
    clampLayerVisibility(layer);
  } else if (canvasDrag.mode === "resize") {
    const h = canvasDrag.handle;
    const lockAspect = (layer.type === "image" || layer.type === "video") && !e.shiftKey;
    const aspect = o.width / Math.max(0.01, o.height);
    const minSize = 5;
    const maxSize = 400;

    if (!lockAspect) {
      let x = o.x;
      let y = o.y;
      let width = o.width;
      let height = o.height;
      if (h.includes("e")) width = clamp(o.width + dx, minSize, maxSize);
      if (h.includes("s")) height = clamp(o.height + dy, minSize, maxSize);
      if (h.includes("w")) {
        width = clamp(o.width - dx, minSize, maxSize);
        x = o.x + o.width - width;
      }
      if (h.includes("n")) {
        height = clamp(o.height - dy, minSize, maxSize);
        y = o.y + o.height - height;
      }
      layer.x = x;
      layer.y = y;
      layer.width = Math.round(width * 10) / 10;
      layer.height = Math.round(height * 10) / 10;
      clampLayerVisibility(layer);
    } else {
      // Drive size from the dominant axis of the drag, then lock aspect.
      const useWidth = Math.abs(dx) >= Math.abs(dy) || h === "e" || h === "w"
        || ((h.includes("e") || h.includes("w")) && !(h.includes("n") || h.includes("s")));
      let width = o.width;
      let height = o.height;
      let x = o.x;
      let y = o.y;

      if (h.includes("e") && h.includes("s")) {
        width = clamp(o.width + dx, minSize, maxSize);
        height = width / aspect;
      } else if (h.includes("w") && h.includes("s")) {
        width = clamp(o.width - dx, minSize, maxSize);
        height = width / aspect;
        x = o.x + o.width - width;
      } else if (h.includes("e") && h.includes("n")) {
        width = clamp(o.width + dx, minSize, maxSize);
        height = width / aspect;
        y = o.y + o.height - height;
      } else if (h.includes("w") && h.includes("n")) {
        width = clamp(o.width - dx, minSize, maxSize);
        height = width / aspect;
        x = o.x + o.width - width;
        y = o.y + o.height - height;
      } else if (useWidth && h.includes("e")) {
        width = clamp(o.width + dx, minSize, maxSize);
        height = width / aspect;
      } else if (useWidth && h.includes("w")) {
        width = clamp(o.width - dx, minSize, maxSize);
        height = width / aspect;
        x = o.x + o.width - width;
      } else if (h.includes("s")) {
        height = clamp(o.height + dy, minSize, maxSize);
        width = height * aspect;
      } else if (h.includes("n")) {
        height = clamp(o.height - dy, minSize, maxSize);
        width = height * aspect;
        y = o.y + o.height - height;
      }

      layer.x = x;
      layer.y = y;
      layer.width = Math.round(width * 10) / 10;
      layer.height = Math.round(height * 10) / 10;
      clampLayerVisibility(layer);
    }
  }

  const el = document.querySelector(`[data-layer-id="${layer.id}"]`);
  if (el) applyLayerStyle(el, layer);
  syncPropInputs(layer);
}

function endCanvasDrag() {
  if (!canvasDrag) return;
  canvasDrag = null;
  scheduleSavePost();
}

function setBackgroundAsset(assetId, format = null) {
  if (!currentPost) return;
  const fmt = format || getTargetFormat();
  if (currentPost.type === "video") {
    const scene = getActiveScene();
    if (scene) {
      scene.background_asset_id = assetId;
      scene.background_format = fmt;
    }
  } else {
    currentPost.background_asset_id = assetId;
    currentPost.background_format = fmt;
  }
  scheduleSavePost();
  renderInteractiveCanvas();
}

// ---------- Poll ----------
let pollTimer = null;
function startProjectPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!currentProject) return;
    const before = new Map((currentProject.assets || []).map((a) => [a.id, a.status]));
    const hasProcessing = [...before.values()].some((s) => s === "processing" || s === "pending");
    // Asset-status only: never reload the open post (that wiped backgrounds).
    if (!hasProcessing) return;
    try {
      await refreshProject({ reloadPost: false });
      for (const a of currentProject.assets || []) {
        const prev = before.get(a.id);
        if (a.status === "failed" && prev && prev !== "failed") {
          toast(`Processing failed: ${a.name}${a.error ? ` — ${a.error}` : ""}`, "error");
        } else if (a.status === "ready" && (prev === "processing" || prev === "pending")) {
          const n = availableImageFormats(a).length;
          toast(`${a.name} ready${n ? ` (${n} formats)` : ""}`, "ok");
        }
      }
    } catch (_) {
      /* ignore transient poll errors */
    }
  }, 2000);
}
function stopProjectPoll() { clearInterval(pollTimer); }

// ---------- LLM Settings ----------
function setLlmProviderFieldsVisible(provider) {
  const ollama = $("ollamaFields");
  const proxy = $("proxyFields");
  if (ollama) ollama.classList.toggle("hidden", provider !== "ollama");
  if (proxy) proxy.classList.toggle("hidden", provider !== "proxy");
}

function setImageGenProviderFieldsVisible(provider) {
  const fields = $("imageGenFields");
  const gateway = $("imageGenGatewayFields");
  if (fields) fields.classList.toggle("hidden", provider === "off");
  if (gateway) gateway.classList.toggle("hidden", provider !== "proxy");
}

function setComfyuiProviderFieldsVisible(provider) {
  const fields = $("comfyuiFields");
  const apiKeyWrap = $("comfyuiApiKeyWrap");
  const gateway = $("comfyuiGatewayFields");
  if (fields) fields.classList.toggle("hidden", provider === "off");
  if (apiKeyWrap) apiKeyWrap.classList.toggle("hidden", provider !== "proxy");
  if (gateway) gateway.classList.toggle("hidden", provider !== "proxy");
}

async function loadLlmSettingsForm() {
  const [llmRes, storageRes, stockRes] = await Promise.all([
    fetch("/api/llm/settings"),
    fetch("/api/settings/storage"),
    fetch("/api/stock/settings"),
  ]);
  const data = await llmRes.json();
  if (!llmRes.ok) throw new Error(data.detail || `HTTP ${llmRes.status}`);
  const storage = await storageRes.json().catch(() => ({}));
  const stock = await stockRes.json().catch(() => ({}));

  if ($("settingsConfigPath")) {
    $("settingsConfigPath").textContent = storage.config_path || config.config_path || "config.yaml";
  }
  if ($("settingsProjectsDir")) {
    $("settingsProjectsDir").value = storage.projects_dir || "";
  }
  if ($("settingsScriptsDir")) {
    $("settingsScriptsDir").value = storage.scripts_dir || "";
  }
  if ($("settingsCacheDir")) {
    $("settingsCacheDir").value = storage.cache_dir || "";
  }
  if ($("settingsProjectsDirHint")) {
    $("settingsProjectsDirHint").textContent = storage.projects_dir_resolved
      ? `Resolved: ${storage.projects_dir_resolved}`
      : "";
  }
  if ($("settingsScriptsDirHint")) {
    $("settingsScriptsDirHint").textContent = storage.scripts_dir_resolved
      ? `Resolved: ${storage.scripts_dir_resolved}`
      : "";
  }

  const provider = data.provider || "ollama";
  const ollama = data.ollama || {};
  const proxy = data.proxy || {};

  const sel = $("llmProvider");
  if (sel) sel.value = provider;
  if ($("ollamaHost")) $("ollamaHost").value = ollama.host || "http://localhost:11434";
  if ($("ollamaModel")) $("ollamaModel").value = ollama.model || "gemma4:31b";
  if ($("ollamaTimeoutS")) $("ollamaTimeoutS").value = String(ollama.timeout_s ?? 60);

  if ($("proxyBaseUrl")) $("proxyBaseUrl").value = proxy.base_url || "https://api.portkey.ai/v1";
  if ($("proxyApiKey")) $("proxyApiKey").value = "";
  if ($("proxyModel")) $("proxyModel").value = proxy.model || "gpt-4o";
  if ($("proxyPortkeyProvider")) $("proxyPortkeyProvider").value = proxy.portkey_provider || "";
  if ($("proxyPortkeyVirtualKey")) $("proxyPortkeyVirtualKey").value = "";
  if ($("proxyTimeoutS")) $("proxyTimeoutS").value = String(proxy.timeout_s ?? 60);

  const apiHint = $("proxyApiKeyHint");
  if (apiHint) {
    apiHint.textContent = proxy.api_key_set
      ? `Current key: ${proxy.api_key_masked || "configured"}`
      : "No API key saved yet.";
  }
  const vkHint = $("proxyVirtualKeyHint");
  if (vkHint) {
    vkHint.textContent = proxy.portkey_virtual_key_set
      ? `Current virtual key: ${proxy.portkey_virtual_key_masked || "configured"}`
      : "";
  }

  setLlmProviderFieldsVisible(provider);

  const ig = data.image_gen || {};
  let igProvider = ig.provider || (ig.enabled ? "proxy" : "off");
  if ($("imageGenProvider")) $("imageGenProvider").value = igProvider;
  if ($("imageGenBaseUrl")) {
    $("imageGenBaseUrl").value = ig.base_url
      || (igProvider === "local" ? "http://127.0.0.1:8080/v1" : "https://api.portkey.ai/v1");
  }
  if ($("imageGenApiKey")) $("imageGenApiKey").value = "";
  if ($("imageGenModel")) $("imageGenModel").value = ig.model || "gpt-image-1";
  if ($("imageGenPortkeyProvider")) $("imageGenPortkeyProvider").value = ig.portkey_provider || "";
  if ($("imageGenPortkeyVirtualKey")) $("imageGenPortkeyVirtualKey").value = "";
  if ($("imageGenTimeoutS")) $("imageGenTimeoutS").value = String(ig.timeout_s ?? 120);
  const igHint = $("imageGenApiKeyHint");
  if (igHint) {
    igHint.textContent = ig.api_key_set
      ? `Current key: ${ig.api_key_masked || "configured"}`
      : (igProvider === "local" ? "API key optional for local servers." : "No API key saved yet.");
  }
  const igVkHint = $("imageGenVirtualKeyHint");
  if (igVkHint) {
    igVkHint.textContent = ig.portkey_virtual_key_set
      ? `Current virtual key: ${ig.portkey_virtual_key_masked || "configured"}`
      : "";
  }
  setImageGenProviderFieldsVisible(igProvider);

  const cu = data.comfyui || {};
  let cuProvider = cu.provider || (cu.enabled ? "local" : "off");
  if ($("comfyuiProvider")) $("comfyuiProvider").value = cuProvider;
  if ($("comfyuiBaseUrl")) $("comfyuiBaseUrl").value = cu.base_url || "http://127.0.0.1:8188";
  if ($("comfyuiApiKey")) $("comfyuiApiKey").value = "";
  if ($("comfyuiDiffusionModel")) $("comfyuiDiffusionModel").value = cu.diffusion_model || "wan2.1_t2v_1.3B_fp16.safetensors";
  if ($("comfyuiClipName")) $("comfyuiClipName").value = cu.clip_name || "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
  if ($("comfyuiVaeName")) $("comfyuiVaeName").value = cu.vae_name || "wan_2.1_vae.safetensors";
  if ($("comfyuiWorkflowPath")) $("comfyuiWorkflowPath").value = cu.workflow_path || "";
  if ($("comfyuiWidth")) $("comfyuiWidth").value = String(cu.width ?? 832);
  if ($("comfyuiHeight")) $("comfyuiHeight").value = String(cu.height ?? 480);
  if ($("comfyuiFrames")) $("comfyuiFrames").value = String(cu.frames ?? 33);
  if ($("comfyuiFps")) $("comfyuiFps").value = String(cu.fps ?? 16);
  if ($("comfyuiSteps")) $("comfyuiSteps").value = String(cu.steps ?? 30);
  if ($("comfyuiCfg")) $("comfyuiCfg").value = String(cu.cfg ?? 6);
  if ($("comfyuiTimeoutS")) $("comfyuiTimeoutS").value = String(cu.timeout_s ?? 900);
  if ($("comfyuiNegativePrompt")) $("comfyuiNegativePrompt").value = cu.negative_prompt || "";
  if ($("comfyuiGatewayBaseUrl")) $("comfyuiGatewayBaseUrl").value = cu.gateway_base_url || "";
  if ($("comfyuiGatewayApiKey")) $("comfyuiGatewayApiKey").value = "";
  if ($("comfyuiGatewayModel")) $("comfyuiGatewayModel").value = cu.gateway_model || "";
  if ($("comfyuiPortkeyProvider")) $("comfyuiPortkeyProvider").value = cu.portkey_provider || "";
  if ($("comfyuiGatewayTimeoutS")) $("comfyuiGatewayTimeoutS").value = String(cu.gateway_timeout_s ?? 600);
  const cuKeyHint = $("comfyuiApiKeyHint");
  if (cuKeyHint) {
    cuKeyHint.textContent = cu.api_key_set
      ? `Current key: ${cu.api_key_masked || "configured"}`
      : "";
  }
  const cuGwHint = $("comfyuiGatewayApiKeyHint");
  if (cuGwHint) {
    cuGwHint.textContent = cu.gateway_api_key_set
      ? `Current key: ${cu.gateway_api_key_masked || "configured"}`
      : "";
  }
  const cuTest = $("comfyuiTestStatus");
  if (cuTest) cuTest.textContent = cu.ready ? "Configured" : "";
  setComfyuiProviderFieldsVisible(cuProvider);

  if ($("stockPixabayApiKey")) $("stockPixabayApiKey").value = "";
  const stockHint = $("stockPixabayApiKeyHint");
  if (stockHint) {
    stockHint.textContent = stock.pixabay_api_key_set
      ? `Current key: ${stock.pixabay_api_key_masked || "configured"}`
      : "No Pixabay key saved — videos unavailable on Free assets.";
  }
  const dailyLimitEl = $("stockDailyDownloadLimit");
  if (dailyLimitEl) {
    dailyLimitEl.value = String(
      stock.daily_download_limit != null ? stock.daily_download_limit : 20,
    );
  }
  const dailyHint = $("stockDailyDownloadLimitHint");
  if (dailyHint) {
    const lim = Number(stock.daily_download_limit ?? 20);
    const used = stock.downloads_used_today ?? 0;
    if (lim <= 0) {
      dailyHint.textContent = `Unlimited. Used today: ${used}.`;
    } else {
      const rem = stock.downloads_remaining_today;
      dailyHint.textContent =
        rem == null
          ? `Used today: ${used}/${lim}.`
          : `Used today: ${used}/${lim} · ${rem} remaining. 0 = unlimited.`;
    }
  }
  stockUploadSitesState = Array.isArray(stock.upload_sites)
    ? stock.upload_sites.map((s) => ({ ...s }))
    : [];
  stockProviderPresets = stock.provider_presets || {};
  renderStockUploadSitesEditor();

  const resultEl = $("llmTestResult");
  if (resultEl) resultEl.textContent = "";
  const statusEl = $("llmTestStatus");
  if (statusEl) statusEl.textContent = "";
}

// ---------- Stock upload destinations (Settings) ----------
/** @type {any[]} */
let stockUploadSitesState = [];
/** @type {Record<string, any>} */
let stockProviderPresets = {};

function newStockUploadSiteId() {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 6);
}

function stockProviderOptionsHtml(selected) {
  const keys = Object.keys(stockProviderPresets).length
    ? Object.keys(stockProviderPresets)
    : ["shutterstock_ftps", "adobe_stock_sftp", "generic_ftps", "generic_sftp", "webhook", "package"];
  return keys.map((k) => {
    const label = stockProviderPresets[k]?.label || k;
    return `<option value="${k}" ${k === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
}

function renderStockUploadSitesEditor() {
  const list = $("stockUploadSitesList");
  const empty = $("stockUploadSitesEmpty");
  if (!list) return;
  if (!stockUploadSitesState.length) {
    list.innerHTML = "";
    empty?.classList.remove("hidden");
    return;
  }
  empty?.classList.add("hidden");
  list.innerHTML = stockUploadSitesState.map((site, idx) => {
    const transport = stockProviderPresets[site.provider]?.transport || "";
    const showHost = transport === "ftps" || transport === "sftp";
    const showWebhook = transport === "webhook";
    const showKey = transport === "sftp";
    const pwHint = site.password_set ? `Saved: ${site.password_masked || "••••"}` : "No password saved";
    const tokHint = site.webhook_token_set ? `Saved: ${site.webhook_token_masked || "••••"}` : "No token saved";
    return `<div class="rounded-xl border border-white/10 bg-black/25 p-3 space-y-2" data-stock-site-idx="${idx}">
      <div class="flex items-center gap-2 flex-wrap">
        <input type="text" data-field="name" value="${escapeHtml(site.name || "")}" placeholder="Site name" class="flex-1 min-w-[8rem] text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-slate-100" />
        <select data-field="provider" class="text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5 text-slate-200">${stockProviderOptionsHtml(site.provider || "package")}</select>
        <label class="flex items-center gap-1.5 text-[11px] text-slate-400"><input type="checkbox" data-field="enabled" ${site.enabled !== false ? "checked" : ""} /> Enabled</label>
        <button type="button" data-stock-test class="text-[10px] px-2 py-1 rounded border border-white/10 text-slate-400 hover:text-white">Test</button>
        <button type="button" data-stock-remove class="text-[10px] px-2 py-1 rounded border border-red-400/30 text-red-300 hover:bg-red-500/10">Remove</button>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 ${showHost ? "" : "hidden"}" data-stock-host-fields>
        <div>
          <label class="text-[10px] uppercase tracking-wider text-slate-500">Host</label>
          <input type="text" data-field="host" value="${escapeHtml(site.host || "")}" class="w-full mt-0.5 text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5" />
        </div>
        <div>
          <label class="text-[10px] uppercase tracking-wider text-slate-500">Port</label>
          <input type="number" data-field="port" value="${site.port != null ? escapeHtml(String(site.port)) : ""}" class="w-full mt-0.5 text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5" />
        </div>
        <div>
          <label class="text-[10px] uppercase tracking-wider text-slate-500">Username</label>
          <input type="text" data-field="username" value="${escapeHtml(site.username || "")}" autocomplete="off" class="w-full mt-0.5 text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5" />
        </div>
        <div>
          <label class="text-[10px] uppercase tracking-wider text-slate-500">Password</label>
          <input type="password" data-field="password" value="" placeholder="Leave blank to keep" autocomplete="new-password" class="w-full mt-0.5 text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5" />
          <p class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(pwHint)}</p>
        </div>
        <div class="sm:col-span-2">
          <label class="text-[10px] uppercase tracking-wider text-slate-500">Remote path</label>
          <input type="text" data-field="remote_path" value="${escapeHtml(site.remote_path || "/")}" class="w-full mt-0.5 text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5" />
        </div>
        <div class="sm:col-span-2 ${showKey ? "" : "hidden"}" data-stock-key-field>
          <label class="text-[10px] uppercase tracking-wider text-slate-500">Private key path (SFTP)</label>
          <input type="text" data-field="private_key_path" value="${escapeHtml(site.private_key_path || "")}" placeholder="/Users/you/.ssh/id_rsa" class="w-full mt-0.5 text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5" />
        </div>
      </div>
      <div class="grid grid-cols-1 gap-2 ${showWebhook ? "" : "hidden"}" data-stock-webhook-fields>
        <div>
          <label class="text-[10px] uppercase tracking-wider text-slate-500">Webhook URL</label>
          <input type="url" data-field="webhook_url" value="${escapeHtml(site.webhook_url || "")}" class="w-full mt-0.5 text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5" />
        </div>
        <div>
          <label class="text-[10px] uppercase tracking-wider text-slate-500">Webhook bearer token</label>
          <input type="password" data-field="webhook_token" value="" placeholder="Leave blank to keep" autocomplete="new-password" class="w-full mt-0.5 text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5" />
          <p class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(tokHint)}</p>
        </div>
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-wider text-slate-500">Contributor portal URL</label>
        <input type="url" data-field="portal_url" value="${escapeHtml(site.portal_url || "")}" class="w-full mt-0.5 text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5" />
      </div>
      <div>
        <label class="text-[10px] uppercase tracking-wider text-slate-500">Notes</label>
        <input type="text" data-field="notes" value="${escapeHtml(site.notes || "")}" class="w-full mt-0.5 text-xs rounded-lg bg-black/30 border border-white/10 px-2 py-1.5" />
      </div>
      <p class="text-[10px] text-slate-500" data-stock-test-status></p>
    </div>`;
  }).join("");

  list.querySelectorAll("[data-stock-site-idx]").forEach((card) => {
    const idx = Number(card.dataset.stockSiteIdx);
    card.querySelectorAll("[data-field]").forEach((el) => {
      const sync = () => {
        const field = el.dataset.field;
        if (!stockUploadSitesState[idx] || !field) return;
        if (el.type === "checkbox") stockUploadSitesState[idx][field] = el.checked;
        else if (field === "port") {
          const n = parseInt(el.value, 10);
          stockUploadSitesState[idx].port = Number.isFinite(n) ? n : null;
        } else if (field === "password" || field === "webhook_token") {
          if (el.value) stockUploadSitesState[idx][field] = el.value;
        } else {
          stockUploadSitesState[idx][field] = el.value;
        }
        if (field === "provider") {
          const preset = stockProviderPresets[el.value] || {};
          if (preset.host && !stockUploadSitesState[idx].host) stockUploadSitesState[idx].host = preset.host;
          if (preset.port != null && stockUploadSitesState[idx].port == null) {
            stockUploadSitesState[idx].port = preset.port;
          }
          if (preset.portal_url && !stockUploadSitesState[idx].portal_url) {
            stockUploadSitesState[idx].portal_url = preset.portal_url;
          }
          renderStockUploadSitesEditor();
        }
      };
      el.addEventListener("change", sync);
      el.addEventListener("input", sync);
    });
    card.querySelector("[data-stock-remove]")?.addEventListener("click", () => {
      stockUploadSitesState.splice(idx, 1);
      renderStockUploadSitesEditor();
    });
    card.querySelector("[data-stock-test]")?.addEventListener("click", async () => {
      const status = card.querySelector("[data-stock-test-status]");
      if (status) status.textContent = "Testing…";
      try {
        const site = { ...stockUploadSitesState[idx] };
        const data = await api("/api/stock/upload-sites/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ site }),
        });
        if (status) {
          status.textContent = data.ok ? `OK — ${data.detail || ""}` : `Failed — ${data.detail || ""}`;
        }
        toast(data.ok ? "Connection OK" : (data.detail || "Test failed"), data.ok ? "ok" : "error");
      } catch (e) {
        if (status) status.textContent = e.message || "Test failed";
        toast(e.message || "Test failed", "error");
      }
    });
  });
}

function collectStockUploadSitesFromForm() {
  return stockUploadSitesState.map((s) => {
    const out = {
      id: s.id,
      name: s.name,
      provider: s.provider,
      enabled: s.enabled !== false,
      host: s.host || "",
      port: s.port,
      username: s.username || "",
      remote_path: s.remote_path || "/",
      private_key_path: s.private_key_path || "",
      webhook_url: s.webhook_url || "",
      portal_url: s.portal_url || "",
      notes: s.notes || "",
    };
    if (s.password) out.password = s.password;
    if (s.webhook_token) out.webhook_token = s.webhook_token;
    return out;
  });
}

function addStockUploadSite() {
  const preset = stockProviderPresets.shutterstock_ftps || {};
  stockUploadSitesState.push({
    id: newStockUploadSiteId(),
    name: "Shutterstock",
    provider: "shutterstock_ftps",
    enabled: true,
    host: preset.host || "ftps.shutterstock.com",
    port: preset.port ?? 21,
    username: "",
    remote_path: "/",
    private_key_path: "",
    webhook_url: "",
    portal_url: preset.portal_url || "https://submit.shutterstock.com/",
    notes: "",
    password_set: false,
    webhook_token_set: false,
  });
  renderStockUploadSitesEditor();
}

async function testLlmSettings() {
  const btn = $("llmTestBtn");
  const status = $("llmTestStatus");
  const resultEl = $("llmTestResult");
  if (btn) { btn.disabled = true; btn.textContent = "Testing…"; }
  if (status) status.textContent = "";

  try {
    const r = await fetch("/api/llm/settings/test", { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (resultEl) resultEl.textContent = JSON.stringify(data, null, 2);
    if (!r.ok || !data.ok) toast("LLM test failed", "error");
    else toast("LLM settings OK", "ok");
  } catch (e) {
    if (resultEl) resultEl.textContent = String(e.message || e);
    toast(`LLM test error: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Test connection"; }
  }
}

async function saveLlmSettings() {
  const provider = $("llmProvider")?.value || "ollama";
  const payload = { provider };
  if (provider === "ollama") {
    payload.ollama_host = $("ollamaHost")?.value?.trim() || "http://localhost:11434";
    payload.ollama_model = $("ollamaModel")?.value?.trim() || "gemma4:31b";
    const t = parseInt($("ollamaTimeoutS")?.value || "60", 10);
    payload.ollama_timeout_s = Number.isFinite(t) ? t : 60;
  }
  if (provider === "proxy") {
    payload.proxy_base_url = $("proxyBaseUrl")?.value?.trim() || "https://api.portkey.ai/v1";
    payload.proxy_model = $("proxyModel")?.value?.trim() || "gpt-4o";
    const apiKey = $("proxyApiKey")?.value?.trim();
    if (apiKey) payload.proxy_api_key = apiKey;
    const vk = $("proxyPortkeyVirtualKey")?.value?.trim();
    if (vk) payload.proxy_portkey_virtual_key = vk;
    payload.proxy_portkey_provider = $("proxyPortkeyProvider")?.value?.trim() || "";
    const pt = parseInt($("proxyTimeoutS")?.value || "60", 10);
    payload.proxy_timeout_s = Number.isFinite(pt) ? pt : 60;
  }

  const storagePayload = {
    projects_dir: $("settingsProjectsDir")?.value?.trim() || undefined,
    scripts_dir: $("settingsScriptsDir")?.value?.trim() || undefined,
    cache_dir: $("settingsCacheDir")?.value?.trim() || undefined,
  };

  payload.image_gen_provider = $("imageGenProvider")?.value || "off";
  payload.image_gen_base_url = $("imageGenBaseUrl")?.value?.trim()
    || (payload.image_gen_provider === "local" ? "http://127.0.0.1:8080/v1" : "https://api.portkey.ai/v1");
  payload.image_gen_model = $("imageGenModel")?.value?.trim() || "gpt-image-1";
  payload.image_gen_portkey_provider = $("imageGenPortkeyProvider")?.value?.trim() || "";
  const igTimeout = parseInt($("imageGenTimeoutS")?.value || "120", 10);
  payload.image_gen_timeout_s = Number.isFinite(igTimeout) ? igTimeout : 120;
  const igKey = $("imageGenApiKey")?.value?.trim();
  if (igKey) payload.image_gen_api_key = igKey;
  const igVk = $("imageGenPortkeyVirtualKey")?.value?.trim();
  if (igVk) payload.image_gen_portkey_virtual_key = igVk;

  payload.comfyui_provider = $("comfyuiProvider")?.value || "off";
  payload.comfyui_base_url = $("comfyuiBaseUrl")?.value?.trim() || "http://127.0.0.1:8188";
  payload.comfyui_diffusion_model = $("comfyuiDiffusionModel")?.value?.trim() || "wan2.1_t2v_1.3B_fp16.safetensors";
  payload.comfyui_clip_name = $("comfyuiClipName")?.value?.trim() || "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
  payload.comfyui_vae_name = $("comfyuiVaeName")?.value?.trim() || "wan_2.1_vae.safetensors";
  payload.comfyui_workflow_path = $("comfyuiWorkflowPath")?.value?.trim() || "";
  const cuApiKey = $("comfyuiApiKey")?.value?.trim();
  if (cuApiKey) payload.comfyui_api_key = cuApiKey;
  payload.comfyui_gateway_base_url = $("comfyuiGatewayBaseUrl")?.value?.trim() || "";
  payload.comfyui_gateway_model = $("comfyuiGatewayModel")?.value?.trim() || "";
  payload.comfyui_portkey_provider = $("comfyuiPortkeyProvider")?.value?.trim() || "";
  const cuGwKey = $("comfyuiGatewayApiKey")?.value?.trim();
  if (cuGwKey) payload.comfyui_gateway_api_key = cuGwKey;
  const cuGwTimeout = parseInt($("comfyuiGatewayTimeoutS")?.value || "600", 10);
  payload.comfyui_gateway_timeout_s = Number.isFinite(cuGwTimeout) ? cuGwTimeout : 600;
  const cuWidth = parseInt($("comfyuiWidth")?.value || "832", 10);
  const cuHeight = parseInt($("comfyuiHeight")?.value || "480", 10);
  const cuFrames = parseInt($("comfyuiFrames")?.value || "33", 10);
  const cuFps = parseFloat($("comfyuiFps")?.value || "16");
  const cuSteps = parseInt($("comfyuiSteps")?.value || "30", 10);
  const cuCfg = parseFloat($("comfyuiCfg")?.value || "6");
  const cuTimeout = parseInt($("comfyuiTimeoutS")?.value || "900", 10);
  payload.comfyui_width = Number.isFinite(cuWidth) ? cuWidth : 832;
  payload.comfyui_height = Number.isFinite(cuHeight) ? cuHeight : 480;
  payload.comfyui_frames = Number.isFinite(cuFrames) ? cuFrames : 33;
  payload.comfyui_fps = Number.isFinite(cuFps) ? cuFps : 16;
  payload.comfyui_steps = Number.isFinite(cuSteps) ? cuSteps : 30;
  payload.comfyui_cfg = Number.isFinite(cuCfg) ? cuCfg : 6;
  payload.comfyui_timeout_s = Number.isFinite(cuTimeout) ? cuTimeout : 900;
  payload.comfyui_negative_prompt = $("comfyuiNegativePrompt")?.value ?? "";

  const btn = $("llmSaveBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const storageR = await fetch("/api/settings/storage", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(storagePayload),
    });
    const storageData = await storageR.json().catch(() => ({}));
    if (!storageR.ok) throw new Error(storageData.detail || `Storage save failed (HTTP ${storageR.status})`);

    const r = await fetch("/api/llm/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);

    const pixabayKey = $("stockPixabayApiKey")?.value?.trim();
    const stockPayload = {
      upload_sites: collectStockUploadSitesFromForm(),
    };
    if (pixabayKey) stockPayload.pixabay_api_key = pixabayKey;
    const dailyRaw = $("stockDailyDownloadLimit")?.value;
    if (dailyRaw !== undefined && dailyRaw !== "") {
      const dailyLimit = parseInt(dailyRaw, 10);
      if (Number.isFinite(dailyLimit) && dailyLimit >= 0) {
        stockPayload.daily_download_limit = dailyLimit;
      }
    }
    const stockR = await fetch("/api/stock/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stockPayload),
    });
    const stockData = await stockR.json().catch(() => ({}));
    if (!stockR.ok) throw new Error(stockData.detail || `Stock settings save failed (HTTP ${stockR.status})`);

    toast("Settings saved to config.yaml", "ok");
    await loadConfig();
    await loadLlmSettingsForm();
    await refreshAiCapabilities();
    if (!$("freeAssetsDialog")?.classList.contains("hidden")) await loadFreeAssetsCapabilities();
    if (currentProject) await refreshProject({ reloadPost: false });
    else await loadProjects();
    $("llmDialog")?.classList.add("hidden");
  } catch (e) {
    toast(`Save failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save"; }
  }
}

async function testComfyuiSettings() {
  const btn = $("comfyuiTestBtn");
  const status = $("comfyuiTestStatus");
  if (btn) { btn.disabled = true; btn.textContent = "Testing…"; }
  if (status) status.textContent = "";
  try {
    // Persist first so Test hits the values currently shown (or already saved).
    // Soft: if not saved yet, server uses last saved config.
    const r = await fetch("/api/comfyui/settings/test", { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      const detail = data.detail || `HTTP ${r.status}`;
      if (status) status.textContent = String(detail).slice(0, 120);
      toast(`ComfyUI test failed: ${detail}`, "error");
      return;
    }
    if (status) status.textContent = `OK · ${data.base_url || ""}`;
    toast("ComfyUI reachable", "ok");
  } catch (e) {
    if (status) status.textContent = String(e.message || e);
    toast(`ComfyUI test error: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Test ComfyUI"; }
  }
}

async function openLlmDialog() {
  try {
    await loadLlmSettingsForm();
    syncThemeChrome(currentTheme());
    $("llmDialog")?.classList.remove("hidden");
  } catch (e) {
    toast(`Could not load settings: ${e.message}`, "error");
  }
}

// ---------- Editor AI assistant ----------
let aiCapabilities = { vision_llm: false, image_gen: false, video_gen: false };
let aiProposedPost = null;
let aiActiveTab = "chat";

function detailMessage(data, fallback) {
  const d = data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((x) => x.msg || JSON.stringify(x)).join("; ");
  return fallback;
}

async function refreshAiCapabilities() {
  try {
    const r = await fetch("/api/ai/capabilities");
    aiCapabilities = await r.json();
  } catch {
    aiCapabilities = { vision_llm: false, image_gen: false, video_gen: false };
  }
  const genHint = $("aiPhotoGenHint");
  const genCb = $("aiPhotoGenerative");
  if (genHint) genHint.classList.toggle("hidden", !!aiCapabilities.image_gen);
  if (genCb && !aiCapabilities.image_gen) {
    genCb.checked = false;
    genCb.disabled = true;
  } else if (genCb) {
    genCb.disabled = false;
  }
  syncProjectVideoGenPanel();
  syncScriptGeneratorLlmStatus();
}

// ---------- Script Generator ----------
const SG_HISTORY_MAX = 50;

let sgState = {
  activeId: null, // script currently open in the editor
  postActiveScriptId: null, // post.active_script_id (only one active per post)
  title: "Untitled script",
  summary: "",
  script: "",
  chat: [], // { role, content }
  brief: {
    topic: "",
    platform: "instagram_reel",
    format: "talking_head",
    tone: "conversational",
    length: "medium",
    audience: "",
    language: "English",
    notes: "",
  },
  history: [], // summaries from /api/projects/{id}/posts/{post}/scripts
  projectId: null,
  postId: null,
};
let sgHydrated = false;
let sgSaveTimer = null;
let sgSaveInFlight = null;
let sgSideTab = "brief"; // "brief" | "history"

function sgDefaultBrief() {
  return {
    topic: "",
    platform: "instagram_reel",
    format: "talking_head",
    tone: "conversational",
    length: "medium",
    audience: "",
    language: "English",
    notes: "",
  };
}

function sgDefaultState() {
  return {
    activeId: null,
    postActiveScriptId: null,
    title: "Untitled script",
    summary: "",
    script: "",
    chat: [],
    brief: sgDefaultBrief(),
    history: [],
    projectId: null,
    postId: null,
  };
}

function requireCurrentProjectId(action = "continue") {
  const id = currentProject?.id;
  if (!id) throw new Error(`Select a project first to ${action}`);
  return id;
}

function requireCurrentPostId(action = "continue") {
  const id = currentPost?.id || sgState.postId;
  if (!id) throw new Error(`Open a post first to ${action}`);
  return id;
}

function postScriptsUrl(suffix = "") {
  const pid = requireCurrentProjectId("use scripts");
  const postId = requireCurrentPostId("use scripts");
  return `/api/projects/${encodeURIComponent(pid)}/posts/${encodeURIComponent(postId)}/scripts${suffix}`;
}

function projectMediaFoldersUrl(suffix = "") {
  const pid = requireCurrentProjectId("manage media folders");
  return `/api/projects/${encodeURIComponent(pid)}/media/folders${suffix}`;
}

function resetFeatureStateForProjectChange() {
  clearTimeout(sgSaveTimer);
  sgSaveTimer = null;
  sgSaveInFlight = null;
  sgState = sgDefaultState();
  sgHydrated = false;
  mmFolders = [];
  mmActiveFolderId = null;
  mmFiles = [];
  mmSelectedPaths = new Set();
  veState.projectId = null;
  veState.sourceId = null;
  veState.focusPostId = null;
  veState.duration = 0;
  veState.start = 0;
  veState.end = 0;
  closeVideoEditorModal({ silent: true });
  closeScriptGeneratorModal({ silent: true });
}

function applyScriptDocToState(doc) {
  if (!doc) return;
  sgState.activeId = doc.id || null;
  sgState.title = doc.title || "Untitled script";
  sgState.summary = doc.summary || "";
  sgState.script = doc.script || "";
  sgState.chat = Array.isArray(doc.chat) ? doc.chat.slice(-40) : [];
  sgState.brief = { ...sgDefaultBrief(), ...(doc.brief || {}) };
}

function sgPayloadFromState(source = "edited") {
  readScriptGeneratorBriefFromForm();
  const script = ($("sgScriptText")?.value ?? sgState.script ?? "").trim();
  if (!script) return null;
  sgState.script = $("sgScriptText")?.value ?? sgState.script;
  return {
    title: (sgState.title || "").trim() || "Untitled script",
    summary: sgState.summary || "",
    script: sgState.script,
    chat: (sgState.chat || []).slice(-40),
    brief: { ...(sgState.brief || sgDefaultBrief()) },
    source,
  };
}

async function loadScriptHistoryFromServer() {
  const data = await api(postScriptsUrl());
  sgState.history = (data.scripts || []).slice(0, SG_HISTORY_MAX);
  sgState.projectId = currentProject?.id || null;
  sgState.postId = currentPost?.id || sgState.postId;
  sgState.postActiveScriptId = data.active_script_id || null;
  if (data.post && currentPost?.id === data.post.id) {
    currentPost = { ...currentPost, ...data.post };
  }
  renderScriptGeneratorHistory();
  syncScriptActiveUi();
  return sgState.history;
}

async function upsertActiveScriptHistory(source = "edited", { activate = false } = {}) {
  const payload = sgPayloadFromState(source);
  if (!payload) return null;
  if (activate) payload.activate = true;
  if (sgSaveInFlight) {
    try { await sgSaveInFlight; } catch (_) { /* continue */ }
  }
  const run = (async () => {
    if (sgState.activeId) {
      const data = await api(postScriptsUrl(`/${encodeURIComponent(sgState.activeId)}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      applyScriptDocToState(data.script);
      if (data.active_script_id !== undefined) sgState.postActiveScriptId = data.active_script_id;
      if (data.post && currentPost?.id === data.post.id) currentPost = { ...currentPost, ...data.post };
    } else {
      const data = await api(postScriptsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(activate ? { ...payload, activate: true } : payload),
      });
      applyScriptDocToState(data.script);
      if (data.active_script_id !== undefined) sgState.postActiveScriptId = data.active_script_id;
      if (data.post && currentPost?.id === data.post.id) currentPost = { ...currentPost, ...data.post };
    }
    await loadScriptHistoryFromServer();
    return sgState.activeId;
  })();
  sgSaveInFlight = run;
  try {
    return await run;
  } finally {
    if (sgSaveInFlight === run) sgSaveInFlight = null;
  }
}

function schedulePersistScriptGenerator() {
  clearTimeout(sgSaveTimer);
  sgSaveTimer = setTimeout(() => {
    upsertActiveScriptHistory("edited").catch((e) => {
      toast(`Save failed: ${e.message}`, "error");
    });
  }, 600);
}

function sgSourceLabel(source) {
  if (source === "generated") return "Generated";
  if (source === "refined") return "Chat refined";
  if (source === "manual") return "Manual";
  return "Edited";
}

function setSgSideTab(tab) {
  sgSideTab = tab === "history" ? "history" : "brief";
  document.querySelectorAll(".sg-side-tab").forEach((btn) => {
    const active = btn.dataset.sgSide === sgSideTab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  $("sgPaneBrief")?.classList.toggle("hidden", sgSideTab !== "brief");
  $("sgPaneHistory")?.classList.toggle("hidden", sgSideTab !== "history");
  const hint = $("sgSideHint");
  if (hint) {
    hint.textContent = sgSideTab === "history"
      ? "Open a draft or set which script is active for this post"
      : "Topic and constraints for the first draft";
  }
  if (sgSideTab === "history") renderScriptGeneratorHistory();
}

function syncScriptActiveUi() {
  const isPostActive = !!(sgState.activeId && sgState.activeId === sgState.postActiveScriptId);
  $("sgActiveBadge")?.classList.toggle("hidden", !isPostActive);
  const actBtn = $("sgActivateBtn");
  if (actBtn) {
    actBtn.classList.toggle("hidden", !sgState.activeId || isPostActive);
  }
  const badge = $("sgPostBadge");
  if (badge) {
    const postName = currentPost?.name || "Post";
    const activeEntry = (sgState.history || []).find((h) => h.id === sgState.postActiveScriptId);
    badge.textContent = activeEntry
      ? `${postName} · active: ${activeEntry.title || "Untitled script"}`
      : `${postName} · no active script yet`;
  }
}

function renderScriptGeneratorHistory() {
  const list = $("sgHistoryList");
  const countEl = $("sgHistoryCount");
  const items = sgState.history || [];
  if (countEl) countEl.textContent = items.length ? `(${items.length})` : "";
  if (!list) return;
  if (!items.length) {
    list.innerHTML = `<p class="text-[11px] text-slate-500 text-center py-8">No scripts for this post yet. Generate or edit a script to save it here.</p>`;
    return;
  }
  list.innerHTML = items.map((item) => {
    const editing = item.id === sgState.activeId;
    const isActive = item.id === sgState.postActiveScriptId || item.active;
    const when = item.updatedAt ? fmtTime(item.updatedAt) : "";
    const words = item.word_count != null ? item.word_count : countWords(item.script || item.preview || "");
    return `
      <article class="sg-history-item${editing ? " is-active" : ""}" data-sg-history-id="${escapeHtml(item.id)}">
        <div class="sg-history-item-title">${escapeHtml(item.title || "Untitled script")}${isActive ? ' <span class="text-emerald-300/90">· Active</span>' : ""}</div>
        <div class="sg-history-item-meta">
          <span>${escapeHtml(sgSourceLabel(item.source))}</span>
          <span>${words} words</span>
          ${when ? `<span>${escapeHtml(when)}</span>` : ""}
        </div>
        <div class="sg-history-item-preview">${escapeHtml(item.preview || "")}</div>
        <div class="sg-history-item-actions">
          <button type="button" class="text-[10px] px-2 py-1 rounded-md bg-indigo-500/15 border border-indigo-400/30 text-indigo-100" data-sg-history-open="${escapeHtml(item.id)}">${editing ? "Editing" : "Open"}</button>
          <button type="button" class="text-[10px] px-2 py-1 rounded-md border ${isActive ? "border-emerald-400/40 text-emerald-200" : "border-white/10 text-slate-300 hover:text-emerald-200"}" data-sg-history-activate="${escapeHtml(item.id)}" ${isActive ? "disabled" : ""}>${isActive ? "Active" : "Set active"}</button>
          <button type="button" class="text-[10px] px-2 py-1 rounded-md border border-white/10 text-slate-400 hover:text-red-200" data-sg-history-delete="${escapeHtml(item.id)}">Delete</button>
        </div>
      </article>`;
  }).join("");
}

function syncScriptGeneratorLlmStatus() {
  const el = $("sgLlmStatus");
  if (!el) return;
  const ready = !!(aiCapabilities?.script_generate ?? aiCapabilities?.vision_llm);
  const model = aiCapabilities?.model ? ` · ${aiCapabilities.model}` : "";
  el.textContent = ready
    ? `LLM ready${model}`
    : "LLM offline — enable Ollama or proxy in Settings";
  el.className = "text-[10px] " + (ready ? "text-emerald-400/90" : "text-amber-300/90");
}

function countWords(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

function syncScriptGeneratorMeta() {
  if ($("sgTitle")) $("sgTitle").textContent = sgState.title || "Untitled script";
  if ($("sgBriefSummary")) $("sgBriefSummary").textContent = sgState.summary || "";
  if ($("sgWordCount")) $("sgWordCount").textContent = `${countWords(sgState.script)} words`;
  const meta = $("sgMeta");
  if (meta) {
    meta.textContent = sgState.summary
      ? sgState.summary
      : "Edit freely — chat refinements replace this draft";
  }
}

function renderScriptGeneratorChat() {
  const thread = $("sgChatThread");
  if (!thread) return;
  if (!sgState.chat.length) {
    thread.innerHTML = `<p class="text-[11px] text-slate-500 text-center py-6">No chat yet. Generate a script, then ask for changes.</p>`;
    return;
  }
  thread.innerHTML = sgState.chat.map((m) => {
    const role = m.role === "user" ? "user" : "assistant";
    return `<div class="sg-chat-bubble ${role}">${escapeHtml(m.content)}</div>`;
  }).join("");
  thread.scrollTop = thread.scrollHeight;
}

function readScriptGeneratorBriefFromForm() {
  sgState.brief = {
    topic: $("sgTopic")?.value || "",
    platform: $("sgPlatform")?.value || "instagram_reel",
    format: $("sgFormat")?.value || "talking_head",
    tone: $("sgTone")?.value || "conversational",
    length: $("sgLength")?.value || "medium",
    audience: $("sgAudience")?.value || "",
    language: $("sgLanguage")?.value || "English",
    notes: $("sgNotes")?.value || "",
  };
}

function writeScriptGeneratorBriefToForm() {
  const b = sgState.brief || {};
  if ($("sgTopic")) $("sgTopic").value = b.topic || "";
  if ($("sgPlatform")) $("sgPlatform").value = b.platform || "instagram_reel";
  if ($("sgFormat")) $("sgFormat").value = b.format || "talking_head";
  if ($("sgTone")) $("sgTone").value = b.tone || "conversational";
  if ($("sgLength")) $("sgLength").value = b.length || "medium";
  if ($("sgAudience")) $("sgAudience").value = b.audience || "";
  if ($("sgLanguage")) $("sgLanguage").value = b.language || "English";
  if ($("sgNotes")) $("sgNotes").value = b.notes || "";
}

function hydrateScriptGeneratorUi() {
  writeScriptGeneratorBriefToForm();
  if ($("sgScriptText")) $("sgScriptText").value = sgState.script || "";
  syncScriptGeneratorMeta();
  renderScriptGeneratorChat();
  renderScriptGeneratorHistory();
  syncScriptGeneratorLlmStatus();
  syncScriptActiveUi();
  setSgSideTab(sgSideTab);
}

function isScriptGeneratorModalOpen() {
  const dlg = $("scriptGeneratorDialog");
  return !!(dlg && !dlg.classList.contains("hidden"));
}

function closeScriptGeneratorModal({ silent = false } = {}) {
  clearTimeout(sgSaveTimer);
  sgSaveTimer = null;
  if (!silent && ($("sgScriptText")?.value || sgState.script || "").trim()) {
    upsertActiveScriptHistory("edited").catch(() => { /* ignore */ });
  }
  $("scriptGeneratorDialog")?.classList.add("hidden");
}

async function openScriptGeneratorModal() {
  if (!currentProject?.id) {
    toast("Open a project first", "info");
    return;
  }
  if (!currentPost?.id) {
    toast("Open a post to manage its scripts", "info");
    return;
  }
  $("scriptGeneratorDialog")?.classList.remove("hidden");
  await onScriptGeneratorShown();
}

async function onScriptGeneratorShown() {
  if (!currentProject?.id || !currentPost?.id) return;
  clearTimeout(sgSaveTimer);
  sgSaveTimer = null;
  const sameContext = sgState.projectId === currentProject.id && sgState.postId === currentPost.id;
  const history = sameContext ? (sgState.history || []) : [];
  const keepOpenId = sameContext ? sgState.activeId : null;
  sgState = {
    ...sgDefaultState(),
    history,
    projectId: currentProject.id,
    postId: currentPost.id,
    postActiveScriptId: currentPost.active_script_id || null,
    activeId: keepOpenId,
  };
  sgHydrated = true;
  sgSideTab = "brief";
  hydrateScriptGeneratorUi();
  try {
    await loadScriptHistoryFromServer();
    const preferId = keepOpenId || sgState.postActiveScriptId;
    if (preferId && (sgState.history || []).some((h) => h.id === preferId)) {
      await openScriptHistoryEntry(preferId, { silent: true });
    } else {
      hydrateScriptGeneratorUi();
    }
  } catch (e) {
    toast(`Could not load scripts: ${e.message}`, "error");
  }
  refreshAiCapabilities();
}

async function openScriptHistoryEntry(id, { silent = false } = {}) {
  try {
    const currentScript = ($("sgScriptText")?.value || "").trim();
    if (currentScript && sgState.activeId !== id) {
      try { await upsertActiveScriptHistory("edited"); } catch (_) { /* still open requested */ }
    }
    const data = await api(postScriptsUrl(`/${encodeURIComponent(id)}`));
    applyScriptDocToState(data.script);
    if (data.active_script_id !== undefined) sgState.postActiveScriptId = data.active_script_id;
    hydrateScriptGeneratorUi();
    setSgSideTab("brief");
    if (!silent) toast(`Opened “${sgState.title || "script"}”`, "ok");
  } catch (e) {
    toast(`Open failed: ${e.message}`, "error");
  }
}

async function activateScriptHistoryEntry(id) {
  try {
    const data = await api(postScriptsUrl(`/${encodeURIComponent(id)}/activate`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    sgState.postActiveScriptId = data.active_script_id || id;
    if (data.post && currentPost?.id === data.post.id) {
      currentPost = { ...currentPost, ...data.post };
    }
    await loadScriptHistoryFromServer();
    syncScriptActiveUi();
    toast("Active script updated", "ok");
  } catch (e) {
    toast(`Could not set active: ${e.message}`, "error");
  }
}

async function deleteScriptHistoryEntry(id) {
  const entry = (sgState.history || []).find((h) => h.id === id);
  const label = entry?.title || "Untitled script";
  const ok = await confirmDialog({
    title: "Delete script?",
    message: `Permanently delete “${label}” from this post?`,
    confirmText: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    const data = await api(postScriptsUrl(`/${encodeURIComponent(id)}`), { method: "DELETE" });
    if (data.active_script_id !== undefined) sgState.postActiveScriptId = data.active_script_id;
    if (data.post && currentPost?.id === data.post.id) {
      currentPost = { ...currentPost, ...data.post };
    }
    if (sgState.activeId === id) {
      clearTimeout(sgSaveTimer);
      sgSaveTimer = null;
      const history = (sgState.history || []).filter((h) => h.id !== id);
      sgState = {
        ...sgDefaultState(),
        history,
        projectId: currentProject?.id || null,
        postId: currentPost?.id || null,
        postActiveScriptId: sgState.postActiveScriptId,
      };
      hydrateScriptGeneratorUi();
    }
    await loadScriptHistoryFromServer();
    toast("Script deleted", "ok");
  } catch (e) {
    toast(`Delete failed: ${e.message}`, "error");
  }
}

async function clearScriptHistory() {
  if (!(sgState.history || []).length) {
    toast("No scripts to clear", "info");
    return;
  }
  const ok = await confirmDialog({
    title: "Delete all scripts for this post?",
    message: "Permanently deletes every saved script for this post. The current editor draft stays until you clear it.",
    confirmText: "Delete all",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(postScriptsUrl(), { method: "DELETE" });
    sgState.activeId = null;
    sgState.postActiveScriptId = null;
    sgState.history = [];
    if (currentPost) currentPost.active_script_id = null;
    renderScriptGeneratorHistory();
    syncScriptActiveUi();
    toast("Post scripts cleared", "ok");
  } catch (e) {
    toast(`Clear failed: ${e.message}`, "error");
  }
}

async function sgGenerateScript() {
  readScriptGeneratorBriefFromForm();
  const topic = sgState.brief.topic.trim();
  if (!topic) {
    toast("Enter a topic or idea first", "error");
    $("sgTopic")?.focus();
    return;
  }
  // Preserve the previous draft on disk before replacing.
  if (($("sgScriptText")?.value || sgState.script || "").trim()) {
    try { await upsertActiveScriptHistory("edited"); } catch (_) { /* continue */ }
  }
  const btn = $("sgGenerateBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Generating…"; }
  try {
    const data = await api("/api/ai/script/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sgState.brief),
    });
    sgState.activeId = null; // force create a new file
    sgState.title = data.title || "Untitled script";
    sgState.summary = data.summary || "";
    sgState.script = data.script || "";
    sgState.chat = [];
    if ($("sgScriptText")) $("sgScriptText").value = sgState.script;
    await upsertActiveScriptHistory("generated", { activate: true });
    syncScriptGeneratorMeta();
    renderScriptGeneratorChat();
    toast("Script generated", "ok");
  } catch (e) {
    toast(`Generate failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Generate script"; }
  }
}

async function sgSendChat(ev) {
  ev?.preventDefault?.();
  const message = $("sgChatInput")?.value?.trim();
  if (!message) {
    toast("Enter a refinement request", "error");
    return;
  }
  const script = ($("sgScriptText")?.value || "").trim();
  if (!script) {
    toast("Generate or paste a script before chatting", "error");
    return;
  }
  readScriptGeneratorBriefFromForm();
  sgState.script = script;
  sgState.chat.push({ role: "user", content: message });
  if ($("sgChatInput")) $("sgChatInput").value = "";
  renderScriptGeneratorChat();

  const btn = $("sgChatSendBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Thinking…"; }
  try {
    const data = await api("/api/ai/script/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script,
        message,
        history: sgState.chat.slice(0, -1).slice(-20),
        topic: sgState.brief.topic,
        platform: sgState.brief.platform,
        tone: sgState.brief.tone,
      }),
    });
    sgState.script = data.script || script;
    sgState.summary = data.summary || sgState.summary;
    if (data.reply) sgState.chat.push({ role: "assistant", content: data.reply });
    if ($("sgScriptText")) $("sgScriptText").value = sgState.script;
    await upsertActiveScriptHistory("refined");
    syncScriptGeneratorMeta();
    renderScriptGeneratorChat();
  } catch (e) {
    sgState.chat.push({ role: "assistant", content: `Sorry — ${e.message}` });
    renderScriptGeneratorChat();
    toast(`Refine failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Send"; }
  }
}

async function sgCopyScript() {
  const text = $("sgScriptText")?.value || "";
  if (!text.trim()) { toast("Nothing to copy", "error"); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard", "ok");
  } catch {
    toast("Clipboard unavailable", "error");
  }
}

function sgDownloadScript() {
  const text = $("sgScriptText")?.value || "";
  if (!text.trim()) { toast("Nothing to download", "error"); return; }
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safe = (sgState.title || "script").replace(/[^\w\-]+/g, "_").slice(0, 48);
  a.href = url;
  a.download = `${safe || "script"}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Download started", "ok");
}

async function sgNewScript() {
  clearTimeout(sgSaveTimer);
  sgSaveTimer = null;
  if (($("sgScriptText")?.value || "").trim() || (sgState.chat || []).length) {
    try { await upsertActiveScriptHistory("edited"); } catch (_) { /* continue */ }
  }
  const history = sgState.history || [];
  sgState = {
    ...sgDefaultState(),
    history,
    projectId: currentProject?.id || null,
    postId: currentPost?.id || sgState.postId,
    postActiveScriptId: sgState.postActiveScriptId,
  };
  hydrateScriptGeneratorUi();
  setSgSideTab("brief");
  $("sgTopic")?.focus();
  toast("Started a new script", "ok");
}

async function sgClearAll() {
  const ok = await confirmDialog({
    title: "Clear current draft?",
    message: "Clears the brief, script, and chat in the editor. Files already saved on disk are kept.",
    confirmText: "Clear draft",
    danger: true,
  });
  if (!ok) return;
  if (($("sgScriptText")?.value || "").trim()) {
    try { await upsertActiveScriptHistory("edited"); } catch (_) { /* continue */ }
  }
  const history = sgState.history || [];
  sgState = {
    ...sgDefaultState(),
    history,
    projectId: currentProject?.id || null,
    postId: currentPost?.id || sgState.postId,
    postActiveScriptId: sgState.postActiveScriptId,
  };
  hydrateScriptGeneratorUi();
  toast("Draft cleared", "ok");
}

function sgClearChat() {
  sgState.chat = [];
  renderScriptGeneratorChat();
  if ((sgState.script || "").trim()) {
    schedulePersistScriptGenerator();
  }
}

async function sgUseInAiScript() {
  const script = ($("sgScriptText")?.value || sgState.script || "").trim();
  if (!script) {
    toast("Generate or paste a script first", "error");
    return;
  }
  try { await upsertActiveScriptHistory("edited"); } catch (_) { /* continue */ }
  if (sgState.activeId && sgState.activeId !== sgState.postActiveScriptId) {
    try { await activateScriptHistoryEntry(sgState.activeId); } catch (_) { /* continue */ }
  }
  closeScriptGeneratorModal({ silent: true });
  if ($("aiScriptText")) $("aiScriptText").value = script;
  openAiPanel("script");
  toast("Script ready in AI Script tab", "ok");
}

function wireScriptGeneratorUi() {
  $("sgGenerateBtn")?.addEventListener("click", sgGenerateScript);
  $("sgChatForm")?.addEventListener("submit", sgSendChat);
  $("sgChatClearBtn")?.addEventListener("click", sgClearChat);
  $("sgNewBtn")?.addEventListener("click", () => { sgNewScript(); });
  $("sgChatNewBtn")?.addEventListener("click", () => { sgNewScript(); });
  $("sgCopyBtn")?.addEventListener("click", sgCopyScript);
  $("sgDownloadBtn")?.addEventListener("click", sgDownloadScript);
  $("sgClearBtn")?.addEventListener("click", () => { sgClearAll(); });
  $("sgUseInAiBtn")?.addEventListener("click", () => { sgUseInAiScript(); });
  $("sgActivateBtn")?.addEventListener("click", () => {
    if (sgState.activeId) activateScriptHistoryEntry(sgState.activeId);
  });
  $("sgDialogClose")?.addEventListener("click", () => closeScriptGeneratorModal());
  $("scriptGeneratorDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "scriptGeneratorDialog") closeScriptGeneratorModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isScriptGeneratorModalOpen()) return;
    if (!$("confirmDialog")?.classList.contains("hidden")) return;
    if (!$("choiceDialog")?.classList.contains("hidden")) return;
    if (!$("promptDialog")?.classList.contains("hidden")) return;
    if (isVideoEditorModalOpen()) return;
    closeScriptGeneratorModal();
  });
  $("openScriptsBtn")?.addEventListener("click", () => { openScriptGeneratorModal(); });
  $("sgHistoryClearBtn")?.addEventListener("click", () => { clearScriptHistory(); });
  $("sgHistoryList")?.addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-sg-history-open]");
    if (openBtn) {
      openScriptHistoryEntry(openBtn.getAttribute("data-sg-history-open"));
      return;
    }
    const actBtn = e.target.closest("[data-sg-history-activate]");
    if (actBtn) {
      activateScriptHistoryEntry(actBtn.getAttribute("data-sg-history-activate"));
      return;
    }
    const delBtn = e.target.closest("[data-sg-history-delete]");
    if (delBtn) {
      deleteScriptHistoryEntry(delBtn.getAttribute("data-sg-history-delete"));
    }
  });
  document.querySelectorAll(".sg-side-tab").forEach((btn) => {
    btn.addEventListener("click", () => setSgSideTab(btn.dataset.sgSide || "brief"));
  });
  $("sgScriptText")?.addEventListener("input", () => {
    sgState.script = $("sgScriptText").value;
    if (!sgState.title || sgState.title === "Untitled script") {
      const first = sgState.script.trim().split("\n").find(Boolean);
      if (first) sgState.title = first.slice(0, 60);
    }
    syncScriptGeneratorMeta();
    schedulePersistScriptGenerator();
  });
  ["sgTopic", "sgPlatform", "sgFormat", "sgTone", "sgLength", "sgAudience", "sgLanguage", "sgNotes"].forEach((id) => {
    $(id)?.addEventListener("change", () => {
      readScriptGeneratorBriefFromForm();
      if ((sgState.script || "").trim()) schedulePersistScriptGenerator();
    });
    $(id)?.addEventListener("input", () => {
      readScriptGeneratorBriefFromForm();
      if ((sgState.script || "").trim()) schedulePersistScriptGenerator();
    });
  });
  $("sgChatInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sgSendChat(e);
    }
  });
}

// ---------- Video Editor (copy-on-write asset edits; no undo) ----------
/** Instagram publish sizes (width/height). Matches backend FORMAT_DIMENSIONS. */
const VE_ASPECT_RATIOS = {
  original: null,
  square: 1080 / 1080,
  portrait: 1080 / 1350,
  landscape: 1080 / 566,
  story: 1080 / 1920,
  custom: null,
};

const VE_MIN_CROP_NORM = 0.05;

/** @type {{ projectId: string | null, sourceId: string | null, focusPostId: string | null, duration: number, start: number, end: number, hasAudio: boolean | null, removeRanges: { id: string, start: number, end: number }[], trimDrag: null | { handle: string }, aspectRatio: string, aspectLocked: boolean, rotateDeg: number, crop: { x: number, y: number, w: number, h: number } | null, cropDrag: null | object, sourceWidth: number | null, sourceHeight: number | null }} */
let veState = {
  projectId: null,
  sourceId: null,
  focusPostId: null,
  duration: 0,
  start: 0,
  end: 0,
  hasAudio: null,
  removeRanges: [],
  trimDrag: null,
  aspectRatio: "original",
  aspectLocked: false,
  rotateDeg: 0,
  crop: null, // normalized 0–1 of post-rotate frame
  cropDrag: null,
  sourceWidth: null,
  sourceHeight: null,
};

let veCutIdSeq = 1;

function veFmt(s) {
  const n = Number(s);
  if (!Number.isFinite(n)) return "0.0s";
  return `${n.toFixed(1)}s`;
}

function veRound(s) {
  return Math.round(Number(s) * 10) / 10;
}

function veProjectVideos(project) {
  const focusPostId = veState.focusPostId || null;
  const sourceId = veState.sourceId || null;
  return (project?.assets || []).filter((a) => {
    if (a.type !== "video" || !a.original_path) return false;
    if (!a.post_id) return true;
    if (focusPostId && a.post_id === focusPostId) return true;
    if (sourceId && a.id === sourceId) return true;
    return false;
  });
}

function veProjectAudio(project) {
  const focusPostId = veState.focusPostId || null;
  return (project?.assets || []).filter((a) => {
    if (a.type !== "audio" || !a.original_path) return false;
    if (!a.post_id) return true;
    if (focusPostId && a.post_id === focusPostId) return true;
    return false;
  });
}

function veSetStatus(msg, kind = "") {
  const el = $("veStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = `text-[11px] min-h-[1rem] ${
    kind === "error" ? "text-red-300" : kind === "ok" ? "text-emerald-300" : "text-slate-500"
  }`;
}

function veSyncSpeedPresets(speed) {
  document.querySelectorAll(".ve-speed-preset").forEach((btn) => {
    const val = Number(btn.dataset.veSpeed);
    const active = Math.abs(val - speed) < 0.001;
    btn.classList.toggle("border-indigo-400/40", active);
    btn.classList.toggle("text-indigo-200", active);
    btn.classList.toggle("bg-indigo-500/10", active);
    btn.classList.toggle("border-white/10", !active);
    btn.classList.toggle("text-slate-400", !active);
  });
}

function veSourceDims() {
  const video = $("vePreview");
  const w = veState.sourceWidth || video?.videoWidth || 0;
  const h = veState.sourceHeight || video?.videoHeight || 0;
  return { w, h };
}

function veRotatedDims() {
  const { w, h } = veSourceDims();
  if (!w || !h) return { w: 0, h: 0 };
  const d = ((veState.rotateDeg % 360) + 360) % 360;
  if (d === 90 || d === 270) return { w: h, h: w };
  return { w, h };
}

function veClampCrop(crop) {
  const min = VE_MIN_CROP_NORM;
  let { x, y, w, h } = crop;
  w = clamp(w, min, 1);
  h = clamp(h, min, 1);
  x = clamp(x, 0, 1 - w);
  y = clamp(y, 0, 1 - h);
  return { x, y, w, h };
}

function veMaxFitCrop(aspect) {
  // Largest rectangle of given aspect (or full frame if null) centered in unit square.
  if (!aspect || !(aspect > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  let w;
  let h;
  if (aspect >= 1) {
    w = 1;
    h = 1 / aspect;
  } else {
    h = 1;
    w = aspect;
  }
  return veClampCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

function vePresetAspect() {
  const key = veState.aspectRatio || "original";
  if (key === "custom") {
    if (veState.crop && veState.crop.h > 0) return veState.crop.w / veState.crop.h;
    return null;
  }
  return VE_ASPECT_RATIOS[key] ?? null;
}

function veInitCropForMode() {
  const key = veState.aspectRatio || "original";
  if (key === "original") {
    veState.crop = null;
    veState.aspectLocked = false;
    return;
  }
  if (key === "custom") {
    veState.aspectLocked = false;
    veState.crop = veState.crop && veState.crop.w > 0
      ? veClampCrop(veState.crop)
      : { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    return;
  }
  veState.aspectLocked = true;
  veState.crop = veMaxFitCrop(VE_ASPECT_RATIOS[key]);
}

function veCropIsPartial() {
  const c = veState.crop;
  if (!c) return false;
  return c.x > 0.005 || c.y > 0.005 || c.w < 0.995 || c.h < 0.995;
}

function veSyncAspectUi() {
  const key = veState.aspectRatio || "original";
  document.querySelectorAll(".ve-aspect-btn").forEach((btn) => {
    const active = btn.dataset.veAspect === key;
    btn.classList.toggle("is-active", active);
    btn.disabled = !veState.sourceId;
  });
  const customWrap = $("veCustomAspectWrap");
  const presetWrap = $("vePresetCropWrap");
  if (customWrap) customWrap.classList.toggle("hidden", key !== "custom" || !veState.sourceId);
  if (presetWrap) {
    presetWrap.classList.toggle(
      "hidden",
      key === "original" || key === "custom" || !veState.sourceId,
    );
  }
  const lock = $("veAspectLock");
  if (lock) lock.checked = !!veState.aspectLocked;
  veUpdatePreviewGeometry();
}

function veSetAspectRatio(key) {
  if (!(key in VE_ASPECT_RATIOS)) return;
  veState.aspectRatio = key;
  veInitCropForMode();
  veSyncAspectUi();
  veSyncOpSaveButtons();
}

function veSetRotate(deg) {
  veState.rotateDeg = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  // Re-fit crop to new rotated frame for presets; keep custom ratios centered max-fit.
  if (veState.aspectRatio === "original") {
    veState.crop = null;
  } else if (veState.aspectRatio === "custom") {
    const ar = veState.crop && veState.crop.h > 0 ? veState.crop.w / veState.crop.h : null;
    veState.crop = ar ? veMaxFitCrop(ar) : { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  } else {
    veState.crop = veMaxFitCrop(VE_ASPECT_RATIOS[veState.aspectRatio]);
  }
  veUpdatePreviewGeometry();
  veSyncOpSaveButtons();
}

function veRotateBy(delta) {
  veSetRotate((veState.rotateDeg || 0) + delta);
}

function veUpdatePreviewGeometry() {
  const stage = $("vePreviewStage");
  const rotator = $("vePreviewRotator");
  if (!stage) return;
  const { w: sw, h: sh } = veSourceDims();
  const { w: rw, h: rh } = veRotatedDims();
  const deg = ((veState.rotateDeg % 360) + 360) % 360;
  const keepOriginalFrame = (veState.aspectRatio || "original") === "original";

  stage.classList.remove("is-natural", "is-cropped");
  // Original aspect mode keeps the source frame; crop presets use post-rotate frame.
  if (keepOriginalFrame && sw > 0 && sh > 0) {
    stage.classList.add("has-frame");
    stage.style.setProperty("--ve-frame-ar", String(sw / sh));
  } else if (rw > 0 && rh > 0) {
    stage.classList.add("has-frame");
    stage.style.setProperty("--ve-frame-ar", String(rw / rh));
  } else if (sw > 0 && sh > 0) {
    stage.classList.add("has-frame");
    stage.style.setProperty("--ve-frame-ar", String(sw / sh));
  } else {
    stage.classList.remove("has-frame");
    stage.style.removeProperty("--ve-frame-ar");
  }

  if (rotator) {
    rotator.style.position = "absolute";
    rotator.style.left = "50%";
    rotator.style.top = "50%";
    rotator.style.right = "auto";
    rotator.style.bottom = "auto";
    if ((deg === 90 || deg === 270) && keepOriginalFrame && sw > 0 && sh > 0) {
      // Letterbox/pillarbox the rotated clip inside the original frame.
      const s = Math.min(sw / sh, sh / sw) * 100;
      rotator.style.width = `${s}%`;
      rotator.style.height = `${s}%`;
    } else if ((deg === 90 || deg === 270) && rw > 0 && rh > 0) {
      // Pre-rotate box is source aspect; after rotate it matches the swapped stage.
      rotator.style.width = `${(rh / rw) * 100}%`;
      rotator.style.height = `${(rw / rh) * 100}%`;
    } else {
      rotator.style.width = "100%";
      rotator.style.height = "100%";
    }
    rotator.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
  }

  if ($("veRotateLabel")) $("veRotateLabel").textContent = `${deg}°`;
  veRenderCropOverlay();
}

function veRenderCropOverlay() {
  const overlay = $("veCropOverlay");
  const box = $("veCropBox");
  if (!overlay || !box) return;
  const mode = veState.aspectRatio || "original";
  const show = !!veState.sourceId && mode !== "original" && !!veState.crop;
  overlay.classList.toggle("is-active", show);
  overlay.setAttribute("aria-hidden", show ? "false" : "true");
  if (!show || !veState.crop) {
    if ($("veCropMeta")) $("veCropMeta").textContent = "";
    if ($("veCropMetaPreset")) $("veCropMetaPreset").textContent = "";
    return;
  }
  const c = veClampCrop(veState.crop);
  veState.crop = c;
  const left = c.x * 100;
  const top = c.y * 100;
  const width = c.w * 100;
  const height = c.h * 100;
  box.style.left = `${left}%`;
  box.style.top = `${top}%`;
  box.style.width = `${width}%`;
  box.style.height = `${height}%`;

  const shades = {
    top: overlay.querySelector('[data-shade="top"]'),
    left: overlay.querySelector('[data-shade="left"]'),
    right: overlay.querySelector('[data-shade="right"]'),
    bottom: overlay.querySelector('[data-shade="bottom"]'),
  };
  if (shades.top) {
    shades.top.style.cssText = `left:0;top:0;right:0;height:${top}%`;
  }
  if (shades.bottom) {
    shades.bottom.style.cssText = `left:0;top:${top + height}%;right:0;bottom:0`;
  }
  if (shades.left) {
    shades.left.style.cssText = `left:0;top:${top}%;width:${left}%;height:${height}%`;
  }
  if (shades.right) {
    shades.right.style.cssText = `left:${left + width}%;top:${top}%;right:0;height:${height}%`;
  }

  const { w: rw, h: rh } = veRotatedDims();
  const pxW = rw ? Math.round(c.w * rw) : 0;
  const pxH = rh ? Math.round(c.h * rh) : 0;
  const meta = rw
    ? `${pxW}×${pxH}px · ${(c.w / c.h).toFixed(3).replace(/\.?0+$/, "")}:1`
    : "";
  if ($("veCropMeta")) $("veCropMeta").textContent = meta;
  if ($("veCropMetaPreset")) $("veCropMetaPreset").textContent = meta;
  if (mode === "custom" && $("veAspectW") && document.activeElement !== $("veAspectW")
      && document.activeElement !== $("veAspectH")) {
    const n = Math.max(1, Math.round(c.w * 100));
    const d = Math.max(1, Math.round(c.h * 100));
    let a = n;
    let b = d;
    while (b) {
      const t = b;
      b = a % b;
      a = t;
    }
    const g = a || 1;
    $("veAspectW").value = String(n / g);
    $("veAspectH").value = String(d / g);
  }
}

function veCropFromPointer(clientX, clientY) {
  const overlay = $("veCropOverlay");
  if (!overlay) return { x: 0, y: 0 };
  const rect = overlay.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return { x: 0, y: 0 };
  return {
    x: clamp((clientX - rect.left) / rect.width, 0, 1),
    y: clamp((clientY - rect.top) / rect.height, 0, 1),
  };
}

function veOnCropPointerDown(e) {
  if (!veState.crop || (veState.aspectRatio || "original") === "original") return;
  const handle = e.target?.dataset?.handle || e.currentTarget?.dataset?.handle;
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  const pt = veCropFromPointer(e.clientX, e.clientY);
  veState.cropDrag = {
    handle,
    startX: pt.x,
    startY: pt.y,
    orig: { ...veState.crop },
    pointerId: e.pointerId,
  };
  try {
    e.currentTarget.setPointerCapture?.(e.pointerId);
  } catch (_) { /* ignore */ }
}

function veOnCropPointerMove(e) {
  const drag = veState.cropDrag;
  if (!drag || !veState.crop) return;
  const pt = veCropFromPointer(e.clientX, e.clientY);
  const dx = pt.x - drag.startX;
  const dy = pt.y - drag.startY;
  const o = drag.orig;
  const lockAspect =
    (veState.aspectRatio !== "custom" && veState.aspectRatio !== "original")
    || (veState.aspectRatio === "custom" && veState.aspectLocked);
  const aspect = lockAspect
    ? (o.h > 0 ? o.w / o.h : vePresetAspect())
    : null;

  let next = { ...o };
  if (drag.handle === "move") {
    next.x = o.x + dx;
    next.y = o.y + dy;
  } else {
    const applyCorner = (nx, ny, nw, nh) => {
      if (aspect && aspect > 0) {
        // Keep aspect; prefer width-driven when |dx| dominates.
        if (Math.abs(nw - o.w) * aspect >= Math.abs(nh - o.h) || !Number.isFinite(nh)) {
          nh = nw / aspect;
        } else {
          nw = nh * aspect;
        }
      }
      return veClampCrop({ x: nx, y: ny, w: nw, h: nh });
    };
    if (drag.handle === "se") {
      next = applyCorner(o.x, o.y, o.w + dx, o.h + dy);
    } else if (drag.handle === "sw") {
      const nw = o.w - dx;
      next = applyCorner(o.x + dx, o.y, nw, o.h + dy);
      if (aspect) next = veClampCrop({ x: o.x + o.w - next.w, y: o.y, w: next.w, h: next.h });
    } else if (drag.handle === "ne") {
      const nh = o.h - dy;
      next = applyCorner(o.x, o.y + dy, o.w + dx, nh);
      if (aspect) next = veClampCrop({ x: o.x, y: o.y + o.h - next.h, w: next.w, h: next.h });
    } else if (drag.handle === "nw") {
      next = applyCorner(o.x + dx, o.y + dy, o.w - dx, o.h - dy);
      if (aspect) {
        next = veClampCrop({
          x: o.x + o.w - next.w,
          y: o.y + o.h - next.h,
          w: next.w,
          h: next.h,
        });
      }
    }
  }
  veState.crop = veClampCrop(next);
  veRenderCropOverlay();
}

function veOnCropPointerUp(e) {
  if (!veState.cropDrag) return;
  veState.cropDrag = null;
  try {
    e.currentTarget?.releasePointerCapture?.(e.pointerId);
  } catch (_) { /* ignore */ }
  veSyncOpSaveButtons();
}

function veApplyCustomAspectInputs() {
  const w = Number($("veAspectW")?.value);
  const h = Number($("veAspectH")?.value);
  if (!(w > 0) || !(h > 0)) {
    toast("Enter positive W and H values", "info");
    return;
  }
  veState.aspectRatio = "custom";
  veState.aspectLocked = true;
  veState.crop = veMaxFitCrop(w / h);
  if ($("veAspectLock")) $("veAspectLock").checked = true;
  veSyncAspectUi();
  veSyncOpSaveButtons();
}

function veResetCrop() {
  veInitCropForMode();
  veUpdatePreviewGeometry();
  veSyncOpSaveButtons();
}

function veCropPixelsForSave() {
  if (!veState.crop || (veState.aspectRatio || "original") === "original") return null;
  const { w: rw, h: rh } = veRotatedDims();
  if (!rw || !rh) return null;
  const c = veClampCrop(veState.crop);
  return {
    crop_x: c.x * rw,
    crop_y: c.y * rh,
    crop_w: c.w * rw,
    crop_h: c.h * rh,
  };
}

function veSyncAudioModeUi() {
  const mode = document.querySelector('input[name="veAudioMode"]:checked')?.value || "keep";
  const sel = $("veAudioSelect");
  const volWrap = $("veAudioVolumeWrap");
  if (sel) sel.disabled = mode !== "replace" || !veState.sourceId;
  if (volWrap) volWrap.classList.toggle("hidden", mode !== "replace");
  veSyncOpSaveButtons();
}

function veUpdateTrimUi() {
  const dur = Math.max(0, veEffectiveDuration());
  const start = clamp(veState.start, 0, Math.max(0, dur - 0.1));
  const end = clamp(veState.end, start + 0.1, Math.max(start + 0.1, dur || start + 0.1));
  veState.start = start;
  veState.end = end;
  veState.duration = dur;
  // Keep cut-outs inside the clip window.
  veState.removeRanges = veState.removeRanges
    .map((r) => ({
      ...r,
      start: clamp(r.start, start, Math.max(start, end - 0.1)),
      end: clamp(r.end, start + 0.1, end),
    }))
    .filter((r) => r.end > r.start + 0.05);
  const startPct = dur > 0 ? (start / dur) * 100 : 0;
  const endPct = dur > 0 ? (end / dur) * 100 : 100;
  const range = $("veTrimRange");
  const hStart = $("veTrimHandleStart");
  const hEnd = $("veTrimHandleEnd");
  if (range) {
    range.style.left = `${startPct}%`;
    range.style.right = `${100 - endPct}%`;
  }
  if (hStart) hStart.style.left = `${startPct}%`;
  if (hEnd) hEnd.style.left = `${endPct}%`;
  if ($("veTrimStartLabel")) $("veTrimStartLabel").textContent = veFmt(start);
  if ($("veTrimEndLabel")) $("veTrimEndLabel").textContent = veFmt(end);
  if ($("veStartInput") && document.activeElement !== $("veStartInput")) {
    $("veStartInput").value = String(veRound(start));
  }
  if ($("veEndInput") && document.activeElement !== $("veEndInput")) {
    $("veEndInput").value = String(veRound(end));
  }
  veRenderCutOverlays();
  veRenderCutList();
  veSyncOpSaveButtons();
}

function veRenderCutOverlays() {
  const host = $("veCutOverlays");
  if (!host) return;
  const dur = Math.max(0, veState.duration);
  host.innerHTML = (veState.removeRanges || []).map((r) => {
    const left = dur > 0 ? (r.start / dur) * 100 : 0;
    const right = dur > 0 ? 100 - (r.end / dur) * 100 : 100;
    return `<div class="ve-cut-range" style="left:${left}%;right:${right}%" title="Cut ${veFmt(r.start)}–${veFmt(r.end)}"></div>`;
  }).join("");
}

function veRenderCutList() {
  const list = $("veCutList");
  const empty = $("veCutEmpty");
  if (!list) return;
  const cuts = veState.removeRanges || [];
  if (empty) empty.classList.toggle("hidden", cuts.length > 0);
  list.innerHTML = cuts.map((r, idx) => `
    <div class="ve-cut-row" data-cut-id="${escapeHtml(r.id)}">
      <span class="text-[10px] text-red-200/80 w-10 shrink-0">Cut ${idx + 1}</span>
      <input type="number" min="0" step="0.1" class="ve-cut-start text-xs rounded-lg bg-black/30 border border-white/10 px-1.5 py-1 tabular-nums" value="${veRound(r.start)}" data-cut-id="${escapeHtml(r.id)}" aria-label="Cut start" />
      <span class="text-[10px] text-slate-500">–</span>
      <input type="number" min="0" step="0.1" class="ve-cut-end text-xs rounded-lg bg-black/30 border border-white/10 px-1.5 py-1 tabular-nums" value="${veRound(r.end)}" data-cut-id="${escapeHtml(r.id)}" aria-label="Cut end" />
      <span class="text-[10px] text-slate-500 tabular-nums">${veFmt(Math.max(0, r.end - r.start))}</span>
      <button type="button" class="ve-cut-delete text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-red-300 hover:text-red-200 ml-auto" data-cut-id="${escapeHtml(r.id)}" title="Remove cut">✕</button>
    </div>
  `).join("");
  list.querySelectorAll(".ve-cut-start, .ve-cut-end").forEach((input) => {
    input.addEventListener("change", () => {
      const cut = veState.removeRanges.find((c) => c.id === input.dataset.cutId);
      if (!cut) return;
      const val = Number(input.value);
      if (!Number.isFinite(val)) return;
      if (input.classList.contains("ve-cut-start")) cut.start = val;
      else cut.end = val;
      if (cut.end < cut.start + 0.1) cut.end = cut.start + 0.1;
      veUpdateTrimUi();
    });
  });
  list.querySelectorAll(".ve-cut-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      veState.removeRanges = veState.removeRanges.filter((c) => c.id !== btn.dataset.cutId);
      veUpdateTrimUi();
    });
  });
}

function veAddCutAtPlayhead() {
  if (!veState.sourceId || veState.duration <= 0) return;
  const video = $("vePreview");
  const t = Number(video?.currentTime);
  const playhead = Number.isFinite(t) ? t : veState.start;
  const windowStart = veState.start;
  const windowEnd = veState.end > windowStart ? veState.end : veState.duration;
  const span = Math.min(1.0, Math.max(0.3, (windowEnd - windowStart) * 0.1));
  let start = clamp(playhead, windowStart, Math.max(windowStart, windowEnd - 0.1));
  let end = clamp(start + span, windowStart + 0.1, windowEnd);
  if (end - start < 0.1) {
    start = Math.max(windowStart, end - 0.1);
  }
  // Avoid exact duplicates of an existing cut.
  const overlaps = veState.removeRanges.some(
    (r) => !(end <= r.start + 0.05 || start >= r.end - 0.05),
  );
  if (overlaps) {
    // Merge into existing by extending the first overlapping cut.
    const hit = veState.removeRanges.find(
      (r) => !(end <= r.start + 0.05 || start >= r.end - 0.05),
    );
    if (hit) {
      hit.start = Math.min(hit.start, start);
      hit.end = Math.max(hit.end, end);
      veUpdateTrimUi();
      toast("Extended overlapping cut", "info");
      return;
    }
  }
  veState.removeRanges.push({
    id: `cut-${veCutIdSeq++}`,
    start: veRound(start),
    end: veRound(end),
  });
  veUpdateTrimUi();
}

function veClearCuts() {
  veState.removeRanges = [];
  veUpdateTrimUi();
}

function veRemoveRangeAt(t) {
  return (veState.removeRanges || []).find((r) => t >= r.start - 1e-3 && t < r.end - 0.02) || null;
}

function veUpdatePlayhead() {
  const video = $("vePreview");
  const dur = Math.max(0, veEffectiveDuration());
  const t = Number(video?.currentTime) || 0;
  const pct = dur > 0 ? clamp((t / dur) * 100, 0, 100) : 0;
  const head = $("veTrimPlayhead");
  if (head) head.style.left = `${pct}%`;
  if ($("vePlayheadLabel")) $("vePlayheadLabel").textContent = veFmt(t);
  const btn = $("vePlayBtn");
  if (btn && video) btn.textContent = video.paused ? "Play" : "Pause";
}

function veSetControlsEnabled(on) {
  [
    "vePlayBtn",
    "veStartInput",
    "veEndInput",
    "veSpeed",
    "veOutputName",
    "veOutputScope",
    "veUploadStockBtn",
    "veAddCutBtn",
    "veClearCutsBtn",
    "veRotateLeftBtn",
    "veRotateRightBtn",
    "veRotateResetBtn",
    "veAspectLock",
    "veAspectW",
    "veAspectH",
    "veAspectApplyBtn",
    "veResetCropBtn",
    "veResetCropPresetBtn",
  ].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !on;
  });
  document.querySelectorAll(".ve-speed-preset, .ve-audio-mode, .ve-aspect-btn").forEach((el) => {
    el.disabled = !on;
  });
  const track = $("veTrimTrack");
  if (track) {
    track.classList.toggle("is-disabled", !on);
    track.classList.remove("opacity-40", "pointer-events-none");
  }
  veSyncAudioModeUi();
  veSyncAspectUi();
  veSyncSaveModeUi(on);
}

function vePopulateProjectSelect() {
  const badge = $("veProjectBadge");
  if (badge) {
    badge.textContent = currentProject?.name
      ? `Project · ${currentProject.name}`
      : "No project open";
  }
}

async function veEnsureProjectLoaded(projectId) {
  if (!projectId) return null;
  if (currentProject?.id === projectId) return currentProject;
  const data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  currentProject = data.project;
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx >= 0) {
    projects[idx] = {
      ...projects[idx],
      name: currentProject.name,
      asset_count: (currentProject.assets || []).length,
      post_count: (currentProject.posts || []).length,
      updated_at: currentProject.updated_at,
    };
  }
  return currentProject;
}

function veRenderVideoList(project) {
  const list = $("veVideoList");
  if (!list) return;
  const videos = veProjectVideos(project);
  if (!videos.length) {
    list.innerHTML = `<p class="text-xs text-slate-500 px-1 py-6 text-center">No video assets in this project. Upload clips in Post Creator.</p>`;
    return;
  }
  list.innerHTML = videos.map((a) => {
    const selected = a.id === veState.sourceId;
    const edited = (a.group || "").trim().toLowerCase() === "edited videos";
    return `<button type="button" class="ve-asset-item ${selected ? "is-selected" : ""}" data-id="${escapeHtml(a.id)}">
      <span class="material-icons text-[18px] text-indigo-300 shrink-0" aria-hidden="true">${edited ? "content_cut" : "movie"}</span>
      <span class="min-w-0 flex-1 text-left">
        <span class="truncate text-xs block">${escapeHtml(a.name || "Video")}</span>
        ${edited ? '<span class="text-[10px] text-fuchsia-300/90">Edited</span>' : ""}
      </span>
    </button>`;
  }).join("");
  list.querySelectorAll(".ve-asset-item").forEach((btn) => {
    btn.addEventListener("click", () => veSelectSource(btn.dataset.id));
  });
}

function vePopulateAudioSelect(project) {
  const sel = $("veAudioSelect");
  if (!sel) return;
  const prev = sel.value;
  const audio = veProjectAudio(project);
  sel.innerHTML = `<option value="">Select audio asset</option>` + audio.map((a) =>
    `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || "Audio")}</option>`
  ).join("");
  if (prev && audio.some((a) => a.id === prev)) sel.value = prev;
}

async function veSelectSource(assetId) {
  const project = currentProject;
  if (!project || !assetId) return;
  const asset = (project.assets || []).find((a) => a.id === assetId && a.type === "video");
  if (!asset?.original_path) {
    toast("Video file missing", "error");
    return;
  }
  veState.sourceId = assetId;
  veState.hasAudio = null;
  veState.sourceWidth = null;
  veState.sourceHeight = null;
  veState.aspectRatio = "original";
  veState.aspectLocked = false;
  veState.rotateDeg = 0;
  veState.crop = null;
  veState.cropDrag = null;
  if (asset.post_id) veState.focusPostId = asset.post_id;
  veRenderVideoList(project);
  if ($("veSourceTitle")) $("veSourceTitle").textContent = asset.name || "Preview";
  if ($("veSourceMeta")) $("veSourceMeta").textContent = "Loading…";
  if ($("veOutputName")) {
    $("veOutputName").value = veIsEditedAsset(asset)
      ? (asset.name || "Video").slice(0, 120)
      : `${asset.name || "Video"} (edit)`.slice(0, 120);
  }
  veSetStatus("");
  veSyncSaveModeUi();

  const video = $("vePreview");
  const placeholder = $("vePreviewPlaceholder");
  const stage = $("vePreviewStage");
  // Bust cache so overwrite (same path) shows the newly encoded file, including rotation.
  const baseUrl = getAssetPreviewUrl(asset) || assetFileUrl(project.id, asset.original_path);
  const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}ve=${Date.now()}`;
  if (video) {
    video.classList.remove("hidden");
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.src = url;
  }
  if (stage) stage.classList.remove("hidden");
  if (placeholder) placeholder.classList.add("hidden");

  try {
    const info = await api(
      `/api/projects/${encodeURIComponent(project.id)}/assets/${encodeURIComponent(assetId)}/video/info`
    );
    veState.duration = Number(info.duration_s) || 0;
    veState.hasAudio = !!info.has_audio;
    veState.sourceWidth = Number(info.width) || null;
    veState.sourceHeight = Number(info.height) || null;
    const dims = info.width && info.height ? ` · ${info.width}×${info.height}` : "";
    const fpsLabel = formatFps(info.fps);
    const fps = fpsLabel ? ` · ${fpsLabel}` : "";
    const container = info.container ? ` · ${String(info.container).toUpperCase()}` : "";
    const codec = info.video_codec ? ` · ${info.video_codec}` : "";
    const audioLabel = info.has_audio ? "has audio" : "no audio";
    if ($("veSourceMeta")) {
      $("veSourceMeta").textContent = `${veFmt(veState.duration)} · ${audioLabel}${container}${codec}${dims}${fps}`;
    }
    veUpdatePreviewGeometry();
  } catch (e) {
    // Fall back to HTML5 duration once metadata loads.
    veState.duration = 0;
    if ($("veSourceMeta")) $("veSourceMeta").textContent = e.message || "Could not probe video";
  }

  veState.start = 0;
  veState.end = veState.duration || 0;
  veState.removeRanges = [];
  veSetControlsEnabled(true);
  veSyncAspectUi();
  veUpdateTrimUi();
  veUpdatePlayhead();
  if ($("veSpeed")) $("veSpeed").value = "1";
  if ($("veSpeedLabel")) $("veSpeedLabel").textContent = "1×";
  veSyncSpeedPresets(1);
  const keep = document.querySelector('input[name="veAudioMode"][value="keep"]');
  if (keep) keep.checked = true;
  veSyncAudioModeUi();
}

function veOnVideoMeta() {
  const video = $("vePreview");
  if (!video || !veState.sourceId) return;
  if (video.videoWidth > 0 && video.videoHeight > 0) {
    if (!veState.sourceWidth || !veState.sourceHeight) {
      veState.sourceWidth = video.videoWidth;
      veState.sourceHeight = video.videoHeight;
    }
    veUpdatePreviewGeometry();
  }
  const d = Number(video.duration);
  if (Number.isFinite(d) && d > 0) {
    if (!veState.duration || Math.abs(veState.duration - d) > 0.3) {
      veState.duration = d;
      if (veState.end <= 0.1 || veState.end > d) veState.end = d;
      veUpdateTrimUi();
      const audioLabel = veState.hasAudio == null ? "" : veState.hasAudio ? " · has audio" : " · no audio";
      if ($("veSourceMeta")) $("veSourceMeta").textContent = `${veFmt(d)}${audioLabel}`;
    }
  }
}

function veTogglePlay() {
  const video = $("vePreview");
  if (!video?.src) return;
  if (video.paused) {
    // Loop within clip window for a sense of the trimmed range.
    if (video.currentTime < veState.start || video.currentTime >= veState.end - 0.05) {
      video.currentTime = veState.start;
    }
    const hit = veRemoveRangeAt(video.currentTime);
    if (hit) video.currentTime = Math.min(hit.end, veState.end);
    video.playbackRate = Number($("veSpeed")?.value) || 1;
    video.play().catch(() => {});
  } else {
    video.pause();
  }
  veUpdatePlayhead();
}

function veOnTimeUpdate() {
  const video = $("vePreview");
  if (!video || video.paused) {
    veUpdatePlayhead();
    return;
  }
  const hit = veRemoveRangeAt(video.currentTime);
  if (hit) {
    video.currentTime = Math.min(hit.end, veState.end);
  }
  if (video.currentTime >= veState.end - 0.02) {
    video.pause();
    video.currentTime = veState.end;
  }
  veUpdatePlayhead();
}

function veEffectiveDuration() {
  const video = $("vePreview");
  const fromVideo = Number(video?.duration);
  if (Number.isFinite(fromVideo) && fromVideo > 0 && fromVideo !== Infinity) {
    if (!veState.duration || Math.abs(veState.duration - fromVideo) > 0.25) {
      veState.duration = fromVideo;
    }
    return fromVideo;
  }
  return Math.max(0, Number(veState.duration) || 0);
}

function veTrimFromPointer(clientX) {
  const track = $("veTrimTrack");
  const dur = veEffectiveDuration();
  if (!track || dur <= 0) return 0;
  const rect = track.getBoundingClientRect();
  const pct = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  return pct * dur;
}

function veSeekPreview(timeS, { resumeIfPlaying = false } = {}) {
  const video = $("vePreview");
  const dur = veEffectiveDuration();
  if (!video || dur <= 0) return;
  const wasPlaying = !video.paused;
  const t = clamp(Number(timeS) || 0, 0, dur);
  try {
    video.currentTime = t;
  } catch (_) { /* ignore seek errors while loading */ }
  veUpdatePlayhead();
  if (resumeIfPlaying && wasPlaying) {
    video.play().catch(() => {});
  }
}

function veOnTrimPointerDown(e) {
  if (!veState.sourceId) return;
  const dur = veEffectiveDuration();
  if (dur <= 0) return;
  const track = $("veTrimTrack");
  if (!track || track.classList.contains("is-disabled")) return;

  const handleEl = e.target?.closest?.("[data-handle]");
  let handle = handleEl?.dataset?.handle || null;
  if (!handle) handle = "scrub";

  const video = $("vePreview");
  const wasPlaying = !!(video && !video.paused);

  veState.trimDrag = {
    handle,
    wasPlaying,
    moved: false,
    startX: e.clientX,
  };
  try {
    track.setPointerCapture(e.pointerId);
  } catch (_) { /* ignore */ }
  e.preventDefault();
  e.stopPropagation();

  if (handle === "scrub" || handle === "playhead") {
    // Jump immediately; keep playing if it was already playing.
    veSeekPreview(veTrimFromPointer(e.clientX), { resumeIfPlaying: wasPlaying });
  }
}

function veOnTrimPointerMove(e) {
  if (!veState.trimDrag) return;
  const drag = veState.trimDrag;
  if (Math.abs(e.clientX - (drag.startX || 0)) > 3) drag.moved = true;
  const t = veTrimFromPointer(e.clientX);
  const handle = drag.handle;
  const video = $("vePreview");

  if (handle === "start") {
    veState.start = Math.min(t, veState.end - 0.1);
    veUpdateTrimUi();
    veSeekPreview(veState.start);
    return;
  }
  if (handle === "end") {
    veState.end = Math.max(t, veState.start + 0.1);
    veUpdateTrimUi();
    veSeekPreview(veState.end);
    return;
  }

  // While dragging the playhead, pause so frames update smoothly, then resume on release.
  if (drag.moved && video && !video.paused) {
    video.pause();
  }
  veSeekPreview(t);
}

function veOnTrimPointerUp(e) {
  if (!veState.trimDrag) return;
  const drag = veState.trimDrag;
  const handle = drag.handle;
  const wasPlaying = drag.wasPlaying;
  veState.trimDrag = null;
  const track = $("veTrimTrack");
  try { track?.releasePointerCapture?.(e.pointerId); } catch (_) { /* ignore */ }

  if ((handle === "scrub" || handle === "playhead") && wasPlaying) {
    const video = $("vePreview");
    if (video?.paused) video.play().catch(() => {});
  }
}

function veIsEditedAsset(asset) {
  return (asset?.group || "").trim().toLowerCase() === "edited videos";
}

function veCurrentSourceAsset() {
  if (!veState.sourceId || !currentProject) return null;
  return (currentProject.assets || []).find((a) => a.id === veState.sourceId) || null;
}

const VE_OP_LABELS = {
  clip: "clip",
  speed: "speed",
  audio: "audio",
  rotate: "rotate",
  aspect: "aspect",
};

function veOpSaveLabel(op, busy = false) {
  if (busy) return "Saving…";
  const noun = VE_OP_LABELS[op] || "edit";
  return `Save ${noun}`;
}

function veOpPending(op) {
  if (op === "clip") {
    const fullClip =
      veState.start <= 0.05 &&
      (veState.duration <= 0 || veState.end >= veState.duration - 0.05);
    return !fullClip || (veState.removeRanges || []).length > 0;
  }
  if (op === "speed") {
    const speed = Number($("veSpeed")?.value) || 1;
    return Math.abs(speed - 1) >= 0.01;
  }
  if (op === "audio") {
    const mode = document.querySelector('input[name="veAudioMode"]:checked')?.value || "keep";
    if (mode === "mute") return true;
    if (mode === "replace" && $("veAudioSelect")?.value) return true;
    return false;
  }
  if (op === "rotate") {
    return ((veState.rotateDeg || 0) % 360) !== 0;
  }
  if (op === "aspect") {
    return (veState.aspectRatio || "original") !== "original" || veCropIsPartial();
  }
  return false;
}

function veHasPendingEdits() {
  return Object.keys(VE_OP_LABELS).some((op) => veOpPending(op));
}

function veSyncOpSaveButtons(controlsEnabled) {
  const on =
    typeof controlsEnabled === "boolean"
      ? controlsEnabled
      : Boolean(veState.sourceId && $("vePlayBtn") && !$("vePlayBtn").disabled);
  document.querySelectorAll(".ve-op-save").forEach((btn) => {
    const op = btn.dataset.veOp || "";
    const pending = veOpPending(op);
    btn.disabled = !on || !pending;
    if (!btn.dataset.veBusy) btn.textContent = veOpSaveLabel(op, false);
  });
}

function veSyncSaveModeUi(controlsEnabled) {
  const asset = veCurrentSourceAsset();
  const edited = veIsEditedAsset(asset);
  const hint = $("veSaveHint");
  const on =
    typeof controlsEnabled === "boolean"
      ? controlsEnabled
      : Boolean(veState.sourceId && $("vePlayBtn") && !$("vePlayBtn").disabled);
  if (hint) {
    if (!veState.sourceId) {
      hint.innerHTML = `<p class="text-[11px] text-amber-100/90 leading-relaxed">Select a video to edit.</p>`;
    } else if (edited) {
      hint.innerHTML = `<p class="text-[11px] text-amber-100/90 leading-relaxed">
        Each section saves on its own. When you save, you’ll choose to <strong class="font-medium">overwrite</strong> this edited asset or create a <strong class="font-medium">new</strong> one. There is no undo.
      </p>`;
    } else {
      hint.innerHTML = `<p class="text-[11px] text-amber-100/90 leading-relaxed">
        Each section has its own save and creates a <strong class="font-medium">new</strong> video. The source is never overwritten.
      </p>`;
    }
  }
  veSyncOpSaveButtons(on);
}

async function veAskSaveDestination(opLabel, otherPending = []) {
  const asset = veCurrentSourceAsset();
  const otherNote = otherPending.length
    ? `\n\nOther unsaved changes (${otherPending.map((o) => VE_OP_LABELS[o]).join(", ")}) will be discarded after this save.`
    : "";
  if (!veIsEditedAsset(asset)) {
    if (!otherPending.length) return "new";
    const ok = await confirmDialog({
      title: `Save ${opLabel}?`,
      message: `This creates a new video with the ${opLabel} change only.${otherNote}`,
      confirmText: `Save ${opLabel}`,
      footnote: "The source video is never overwritten.",
    });
    return ok ? "new" : null;
  }
  return choiceDialog({
    title: `Save ${opLabel}`,
    message: `Apply the ${opLabel} change only.${otherNote}`,
    footnote: "Overwrite replaces this edited asset in place. There is no undo.",
    cancelText: "Cancel",
    choices: [
      { id: "new", label: "Save as new", primary: true },
      { id: "overwrite", label: "Overwrite", danger: true },
    ],
  });
}

function veBuildEditBodyForOp(op, overwrite = false) {
  const body = {
    name: ($("veOutputName")?.value || "").trim() || undefined,
    overwrite: !!overwrite,
  };
  const scopeRaw = $("veOutputScope")?.value;
  if (scopeRaw !== undefined && scopeRaw !== "__inherit__") {
    body.set_post_id = true;
    body.post_id = scopeRaw === "" ? null : scopeRaw;
  }

  if (op === "clip") {
    const trimStart = veState.start > 0.05;
    const trimEnd = veState.duration > 0 && veState.end < veState.duration - 0.05;
    if (trimStart) body.start_s = veRound(veState.start);
    if (trimEnd || trimStart) body.end_s = veRound(veState.end);
    if ((veState.removeRanges || []).length) {
      body.remove_ranges = veState.removeRanges.map((r) => ({
        start_s: veRound(r.start),
        end_s: veRound(r.end),
      }));
    }
    return body;
  }

  if (op === "speed") {
    body.speed = Number($("veSpeed")?.value) || 1;
    return body;
  }

  if (op === "audio") {
    const mode = document.querySelector('input[name="veAudioMode"]:checked')?.value || "keep";
    body.mute = mode === "mute";
    if (mode === "replace") {
      body.audio_asset_id = $("veAudioSelect")?.value || undefined;
      body.audio_volume = Number($("veAudioVolume")?.value) || 1;
    }
    return body;
  }

  if (op === "rotate") {
    body.rotate_deg = ((veState.rotateDeg % 360) + 360) % 360;
    return body;
  }

  if (op === "aspect") {
    body.aspect_ratio = veState.aspectRatio || "original";
    const cropPx = veCropPixelsForSave();
    if (cropPx) {
      body.crop_x = cropPx.crop_x;
      body.crop_y = cropPx.crop_y;
      body.crop_w = cropPx.crop_w;
      body.crop_h = cropPx.crop_h;
    }
    return body;
  }

  return body;
}

async function veSaveEdit(op) {
  if (!veState.projectId || !veState.sourceId) return;
  const editOp = typeof op === "string" ? op : "";
  if (!VE_OP_LABELS[editOp]) {
    toast("Choose which edit to save", "info");
    return;
  }
  if (!veOpPending(editOp)) {
    toast(`Change ${VE_OP_LABELS[editOp]} before saving`, "info");
    return;
  }
  if (editOp === "audio") {
    const mode = document.querySelector('input[name="veAudioMode"]:checked')?.value || "keep";
    if (mode === "replace" && !$("veAudioSelect")?.value) {
      toast("Select an audio asset to replace with", "info");
      return;
    }
  }
  if (editOp === "aspect") {
    const cropPx = veCropPixelsForSave();
    if (!cropPx && (veState.aspectRatio || "original") === "custom") {
      toast("Set a crop region for custom aspect", "info");
      return;
    }
  }

  const otherPending = Object.keys(VE_OP_LABELS).filter((o) => o !== editOp && veOpPending(o));
  const destination = await veAskSaveDestination(VE_OP_LABELS[editOp], otherPending);
  if (!destination) return;
  const overwrite = destination === "overwrite";

  const body = veBuildEditBodyForOp(editOp, overwrite);
  const btn = document.querySelector(`.ve-op-save[data-ve-op="${editOp}"]`);
  document.querySelectorAll(".ve-op-save").forEach((el) => {
    el.disabled = true;
  });
  if (btn) {
    btn.dataset.veBusy = "1";
    btn.textContent = veOpSaveLabel(editOp, true);
  }
  veSetStatus(
    overwrite
      ? `Overwriting ${VE_OP_LABELS[editOp]}…`
      : `Encoding ${VE_OP_LABELS[editOp]}… this may take a moment.`
  );
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(veState.projectId)}/assets/${encodeURIComponent(veState.sourceId)}/video/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (data.project) currentProject = data.project;
    const name = data.asset?.name || "edit";
    if (data.overwritten) {
      toast(`Updated “${name}”`, "ok");
      veSetStatus(`Overwrote “${name}” (${VE_OP_LABELS[editOp]}).`, "ok");
    } else {
      toast(`Created “${name}”`, "ok");
      veSetStatus(`Saved “${name}” (${VE_OP_LABELS[editOp]}). Source unchanged.`, "ok");
    }
    vePopulateAudioSelect(currentProject);
    veRenderVideoList(currentProject);
    veRefreshCallerUi();
    if (data.asset?.id) await veSelectSource(data.asset.id);
  } catch (e) {
    toast(e.message || "Save failed", "error");
    veSetStatus(e.message || "Save failed", "error");
  } finally {
    if (btn) delete btn.dataset.veBusy;
    veSyncOpSaveButtons();
  }
}

async function refreshVideoEditor({ preferAssetId = null, focusPostId = null } = {}) {
  vePopulateProjectSelect();
  const projectId = currentProject?.id || "";
  const empty = $("veEmptyState");
  const workspace = $("veWorkspace");
  if (focusPostId !== undefined && focusPostId !== null) {
    veState.focusPostId = focusPostId || null;
  }
  if (!projectId) {
    veState.projectId = null;
    veState.sourceId = null;
    empty?.classList.remove("hidden");
    workspace?.classList.add("hidden");
    veSetControlsEnabled(false);
    return;
  }
  try {
    const project = await veEnsureProjectLoaded(projectId);
    veState.projectId = project?.id || projectId;
    const preferId = preferAssetId || veState.sourceId;
    const preferAsset = preferId
      ? (project?.assets || []).find((a) => a.id === preferId && a.type === "video")
      : null;
    if (preferAsset?.post_id) veState.focusPostId = preferAsset.post_id;
    fillAssetScopeSelect($("veOutputScope"), {
      selected: "__inherit__",
      includeInherit: true,
    });
    const videos = veProjectVideos(project);
    if (!videos.length) {
      empty?.classList.remove("hidden");
      workspace?.classList.add("hidden");
      veState.sourceId = null;
      veSetControlsEnabled(false);
      if ($("veSourceTitle")) $("veSourceTitle").textContent = "Preview";
      if ($("veSourceMeta")) $("veSourceMeta").textContent = "No videos available";
      return;
    }
    empty?.classList.add("hidden");
    workspace?.classList.remove("hidden");
    vePopulateAudioSelect(project);
    veRenderVideoList(project);
    const pickId = preferId && videos.some((v) => v.id === preferId)
      ? preferId
      : (veState.sourceId && videos.some((v) => v.id === veState.sourceId) ? veState.sourceId : videos[0].id);
    if (pickId !== veState.sourceId || !$("vePreview")?.src) {
      await veSelectSource(pickId);
    } else {
      veRenderVideoList(project);
    }
  } catch (e) {
    toast(e.message || "Could not load project", "error");
    empty?.classList.remove("hidden");
    workspace?.classList.add("hidden");
  }
}

function veRefreshCallerUi() {
  if (!currentProject) return;
  if (typeof activeTab !== "undefined" && activeTab === "hub") {
    try { renderAssets(); } catch (_) { /* ignore */ }
  }
  if (currentPost) {
    try { renderAssetPalette(); } catch (_) { /* ignore */ }
  }
  try { renderProjectHeader(); } catch (_) { /* ignore */ }
}

function isVideoEditorModalOpen() {
  const dlg = $("videoEditorDialog");
  return !!(dlg && !dlg.classList.contains("hidden"));
}

function closeVideoEditorModal({ silent = false } = {}) {
  const dlg = $("videoEditorDialog");
  const video = $("vePreview");
  if (video) {
    try { video.pause(); } catch (_) { /* ignore */ }
  }
  dlg?.classList.add("hidden");
  if (!silent) veRefreshCallerUi();
}

async function openVideoEditorModal(assetId, { postId = null } = {}) {
  if (!currentProject) {
    toast("Open a project first", "info");
    return;
  }
  const asset = (currentProject.assets || []).find((a) => a.id === assetId);
  if (!asset || asset.type !== "video" || !asset.original_path) {
    toast("Video asset not available", "error");
    return;
  }
  veState.focusPostId = postId || asset.post_id || null;
  veState.sourceId = assetId;
  const dlg = $("videoEditorDialog");
  dlg?.classList.remove("hidden");
  await refreshVideoEditor({ preferAssetId: assetId, focusPostId: veState.focusPostId });
}

/** @deprecated kept as alias for older call sites */
function onVideoEditorShown() {
  /* no-op: Video Editor is a modal opened via openVideoEditorModal */
}

// ---------- Image Editor (crop / resize / color) ----------
const EDITED_IMAGES_GROUP = "Edited images";

let ieState = {
  assetId: null,
  focusPostId: null,
  natW: 0,
  natH: 0,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  aspect: null,
  brightness: 1,
  contrast: 1,
  saturation: 1,
  sharpen: 1,
  blur: 0,
  grade: "none",
  rotateDeg: 0,
  flipH: false,
  flipV: false,
  resizeEnable: false,
  resizeLock: true,
  resizeW: 0,
  resizeH: 0,
  cropDrag: null,
  imgEl: null,
};

function isImageEditorModalOpen() {
  return !$("imageEditorDialog")?.classList.contains("hidden");
}

function ieIsEditedAsset(asset) {
  return (asset?.group || "").trim().toLowerCase() === EDITED_IMAGES_GROUP.toLowerCase();
}

function ieCurrentAsset() {
  if (!ieState.assetId || !currentProject) return null;
  return (currentProject.assets || []).find((a) => a.id === ieState.assetId) || null;
}

function ieClampCrop(crop) {
  let { x, y, w, h } = crop || { x: 0, y: 0, w: 1, h: 1 };
  w = Math.max(0.02, Math.min(1, w));
  h = Math.max(0.02, Math.min(1, h));
  x = Math.max(0, Math.min(1 - w, x));
  y = Math.max(0, Math.min(1 - h, y));
  return { x, y, w, h };
}

function ieMaxFitCrop(aspect) {
  if (!aspect || aspect <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  const imgAr = (ieState.natW || 1) / (ieState.natH || 1);
  let w = 1;
  let h = w / aspect * imgAr;
  if (h > 1) {
    h = 1;
    w = h * aspect / imgAr;
  }
  return ieClampCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
}

function ieCropIsPartial() {
  const c = ieClampCrop(ieState.crop);
  return c.x > 0.005 || c.y > 0.005 || c.w < 0.995 || c.h < 0.995;
}

function ieResetAdjustments() {
  ieState.brightness = 1;
  ieState.contrast = 1;
  ieState.saturation = 1;
  ieState.sharpen = 1;
  ieState.blur = 0;
  ieState.grade = "none";
  ieState.rotateDeg = 0;
  ieState.flipH = false;
  ieState.flipV = false;
  ieState.resizeEnable = false;
  ieState.resizeLock = true;
  ieState.aspect = null;
  ieState.crop = { x: 0, y: 0, w: 1, h: 1 };
  if (ieState.natW && ieState.natH) {
    ieState.resizeW = ieState.natW;
    ieState.resizeH = ieState.natH;
  }
  ieSyncControlsFromState();
  ieApplyPreviewStyles();
  ieRenderCropOverlay();
  ieUpdateMeta();
}

function ieSyncControlsFromState() {
  const setVal = (id, v) => { const el = $(id); if (el) el.value = String(v); };
  const setLabel = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  setVal("ieBrightness", ieState.brightness);
  setLabel("ieBrightnessLabel", Number(ieState.brightness).toFixed(2));
  setVal("ieContrast", ieState.contrast);
  setLabel("ieContrastLabel", Number(ieState.contrast).toFixed(2));
  setVal("ieSaturation", ieState.saturation);
  setLabel("ieSaturationLabel", Number(ieState.saturation).toFixed(2));
  setVal("ieSharpen", ieState.sharpen);
  setLabel("ieSharpenLabel", Number(ieState.sharpen).toFixed(2));
  setVal("ieBlur", ieState.blur);
  setLabel("ieBlurLabel", String(Number(ieState.blur)));
  if ($("ieRotateLabel")) $("ieRotateLabel").textContent = `${ieState.rotateDeg}°`;
  if ($("ieResizeEnable")) $("ieResizeEnable").checked = !!ieState.resizeEnable;
  if ($("ieResizeLock")) $("ieResizeLock").checked = !!ieState.resizeLock;
  $("ieResizeFields")?.classList.toggle("hidden", !ieState.resizeEnable);
  setVal("ieResizeW", ieState.resizeW || "");
  setVal("ieResizeH", ieState.resizeH || "");
  document.querySelectorAll(".ie-grade-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.ieGrade === ieState.grade);
  });
  document.querySelectorAll(".ie-aspect-btn").forEach((btn) => {
    const val = btn.dataset.ieAspect;
    const active = (ieState.aspect == null && val === "free")
      || (ieState.aspect != null && Number(val) === ieState.aspect);
    btn.classList.toggle("is-active", active);
  });
  $("ieFlipHBtn")?.classList.toggle("is-active", ieState.flipH);
  $("ieFlipVBtn")?.classList.toggle("is-active", ieState.flipV);
}

function ieApplyPreviewStyles() {
  const img = $("iePreview");
  if (!img) return;
  const filters = [
    `brightness(${ieState.brightness})`,
    `contrast(${ieState.contrast})`,
    `saturate(${ieState.saturation})`,
  ];
  if (ieState.blur > 0) filters.push(`blur(${Math.min(8, ieState.blur)}px)`);
  if (ieState.grade === "warm") filters.push("sepia(0.22) saturate(1.15)");
  if (ieState.grade === "cool") filters.push("hue-rotate(195deg) saturate(1.1)");
  img.style.filter = filters.join(" ");
  const sx = ieState.flipH ? -1 : 1;
  const sy = ieState.flipV ? -1 : 1;
  img.style.transform = `rotate(${ieState.rotateDeg}deg) scale(${sx}, ${sy})`;
}

function ieUpdateMeta() {
  const meta = $("ieSourceMeta");
  const cropMeta = $("ieCropMeta");
  const asset = ieCurrentAsset();
  if (meta) {
    if (!asset) meta.textContent = "No image selected";
    else meta.textContent = `${ieState.natW}×${ieState.natH}px · ${asset.name || ""}`;
  }
  if (cropMeta && ieState.natW) {
    const c = ieClampCrop(ieState.crop);
    const cw = Math.round(c.w * ieState.natW);
    const ch = Math.round(c.h * ieState.natH);
    cropMeta.textContent = `Crop ${cw}×${ch}px (${Math.round(c.w * 100)}% × ${Math.round(c.h * 100)}%)`;
  }
  ieSyncSaveHint();
}

function ieSyncSaveHint() {
  const hint = $("ieSaveHint");
  if (!hint) return;
  const asset = ieCurrentAsset();
  if (!asset) {
    hint.textContent = "Select an image to edit.";
    return;
  }
  if (ieIsEditedAsset(asset)) {
    hint.textContent = "Save will ask to overwrite this edited asset or create a new one. There is no undo.";
  } else {
    hint.textContent = "Save creates a new asset in Edited images. The source is never overwritten.";
  }
}

function ieRenderCropOverlay() {
  const overlay = $("ieCropOverlay");
  const box = $("ieCropBox");
  const stage = $("iePreviewStage");
  const img = $("iePreview");
  if (!overlay || !box || !stage || !img?.naturalWidth) return;

  const stageRect = stage.getBoundingClientRect();
  const imgRect = img.getBoundingClientRect();
  if (stageRect.width < 4 || imgRect.width < 4) return;

  const left = imgRect.left - stageRect.left;
  const top = imgRect.top - stageRect.top;
  const width = imgRect.width;
  const height = imgRect.height;

  overlay.style.left = `${left}px`;
  overlay.style.top = `${top}px`;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  overlay.style.right = "auto";
  overlay.style.bottom = "auto";
  overlay.style.inset = "auto";

  const c = ieClampCrop(ieState.crop);
  box.style.left = `${c.x * 100}%`;
  box.style.top = `${c.y * 100}%`;
  box.style.width = `${c.w * 100}%`;
  box.style.height = `${c.h * 100}%`;

  const shades = {
    top: overlay.querySelector('[data-shade="top"]'),
    left: overlay.querySelector('[data-shade="left"]'),
    right: overlay.querySelector('[data-shade="right"]'),
    bottom: overlay.querySelector('[data-shade="bottom"]'),
  };
  if (shades.top) Object.assign(shades.top.style, { left: "0", top: "0", width: "100%", height: `${c.y * 100}%` });
  if (shades.bottom) Object.assign(shades.bottom.style, { left: "0", top: `${(c.y + c.h) * 100}%`, width: "100%", height: `${(1 - c.y - c.h) * 100}%` });
  if (shades.left) Object.assign(shades.left.style, { left: "0", top: `${c.y * 100}%`, width: `${c.x * 100}%`, height: `${c.h * 100}%` });
  if (shades.right) Object.assign(shades.right.style, { left: `${(c.x + c.w) * 100}%`, top: `${c.y * 100}%`, width: `${(1 - c.x - c.w) * 100}%`, height: `${c.h * 100}%` });
}

function ieCropFromPointer(clientX, clientY) {
  const overlay = $("ieCropOverlay");
  if (!overlay) return { x: 0, y: 0 };
  const r = overlay.getBoundingClientRect();
  return {
    x: clamp((clientX - r.left) / Math.max(1, r.width), 0, 1),
    y: clamp((clientY - r.top) / Math.max(1, r.height), 0, 1),
  };
}

function ieOnCropPointerDown(e) {
  if (!isImageEditorModalOpen()) return;
  const handle = e.target?.dataset?.handle || e.target?.closest?.("[data-handle]")?.dataset?.handle;
  if (!handle) return;
  e.preventDefault();
  const pt = ieCropFromPointer(e.clientX, e.clientY);
  ieState.cropDrag = {
    handle,
    start: pt,
    origin: { ...ieClampCrop(ieState.crop) },
  };
  e.currentTarget?.setPointerCapture?.(e.pointerId);
}

function ieOnCropPointerMove(e) {
  if (!ieState.cropDrag) return;
  const pt = ieCropFromPointer(e.clientX, e.clientY);
  const o = ieState.cropDrag.origin;
  const dx = pt.x - ieState.cropDrag.start.x;
  const dy = pt.y - ieState.cropDrag.start.y;
  const handle = ieState.cropDrag.handle;
  let next = { ...o };
  const aspect = ieState.aspect;

  if (handle === "move") {
    next = ieClampCrop({ x: o.x + dx, y: o.y + dy, w: o.w, h: o.h });
  } else {
    let x = o.x;
    let y = o.y;
    let w = o.w;
    let h = o.h;
    if (handle.includes("w")) {
      const nx = clamp(o.x + dx, 0, o.x + o.w - 0.02);
      w = o.w - (nx - o.x);
      x = nx;
    }
    if (handle.includes("e")) {
      w = clamp(o.w + dx, 0.02, 1 - o.x);
    }
    if (handle.includes("n")) {
      const ny = clamp(o.y + dy, 0, o.y + o.h - 0.02);
      h = o.h - (ny - o.y);
      y = ny;
    }
    if (handle.includes("s")) {
      h = clamp(o.h + dy, 0.02, 1 - o.y);
    }
    if (aspect && aspect > 0 && ieState.natW && ieState.natH) {
      const imgAr = ieState.natW / ieState.natH;
      const targetNormAr = aspect / imgAr;
      if (handle === "e" || handle === "w") {
        h = w / targetNormAr;
        if (handle.includes("n")) y = o.y + o.h - h;
      } else if (handle === "n" || handle === "s") {
        w = h * targetNormAr;
        if (handle.includes("w")) x = o.x + o.w - w;
      } else {
        h = w / targetNormAr;
        if (handle.includes("n")) y = o.y + o.h - h;
        if (handle.includes("w")) x = o.x + o.w - w;
      }
    }
    next = ieClampCrop({ x, y, w, h });
  }
  ieState.crop = next;
  ieRenderCropOverlay();
  ieUpdateMeta();
}

function ieOnCropPointerUp(e) {
  if (!ieState.cropDrag) return;
  ieState.cropDrag = null;
  try { e.currentTarget?.releasePointerCapture?.(e.pointerId); } catch (_) { /* ignore */ }
}

function ieSetAspect(raw) {
  ieState.aspect = raw === "free" || raw == null || raw === "" ? null : Number(raw);
  if (ieState.aspect != null && !Number.isFinite(ieState.aspect)) ieState.aspect = null;
  if (ieState.aspect != null) ieState.crop = ieMaxFitCrop(ieState.aspect);
  ieSyncControlsFromState();
  ieRenderCropOverlay();
  ieUpdateMeta();
}

function ieCroppedPixelSize() {
  const c = ieClampCrop(ieState.crop);
  return {
    w: Math.max(1, Math.round(c.w * ieState.natW)),
    h: Math.max(1, Math.round(c.h * ieState.natH)),
  };
}

function ieHasEdits() {
  if (ieCropIsPartial()) return true;
  if (Math.abs(ieState.brightness - 1) >= 0.01) return true;
  if (Math.abs(ieState.contrast - 1) >= 0.01) return true;
  if (Math.abs(ieState.saturation - 1) >= 0.01) return true;
  if (ieState.sharpen > 1.01) return true;
  if (ieState.blur > 0.05) return true;
  if (ieState.grade && ieState.grade !== "none") return true;
  if ((ieState.rotateDeg || 0) % 360 !== 0) return true;
  if (ieState.flipH || ieState.flipV) return true;
  if (ieState.resizeEnable) {
    const { w, h } = ieCroppedPixelSize();
    if (ieState.resizeW !== w || ieState.resizeH !== h) return true;
  }
  return false;
}

function ieBuildOps() {
  const ops = [];
  // Transform first so crop box stays in source coordinates relative to upright image.
  // Preview applies CSS rotate/flip for display only; server ops order: rotate → flip → crop → color → resize.
  const rot = ((ieState.rotateDeg % 360) + 360) % 360;
  // Pillow rotate uses degrees; our UI uses clockwise positive like CSS.
  // photo_ops rotates with -degrees (CSS-like clockwise).
  if (rot === 90) ops.push({ op: "rotate", degrees: 90 });
  else if (rot === 180) ops.push({ op: "rotate", degrees: 180 });
  else if (rot === 270) ops.push({ op: "rotate", degrees: -90 });

  if (ieState.flipH) ops.push({ op: "flip", axis: "horizontal" });
  if (ieState.flipV) ops.push({ op: "flip", axis: "vertical" });

  // Note: crop is in pre-transform image space matching the overlay on the untransformed
  // source. When rotate/flip are set, crop is still applied after transform on the server,
  // so we skip crop when transform is active unless crop is full-frame... Actually the
  // overlay is drawn on the CSS-transformed image which doesn't rematch server order.
  // Keep crop in source-image coords (no CSS rotate on overlay positioning of crop).
  // We apply CSS transform on the img but crop overlay uses getBoundingClientRect of the
  // transformed img — so crop is in displayed (transformed) space. Server applies rotate
  // then crop — that matches if rotate expands and crop is on rotated result.
  // For simplicity: when rotate is non-zero, still send crop in normalized display coords
  // which approximate post-rotate frame when expand=True and 90° snaps.
  if (ieCropIsPartial()) {
    const c = ieClampCrop(ieState.crop);
    ops.push({ op: "crop", box: [c.x, c.y, c.x + c.w, c.y + c.h] });
  }

  if (Math.abs(ieState.brightness - 1) >= 0.01) {
    ops.push({ op: "brightness", value: ieState.brightness });
  }
  if (Math.abs(ieState.contrast - 1) >= 0.01) {
    ops.push({ op: "contrast", value: ieState.contrast });
  }
  if (Math.abs(ieState.saturation - 1) >= 0.01) {
    ops.push({ op: "saturation", value: ieState.saturation });
  }
  if (ieState.sharpen > 1.01) {
    ops.push({ op: "sharpen", value: ieState.sharpen });
  }
  if (ieState.blur > 0.05) {
    ops.push({ op: "blur", radius: ieState.blur });
  }
  if (ieState.grade && ieState.grade !== "none") {
    ops.push({ op: "grade", preset: ieState.grade });
  }

  if (ieState.resizeEnable) {
    const w = Math.max(8, Math.min(8192, Math.round(Number(ieState.resizeW) || 0)));
    const h = Math.max(8, Math.min(8192, Math.round(Number(ieState.resizeH) || 0)));
    const cropped = ieCroppedPixelSize();
    if (w !== cropped.w || h !== cropped.h) {
      ops.push({ op: "resize", width: w, height: h });
    }
  }
  return ops;
}

function closeImageEditorModal({ silent = false } = {}) {
  const dlg = $("imageEditorDialog");
  dlg?.classList.add("hidden");
  const img = $("iePreview");
  if (img) {
    img.onload = null;
    img.onerror = null;
    img.removeAttribute("src");
    img.style.filter = "";
    img.style.transform = "";
  }
  ieState.assetId = null;
  ieState.cropDrag = null;
  if (!silent) {
    if (activeTab === "hub") renderAssets();
    if (activeTab === "editor") renderAssetPalette();
  }
}

async function openImageEditorModal(assetId, { postId = null } = {}) {
  if (!currentProject) {
    toast("Open a project first", "info");
    return;
  }
  const asset = getAssetById(assetId) || (currentProject.assets || []).find((a) => a.id === assetId);
  if (!asset || asset.type !== "image") {
    toast("Only image assets can be edited", "info");
    return;
  }
  if (!asset.original_path) {
    toast("This asset has no source image", "error");
    return;
  }

  ieState.assetId = assetId;
  ieState.focusPostId = postId || asset.post_id || null;
  ieState.cropDrag = null;

  const dlg = $("imageEditorDialog");
  const title = $("ieDialogTitle");
  const badge = $("ieProjectBadge");
  if (title) title.textContent = `Image Editor · ${asset.name}`;
  if (badge) badge.textContent = currentProject.name || "";
  if ($("ieOutputName")) {
    $("ieOutputName").value = ieIsEditedAsset(asset)
      ? asset.name
      : `${asset.name} (edit)`.slice(0, 120);
  }
  fillAssetScopeSelect($("ieOutputScope"), {
    selected: "__inherit__",
    includeInherit: true,
    inheritLabel: "Same as source",
  });

  $("iePreviewStage")?.classList.add("hidden");
  $("iePreviewPlaceholder")?.classList.remove("hidden");
  if ($("iePreviewPlaceholder")) $("iePreviewPlaceholder").textContent = "Loading image…";
  dlg?.classList.remove("hidden");

  const img = $("iePreview");
  if (!img) return;
  img.onload = () => {
    ieState.natW = img.naturalWidth;
    ieState.natH = img.naturalHeight;
    ieState.resizeW = ieState.natW;
    ieState.resizeH = ieState.natH;
    ieResetAdjustments();
    $("iePreviewStage")?.classList.remove("hidden");
    $("iePreviewPlaceholder")?.classList.add("hidden");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ieRenderCropOverlay();
        ieUpdateMeta();
      });
    });
  };
  img.onerror = () => {
    if ($("iePreviewPlaceholder")) $("iePreviewPlaceholder").textContent = "Failed to load image";
    toast("Could not load image", "error");
  };
  img.src = assetFileUrl(currentProject.id, asset.original_path);
}

async function ieAskSaveDestination() {
  const asset = ieCurrentAsset();
  if (!ieIsEditedAsset(asset)) {
    const ok = await confirmDialog({
      title: "Save image edits?",
      message: "Creates a new asset in Edited images with your crop, color, and transform changes.",
      confirmText: "Save as new",
      footnote: "The source image is never overwritten.",
    });
    return ok ? "new" : null;
  }
  return choiceDialog({
    title: "Save image edits",
    message: "Apply the current adjustments.",
    footnote: "Overwrite replaces this edited asset in place. There is no undo.",
    cancelText: "Cancel",
    choices: [
      { id: "new", label: "Save as new", primary: true },
      { id: "overwrite", label: "Overwrite", danger: true },
    ],
  });
}

async function ieSaveEdits() {
  if (!currentProject || !ieState.assetId) return;
  const ops = ieBuildOps();
  if (!ops.length) {
    toast("No edits to save — adjust crop, color, size, or transform first", "info");
    return;
  }
  const dest = await ieAskSaveDestination();
  if (!dest) return;

  const btn = $("ieSaveBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  const body = {
    name: ($("ieOutputName")?.value || "").trim() || undefined,
    ops,
    overwrite: dest === "overwrite",
  };
  const scopeRaw = $("ieOutputScope")?.value;
  if (scopeRaw !== undefined && scopeRaw !== "__inherit__") {
    body.set_post_id = true;
    body.post_id = scopeRaw === "" ? null : scopeRaw;
  }

  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(currentProject.id)}/assets/${encodeURIComponent(ieState.assetId)}/photo/edit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (data.project) currentProject = data.project;
    toast(
      data.overwritten
        ? `Updated “${data.asset?.name || "image"}”`
        : `Created “${data.asset?.name || "edit"}”`,
      "ok",
    );
    closeImageEditorModal({ silent: true });
    await refreshProject({ reloadPost: false });
    startProjectPoll();
    if (activeTab === "hub") renderAssets();
    if (activeTab === "editor") renderAssetPalette();
  } catch (err) {
    toast(err.message || "Photo edit failed", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save edits"; }
  }
}

function wireImageEditorUi() {
  $("ieDialogClose")?.addEventListener("click", () => closeImageEditorModal());
  $("imageEditorDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "imageEditorDialog") closeImageEditorModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isImageEditorModalOpen()) return;
    if (!$("choiceDialog")?.classList.contains("hidden")) return;
    if (!$("confirmDialog")?.classList.contains("hidden")) return;
    if (!$("promptDialog")?.classList.contains("hidden")) return;
    if (isVideoEditorModalOpen()) return;
    closeImageEditorModal();
  });
  $("ieResetAllBtn")?.addEventListener("click", () => ieResetAdjustments());
  $("ieResetCropBtn")?.addEventListener("click", () => {
    ieState.crop = ieState.aspect != null ? ieMaxFitCrop(ieState.aspect) : { x: 0, y: 0, w: 1, h: 1 };
    ieRenderCropOverlay();
    ieUpdateMeta();
  });
  $("ieSaveBtn")?.addEventListener("click", () => ieSaveEdits());

  document.querySelectorAll(".ie-aspect-btn").forEach((btn) => {
    btn.addEventListener("click", () => ieSetAspect(btn.dataset.ieAspect));
  });
  document.querySelectorAll(".ie-grade-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      ieState.grade = btn.dataset.ieGrade || "none";
      ieSyncControlsFromState();
      ieApplyPreviewStyles();
    });
  });

  const bindRange = (id, key, labelId, fmt) => {
    $(id)?.addEventListener("input", (e) => {
      const v = Number(e.target.value);
      ieState[key] = v;
      if ($(labelId)) $(labelId).textContent = fmt(v);
      ieApplyPreviewStyles();
    });
  };
  bindRange("ieBrightness", "brightness", "ieBrightnessLabel", (v) => v.toFixed(2));
  bindRange("ieContrast", "contrast", "ieContrastLabel", (v) => v.toFixed(2));
  bindRange("ieSaturation", "saturation", "ieSaturationLabel", (v) => v.toFixed(2));
  bindRange("ieSharpen", "sharpen", "ieSharpenLabel", (v) => v.toFixed(2));
  bindRange("ieBlur", "blur", "ieBlurLabel", (v) => String(v));

  $("ieRotateLeftBtn")?.addEventListener("click", () => {
    ieState.rotateDeg = (ieState.rotateDeg - 90 + 360) % 360;
    ieSyncControlsFromState();
    ieApplyPreviewStyles();
    requestAnimationFrame(() => ieRenderCropOverlay());
  });
  $("ieRotateRightBtn")?.addEventListener("click", () => {
    ieState.rotateDeg = (ieState.rotateDeg + 90) % 360;
    ieSyncControlsFromState();
    ieApplyPreviewStyles();
    requestAnimationFrame(() => ieRenderCropOverlay());
  });
  $("ieFlipHBtn")?.addEventListener("click", () => {
    ieState.flipH = !ieState.flipH;
    ieSyncControlsFromState();
    ieApplyPreviewStyles();
    requestAnimationFrame(() => ieRenderCropOverlay());
  });
  $("ieFlipVBtn")?.addEventListener("click", () => {
    ieState.flipV = !ieState.flipV;
    ieSyncControlsFromState();
    ieApplyPreviewStyles();
    requestAnimationFrame(() => ieRenderCropOverlay());
  });

  $("ieResizeEnable")?.addEventListener("change", (e) => {
    ieState.resizeEnable = !!e.target.checked;
    if (ieState.resizeEnable) {
      const sz = ieCroppedPixelSize();
      ieState.resizeW = sz.w;
      ieState.resizeH = sz.h;
    }
    ieSyncControlsFromState();
  });
  $("ieResizeLock")?.addEventListener("change", (e) => {
    ieState.resizeLock = !!e.target.checked;
  });
  $("ieResizeW")?.addEventListener("input", (e) => {
    const w = Math.max(8, Math.round(Number(e.target.value) || 0));
    ieState.resizeW = w;
    if (ieState.resizeLock && ieState.natW && ieState.natH) {
      const sz = ieCroppedPixelSize();
      const ar = sz.w / Math.max(1, sz.h);
      ieState.resizeH = Math.max(8, Math.round(w / ar));
      if ($("ieResizeH")) $("ieResizeH").value = String(ieState.resizeH);
    }
  });
  $("ieResizeH")?.addEventListener("input", (e) => {
    const h = Math.max(8, Math.round(Number(e.target.value) || 0));
    ieState.resizeH = h;
    if (ieState.resizeLock && ieState.natW && ieState.natH) {
      const sz = ieCroppedPixelSize();
      const ar = sz.w / Math.max(1, sz.h);
      ieState.resizeW = Math.max(8, Math.round(h * ar));
      if ($("ieResizeW")) $("ieResizeW").value = String(ieState.resizeW);
    }
  });
  document.querySelectorAll(".ie-size-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetW = Number(btn.dataset.ieSize) || 1080;
      const sz = ieCroppedPixelSize();
      const ar = sz.w / Math.max(1, sz.h);
      ieState.resizeEnable = true;
      ieState.resizeW = targetW;
      ieState.resizeH = Math.max(8, Math.round(targetW / ar));
      ieSyncControlsFromState();
    });
  });

  const overlay = $("ieCropOverlay");
  if (overlay) {
    overlay.addEventListener("pointerdown", ieOnCropPointerDown);
    overlay.addEventListener("pointermove", ieOnCropPointerMove);
    overlay.addEventListener("pointerup", ieOnCropPointerUp);
    overlay.addEventListener("pointercancel", ieOnCropPointerUp);
  }
  window.addEventListener("resize", () => {
    if (isImageEditorModalOpen()) ieRenderCropOverlay();
  });
}

// ---------- Media Manager ----------
function mmFileUrl(folderId, relPath) {
  const params = new URLSearchParams({
    folder_id: folderId || "",
    path: relPath || "",
  });
  return `/api/media/file?${params.toString()}`;
}

function mmTypeIcon(type) {
  if (type === "video") return "movie";
  if (type === "audio") return "audiotrack";
  return "image";
}

function setMmTab(tab) {
  mmTab = tab === "publish" ? "publish" : "local";
  $("mmPaneLocal")?.classList.toggle("hidden", mmTab !== "local");
  $("mmPanePublish")?.classList.toggle("hidden", mmTab !== "publish");
  document.querySelectorAll(".mm-tab").forEach((btn) => {
    const active = btn.dataset.mmTab === mmTab;
    btn.classList.toggle("border-indigo-400/40", active);
    btn.classList.toggle("bg-indigo-500/15", active);
    btn.classList.toggle("text-indigo-100", active);
    btn.classList.toggle("border-white/10", !active);
    btn.classList.toggle("text-slate-300", !active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (mmTab === "publish") {
    syncMmPublishSelectionHint();
    renderMmPublishPlatformChecks();
    loadMmPackages();
  }
}

function syncMmActionButtons() {
  const hasFolder = !!mmActiveFolderId;
  const hasSel = mmSelectedPaths.size > 0;
  ["mmRefreshFilesBtn", "mmFileSearch", "mmFileTypeFilter"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !hasFolder;
  });
  if ($("mmImportBtn")) $("mmImportBtn").disabled = !hasSel;
  if ($("mmPreparePublishBtn")) $("mmPreparePublishBtn").disabled = !hasSel;
  if ($("mmCreatePackageBtn")) $("mmCreatePackageBtn").disabled = !hasSel;
  syncMmPublishSelectionHint();
}

function syncMmPublishSelectionHint() {
  const el = $("mmPublishSelectionHint");
  if (!el) return;
  const n = mmSelectedPaths.size;
  if (!mmActiveFolderId) {
    el.textContent = "Select a folder and files in Local library first.";
    return;
  }
  el.textContent = n
    ? `${n} file${n === 1 ? "" : "s"} selected from the current folder.`
    : "No files selected — pick files in Local library.";
}

async function onMediaManagerShown() {
  syncHeaderAppNav();
  const mmBadge = $("mmProjectBadge");
  if (mmBadge) {
    mmBadge.textContent = currentProject?.name
      ? `Using project · ${currentProject.name}`
      : "Select a project in the header to browse folders and import";
  }
  setMmTab(mmTab);
  if (!currentProject?.id) {
    mmFolders = [];
    mmFiles = [];
    mmSelectedPaths = new Set();
    mmActiveFolderId = null;
    renderMmFolders();
    renderMmFiles();
    syncMmActionButtons();
    await loadMmPlatforms().catch(() => { /* optional */ });
    return;
  }
  await Promise.all([loadMmFolders(), loadMmPlatforms()]);
  if (mmActiveFolderId) await loadMmFiles();
  else renderMmFiles();
  if (mmTab === "publish") await loadMmPackages();
}

async function loadMmFolders() {
  if (!currentProject?.id) {
    mmFolders = [];
    renderMmFolders();
    syncMmActionButtons();
    return;
  }
  try {
    const data = await api(projectMediaFoldersUrl());
    mmFolders = Array.isArray(data.folders) ? data.folders : [];
    if (mmActiveFolderId && !mmFolders.some((f) => f.id === mmActiveFolderId)) {
      mmActiveFolderId = null;
      mmFiles = [];
      mmSelectedPaths = new Set();
    }
    renderMmFolders();
    syncMmActionButtons();
  } catch (e) {
    toast(e.message || "Could not load folders", "error");
  }
}

function renderMmFolders() {
  const list = $("mmFolderList");
  const empty = $("mmFolderEmpty");
  if (!list) return;
  list.innerHTML = "";
  if (!mmFolders.length) {
    empty?.classList.remove("hidden");
    return;
  }
  empty?.classList.add("hidden");
  mmFolders.forEach((folder) => {
    const active = folder.id === mmActiveFolderId;
    const row = document.createElement("div");
    row.className =
      "rounded-lg border px-2.5 py-2 cursor-pointer " +
      (active
        ? "border-indigo-400/40 bg-indigo-500/10"
        : "border-white/10 hover:border-white/20");
    row.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="text-sm text-slate-100 truncate">${escapeHtml(folder.label || "Folder")}</p>
          <p class="text-[10px] text-slate-500 font-mono truncate mt-0.5" title="${escapeHtml(folder.path || "")}">${escapeHtml(folder.path || "")}</p>
          ${folder.enabled === false ? '<p class="text-[10px] text-amber-300/80 mt-0.5">Disabled</p>' : ""}
        </div>
        <button type="button" class="mm-folder-remove shrink-0 text-slate-500 hover:text-red-300 text-xs px-1" data-id="${escapeHtml(folder.id)}" title="Remove">×</button>
      </div>`;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".mm-folder-remove")) return;
      selectMmFolder(folder.id);
    });
    row.querySelector(".mm-folder-remove")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog({
        title: "Remove folder?",
        message: `Stop monitoring “${folder.label || folder.path}”? Files on disk are not deleted.`,
        confirmText: "Remove",
        danger: true,
      });
      if (!ok) return;
      try {
        await api(projectMediaFoldersUrl(`/${encodeURIComponent(folder.id)}`), { method: "DELETE" });
        if (mmActiveFolderId === folder.id) {
          mmActiveFolderId = null;
          mmFiles = [];
          mmSelectedPaths = new Set();
          renderMmFiles();
        }
        await loadMmFolders();
        toast("Folder removed", "ok");
      } catch (err) {
        toast(err.message || "Remove failed", "error");
      }
    });
    list.appendChild(row);
  });
}

async function selectMmFolder(folderId) {
  mmActiveFolderId = folderId;
  mmSelectedPaths = new Set();
  renderMmFolders();
  syncMmActionButtons();
  await loadMmFiles();
}

async function addMmFolder() {
  const label = ($("mmFolderLabel")?.value || "").trim() || "Folder";
  const path = ($("mmFolderPath")?.value || "").trim();
  if (!path) {
    toast("Browse to choose a folder first", "error");
    openMmBrowseDialog();
    return;
  }
  try {
    const data = await api(projectMediaFoldersUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, path, enabled: true }),
    });
    if ($("mmFolderLabel")) $("mmFolderLabel").value = "";
    if ($("mmFolderPath")) $("mmFolderPath").value = "";
    await loadMmFolders();
    if (data.folder?.id) await selectMmFolder(data.folder.id);
    toast("Folder added", "ok");
  } catch (e) {
    toast(e.message || "Could not add folder", "error");
  }
}

async function openMmBrowseDialog(startPath) {
  const dlg = $("mmBrowseDialog");
  dlg?.classList.remove("hidden");
  const initial =
    (typeof startPath === "string" && startPath) ||
    ($("mmFolderPath")?.value || "").trim() ||
    "";
  await loadMmBrowse(initial);
}

function closeMmBrowseDialog() {
  $("mmBrowseDialog")?.classList.add("hidden");
}

async function loadMmBrowse(path) {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  try {
    const data = await api(`/api/media/browse?${params.toString()}`);
    mmBrowsePath = data.path || "";
    mmBrowseParent = data.parent || null;
    renderMmBrowse(data);
  } catch (e) {
    toast(e.message || "Could not browse folder", "error");
  }
}

function renderMmBrowse(data) {
  const pathEl = $("mmBrowsePath");
  if (pathEl) {
    pathEl.textContent = data.path || "";
    pathEl.title = data.path || "";
  }
  const upBtn = $("mmBrowseUpBtn");
  if (upBtn) upBtn.disabled = !data.parent;

  const roots = $("mmBrowseRoots");
  if (roots) {
    roots.innerHTML = (data.roots || [])
      .map(
        (r) => `
      <button type="button" class="mm-browse-root text-[10px] px-2 py-1 rounded-lg border border-white/10 text-slate-300 hover:border-indigo-400/40 hover:text-indigo-100 ${
        r.path === data.path ? "border-indigo-400/40 bg-indigo-500/15 text-indigo-100" : ""
      }" data-path="${escapeHtml(r.path)}">${escapeHtml(r.label)}</button>`
      )
      .join("");
    roots.querySelectorAll(".mm-browse-root").forEach((btn) => {
      btn.addEventListener("click", () => loadMmBrowse(btn.dataset.path));
    });
  }

  const list = $("mmBrowseList");
  const empty = $("mmBrowseEmpty");
  if (!list) return;
  list.innerHTML = "";
  const dirs = Array.isArray(data.directories) ? data.directories : [];
  if (!dirs.length) {
    empty?.classList.remove("hidden");
    return;
  }
  empty?.classList.add("hidden");
  dirs.forEach((dir) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className =
      "w-full flex items-center gap-2 text-left rounded-lg px-2.5 py-2 border border-transparent hover:border-white/15 hover:bg-white/5 text-sm text-slate-200";
    row.innerHTML = `
      <span class="material-icons text-[18px] text-indigo-300/80" aria-hidden="true">folder</span>
      <span class="truncate">${escapeHtml(dir.name)}</span>`;
    row.addEventListener("click", () => loadMmBrowse(dir.path));
    row.addEventListener("dblclick", () => loadMmBrowse(dir.path));
    list.appendChild(row);
  });
}

function confirmMmBrowseSelection() {
  const path = mmBrowsePath;
  if (!path) {
    toast("No folder selected", "error");
    return;
  }
  if ($("mmFolderPath")) $("mmFolderPath").value = path;
  const labelEl = $("mmFolderLabel");
  if (labelEl && !(labelEl.value || "").trim()) {
    const base = path.split(/[/\\]/).filter(Boolean).pop() || "Folder";
    labelEl.value = base;
  }
  closeMmBrowseDialog();
}

async function loadMmFiles() {
  if (!mmActiveFolderId) {
    mmFiles = [];
    renderMmFiles();
    return;
  }
  const q = ($("mmFileSearch")?.value || "").trim();
  const mediaType = $("mmFileTypeFilter")?.value || "all";
  const params = new URLSearchParams({ q, media_type: mediaType });
  try {
    const data = await api(
      projectMediaFoldersUrl(`/${encodeURIComponent(mmActiveFolderId)}/files?${params.toString()}`)
    );
    mmFiles = Array.isArray(data.files) ? data.files : [];
    const keep = new Set(mmFiles.map((f) => f.path));
    mmSelectedPaths = new Set([...mmSelectedPaths].filter((p) => keep.has(p)));
    renderMmFiles();
    syncMmActionButtons();
  } catch (e) {
    toast(e.message || "Could not list files", "error");
    mmFiles = [];
    renderMmFiles();
  }
}

function renderMmFiles() {
  const grid = $("mmFileGrid");
  const empty = $("mmFilesEmpty");
  const title = $("mmFilesTitle");
  const meta = $("mmFilesMeta");
  const folder = mmFolders.find((f) => f.id === mmActiveFolderId);
  if (title) title.textContent = folder ? folder.label || "Files" : "Files";
  if (meta) {
    meta.textContent = folder
      ? `${mmFiles.length} media file${mmFiles.length === 1 ? "" : "s"}${
          mmSelectedPaths.size ? ` · ${mmSelectedPaths.size} selected` : ""
        }`
      : "Select a folder";
  }
  if (!grid) return;
  grid.innerHTML = "";
  if (!mmActiveFolderId) {
    empty?.classList.remove("hidden");
    if (empty) empty.textContent = "Select a monitored folder to list media.";
    return;
  }
  if (!mmFiles.length) {
    empty?.classList.remove("hidden");
    if (empty) empty.textContent = "No matching media files in this folder.";
    return;
  }
  empty?.classList.add("hidden");
  mmFiles.forEach((file) => {
    const selected = mmSelectedPaths.has(file.path);
    const card = document.createElement("article");
    card.className = "mm-file-card" + (selected ? " is-selected" : "");
    card.dataset.path = file.path;
    const canEdit = file.type === "image" || file.type === "video";
    const editLabel = file.type === "video" ? "Edit video" : "Edit photo";
    const thumbInner =
      file.type === "image"
        ? `<img src="${mmFileUrl(mmActiveFolderId, file.path)}" alt="" loading="lazy" />`
        : `<span class="material-icons text-3xl text-slate-500">${mmTypeIcon(file.type)}</span>`;
    card.innerHTML = `
      <span class="mm-file-check" aria-hidden="true">✓</span>
      <div class="mm-file-thumb">${thumbInner}</div>
      <div class="px-2 py-1.5">
        <p class="text-[11px] text-slate-200 truncate" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</p>
        <p class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(file.type)} · ${escapeHtml(file.size_human || "")}</p>
      </div>
      <div class="mm-file-actions">
        <button type="button" class="mm-file-action mm-file-preview-btn">Preview</button>
        ${canEdit ? `<button type="button" class="mm-file-action mm-file-edit-btn">${escapeHtml(editLabel)}</button>` : ""}
      </div>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (mmSelectedPaths.has(file.path)) mmSelectedPaths.delete(file.path);
      else mmSelectedPaths.add(file.path);
      renderMmFiles();
      syncMmActionButtons();
    });
    card.querySelector(".mm-file-preview-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openMmPreview(file);
    });
    card.querySelector(".mm-file-edit-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      editMmFile(file);
    });
    card.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      openMmPreview(file);
    });
    grid.appendChild(card);
  });
}

function openMediaPreview({ url, type, title, meta, assetId, mmFile = null } = {}) {
  const dlg = $("mmPreviewDialog");
  const body = $("mmPreviewBody");
  if (!dlg || !body) return;
  mmPreviewEditFile = mmFile && (mmFile.type === "image" || mmFile.type === "video") ? mmFile : null;
  if ($("mmPreviewTitle")) $("mmPreviewTitle").textContent = title || "Preview";
  if ($("mmPreviewMeta")) $("mmPreviewMeta").textContent = meta || "";
  body.innerHTML = "";
  const setThumbBtn = $("mmPreviewSetThumb");
  if (setThumbBtn) {
    setThumbBtn.classList.add("hidden");
    setThumbBtn.dataset.assetId = "";
  }
  const editBtn = $("mmPreviewEdit");
  if (editBtn) {
    const canEditMm = !!(mmPreviewEditFile && (mmPreviewEditFile.type === "image" || mmPreviewEditFile.type === "video"));
    editBtn.classList.toggle("hidden", !canEditMm);
    if (canEditMm) {
      editBtn.innerHTML = `<span class="material-icons text-[14px] leading-none" aria-hidden="true">tune</span> ${
        mmPreviewEditFile.type === "video" ? "Edit video" : "Edit photo"
      }`;
    }
  }
  if (!url) {
    body.innerHTML = `<p class="text-sm text-slate-400 p-4">No preview available.</p>`;
  } else if (type === "image") {
    const img = document.createElement("img");
    img.src = url;
    img.alt = title || "";
    img.className = "max-h-[70vh] max-w-full object-contain";
    body.appendChild(img);
  } else if (type === "video") {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.autoplay = true;
    video.className = "max-h-[70vh] max-w-full";
    video.dataset.previewVideo = "1";
    body.appendChild(video);
    if (setThumbBtn && assetId) {
      setThumbBtn.classList.remove("hidden");
      setThumbBtn.dataset.assetId = assetId;
    }
  } else if (type === "audio") {
    const audio = document.createElement("audio");
    audio.src = url;
    audio.controls = true;
    audio.autoplay = true;
    audio.className = "w-full";
    body.appendChild(audio);
  } else {
    body.innerHTML = `<p class="text-sm text-slate-400 p-4">No preview for this type.</p>`;
  }
  dlg.classList.remove("hidden");
}

function openMmPreview(file) {
  if (!mmActiveFolderId || !file) return;
  openMediaPreview({
    url: mmFileUrl(mmActiveFolderId, file.path),
    type: file.type,
    title: file.name || "Preview",
    meta: `${file.type || ""} · ${file.size_human || ""} · ${file.path || ""}`,
    mmFile: file,
  });
}

function openAssetPreview(asset) {
  if (!asset || !currentProject) return;
  let url = null;
  if (asset.type === "image" || asset.type === "video") {
    url = getAssetPreviewUrl(asset);
  } else if (asset.type === "audio") {
    url = getAudioAssetUrl(asset);
  }
  if (!url) {
    toast("No preview available for this asset", "info");
    return;
  }
  const mediaSummary = formatAssetMediaSummary(asset);
  openMediaPreview({
    url,
    type: asset.type,
    title: asset.name || "Preview",
    meta: [asset.type, mediaSummary, asset.original_filename].filter(Boolean).join(" · "),
    assetId: asset.type === "video" ? asset.id : undefined,
  });
}

async function generateVideoThumb(assetId, timeS = null) {
  if (!currentProject?.id || !assetId) return null;
  try {
    toast(timeS != null ? "Saving thumbnail from this frame…" : "Generating video thumbnail…", "info");
    const body = timeS != null && Number.isFinite(timeS) ? { time_s: Math.max(0, timeS) } : {};
    const data = await api(
      `/api/projects/${encodeURIComponent(currentProject.id)}/assets/${encodeURIComponent(assetId)}/thumb`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (data.project) currentProject = data.project;
    else if (data.asset) {
      const idx = (currentProject.assets || []).findIndex((a) => a.id === assetId);
      if (idx >= 0) currentProject.assets[idx] = data.asset;
    }
    toast("Thumbnail saved", "success");
    if (activeTab === "hub") renderAssets();
    if (!$("panelEditor")?.classList.contains("hidden")) renderAssetPalette();
    return data.asset || null;
  } catch (err) {
    toast(err.message || "Thumbnail generation failed", "error");
    return null;
  }
}

function closeMmPreview() {
  $("mmPreviewDialog")?.classList.add("hidden");
  const body = $("mmPreviewBody");
  body?.querySelectorAll("video, audio").forEach((el) => {
    try { el.pause(); } catch (_) { /* ignore */ }
  });
  if (body) body.innerHTML = "";
  mmPreviewEditFile = null;
  $("mmPreviewEdit")?.classList.add("hidden");
  const setThumbBtn = $("mmPreviewSetThumb");
  if (setThumbBtn) {
    setThumbBtn.classList.add("hidden");
    setThumbBtn.dataset.assetId = "";
  }
}

async function importMmPaths(paths, { group = "", postId = null } = {}) {
  if (!currentProject?.id) throw new Error("Select a project in the header first");
  if (!mmActiveFolderId) throw new Error("Select a monitored folder first");
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length) throw new Error("No files to import");
  const data = await api("/api/media/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: currentProject.id,
      folder_id: mmActiveFolderId,
      paths: list,
      group: (group || "").trim(),
      post_id: postId || null,
    }),
  });
  if (data.project && currentProject?.id === data.project.id) {
    currentProject = data.project;
  }
  return data;
}

async function editMmFile(file) {
  if (!file || (file.type !== "image" && file.type !== "video")) {
    toast("Only photos and videos can be edited", "info");
    return;
  }
  if (!currentProject?.id) {
    toast("Select a project in the header first", "info");
    return;
  }
  if (!mmActiveFolderId) {
    toast("Select a folder first", "info");
    return;
  }
  toast(`Importing “${file.name || "file"}” for editing…`, "info");
  try {
    const data = await importMmPaths([file.path], { postId: null });
    const assetDump = (data.imported || [])[0];
    if (!assetDump?.id) {
      const err = (data.errors || [])[0]?.error;
      throw new Error(err || "Import produced no asset");
    }
    if (!getAssetById(assetDump.id)) {
      await refreshProject({ reloadPost: false });
    }
    const asset = getAssetById(assetDump.id) || assetDump;
    closeMmPreview();
    const kind = asset.type || file.type;
    if (kind === "image") {
      await openImageEditorModal(asset.id, { postId: asset.post_id || null });
    } else if (kind === "video") {
      await openVideoEditorModal(asset.id, { postId: asset.post_id || null });
    } else {
      toast("Imported, but this type has no editor", "info");
    }
  } catch (e) {
    toast(e.message || "Could not open editor", "error");
  }
}

async function openMmImportDialog() {
  if (!mmActiveFolderId || !mmSelectedPaths.size) {
    toast("Select files to import", "info");
    return;
  }
  if (!currentProject?.id) {
    toast("Open a project first to import media", "info");
    return;
  }
  try {
    $("mmImportProjectWrap")?.classList.add("hidden");
    if ($("mmImportProject")) $("mmImportProject").value = currentProject.id;
    fillAssetScopeSelect($("mmImportScope"), { selected: currentPost?.id || "" });
    if ($("mmImportHint")) {
      $("mmImportHint").textContent = `Import ${mmSelectedPaths.size} file${
        mmSelectedPaths.size === 1 ? "" : "s"
      } into “${currentProject.name}”.`;
    }
    $("mmImportDialog")?.classList.remove("hidden");
  } catch (e) {
    toast(e.message || "Could not open import dialog", "error");
  }
}

function closeMmImportDialog() {
  $("mmImportDialog")?.classList.add("hidden");
}

async function confirmMmImport() {
  const projectId = currentProject?.id || $("mmImportProject")?.value;
  if (!projectId) {
    toast("Open a project first", "error");
    return;
  }
  if (!currentProject?.id || currentProject.id !== projectId) {
    toast("Open the target project in the header first", "error");
    return;
  }
  const btn = $("mmImportConfirm");
  if (btn) btn.disabled = true;
  try {
    const data = await importMmPaths([...mmSelectedPaths], {
      group: ($("mmImportGroup")?.value || "").trim(),
      postId: readAssetScopeValue("mmImportScope", { fallback: null }),
    });
    const n = data.imported_count || 0;
    const errN = (data.errors || []).length;
    if (n) toast(`Imported ${n} asset${n === 1 ? "" : "s"}`, "ok");
    if (errN) toast(`${errN} file${errN === 1 ? "" : "s"} failed`, "error");
    closeMmImportDialog();
    await refreshProject({ reloadPost: false });
  } catch (e) {
    toast(e.message || "Import failed", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadMmPlatforms() {
  try {
    const data = await api("/api/media/publish/platforms");
    mmPlatforms = Array.isArray(data.platforms) ? data.platforms : [];
    renderMmPlatforms();
    renderMmPublishPlatformChecks();
  } catch (e) {
    toast(e.message || "Could not load platforms", "error");
  }
}

function renderMmPlatforms() {
  const list = $("mmPlatformList");
  if (!list) return;
  list.innerHTML = "";
  mmPlatforms.forEach((p, idx) => {
    const row = document.createElement("div");
    row.className = "rounded-lg border border-white/10 p-3 space-y-2";
    row.innerHTML = `
      <div class="flex items-center gap-2 flex-wrap">
        <label class="inline-flex items-center gap-1.5 text-xs text-slate-300">
          <input type="checkbox" class="mm-plat-enabled rounded border-white/20" data-idx="${idx}" ${p.enabled !== false ? "checked" : ""} />
          Enabled
        </label>
        <input type="text" class="mm-plat-label flex-1 min-w-[8rem] rounded-lg bg-black/30 border border-white/10 px-2 py-1 text-sm text-slate-100" data-idx="${idx}" value="${escapeHtml(p.label || "")}" placeholder="Label" />
        <button type="button" class="mm-plat-remove text-xs text-slate-500 hover:text-red-300 px-1" data-idx="${idx}">Remove</button>
      </div>
      <input type="url" class="mm-plat-url w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-100 font-mono" data-idx="${idx}" value="${escapeHtml(p.contributor_url || "")}" placeholder="https://… contributor upload URL" />
      <input type="text" class="mm-plat-notes w-full rounded-lg bg-black/30 border border-white/10 px-2 py-1 text-xs text-slate-300" data-idx="${idx}" value="${escapeHtml(p.notes || "")}" placeholder="Notes (optional)" />
      <input type="hidden" class="mm-plat-id" data-idx="${idx}" value="${escapeHtml(p.id || "")}" />
    `;
    list.appendChild(row);
  });
  list.querySelectorAll(".mm-plat-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.idx);
      mmPlatforms.splice(i, 1);
      renderMmPlatforms();
      renderMmPublishPlatformChecks();
    });
  });
}

function collectMmPlatformsFromForm() {
  const list = $("mmPlatformList");
  if (!list) return mmPlatforms.slice();
  const rows = [...list.children];
  return rows.map((row, idx) => {
    const id = row.querySelector(".mm-plat-id")?.value || mmPlatforms[idx]?.id || "";
    return {
      id,
      label: row.querySelector(".mm-plat-label")?.value?.trim() || "Stock platform",
      enabled: !!row.querySelector(".mm-plat-enabled")?.checked,
      contributor_url: row.querySelector(".mm-plat-url")?.value?.trim() || "",
      notes: row.querySelector(".mm-plat-notes")?.value?.trim() || "",
    };
  });
}

function addMmPlatform() {
  mmPlatforms = collectMmPlatformsFromForm();
  mmPlatforms.push({
    id: "",
    label: "Custom platform",
    enabled: true,
    contributor_url: "",
    notes: "",
  });
  renderMmPlatforms();
  renderMmPublishPlatformChecks();
}

async function saveMmPlatforms() {
  const platforms = collectMmPlatformsFromForm();
  try {
    const data = await api("/api/media/publish/platforms", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platforms }),
    });
    mmPlatforms = Array.isArray(data.platforms) ? data.platforms : platforms;
    renderMmPlatforms();
    renderMmPublishPlatformChecks();
    toast("Platforms saved", "ok");
  } catch (e) {
    toast(e.message || "Save failed", "error");
  }
}

function renderMmPublishPlatformChecks() {
  const box = $("mmPublishPlatformChecks");
  if (!box) return;
  const enabled = mmPlatforms.filter((p) => p.enabled !== false);
  if (!enabled.length) {
    box.innerHTML = `<p class="text-xs text-slate-500">Enable at least one platform above.</p>`;
    return;
  }
  box.innerHTML = enabled
    .map(
      (p) => `
      <label class="inline-flex items-center gap-1.5 text-xs text-slate-300 border border-white/10 rounded-lg px-2 py-1">
        <input type="checkbox" class="mm-pub-plat rounded border-white/20" value="${escapeHtml(p.id)}" checked />
        ${escapeHtml(p.label || p.id)}
      </label>`
    )
    .join("");
}

async function createMmPublishPackage() {
  if (!mmActiveFolderId || !mmSelectedPaths.size) {
    toast("Select files in Local library first", "info");
    return;
  }
  const platformIds = [...document.querySelectorAll(".mm-pub-plat:checked")].map((el) => el.value);
  if (!platformIds.length) {
    toast("Select at least one platform", "error");
    return;
  }
  const tags = ($("mmPublishTags")?.value || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const btn = $("mmCreatePackageBtn");
  if (btn) btn.disabled = true;
  try {
    const data = await api("/api/media/publish/packages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder_id: mmActiveFolderId,
        paths: [...mmSelectedPaths],
        platform_ids: platformIds,
        title: ($("mmPublishTitle")?.value || "").trim(),
        description: ($("mmPublishDescription")?.value || "").trim(),
        tags,
      }),
    });
    toast("Package created", "ok");
    await loadMmPackages();
    setMmTab("publish");
    if (data.package?.package_dir) {
      // Keep selection; user may open portals next
    }
  } catch (e) {
    toast(e.message || "Could not create package", "error");
  } finally {
    syncMmActionButtons();
  }
}

async function loadMmPackages() {
  try {
    const data = await api("/api/media/publish/packages");
    mmPackages = Array.isArray(data.packages) ? data.packages : [];
    renderMmPackages();
  } catch (e) {
    toast(e.message || "Could not load packages", "error");
  }
}

function renderMmPackages() {
  const list = $("mmPackageList");
  const empty = $("mmPackagesEmpty");
  if (!list) return;
  list.innerHTML = "";
  if (!mmPackages.length) {
    empty?.classList.remove("hidden");
    return;
  }
  empty?.classList.add("hidden");
  mmPackages.forEach((pkg) => {
    const row = document.createElement("div");
    row.className = "rounded-lg border border-white/10 p-3 space-y-2";
    const plats = (pkg.platforms || []).map((p) => p.label || p.id).join(", ");
    row.innerHTML = `
      <div class="flex items-start justify-between gap-2 flex-wrap">
        <div class="min-w-0">
          <p class="text-sm text-slate-100">${escapeHtml(pkg.title || "(untitled)")}</p>
          <p class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(pkg.status || "draft")} · ${
            pkg.file_count || (pkg.files || []).length || 0
          } files · ${escapeHtml(plats || "no platforms")}</p>
          <p class="text-[10px] text-slate-600 font-mono truncate mt-0.5" title="${escapeHtml(
            pkg.package_dir || ""
          )}">${escapeHtml(pkg.package_dir || "")}</p>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap">
          <button type="button" class="mm-pkg-open text-xs px-2 py-1 rounded-lg border border-indigo-400/35 text-indigo-100" data-id="${escapeHtml(
            pkg.id
          )}">Open portals</button>
          <button type="button" class="mm-pkg-submit text-xs px-2 py-1 rounded-lg border border-emerald-400/35 text-emerald-200 ${
            pkg.status === "submitted" ? "opacity-40" : ""
          }" data-id="${escapeHtml(pkg.id)}" ${pkg.status === "submitted" ? "disabled" : ""}>Mark submitted</button>
        </div>
      </div>`;
    list.appendChild(row);
  });
  list.querySelectorAll(".mm-pkg-open").forEach((btn) => {
    btn.addEventListener("click", () => openMmPackagePortals(btn.dataset.id));
  });
  list.querySelectorAll(".mm-pkg-submit").forEach((btn) => {
    btn.addEventListener("click", () => markMmPackageSubmitted(btn.dataset.id));
  });
}

async function openMmPackagePortals(packageId) {
  try {
    const data = await api(`/api/media/publish/packages/${encodeURIComponent(packageId)}/open`, {
      method: "POST",
    });
    const urls = (data.contributor_urls || []).filter((u) => u.contributor_url);
    if (!urls.length) {
      toast("No contributor URLs configured", "info");
    } else {
      urls.forEach((u) => {
        try {
          window.open(u.contributor_url, "_blank", "noopener,noreferrer");
        } catch (_) { /* ignore */ }
      });
      toast(`Opened ${urls.length} portal${urls.length === 1 ? "" : "s"}`, "ok");
    }
    await loadMmPackages();
  } catch (e) {
    toast(e.message || "Could not open package", "error");
  }
}

async function markMmPackageSubmitted(packageId) {
  try {
    await api(`/api/media/publish/packages/${encodeURIComponent(packageId)}/mark-submitted`, {
      method: "POST",
    });
    toast("Marked submitted", "ok");
    await loadMmPackages();
  } catch (e) {
    toast(e.message || "Update failed", "error");
  }
}

function wireMediaManagerUi() {
  document.querySelectorAll(".mm-tab").forEach((btn) => {
    btn.addEventListener("click", () => setMmTab(btn.dataset.mmTab));
  });
  $("mmAddFolderBtn")?.addEventListener("click", addMmFolder);
  $("mmBrowseFolderBtn")?.addEventListener("click", () => openMmBrowseDialog());
  $("mmBrowseClose")?.addEventListener("click", closeMmBrowseDialog);
  $("mmBrowseCancel")?.addEventListener("click", closeMmBrowseDialog);
  $("mmBrowseSelect")?.addEventListener("click", confirmMmBrowseSelection);
  $("mmBrowseUpBtn")?.addEventListener("click", () => {
    if (mmBrowseParent) loadMmBrowse(mmBrowseParent);
  });
  $("mmBrowseDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "mmBrowseDialog") closeMmBrowseDialog();
  });
  $("mmRefreshFilesBtn")?.addEventListener("click", loadMmFiles);
  $("mmFileTypeFilter")?.addEventListener("change", loadMmFiles);
  $("mmFileSearch")?.addEventListener("input", () => {
    clearTimeout(mmSearchTimer);
    mmSearchTimer = setTimeout(loadMmFiles, 250);
  });
  $("mmImportBtn")?.addEventListener("click", openMmImportDialog);
  $("mmImportClose")?.addEventListener("click", closeMmImportDialog);
  $("mmImportCancel")?.addEventListener("click", closeMmImportDialog);
  $("mmImportConfirm")?.addEventListener("click", confirmMmImport);
  $("mmImportDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "mmImportDialog") closeMmImportDialog();
  });
  $("mmPreviewClose")?.addEventListener("click", closeMmPreview);
  $("mmPreviewDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "mmPreviewDialog") closeMmPreview();
  });
  $("mmPreviewEdit")?.addEventListener("click", () => {
    if (mmPreviewEditFile) editMmFile(mmPreviewEditFile);
  });
  $("mmPreviewSetThumb")?.addEventListener("click", async () => {
    const btn = $("mmPreviewSetThumb");
    const assetId = btn?.dataset.assetId;
    if (!assetId) return;
    const video = $("mmPreviewBody")?.querySelector("video");
    const timeS = video && Number.isFinite(video.currentTime) ? video.currentTime : null;
    const updated = await generateVideoThumb(assetId, timeS);
    if (updated) closeMmPreview();
  });
  $("mmPreparePublishBtn")?.addEventListener("click", () => {
    setMmTab("publish");
    syncMmPublishSelectionHint();
  });
  $("mmAddPlatformBtn")?.addEventListener("click", addMmPlatform);
  $("mmSavePlatformsBtn")?.addEventListener("click", saveMmPlatforms);
  $("mmCreatePackageBtn")?.addEventListener("click", createMmPublishPackage);
  $("mmRefreshPackagesBtn")?.addEventListener("click", loadMmPackages);
}


async function openVeStockUploadDialog() {
  if (!veState.projectId || !veState.sourceId) {
    toast("Select a video first", "info");
    return;
  }
  const asset = (currentProject?.assets || []).find((a) => a.id === veState.sourceId);
  if (!asset) {
    toast("Video asset not found", "error");
    return;
  }
  let sites = [];
  try {
    const data = await api("/api/stock/settings");
    sites = (data.upload_sites || []).filter((s) => s.enabled !== false);
  } catch (e) {
    toast(e.message || "Could not load stock sites", "error");
    return;
  }
  const dlg = $("veStockUploadDialog");
  const list = $("veStockUploadSites");
  const hint = $("veStockUploadSitesHint");
  if ($("veStockUploadAsset")) {
    $("veStockUploadAsset").textContent = `Asset: ${asset.name || asset.id}`;
  }
  if ($("veStockTitle")) $("veStockTitle").value = asset.name || "";
  if ($("veStockDescription")) $("veStockDescription").value = asset.description || "";
  if ($("veStockKeywords")) $("veStockKeywords").value = "";
  if ($("veStockCategory")) $("veStockCategory").value = "";
  if ($("veStockFilename")) $("veStockFilename").value = `${(asset.name || "clip").replace(/[^\w.\-]+/g, "_")}.mp4`;
  const results = $("veStockUploadResults");
  if (results) {
    results.classList.add("hidden");
    results.innerHTML = "";
  }
  if (!sites.length) {
    if (list) list.innerHTML = "";
    hint?.classList.remove("hidden");
  } else {
    hint?.classList.add("hidden");
    if (list) {
      list.innerHTML = sites.map((s) => {
        const label = `${s.name} · ${s.provider}`;
        return `<label class="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" class="ve-stock-site" value="${escapeHtml(s.id)}" checked />
          <span class="truncate">${escapeHtml(label)}</span>
        </label>`;
      }).join("");
    }
  }
  dlg?.classList.remove("hidden");
}

function closeVeStockUploadDialog() {
  $("veStockUploadDialog")?.classList.add("hidden");
}

async function confirmVeStockUpload() {
  if (!veState.projectId || !veState.sourceId) return;
  const siteIds = [...document.querySelectorAll(".ve-stock-site:checked")].map((el) => el.value);
  if (!siteIds.length) {
    toast("Select at least one destination", "info");
    return;
  }
  const title = ($("veStockTitle")?.value || "").trim();
  if (!title) {
    toast("Title is required", "info");
    return;
  }
  const keywords = ($("veStockKeywords")?.value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const btn = $("veStockUploadConfirm");
  if (btn) { btn.disabled = true; btn.textContent = "Uploading…"; }
  try {
    const data = await api(
      `/api/projects/${encodeURIComponent(veState.projectId)}/assets/${encodeURIComponent(veState.sourceId)}/stock/upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          site_ids: siteIds,
          title,
          description: ($("veStockDescription")?.value || "").trim(),
          keywords,
          category: ($("veStockCategory")?.value || "").trim(),
          filename: ($("veStockFilename")?.value || "").trim() || undefined,
        }),
      }
    );
    const results = $("veStockUploadResults");
    if (results) {
      results.classList.remove("hidden");
      results.innerHTML = (data.results || []).map((r) => {
        const cls = r.ok ? "text-emerald-300" : "text-red-300";
        const portal = r.portal_url
          ? ` · <a href="${escapeHtml(r.portal_url)}" target="_blank" rel="noopener" class="underline text-indigo-300">portal</a>`
          : "";
        const pkg = r.package_dir ? ` · package: ${escapeHtml(r.package_dir)}` : "";
        return `<li class="${cls}"><strong>${escapeHtml(r.site_name)}</strong>: ${escapeHtml(r.message || "")}${portal}${pkg}</li>`;
      }).join("");
    }
    const ok = Number(data.ok_count) || 0;
    const fail = Number(data.fail_count) || 0;
    if (fail && !ok) toast("All stock uploads failed", "error");
    else if (fail) toast(`Uploaded to ${ok} site(s); ${fail} failed`, "info");
    else toast(`Uploaded to ${ok} site(s)`, "ok");
    // Open first portal on success for FTPS/SFTP follow-up metadata.
    const firstPortal = (data.results || []).find((r) => r.ok && r.portal_url)?.portal_url;
    if (firstPortal) {
      try { window.open(firstPortal, "_blank", "noopener"); } catch (_) { /* ignore */ }
    }
  } catch (e) {
    toast(e.message || "Upload failed", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Upload"; }
  }
}

function wireVideoEditorUi() {
  $("veRefreshBtn")?.addEventListener("click", () => refreshVideoEditor({ preferAssetId: veState.sourceId }));
  $("veDialogClose")?.addEventListener("click", () => closeVideoEditorModal());
  $("videoEditorDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "videoEditorDialog") closeVideoEditorModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isVideoEditorModalOpen()) return;
    if (!$("veStockUploadDialog")?.classList.contains("hidden")) return;
    if (!$("choiceDialog")?.classList.contains("hidden")) return;
    if (!$("confirmDialog")?.classList.contains("hidden")) return;
    if (!$("promptDialog")?.classList.contains("hidden")) return;
    closeVideoEditorModal();
  });
  // veProjectSelect removed — Video Editor uses the open project shell.
  $("veUploadStockBtn")?.addEventListener("click", openVeStockUploadDialog);
  $("veStockUploadClose")?.addEventListener("click", closeVeStockUploadDialog);
  $("veStockUploadCancel")?.addEventListener("click", closeVeStockUploadDialog);
  $("veStockUploadConfirm")?.addEventListener("click", confirmVeStockUpload);
  $("veStockUploadDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "veStockUploadDialog") closeVeStockUploadDialog();
  });
  $("vePlayBtn")?.addEventListener("click", veTogglePlay);
  $("veAddCutBtn")?.addEventListener("click", veAddCutAtPlayhead);
  $("veClearCutsBtn")?.addEventListener("click", veClearCuts);
  document.querySelectorAll(".ve-op-save").forEach((btn) => {
    btn.addEventListener("click", () => veSaveEdit(btn.dataset.veOp || ""));
  });
  $("veSpeed")?.addEventListener("input", (e) => {
    const v = Number(e.target.value) || 1;
    if ($("veSpeedLabel")) $("veSpeedLabel").textContent = `${v.toFixed(2).replace(/\.?0+$/, "")}×`;
    veSyncSpeedPresets(v);
    const video = $("vePreview");
    if (video) video.playbackRate = v;
    veSyncOpSaveButtons();
  });
  document.querySelectorAll(".ve-speed-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = Number(btn.dataset.veSpeed) || 1;
      if ($("veSpeed")) $("veSpeed").value = String(v);
      if ($("veSpeedLabel")) $("veSpeedLabel").textContent = `${v}×`;
      veSyncSpeedPresets(v);
      const video = $("vePreview");
      if (video) video.playbackRate = v;
      veSyncOpSaveButtons();
    });
  });
  document.querySelectorAll(".ve-aspect-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      veSetAspectRatio(btn.dataset.veAspect || "original");
    });
  });
  $("veRotateLeftBtn")?.addEventListener("click", () => veRotateBy(-90));
  $("veRotateRightBtn")?.addEventListener("click", () => veRotateBy(90));
  $("veRotateResetBtn")?.addEventListener("click", () => veSetRotate(0));
  $("veAspectLock")?.addEventListener("change", (e) => {
    veState.aspectLocked = !!e.target.checked;
  });
  $("veAspectApplyBtn")?.addEventListener("click", veApplyCustomAspectInputs);
  $("veResetCropBtn")?.addEventListener("click", veResetCrop);
  $("veResetCropPresetBtn")?.addEventListener("click", veResetCrop);
  const cropOverlay = $("veCropOverlay");
  if (cropOverlay) {
    cropOverlay.addEventListener("pointerdown", veOnCropPointerDown);
    cropOverlay.addEventListener("pointermove", veOnCropPointerMove);
    cropOverlay.addEventListener("pointerup", veOnCropPointerUp);
    cropOverlay.addEventListener("pointercancel", veOnCropPointerUp);
  }
  document.querySelectorAll(".ve-audio-mode").forEach((el) => {
    el.addEventListener("change", veSyncAudioModeUi);
  });
  $("veAudioSelect")?.addEventListener("change", veSyncOpSaveButtons);
  $("veAudioVolume")?.addEventListener("input", (e) => {
    const v = Number(e.target.value) || 1;
    if ($("veAudioVolumeLabel")) $("veAudioVolumeLabel").textContent = `${Math.round(v * 100)}%`;
  });
  $("veStartInput")?.addEventListener("change", () => {
    veState.start = Number($("veStartInput").value) || 0;
    veUpdateTrimUi();
  });
  $("veEndInput")?.addEventListener("change", () => {
    veState.end = Number($("veEndInput").value) || 0;
    veUpdateTrimUi();
  });
  const video = $("vePreview");
  if (video) {
    video.addEventListener("loadedmetadata", veOnVideoMeta);
    video.addEventListener("timeupdate", veOnTimeUpdate);
    video.addEventListener("play", veUpdatePlayhead);
    video.addEventListener("pause", veUpdatePlayhead);
  }
  const trimTrack = $("veTrimTrack");
  if (trimTrack) {
    trimTrack.addEventListener("pointerdown", veOnTrimPointerDown);
    trimTrack.addEventListener("pointermove", veOnTrimPointerMove);
    trimTrack.addEventListener("pointerup", veOnTrimPointerUp);
    trimTrack.addEventListener("pointercancel", veOnTrimPointerUp);
  }
}

function setAiTab(tab) {
  aiActiveTab = tab;
  document.querySelectorAll(".ai-tab").forEach((btn) => {
    const active = btn.dataset.aiTab === tab;
    btn.classList.toggle("border-violet-400", active);
    btn.classList.toggle("text-violet-200", active);
    btn.classList.toggle("border-transparent", !active);
    btn.classList.toggle("text-slate-400", !active);
  });
  $("aiTabChat")?.classList.toggle("hidden", tab !== "chat");
  $("aiTabScript")?.classList.toggle("hidden", tab !== "script");
  $("aiTabPhoto")?.classList.toggle("hidden", tab !== "photo");
  $("aiTabSuggest")?.classList.toggle("hidden", tab !== "suggest");
}

function syncAiScriptTabVisibility() {
  const isVideo = currentPost?.type === "video";
  $("aiTabScriptBtn")?.classList.toggle("hidden", !isVideo);
  if (!isVideo && aiActiveTab === "script") setAiTab("chat");
}

function populateAiPhotoTargets() {
  const sel = $("aiPhotoTarget");
  if (!sel || !currentProject || !currentPost) return;
  const opts = [];
  if (selectedLayerId) {
    const layer = getLayerById(selectedLayerId);
    if (layer?.type === "image" && layer.asset_id) {
      opts.push(`<option value="layer:${layer.id}">Selected image layer</option>`);
    }
  }
  for (const a of visibleAssets().filter((x) => x.type === "image")) {
    opts.push(`<option value="asset:${a.id}">${escapeHtml(a.name)}${a.post_id ? " · post" : ""}</option>`);
  }
  if (!opts.length) {
    opts.push(`<option value="">No images available for this post</option>`);
  }
  sel.innerHTML = opts.join("");
}

function openAiPanel(tab = "chat") {
  if (!currentProject || !currentPost) {
    toast("Open a post first", "error");
    return;
  }
  // Restore assets/timeline while AI sits on the preview.
  propsOverlayOpen = false;
  syncLeftColumnMode(false);
  $("aiPanelOverlay")?.classList.remove("hidden");
  syncAiScriptTabVisibility();
  const resolved = tab === "script" && currentPost.type !== "video" ? "chat" : tab;
  setAiTab(resolved);
  populateAiPhotoTargets();
  refreshAiCapabilities();
}

function closeAiPanel() {
  $("aiPanelOverlay")?.classList.add("hidden");
}

function setLayoutProposal(post, summary) {
  aiProposedPost = post;
  if ($("aiLayoutSummary")) $("aiLayoutSummary").textContent = summary || "";
  if ($("aiScriptSummary")) $("aiScriptSummary").textContent = summary || "";
  $("aiLayoutApplyBtn")?.classList.toggle("hidden", !post);
  $("aiLayoutDiscardBtn")?.classList.toggle("hidden", !post);
  $("aiScriptApplyBtn")?.classList.toggle("hidden", !post);
  $("aiScriptDiscardBtn")?.classList.toggle("hidden", !post);
}

async function aiLayoutPropose() {
  if (!currentProject || !currentPost) return;
  const instruction = $("aiLayoutInstruction")?.value?.trim();
  if (!instruction) { toast("Enter a layout instruction", "error"); return; }
  const btn = $("aiLayoutProposeBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Thinking…"; }
  try {
    await savePostNow();
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/ai/layout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction, apply: false, include_preview: true }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(detailMessage(data, `HTTP ${r.status}`));
    setLayoutProposal(data.post, data.summary);
    toast("Layout proposal ready", "ok");
  } catch (e) {
    toast(`Layout AI failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Propose"; }
  }
}

async function synthesizeAllPendingTts() {
  if (!currentProject || !currentPost || currentPost.type !== "video") return 0;
  const pending = [];
  for (const scene of currentPost.scenes || []) {
    for (const layer of scene.layers || []) {
      if (layer.type === "tts" && (layer.text || "").trim() && !layer.asset_id) {
        pending.push({ sceneId: scene.id, layer });
      }
    }
  }
  if (!pending.length) return 0;
  let ok = 0;
  for (const { sceneId, layer } of pending) {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/tts/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          post_id: currentPost.id,
          scene_id: sceneId,
          layer_id: layer.id,
          text: layer.text,
          voice: layer.tts_voice || currentPost.default_tts_voice,
          volume: layer.tts_volume,
          mood: layer.tts_mood || "neutral",
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(detailMessage(data, `HTTP ${r.status}`));
      if (data.project) currentProject = data.project;
      if (data.post) currentPost = data.post;
      ok += 1;
    } catch (e) {
      toast(`Speech failed for “${(layer.text || "").slice(0, 40)}…”: ${e.message}`, "error");
    }
  }
  return ok;
}

async function aiLayoutApply() {
  if (!currentProject || !currentPost || !aiProposedPost) return;
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ post: aiProposedPost }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(detailMessage(data, `HTTP ${r.status}`));
    currentPost = data.post || aiProposedPost;
    setLayoutProposal(null, "Applied.");
    renderLayers();
    renderInteractiveCanvas();
    renderSceneGantt();
    const ttsCount = await synthesizeAllPendingTts();
    if (ttsCount > 0) {
      renderLayers();
      renderInteractiveCanvas();
      renderSceneGantt();
      toast(`Layout applied · ${ttsCount} voice clip${ttsCount === 1 ? "" : "s"} generated`, "ok");
    } else {
      toast("Layout applied", "ok");
    }
  } catch (e) {
    toast(`Apply failed: ${e.message}`, "error");
  }
}

async function aiScriptGenerate() {
  if (!currentProject || !currentPost) return;
  if (currentPost.type !== "video") {
    toast("Script-to-video is only for video posts", "error");
    return;
  }
  const script = $("aiScriptText")?.value?.trim();
  if (!script) { toast("Paste or upload a script first", "error"); return; }
  const btn = $("aiScriptGenerateBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Building…"; }
  try {
    await savePostNow();
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/ai/script-video`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script, apply: false, include_preview: false }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(detailMessage(data, `HTTP ${r.status}`));
    setLayoutProposal(data.post, data.summary);
    toast("Script video proposal ready", "ok");
  } catch (e) {
    toast(`Script-to-video failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Generate from script"; }
  }
}

function onAiScriptFileChange(ev) {
  const file = ev.target?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = typeof reader.result === "string" ? reader.result : "";
    if ($("aiScriptText")) $("aiScriptText").value = text;
    toast(`Loaded ${file.name}`, "ok");
  };
  reader.onerror = () => toast("Could not read script file", "error");
  reader.readAsText(file);
}

async function aiPhotoRun() {
  if (!currentProject || !currentPost) return;
  const instruction = $("aiPhotoInstruction")?.value?.trim();
  if (!instruction) { toast("Enter a photo edit instruction", "error"); return; }
  const useLocal = !!$("aiPhotoLocalOps")?.checked;
  const useGen = !!$("aiPhotoGenerative")?.checked;
  if (!useLocal && !useGen) { toast("Enable local ops and/or generative", "error"); return; }

  const target = $("aiPhotoTarget")?.value || "background";
  const payload = {
    instruction,
    use_local_ops: useLocal,
    use_generative: useGen,
    set_as_background: false,
  };
  const addAsBottom = !!$("aiPhotoSetBg")?.checked;
  if (target.startsWith("layer:")) {
    payload.layer_id = target.slice(6);
    payload.replace_layer_id = payload.layer_id;
  } else if (target.startsWith("asset:")) {
    payload.asset_id = target.slice(6);
  } else {
    toast("Pick an image to edit", "error");
    return;
  }

  const btn = $("aiPhotoRunBtn");
  const status = $("aiPhotoStatus");
  if (btn) { btn.disabled = true; btn.textContent = "Editing…"; }
  if (status) status.textContent = "Working…";
  try {
    await savePostNow();
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/ai/photo-edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(detailMessage(data, `HTTP ${r.status}`));
    if (status) status.textContent = data.summary || "Done";
    toast(data.summary || "Photo edit complete", "ok");
    await refreshProject({ reloadPost: !!data.post });
    if (data.post) currentPost = data.post;
    if (addAsBottom && data.asset?.id) {
      addImageLayer(data.asset.id, null, { format: getTargetFormat(), asBottom: true });
    }
    populateAiPhotoTargets();
    renderInteractiveCanvas();
  } catch (e) {
    if (status) status.textContent = "";
    toast(`Photo edit failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Edit photo"; }
  }
}

async function aiSuggestRun() {
  if (!currentProject || !currentPost) return;
  const btn = $("aiSuggestBtn");
  const list = $("aiSuggestList");
  if (btn) { btn.disabled = true; btn.textContent = "Analyzing…"; }
  if (list) list.innerHTML = "";
  try {
    await savePostNow();
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/ai/suggest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ include_preview: true }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(detailMessage(data, `HTTP ${r.status}`));
    if ($("aiSuggestDisclaimer")) $("aiSuggestDisclaimer").textContent = data.disclaimer || "";
    const items = data.suggestions || [];
    if (!items.length) {
      if (list) list.innerHTML = `<li class="text-xs text-slate-500">No suggestions returned.</li>`;
      return;
    }
    for (const s of items) {
      const li = document.createElement("li");
      li.className = "rounded-lg border border-white/10 bg-black/25 p-2 space-y-1";
      const sev = s.severity === "critical" ? "text-red-300" : s.severity === "warn" ? "text-amber-300" : "text-slate-400";
      li.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="text-xs text-slate-200 font-medium">${s.title || "Suggestion"}</div>
            <div class="text-[10px] ${sev} uppercase tracking-wider">${s.category || "design"} · ${s.severity || "info"}</div>
          </div>
          ${s.action?.post ? `<button type="button" class="ai-suggest-apply text-[10px] px-2 py-1 rounded border border-emerald-400/30 text-emerald-200 shrink-0" data-id="${s.id}">Apply</button>` : ""}
        </div>
        <p class="text-[11px] text-slate-400">${s.detail || ""}</p>`;
      list.appendChild(li);
      const applyBtn = li.querySelector(".ai-suggest-apply");
      if (applyBtn && s.action?.post) {
        applyBtn.addEventListener("click", async () => {
          try {
            const pr = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ post: s.action.post }),
            });
            const pdata = await pr.json().catch(() => ({}));
            if (!pr.ok) throw new Error(detailMessage(pdata, `HTTP ${pr.status}`));
            currentPost = pdata.post || s.action.post;
            renderLayers();
            renderInteractiveCanvas();
            renderSceneGantt();
            toast(s.action.summary || "Suggestion applied", "ok");
          } catch (err) {
            toast(`Apply failed: ${err.message}`, "error");
          }
        });
      }
    }
  } catch (e) {
    toast(`Suggest failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Analyze post"; }
  }
}

function stopPreviewPlayback() {
  previewPlaying = false;
  previewPlayLastTs = 0;
  if (previewPlayRaf) {
    cancelAnimationFrame(previewPlayRaf);
    previewPlayRaf = 0;
  }
  pausePreviewAudio();
  pausePreviewVideos();
  const btn = $("previewPlayBtn");
  if (btn) btn.textContent = "Play";
}

function getAudioAssetUrl(asset) {
  if (!asset?.original_path || !currentProject) return null;
  const bust = asset.updated_at ? `&t=${encodeURIComponent(asset.updated_at)}` : "";
  return `${assetFileUrl(currentProject.id, asset.original_path)}${bust}`;
}

/** Flatten reusable scene refs the same way export mixes audio. */
function expandScenesForPreviewAudio(post, stack = null) {
  if (!post || post.type !== "video") return [];
  const seen = stack || new Set();
  if (seen.has(post.id)) return [];
  const nested = new Set(seen);
  nested.add(post.id);
  const out = [];
  for (const scene of post.scenes || []) {
    const refId = String(scene.ref_post_id || "").trim();
    if (!refId) {
      out.push(scene);
      continue;
    }
    const src = findProjectPost(refId);
    if (!src || src.type !== "video") {
      out.push({
        id: scene.id,
        name: scene.name || "Missing reusable post",
        duration_s: Math.max(0.5, Number(scene.duration_s) || 0.5),
        gap_before_s: Math.max(0, Number(scene.gap_before_s) || 0),
        layers: [],
      });
      continue;
    }
    const expanded = expandScenesForPreviewAudio(src, nested);
    if (!expanded.length) continue;
    out.push({
      ...expanded[0],
      gap_before_s: Math.max(0, Number(scene.gap_before_s) || 0),
    });
    for (let i = 1; i < expanded.length; i += 1) out.push(expanded[i]);
  }
  return out;
}

/** Clips aligned to absolute timeline time — mirrors server _collect_audio_clips. */
function collectPreviewAudioClips() {
  if (!currentProject || !currentPost || currentPost.type !== "video") return [];
  const clips = [];
  let offset = 0;
  for (const scene of expandScenesForPreviewAudio(currentPost)) {
    offset += Math.max(0, Number(scene.gap_before_s) || 0);
    const sceneDur = Math.max(0.5, Number(scene.duration_s) || 0.5);
    for (const layer of scene.layers || []) {
      if (layer.type !== "tts" && layer.type !== "audio") continue;
      if (!layer.asset_id) continue;
      const asset = getAssetById(layer.asset_id);
      const url = getAudioAssetUrl(asset);
      if (!url) continue;
      const startAbs = offset + Math.max(0, Number(layer.start_s) || 0);
      const duration = layerEffectiveDuration(layer, sceneDur);
      const volume = clamp(Number(layer.tts_volume), 0, 1);
      const vol = Number.isFinite(volume) ? volume : 1;
      clips.push({
        key: `${layer.id}:${startAbs.toFixed(3)}:${layer.asset_id}`,
        url,
        startAbs,
        duration: Math.max(0.05, duration),
        volume: vol,
      });
    }
    offset += sceneDur;
  }
  if (currentPost.music_asset_id) {
    const asset = getAssetById(currentPost.music_asset_id);
    const url = getAudioAssetUrl(asset);
    if (url) {
      const volRaw = Number(currentPost.music_volume);
      clips.push({
        key: `legacy-music:${currentPost.music_asset_id}`,
        url,
        startAbs: 0,
        duration: Math.max(0.5, getTotalDuration()),
        volume: Number.isFinite(volRaw) ? clamp(volRaw, 0, 1) : 0.8,
      });
    }
  }
  return clips;
}

function pausePreviewAudio() {
  for (const entry of previewAudioPlayers.values()) {
    try {
      if (!entry.audio.paused) entry.audio.pause();
    } catch (_) { /* ignore */ }
  }
}

function disposePreviewAudio() {
  for (const entry of previewAudioPlayers.values()) {
    try {
      entry.audio.pause();
      entry.audio.removeAttribute("src");
      entry.audio.load();
    } catch (_) { /* ignore */ }
  }
  previewAudioPlayers.clear();
  disposePreviewVideos();
}

function pausePreviewVideos() {
  for (const video of previewVideoEls.values()) {
    try {
      if (!video.paused) video.pause();
    } catch (_) { /* ignore */ }
  }
  const bgVideo = $("canvasBackgroundVideo");
  if (bgVideo && !bgVideo.paused) {
    try { bgVideo.pause(); } catch (_) { /* ignore */ }
  }
}

function disposePreviewVideos() {
  for (const video of previewVideoEls.values()) {
    try {
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (_) { /* ignore */ }
  }
  previewVideoEls.clear();
  const bgVideo = $("canvasBackgroundVideo");
  if (bgVideo) {
    try {
      bgVideo.pause();
      bgVideo.removeAttribute("src");
      bgVideo.load();
    } catch (_) { /* ignore */ }
  }
}

/** Timed video clips on the absolute timeline (mirrors audio clip collection). */
function collectPreviewVideoClips() {
  if (!currentProject || !currentPost || currentPost.type !== "video") return [];
  const clips = [];
  let offset = 0;
  for (const scene of expandScenesForPreviewAudio(currentPost)) {
    offset += Math.max(0, Number(scene.gap_before_s) || 0);
    const sceneDur = Math.max(0.5, Number(scene.duration_s) || 0.5);
    for (const layer of scene.layers || []) {
      if (layer.type !== "video" || !layer.asset_id) continue;
      const asset = getAssetById(layer.asset_id);
      const url = getAssetPreviewUrl(asset);
      if (!url) continue;
      const startAbs = offset + Math.max(0, Number(layer.start_s) || 0);
      const duration = layerEffectiveDuration(layer, sceneDur);
      const volume = clamp(Number(layer.tts_volume), 0, 1.5);
      clips.push({
        layerId: layer.id,
        url,
        startAbs,
        duration: Math.max(0.05, duration),
        volume: Number.isFinite(volume) ? volume : 1,
        sourceStart: Math.max(0, Number(layer.source_start_s) || 0),
      });
    }
    offset += sceneDur;
  }
  return clips;
}

function syncPreviewVideoElement(video, localTime, { playing, forceSeek, volume, muted = false } = {}) {
  if (!video) return;
  const t = Math.max(0, localTime);
  try {
    video.muted = !!muted;
    if (!muted && volume != null && Number.isFinite(volume)) {
      video.volume = clamp(volume, 0, 1);
    }
  } catch (_) { /* ignore */ }
  const drift = Math.abs((video.currentTime || 0) - t);
  if (forceSeek || drift > 0.35 || (!playing && drift > 0.05)) {
    try { video.currentTime = t; } catch (_) { /* ignore until metadata */ }
  }
  if (!playing) {
    if (!video.paused) {
      try { video.pause(); } catch (_) { /* ignore */ }
    }
    return;
  }
  if (video.paused) {
    video.play().catch(() => {
      // Browser may block unmuted play mid-timeline; keep visuals with muted fallback.
      try {
        video.muted = true;
        video.play().catch(() => { /* ignore */ });
      } catch (_) { /* ignore */ }
    });
  }
}

function syncPreviewVideos(absS, { playing = false, forceSeek = false } = {}) {
  if (!currentPost || currentPost.type !== "video") {
    pausePreviewVideos();
    return;
  }

  // Legacy scene background video (still used if background_asset_id points at a clip).
  const bgVideo = $("canvasBackgroundVideo");
  const activeScene = getActiveScene();
  const bgAsset = activeScene?.background_asset_id
    ? getAssetById(activeScene.background_asset_id)
    : null;
  if (bgVideo && bgAsset?.type === "video" && !bgVideo.classList.contains("hidden")) {
    const sceneDur = Math.max(0.5, Number(activeScene.duration_s) || 0.5);
    const local = previewTimeS;
    const active = local >= -0.02 && local < sceneDur;
    if (active) {
      syncPreviewVideoElement(bgVideo, local, {
        playing,
        forceSeek,
        muted: true,
      });
    } else if (!bgVideo.paused) {
      try { bgVideo.pause(); } catch (_) { /* ignore */ }
    }
  } else if (bgVideo && !bgVideo.paused) {
    try { bgVideo.pause(); } catch (_) { /* ignore */ }
  }

  const clips = collectPreviewVideoClips();
  const activeIds = new Set(clips.map((c) => c.layerId));
  for (const [id, video] of previewVideoEls) {
    if (activeIds.has(id)) continue;
    if (!video.paused) {
      try { video.pause(); } catch (_) { /* ignore */ }
    }
  }
  for (const clip of clips) {
    const video = previewVideoEls.get(clip.layerId);
    if (!video) continue;
    const local = absS - clip.startAbs;
    const active = local >= -0.02 && local < clip.duration;
    if (!active) {
      if (!video.paused) {
        try { video.pause(); } catch (_) { /* ignore */ }
      }
      continue;
    }
    syncPreviewVideoElement(video, (clip.sourceStart || 0) + local, {
      playing,
      forceSeek,
      volume: clip.volume,
      muted: false,
    });
  }
}

function ensurePreviewAudioPlayer(clip) {
  let entry = previewAudioPlayers.get(clip.key);
  if (entry && entry.url === clip.url) {
    entry.startAbs = clip.startAbs;
    entry.duration = clip.duration;
    entry.volume = clip.volume;
    return entry;
  }
  if (entry) {
    try {
      entry.audio.pause();
      entry.audio.removeAttribute("src");
      entry.audio.load();
    } catch (_) { /* ignore */ }
    previewAudioPlayers.delete(clip.key);
  }
  const audio = new Audio();
  audio.preload = "auto";
  audio.src = clip.url;
  entry = {
    audio,
    url: clip.url,
    startAbs: clip.startAbs,
    duration: clip.duration,
    volume: clip.volume,
  };
  previewAudioPlayers.set(clip.key, entry);
  return entry;
}

function syncPreviewAudio(absS, { playing = false, forceSeek = false } = {}) {
  if (!currentPost || currentPost.type !== "video") {
    pausePreviewAudio();
    return;
  }
  const clips = collectPreviewAudioClips();
  const activeKeys = new Set(clips.map((c) => c.key));
  for (const [key, entry] of previewAudioPlayers) {
    if (!activeKeys.has(key)) {
      try {
        entry.audio.pause();
        entry.audio.removeAttribute("src");
        entry.audio.load();
      } catch (_) { /* ignore */ }
      previewAudioPlayers.delete(key);
    }
  }
  for (const clip of clips) {
    const entry = ensurePreviewAudioPlayer(clip);
    const local = absS - clip.startAbs;
    const active = local >= -0.02 && local < clip.duration;
    entry.audio.volume = clip.volume;
    if (!active || !playing) {
      if (!entry.audio.paused) {
        try { entry.audio.pause(); } catch (_) { /* ignore */ }
      }
      continue;
    }
    const drift = Math.abs((entry.audio.currentTime || 0) - Math.max(0, local));
    if (forceSeek || entry.audio.paused || drift > 0.4) {
      try {
        entry.audio.currentTime = Math.max(0, local);
      } catch (_) { /* ignore seek until metadata ready */ }
    }
    if (entry.audio.paused) {
      entry.audio.play().catch(() => { /* autoplay / missing file */ });
    }
  }
}

function setPreviewAbsTime(absS, { render = true, forceSeek = false } = {}) {
  const total = getTotalDuration();
  previewAbsS = clamp(absS, 0, Math.max(0, total));
  syncPreviewTimeControls();
  syncPreviewAudio(previewAbsS, { playing: previewPlaying, forceSeek });
  syncPreviewVideos(previewAbsS, { playing: previewPlaying, forceSeek });
  if (render) {
    renderLayerOverlays();
    renderSceneGantt();
    updateCanvasPreview();
  } else {
    updateGanttPlayheads();
    renderLayerOverlays();
    updateCanvasPreview();
  }
}

function togglePreviewPlayback() {
  if (currentPost?.type !== "video") {
    openPostPreviewDialog();
    return;
  }
  if (previewPlaying) {
    stopPreviewPlayback();
    return;
  }
  const total = getTotalDuration();
  if (previewAbsS >= total - 0.05) {
    setPreviewAbsTime(0, { render: true });
  }
  previewPlaying = true;
  previewPlayLastTs = performance.now();
  const btn = $("previewPlayBtn");
  if (btn) btn.textContent = "Pause";
  syncPreviewAudio(previewAbsS, { playing: true, forceSeek: true });
  syncPreviewVideos(previewAbsS, { playing: true, forceSeek: true });
  const tick = (now) => {
    if (!previewPlaying) return;
    const dt = (now - previewPlayLastTs) / 1000;
    previewPlayLastTs = now;
    const dur = getTotalDuration();
    let next = previewAbsS + dt;
    if (next >= dur) {
      setPreviewAbsTime(dur);
      stopPreviewPlayback();
      return;
    }
    setPreviewAbsTime(next);
    previewPlayRaf = requestAnimationFrame(tick);
  };
  previewPlayRaf = requestAnimationFrame(tick);
}

async function openPostPreviewDialog() {
  if (!currentProject || !currentPost) return;
  const dlg = $("postPreviewDialog");
  const img = $("postPreviewImage");
  const status = $("postPreviewStatus");
  if (!dlg || !img) return;
  dlg.classList.remove("hidden");
  if (status) status.textContent = "Rendering preview…";
  img.removeAttribute("src");
  try {
    await savePostNow();
    const body = { post_id: currentPost.id };
    if (currentPost.type === "video") {
      body.abs_time_s = previewAbsS;
    }
    const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    img.src = URL.createObjectURL(blob);
    if (status) {
      status.textContent = currentPost.type === "video"
        ? `Frame at ${previewAbsS.toFixed(1)}s`
        : "Image composition";
    }
  } catch (e) {
    if (status) status.textContent = `Preview failed: ${e.message}`;
    toast(`Preview failed: ${e.message}`, "error");
  }
}

function closePostPreviewDialog() {
  const dlg = $("postPreviewDialog");
  const img = $("postPreviewImage");
  if (img?.src?.startsWith("blob:")) URL.revokeObjectURL(img.src);
  if (img) img.removeAttribute("src");
  dlg?.classList.add("hidden");
}

async function deleteCurrentPost() {
  if (!currentProject || !currentPost) return;
  const post = currentPost;
  const ok = await confirmDialog({
    title: `Delete post “${post.name}”?`,
    message: "This permanently removes the post composition and its exports. Project assets are kept. This cannot be undone.",
    confirmText: "Delete post",
    cancelText: "Keep post",
    danger: true,
  });
  if (!ok) return;
  try {
    stopPreviewPlayback();
    const data = await api(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${post.id}`, { method: "DELETE" });
    currentProject = data.project;
    currentPost = null;
    toast("Post deleted", "ok");
    showProjectHub();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, "error");
  }
}

async function savePostNow() {
  if (!currentProject || !currentPost) return;
  flushLayerPropsFromDom();
  clearTimeout(saveTimer);
  await api(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ post: currentPost }),
  });
}

// ---------- Init ----------
const THEME_STORAGE_KEY = "content-sprout.theme";

function getPreferredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) || localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch (_) { /* ignore */ }
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
}

function currentTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "dark" ? attr : getPreferredTheme();
}

function syncThemeChrome(theme) {
  document.querySelectorAll(".settings-theme-btn").forEach((btn) => {
    const active = btn.dataset.themeChoice === theme;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function applyTheme(theme, { persist = true } = {}) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  document.documentElement.style.colorScheme = next;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
      localStorage.setItem("theme", next); // keep landing page in sync
    } catch (_) { /* ignore */ }
  }
  syncThemeChrome(next);
}

function toggleTheme() {
  applyTheme(currentTheme() === "light" ? "dark" : "light");
}

function initApp() {
  applyTheme(getPreferredTheme(), { persist: false });

  loadConfig();
  loadProjects();
  setActiveFeature("post-creator");
  wireScriptGeneratorUi();
  wireVideoEditorUi();
  wireImageEditorUi();
  wireMediaManagerUi();
  wireGanttCtxMenu();

  $("headerProjectBtn")?.addEventListener("click", () => openProjectsBrowser());
  $("headerPostsBtn")?.addEventListener("click", () => setActiveFeature("post-creator"));
  $("headerMediaBtn")?.addEventListener("click", () => setActiveFeature("media-manager"));
  $("emptyBrowseProjectsBtn")?.addEventListener("click", () => openProjectsBrowser());
  $("emptyNewProjectBtn")?.addEventListener("click", () => openCreateProjectDialog());
  $("projectsBrowserClose")?.addEventListener("click", () => closeProjectsBrowser());
  $("projectsBrowserNewBtn")?.addEventListener("click", () => openCreateProjectDialog());
  $("projectsBrowserDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "projectsBrowserDialog") closeProjectsBrowser();
  });
  $("createProjectCancel")?.addEventListener("click", () => closeCreateProjectDialog());
  $("createProjectConfirm")?.addEventListener("click", createProject);
  $("createProjectDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "createProjectDialog") closeCreateProjectDialog();
  });
  $("newProjectName")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      createProject();
    }
  });
  $("projectSort")?.addEventListener("change", (e) => {
    projectSort = e.target.value === SORT_MODIFIED ? SORT_MODIFIED : SORT_CREATED;
    saveSortPref(PROJECT_SORT_KEY, projectSort);
    renderProjectList();
  });
  $("postSort")?.addEventListener("change", (e) => {
    postSort = e.target.value === SORT_MODIFIED ? SORT_MODIFIED : SORT_CREATED;
    saveSortPref(POST_SORT_KEY, postSort);
    renderPosts();
  });

  $("crumbProject")?.addEventListener("click", () => {
    if (!currentProject) return;
    showProjectHub();
  });

  $("crumbPost")?.addEventListener("click", () => {
    if (!currentPost) return;
    activeTab = "editor";
    renderProjectHeader();
    renderProjectTabs();
    renderEditor();
  });
  $("newPostBtn")?.addEventListener("click", () => {
    const type = $("newPostType")?.value || "image";
    $("newPostReusableWrap")?.classList.toggle("hidden", type !== "video");
    $("createPostDialog")?.classList.remove("hidden");
  });
  $("newPostType")?.addEventListener("change", () => {
    const type = $("newPostType")?.value || "image";
    $("newPostReusableWrap")?.classList.toggle("hidden", type !== "video");
    if (type !== "video" && $("newPostReusable")) $("newPostReusable").checked = false;
  });
  $("createPostCancel")?.addEventListener("click", () => $("createPostDialog")?.classList.add("hidden"));
  $("createPostConfirm")?.addEventListener("click", createPost);
  $("createPostDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "createPostDialog") e.target.classList.add("hidden");
  });
  $("postReusableToggle")?.addEventListener("change", () => {
    if (!currentPost || currentPost.type !== "video") return;
    currentPost.is_reusable = !!$("postReusableToggle").checked;
    // Keep project.posts in sync for insert picker.
    const summary = (currentProject?.posts || []).find((p) => p.id === currentPost.id);
    if (summary) summary.is_reusable = currentPost.is_reusable;
    scheduleSavePost();
    toast(currentPost.is_reusable ? "Marked as reusable clip" : "No longer reusable", "ok");
  });
  $("insertReusableCancel")?.addEventListener("click", () => $("insertReusableDialog")?.classList.add("hidden"));
  $("insertReusableDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "insertReusableDialog") e.target.classList.add("hidden");
  });
  $("insertReusableConfirm")?.addEventListener("click", () => {
    const id = $("insertReusableSelect")?.value;
    $("insertReusableDialog")?.classList.add("hidden");
    if (id) insertReusablePost(id);
  });

  $("cropAssetClose")?.addEventListener("click", closeCropAssetDialog);
  $("cropAssetCancel")?.addEventListener("click", closeCropAssetDialog);
  $("cropAssetDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "cropAssetDialog") closeCropAssetDialog();
  });
  $("cropAssetReset")?.addEventListener("click", () => resetCropBox());
  $("cropAssetSave")?.addEventListener("click", () => saveCroppedAsset());
  document.querySelectorAll(".crop-aspect-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.dataset.cropAspect;
      setCropAspect(raw === "free" ? null : Number(raw));
    });
  });
  const cropCanvas = $("cropCanvas");
  if (cropCanvas) {
    cropCanvas.addEventListener("pointerdown", onCropPointerDown);
    cropCanvas.addEventListener("pointermove", onCropPointerMove);
    cropCanvas.addEventListener("pointerup", onCropPointerUp);
    cropCanvas.addEventListener("pointercancel", onCropPointerUp);
  }
  window.addEventListener("resize", () => {
    if (cropState && !$("cropAssetDialog")?.classList.contains("hidden")) layoutCropCanvas();
  });

  $("deletePostBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    deleteCurrentPost();
  });

  $("deleteProjectBtn").addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentProject) return;
    const name = currentProject.name || "this project";
    const ok = await confirmDialog({
      title: `Delete project “${name}”?`,
      message: "This permanently deletes the project, all of its posts, assets, and exports. This cannot be undone.",
      confirmText: "Delete project",
      cancelText: "Keep project",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/projects/${encodeURIComponent(currentProject.id)}`, { method: "DELETE" });
      toast("Project deleted", "ok");
      clearCurrentProject();
      await loadProjects();
    } catch (err) {
      toast(`Delete failed: ${err.message}`, "error");
    }
  });

  // Asset upload (dialog)
  $("openUploadAssetsDialogBtn")?.addEventListener("click", openUploadAssetsDialog);
  $("uploadAssetsDialogClose")?.addEventListener("click", closeUploadAssetsDialog);
  $("uploadAssetsDialogDone")?.addEventListener("click", closeUploadAssetsDialog);
  $("uploadAssetsDialog")?.addEventListener("click", (e) => {
    if (e.target === $("uploadAssetsDialog")) closeUploadAssetsDialog();
  });
  const assetDz = $("assetDropzone");
  $("assetFileInput")?.addEventListener("change", (e) => {
    uploadAssets(e.target.files);
  });
  if (assetDz) {
    ["dragenter", "dragover"].forEach((ev) => assetDz.addEventListener(ev, (e) => { e.preventDefault(); assetDz.classList.add("dropzone-active"); }));
    ["dragleave", "drop"].forEach((ev) => assetDz.addEventListener(ev, (e) => { e.preventDefault(); assetDz.classList.remove("dropzone-active"); }));
    assetDz.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) uploadAssets(e.dataTransfer.files); });
  }

  const paletteDz = $("paletteDropzone");
  $("paletteFileInput")?.addEventListener("change", (e) => {
    if (!currentPost) {
      toast("Open a post first", "error");
      return;
    }
    uploadAssets(e.target.files, { postId: currentPost.id });
    e.target.value = "";
  });
  if (paletteDz) {
    ["dragenter", "dragover"].forEach((ev) => paletteDz.addEventListener(ev, (e) => {
      e.preventDefault();
      paletteDz.classList.add("dropzone-active");
    }));
    ["dragleave", "drop"].forEach((ev) => paletteDz.addEventListener(ev, (e) => {
      e.preventDefault();
      paletteDz.classList.remove("dropzone-active");
    }));
    paletteDz.addEventListener("drop", (e) => {
      if (!currentPost) {
        toast("Open a post first", "error");
        return;
      }
      if (e.dataTransfer?.files?.length) uploadAssets(e.dataTransfer.files, { postId: currentPost.id });
    });
  }

  // Editor controls
  $("editorTabProjectAssets")?.addEventListener("click", () => setEditorSideTab("project-assets"));
  $("editorTabPostAssets")?.addEventListener("click", () => setEditorSideTab("post-assets"));
  document.querySelectorAll(".asset-type-tab").forEach((btn) => {
    btn.addEventListener("click", () => setAssetLibraryTab(btn.dataset.assetTypeTab));
  });
  document.querySelectorAll(".palette-type-tab").forEach((btn) => {
    btn.addEventListener("click", () => setAssetPaletteTab(btn.dataset.paletteTypeTab));
  });
  $("assetGroupFilter")?.addEventListener("change", (e) => {
    assetGroupFilter = e.target.value || "__all__";
    renderAssets();
  });
  $("downloadAllAssetsBtn")?.addEventListener("click", () => downloadAllProjectAssets());
  $("openProjectTtsDialogBtn")?.addEventListener("click", () => openProjectTtsDialog());
  $("projectTtsDialogClose")?.addEventListener("click", () => closeProjectTtsDialog());
  $("projectTtsCancelBtn")?.addEventListener("click", () => closeProjectTtsDialog());
  $("projectTtsDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "projectTtsDialog") closeProjectTtsDialog();
  });
  $("projectTtsPreviewBtn")?.addEventListener("click", () => previewProjectTtsAsset());
  $("projectTtsGenerateBtn")?.addEventListener("click", () => generateProjectTtsAsset());
  for (const id of ["projectTtsText", "projectTtsMood", "projectTtsVoice", "projectTtsRegion"]) {
    $(id)?.addEventListener("input", () => clearTtsPreview("project"));
    $(id)?.addEventListener("change", () => clearTtsPreview("project"));
  }
  $("openProjectVideoGenDialogBtn")?.addEventListener("click", () => openProjectVideoGenDialog());
  $("projectVideoGenDialogClose")?.addEventListener("click", () => closeProjectVideoGenDialog());
  $("projectVideoGenCancelBtn")?.addEventListener("click", () => closeProjectVideoGenDialog());
  $("projectVideoGenDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "projectVideoGenDialog") closeProjectVideoGenDialog();
  });
  $("projectVideoGenBtn")?.addEventListener("click", () => generateProjectVideoAsset());
  $("openAssetGroupsDialogBtn")?.addEventListener("click", openAssetGroupsDialog);
  $("assetGroupsDialogClose")?.addEventListener("click", closeAssetGroupsDialog);
  $("assetGroupsDialogDone")?.addEventListener("click", closeAssetGroupsDialog);
  $("assetGroupsDialog")?.addEventListener("click", (e) => {
    if (e.target === $("assetGroupsDialog")) closeAssetGroupsDialog();
  });
  $("newAssetGroupBtn")?.addEventListener("click", createAssetGroupPrompt);
  $("projectLogoDarkShortInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try { await uploadProjectLogo("dark_short", file); }
    catch (err) { toast(err.message, "error"); }
  });
  $("projectLogoDarkFullInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try { await uploadProjectLogo("dark_full", file); }
    catch (err) { toast(err.message, "error"); }
  });
  $("projectLogoLightShortInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try { await uploadProjectLogo("light_short", file); }
    catch (err) { toast(err.message, "error"); }
  });
  $("projectLogoLightFullInput")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try { await uploadProjectLogo("light_full", file); }
    catch (err) { toast(err.message, "error"); }
  });
  $("clearLogoDarkShortBtn")?.addEventListener("click", async () => {
    try { await clearProjectLogo("dark_short"); }
    catch (err) { toast(err.message, "error"); }
  });
  $("clearLogoDarkFullBtn")?.addEventListener("click", async () => {
    try { await clearProjectLogo("dark_full"); }
    catch (err) { toast(err.message, "error"); }
  });
  $("clearLogoLightShortBtn")?.addEventListener("click", async () => {
    try { await clearProjectLogo("light_short"); }
    catch (err) { toast(err.message, "error"); }
  });
  $("clearLogoLightFullBtn")?.addEventListener("click", async () => {
    try { await clearProjectLogo("light_full"); }
    catch (err) { toast(err.message, "error"); }
  });
  $("addTextLayerBtn").addEventListener("click", addTextLayer);
  $("addTtsLayerBtn")?.addEventListener("click", () => addTtsLayer());
  $("targetFormat").addEventListener("change", () => {
    if (!currentProject || !currentPost) return;
    currentPost.target_format = $("targetFormat").value;
    // Keep optional legacy scene/post media format in sync when present.
    const bg = getBackgroundInfo();
    if (bg.assetId) setBackgroundAsset(bg.assetId, $("targetFormat").value);
    else scheduleSavePost();
    renderInteractiveCanvas();
  });
  $("refreshPreviewBtn").addEventListener("click", updateCanvasPreview);
  $("previewZoomInBtn")?.addEventListener("click", () => zoomPreviewBy(PREVIEW_ZOOM_STEP));
  $("previewZoomOutBtn")?.addEventListener("click", () => zoomPreviewBy(-PREVIEW_ZOOM_STEP));
  $("previewZoomResetBtn")?.addEventListener("click", () => setPreviewZoom(1));
  $("canvasDropzone")?.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const step = e.deltaY > 0 ? -PREVIEW_ZOOM_STEP : PREVIEW_ZOOM_STEP;
    zoomPreviewBy(step, { anchorClientX: e.clientX, anchorClientY: e.clientY });
  }, { passive: false });

  $("exportImageBtn").addEventListener("click", async () => {
    if (!currentProject || !currentPost) return;
    try {
      if (currentPost.type === "image") {
        const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/export/image`, { method: "POST" });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.detail || `HTTP ${r.status}`); }
        const blob = await r.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${currentPost.name}.jpg`;
        a.click();
        toast("Image exported", "ok");
        return;
      }
      const body = { post_id: currentPost.id, abs_time_s: previewAbsS };
      const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${currentPost.name}.jpg`;
      a.click();
    } catch (e) {
      toast(`Export failed: ${e.message}`, "error");
    }
  });

  $("exportVideoBtn").addEventListener("click", async () => {
    if (!currentProject || !currentPost) return;
    try {
      toast("Exporting video… this may take a moment", "info");
      const r = await fetch(`/api/projects/${encodeURIComponent(currentProject.id)}/posts/${currentPost.id}/export/video`, { method: "POST" });
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail); }
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${currentPost.name}.mp4`;
      a.click();
      toast("Video exported", "ok");
    } catch (e) { toast(`Export failed: ${e.message}`, "error"); }
  });

  const canvasDz = $("canvasDropzone");
  const editorStage = $("editorStage");
  canvasDz.addEventListener("dragover", (e) => {
    if (currentPost?.type === "video") {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.preventDefault();
  });
  canvasDz.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (currentPost?.type === "video") {
      toast("For video posts, drop assets on the timeline", "info");
      return;
    }
    const assetId = e.dataTransfer.getData("text/plain") || dragAssetId;
    dragAssetId = null;
    if (!assetId) return;
    const asset = (currentProject?.assets || []).find((a) => a.id === assetId);
    if (!asset) {
      toast("Unknown asset", "error");
      return;
    }
    if (asset.post_id && asset.post_id !== currentPost?.id) {
      toast("That asset belongs to another post", "error");
      return;
    }
    const pt = getStagePoint(e.clientX, e.clientY);
    const pos = { x: clamp(pt.x - 20, 0, 80), y: clamp(pt.y - 20, 0, 80) };
    if (asset.type === "image") {
      const format = await pickImageFormat(asset, e.clientX, e.clientY);
      if (!format) return;
      addImageLayer(assetId, pos, { format });
      return;
    }
    addImageLayer(assetId, pos);
  });

  bindGanttAssetDropTargets($("sceneGantt"));

  editorStage?.addEventListener("mousedown", (e) => {
    if (e.target.closest(".layer-item")) return;
    selectLayer(null);
  });

  $("sceneDuration")?.addEventListener("change", (e) => {
    const scene = getActiveScene();
    if (scene) {
      setSceneDuration(scene, +e.target.value);
      scheduleSavePost();
      syncPreviewTimeControls();
      renderSceneGantt();
      renderLayerList();
    }
  });

  $("previewTime")?.addEventListener("input", (e) => {
    stopPreviewPlayback();
    setPreviewAbsTime(+e.target.value, { forceSeek: true });
  });
  $("previewPlayBtn")?.addEventListener("click", () => togglePreviewPlayback());
  $("previewPostBtn")?.addEventListener("click", () => openPostPreviewDialog());
  $("postPreviewClose")?.addEventListener("click", closePostPreviewDialog);
  $("postPreviewDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "postPreviewDialog") closePostPreviewDialog();
  });

  $("ganttAddScene")?.addEventListener("click", () => {
    if (currentPost?.type === "video") addScene();
  });
  $("ganttAddReusable")?.addEventListener("click", () => {
    if (currentPost?.type === "video") openInsertReusableDialog();
    else toast("Reusable clips are for video posts", "info");
  });
  $("closeLayerPropsBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeLayerPropsOverlay();
  });
  $("layerPropsOverlay")?.addEventListener("mousedown", (e) => e.stopPropagation());

  $("openAiPanelBtn")?.addEventListener("click", () => openAiPanel("chat"));
  $("closeAiPanelBtn")?.addEventListener("click", closeAiPanel);
  $("aiPanelOverlay")?.addEventListener("mousedown", (e) => e.stopPropagation());
  document.querySelectorAll(".ai-tab").forEach((btn) => {
    btn.addEventListener("click", () => setAiTab(btn.dataset.aiTab));
  });
  $("aiLayoutProposeBtn")?.addEventListener("click", aiLayoutPropose);
  $("aiLayoutApplyBtn")?.addEventListener("click", aiLayoutApply);
  $("aiLayoutDiscardBtn")?.addEventListener("click", () => setLayoutProposal(null, ""));
  $("aiScriptGenerateBtn")?.addEventListener("click", aiScriptGenerate);
  $("aiScriptApplyBtn")?.addEventListener("click", aiLayoutApply);
  $("aiScriptDiscardBtn")?.addEventListener("click", () => setLayoutProposal(null, ""));
  $("aiScriptFile")?.addEventListener("change", onAiScriptFileChange);
  $("aiPhotoRunBtn")?.addEventListener("click", aiPhotoRun);
  $("aiSuggestBtn")?.addEventListener("click", aiSuggestRun);

  document.addEventListener("mousemove", (e) => {
    onMaskPointerMove(e);
    onCanvasPointerMove(e);
    onGanttPointerMove(e);
  });
  document.addEventListener("mouseup", () => {
    endMaskDrag();
    endCanvasDrag();
    endGanttDrag();
  });

  $("refreshBtn")?.addEventListener("click", () => {
    if (!$("freeAssetsDialog")?.classList.contains("hidden")) {
      searchFreeAssets();
      return;
    }
    if (activeFeature !== "post-creator") return;
    if (currentProject && !$("viewProject")?.classList.contains("hidden")) refreshProject();
    else loadProjects();
  });

  $("openFreeAssetsDialogBtn")?.addEventListener("click", () => openFreeAssetsDialog());
  $("freeAssetsDialogClose")?.addEventListener("click", () => closeFreeAssetsDialog());
  $("freeAssetsDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "freeAssetsDialog") closeFreeAssetsDialog();
  });
  $("freeAssetsSearchForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    searchFreeAssets({ resetPage: true });
  });
  $("freeAssetsTypeTabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".free-assets-type");
    if (!btn) return;
    setFreeAssetsType(btn.dataset.type);
    if (freeAssetsQuery || ($("freeAssetsQuery")?.value || "").trim()) {
      searchFreeAssets({ resetPage: true });
    }
  });
  $("freeAssetsPrevBtn")?.addEventListener("click", () => {
    if (freeAssetsPage <= 1) return;
    freeAssetsPage -= 1;
    searchFreeAssets();
  });
  $("freeAssetsNextBtn")?.addEventListener("click", () => {
    freeAssetsPage += 1;
    searchFreeAssets();
  });

  $("llmSettingsBtn")?.addEventListener("click", () => openLlmDialog());
  $("llmDialogClose")?.addEventListener("click", () => $("llmDialog")?.classList.add("hidden"));
  $("llmCancelBtn")?.addEventListener("click", () => $("llmDialog")?.classList.add("hidden"));
  $("llmDialog")?.addEventListener("click", (e) => { if (e.target.id === "llmDialog") $("llmDialog").classList.add("hidden"); });
  document.querySelectorAll(".settings-theme-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const choice = btn.dataset.themeChoice === "light" ? "light" : "dark";
      applyTheme(choice);
    });
  });
  $("llmProvider")?.addEventListener("change", (e) => setLlmProviderFieldsVisible(e.target.value));
  $("imageGenProvider")?.addEventListener("change", (e) => setImageGenProviderFieldsVisible(e.target.value));
  $("comfyuiProvider")?.addEventListener("change", (e) => setComfyuiProviderFieldsVisible(e.target.value));
  $("llmSaveBtn")?.addEventListener("click", saveLlmSettings);
  $("stockUploadSiteAddBtn")?.addEventListener("click", addStockUploadSite);
  $("llmTestBtn")?.addEventListener("click", testLlmSettings);
  $("comfyuiTestBtn")?.addEventListener("click", testComfyuiSettings);

  function openAboutDialog() {
    closeCreditsDialog();
    $("aboutDialog")?.classList.remove("hidden");
  }
  function closeAboutDialog() {
    $("aboutDialog")?.classList.add("hidden");
  }
  function openCreditsDialog() {
    closeAboutDialog();
    $("creditsDialog")?.classList.remove("hidden");
  }
  function closeCreditsDialog() {
    $("creditsDialog")?.classList.add("hidden");
  }
  $("aboutFooterLink")?.addEventListener("click", openAboutDialog);
  $("aboutDialogClose")?.addEventListener("click", closeAboutDialog);
  $("aboutCloseBtn")?.addEventListener("click", closeAboutDialog);
  $("aboutDialog")?.addEventListener("click", (e) => { if (e.target.id === "aboutDialog") closeAboutDialog(); });
  $("creditsFooterLink")?.addEventListener("click", openCreditsDialog);
  $("creditsDialogClose")?.addEventListener("click", closeCreditsDialog);
  $("creditsCloseBtn")?.addEventListener("click", closeCreditsDialog);
  $("creditsDialog")?.addEventListener("click", (e) => { if (e.target.id === "creditsDialog") closeCreditsDialog(); });
  $("aboutOpenLlmBtn")?.addEventListener("click", () => {
    closeAboutDialog();
    openLlmDialog();
  });

  // ---------- Help / walkthrough ----------
  let helpTourSteps = [];
  let helpTourIndex = 0;

  function currentHelpContext() {
    if (!currentProject) return "projects";
    const editing = !$("panelEditor")?.classList.contains("hidden") && !!currentPost;
    if (editing) return "editor";
    if (activeFeature === "post-creator") return "hub";
    return "overview";
  }

  function setHelpSection(section) {
    const allowed = ["overview", "projects", "hub", "editor"];
    const id = allowed.includes(section) ? section : "overview";
    document.querySelectorAll(".help-section-tab").forEach((btn) => {
      const active = btn.dataset.helpSection === id;
      btn.classList.toggle("border-emerald-400", active);
      btn.classList.toggle("text-emerald-200", active);
      btn.classList.toggle("border-transparent", !active);
      btn.classList.toggle("text-slate-400", !active);
    });
    $("helpSectionOverview")?.classList.toggle("hidden", id !== "overview");
    $("helpSectionProjects")?.classList.toggle("hidden", id !== "projects");
    $("helpSectionHub")?.classList.toggle("hidden", id !== "hub");
    $("helpSectionEditor")?.classList.toggle("hidden", id !== "editor");
    const hints = {
      overview: "Start here for the big picture, then pick a section.",
      projects: "Projects live in the header — select, create, or browse anytime.",
      hub: "Assets library, logos, and posts list.",
      editor: "Canvas, layers, masks, timeline, and export.",
    };
    const hint = $("helpContextHint");
    if (hint) hint.textContent = hints[id] || "";
  }

  function openHelpDialog(section = null) {
    closeAboutDialog();
    endHelpTour();
    const ctx = section || currentHelpContext();
    setHelpSection(ctx === "projects" || ctx === "hub" || ctx === "editor" ? ctx : "overview");
    $("helpDialog")?.classList.remove("hidden");
  }

  function closeHelpDialog() {
    $("helpDialog")?.classList.add("hidden");
  }

  function buildHelpTourSteps() {
    const ctx = currentHelpContext();
    if (ctx === "projects") {
      return [
        { sel: "#headerProjectBtn", text: "This header control shows the active project. Click it to browse projects, create a new one, or switch." },
        { sel: "#headerMediaBtn", text: "Media Manager lives in the header — browse folders, import into the open project, and prepare stock packages." },
        { sel: "#helpFooterLink", text: "Help is in the footer. Open it anytime for a walkthrough or Tour this screen." },
      ];
    }
    if (ctx === "hub") {
      return [
        { sel: "#openUploadAssetsDialogBtn", text: "Add project-shared photos, videos, or audio. Choose a group and logo option in the upload dialog." },
        { sel: "#openAssetGroupsDialogBtn", text: "Create or delete asset groups. Assets stay listed by group in the library — this dialog only manages the folders." },
        { sel: "#openFreeAssetsDialogBtn", text: "Search free assets and download them into this project." },
        { sel: "#newPostBtn", text: "Create an image or video post, then open it to edit on the canvas." },
        { sel: "#postList", text: "Your posts appear here. Click one to enter the editor." },
      ];
    }
    // editor
    const steps = [
      { sel: "#sceneGantt", text: "The timeline shows scenes and timed layers. Drag bars to place content; scrub the playhead to preview." },
      { sel: "#assetPalette", text: "Drag Project or Post assets from the middle column onto the timeline (video) or canvas (image)." },
      { sel: "#addTextLayerBtn", text: "Add a text layer, or use Voice on video posts for local text-to-speech." },
      { sel: "#canvasDropzone", text: "The preview stage: drag to move layers, resize from corners, and click to edit properties." },
    ];
    if (currentPost?.type === "video") {
      steps.push({ sel: "#previewPlayBtn", text: "Play the reel in the editor before you export." });
    } else {
      steps[0] = { sel: "#imageTimelineHint", text: "Image posts skip the scene timeline — build the layout on the preview canvas instead." };
    }
    steps.push({ sel: currentPost?.type === "video" ? "#exportVideoBtn" : "#exportImageBtn", text: "When you are happy with the layout, export from here. Video export needs ffmpeg on this Mac." });
    steps.push({ sel: "#crumbProject", text: "Use the breadcrumb to return to Assets & posts without leaving the project." });
    return steps;
  }

  function positionHelpTourCard(rect) {
    const card = $("helpTourCard");
    if (!card) return;
    const pad = 12;
    const cardW = card.offsetWidth || 320;
    const cardH = card.offsetHeight || 140;
    let left = rect.left;
    let top = rect.bottom + pad;
    if (top + cardH > window.innerHeight - pad) {
      top = Math.max(pad, rect.top - cardH - pad);
    }
    if (left + cardW > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - cardW - pad);
    }
    left = Math.max(pad, left);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  function renderHelpTourStep() {
    const root = $("helpTourRoot");
    const highlight = $("helpTourHighlight");
    if (!root || !highlight) return;
    const step = helpTourSteps[helpTourIndex];
    if (!step) {
      endHelpTour();
      return;
    }
    const el = document.querySelector(step.sel);
    const rect = el?.getBoundingClientRect?.();
    if (!el || el.classList.contains("hidden") || !rect || (rect.width < 2 && rect.height < 2)) {
      // Skip missing/hidden targets
      if (helpTourIndex < helpTourSteps.length - 1) {
        helpTourIndex += 1;
        renderHelpTourStep();
      } else {
        endHelpTour();
      }
      return;
    }
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    const liveRect = el.getBoundingClientRect();
    const pad = 6;
    highlight.style.left = `${Math.max(0, liveRect.left - pad)}px`;
    highlight.style.top = `${Math.max(0, liveRect.top - pad)}px`;
    highlight.style.width = `${liveRect.width + pad * 2}px`;
    highlight.style.height = `${liveRect.height + pad * 2}px`;
    const label = $("helpTourStepLabel");
    const text = $("helpTourText");
    if (label) label.textContent = `Step ${helpTourIndex + 1} of ${helpTourSteps.length}`;
    if (text) text.textContent = step.text;
    const next = $("helpTourNext");
    if (next) next.textContent = helpTourIndex >= helpTourSteps.length - 1 ? "Done" : "Next";
    const prev = $("helpTourPrev");
    if (prev) prev.disabled = helpTourIndex <= 0;
    requestAnimationFrame(() => positionHelpTourCard(liveRect));
  }

  function startHelpTour() {
    closeHelpDialog();
    helpTourSteps = buildHelpTourSteps().filter((s) => {
      const el = document.querySelector(s.sel);
      return !!el && !el.classList.contains("hidden");
    });
    if (!helpTourSteps.length) {
      toast("Nothing to highlight on this screen yet", "info");
      openHelpDialog();
      return;
    }
    helpTourIndex = 0;
    $("helpTourRoot")?.classList.remove("hidden");
    renderHelpTourStep();
  }

  function endHelpTour() {
    helpTourSteps = [];
    helpTourIndex = 0;
    $("helpTourRoot")?.classList.add("hidden");
  }

  $("helpFooterLink")?.addEventListener("click", () => openHelpDialog());
  $("helpDialogClose")?.addEventListener("click", closeHelpDialog);
  $("helpCloseBtn")?.addEventListener("click", closeHelpDialog);
  $("helpDialog")?.addEventListener("click", (e) => {
    if (e.target.id === "helpDialog") closeHelpDialog();
  });
  document.querySelectorAll(".help-section-tab").forEach((btn) => {
    btn.addEventListener("click", () => setHelpSection(btn.dataset.helpSection));
  });
  $("helpStartTourBtn")?.addEventListener("click", () => startHelpTour());
  $("helpTourSkip")?.addEventListener("click", endHelpTour);
  $("helpTourPrev")?.addEventListener("click", () => {
    if (helpTourIndex <= 0) return;
    helpTourIndex -= 1;
    renderHelpTourStep();
  });
  $("helpTourNext")?.addEventListener("click", () => {
    if (helpTourIndex >= helpTourSteps.length - 1) {
      endHelpTour();
      return;
    }
    helpTourIndex += 1;
    renderHelpTourStep();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("helpTourRoot")?.classList.contains("hidden")) {
      endHelpTour();
      return;
    }
    if (!$("mmPreviewDialog")?.classList.contains("hidden")) {
      closeMmPreview();
      return;
    }
    if (!$("createProjectDialog")?.classList.contains("hidden")) {
      closeCreateProjectDialog();
      return;
    }
    if (!$("projectsBrowserDialog")?.classList.contains("hidden")) {
      closeProjectsBrowser();
    }
  });
}

document.addEventListener("DOMContentLoaded", initApp);
window.addEventListener("resize", () => {
  if (currentPost) renderInteractiveCanvas();
});
