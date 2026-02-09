// ✅ Change this if backend URL changes
const BACKEND_URL = "https://image-sharing-api-1mk9.onrender.com";

const statusEl = document.getElementById("galleryStatus");
const gridEl = document.getElementById("galleryGrid");
const countEl = document.getElementById("galleryCount");

// ✅ NEW filter UI
const nameFilterEl = document.getElementById("nameFilter");
const clearFilterBtn = document.getElementById("clearFilterBtn");

// ✅ NEW viewer modal
const viewer = document.getElementById("viewer");
const viewerBackdrop = document.getElementById("viewerBackdrop");
const viewerClose = document.getElementById("viewerClose");
const viewerPrev = document.getElementById("viewerPrev");
const viewerNext = document.getElementById("viewerNext");
const viewerImg = document.getElementById("viewerImg");
const viewerName = document.getElementById("viewerName");
const viewerOpen = document.getElementById("viewerOpen");
const viewerLoader = document.getElementById("viewerLoader");

let allPhotos = [];
let filteredPhotos = [];
let currentIndex = -1;

/* ✅ OWNER MODE */
const urlParams = new URLSearchParams(window.location.search);
const wantsOwnerMode = urlParams.get("owner") === "1";
const savedPassword = localStorage.getItem("gallery_admin_pw") || "";
const adminMode = wantsOwnerMode && !!savedPassword;

function getUploaderFromFilename(filename) {
  const idx = filename.indexOf("_");
  if (idx <= 0) return "ללא שם";
  return filename.slice(0, idx);
}

function setStatus(msg, type = "") {
  statusEl.textContent = msg || "";
  statusEl.classList.remove("ok", "err");
  if (type === "ok") statusEl.classList.add("ok");
  if (type === "err") statusEl.classList.add("err");
}

function openViewer(index) {
  currentIndex = index;
  const p = filteredPhotos[currentIndex];
  if (!p) return;

  viewer.classList.remove("hidden");
  viewer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  // ✅ show loader
  viewerLoader.classList.remove("hidden");

  // ✅ reset image
  viewerImg.src = "";
  viewerImg.alt = p.name;

  viewerName.textContent = p.uploader;
  viewerOpen.href = p.signedUrl;

  // ✅ preload full image
  const pre = new Image();
  pre.onload = () => {
    viewerImg.src = p.signedUrl;
    viewerLoader.classList.add("hidden");
  };
  pre.onerror = () => {
    viewerLoader.classList.add("hidden");
    setStatus("❌ לא הצלחנו לטעון את התמונה", "err");
  };

  pre.src = p.signedUrl;
}

function closeViewer() {
  viewer.classList.add("hidden");
  viewer.setAttribute("aria-hidden", "true");

  viewerImg.src = "";
  viewerLoader.classList.add("hidden");

  document.body.style.overflow = "";
}

function showNext() {
  if (!filteredPhotos.length) return;
  currentIndex = (currentIndex + 1) % filteredPhotos.length;
  openViewer(currentIndex);
}

function showPrev() {
  if (!filteredPhotos.length) return;
  currentIndex = (currentIndex - 1 + filteredPhotos.length) % filteredPhotos.length;
  openViewer(currentIndex);
}

function renderGrid(list) {
  gridEl.innerHTML = "";

  list.forEach((p, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "photoCard";
    card.setAttribute("aria-label", `פתח תמונה של ${p.uploader}`);
    card.addEventListener("click", () => openViewer(i));

    const img = document.createElement("img");
    img.className = "photoImg";
    img.loading = "lazy";
    img.alt = p.name;
    img.src = p.signedThumbUrl || p.signedUrl;

    card.appendChild(img);
    gridEl.appendChild(card);
  });
}

function applyFilter() {
  const selectedName = nameFilterEl.value;

  if (!selectedName) {
    filteredPhotos = [...allPhotos];
  } else {
    filteredPhotos = allPhotos.filter(p => p.uploader === selectedName);
  }

  countEl.textContent = `✅ מוצגות ${filteredPhotos.length} תמונות`;
  renderGrid(filteredPhotos);
}

function populateFilterOptions() {
  const names = Array.from(new Set(allPhotos.map(p => p.uploader)))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "he"));

  nameFilterEl.innerHTML = `<option value="">הכל</option>`;

  names.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    nameFilterEl.appendChild(opt);
  });
}

async function loadPhotos() {
  gridEl.innerHTML = "";
  countEl.textContent = "";

  try {
    const headers = { "Accept": "application/json" };

    // ✅ owner mode → send password
    if (adminMode) {
      headers["x-gallery-password"] = savedPassword;
    }

    const res = await fetch(`${BACKEND_URL}/photos`, {
      method: "GET",
      headers
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Failed to load gallery");
    }

    // ✅ owner requested but password wrong
    if (adminMode && !data.admin) {
      localStorage.removeItem("gallery_admin_pw");
      setStatus("❌ סיסמה לא נכונה. חוזר לעמוד הסיסמה.", "err");
      setTimeout(() => window.location.href = "owner.html", 900);
      return;
    }

    const photos = data.photos || [];

    if (photos.length === 0) {
      setStatus("אין תמונות להצגה כרגע.", "ok");
      return;
    }

    allPhotos = photos.map(p => ({
      ...p,
      uploader: getUploaderFromFilename(p.name)
    }));

    setStatus("", "ok");
    populateFilterOptions();
    filteredPhotos = [...allPhotos];

    countEl.textContent = adminMode
      ? `🔒 מצב בעל האירוע: ${allPhotos.length} תמונות`
      : `✅ נמצאו ${allPhotos.length} תמונות`;

    renderGrid(filteredPhotos);

  } catch (err) {
    console.error(err);
    setStatus(`❌ שגיאה: ${err.message}`, "err");
  }
}

/* ✅ Filter events */
nameFilterEl.addEventListener("change", applyFilter);
clearFilterBtn.addEventListener("click", () => {
  nameFilterEl.value = "";
  applyFilter();
});

/* ✅ Viewer events */
viewerClose.addEventListener("click", closeViewer);
viewerBackdrop.addEventListener("click", closeViewer);
viewerNext.addEventListener("click", showNext);
viewerPrev.addEventListener("click", showPrev);

document.addEventListener("keydown", (e) => {
  if (viewer.classList.contains("hidden")) return;
  if (e.key === "Escape") closeViewer();
  if (e.key === "ArrowRight") showNext();
  if (e.key === "ArrowLeft") showPrev();
});

let touchStartX = 0;
viewerImg.addEventListener("touchstart", (e) => {
  touchStartX = e.touches[0].clientX;
});
viewerImg.addEventListener("touchend", (e) => {
  const endX = e.changedTouches[0].clientX;
  const diff = endX - touchStartX;
  if (Math.abs(diff) > 40) {
    diff < 0 ? showNext() : showPrev();
  }
});

loadPhotos();
