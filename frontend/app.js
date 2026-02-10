const BACKEND_URL = "https://image-sharing-api-1mk9.onrender.com";

const nameInput = document.getElementById("nameInput");
const photoInput = document.getElementById("photoInput");
const pickBtn = document.getElementById("pickBtn");
const fileNameEl = document.getElementById("fileName");
const preview = document.getElementById("preview");
const uploadBtn = document.getElementById("uploadBtn");
const statusEl = document.getElementById("status");
const publicCheckbox = document.getElementById("publicCheckbox");

// ✅ Android-only inputs/buttons
const photoInputCamera = document.getElementById("photoInputCamera");
const androidCameraBtn = document.getElementById("androidCameraBtn");
const androidLibraryBtn = document.getElementById("androidLibraryBtn");

const btnText = uploadBtn.querySelector(".btnText");
const spinner = uploadBtn.querySelector(".spinner");

let selectedFile = null;
let uploading = false;

// ✅ simple gate: require landing password first
if (localStorage.getItem("landing_ok") !== "1") {
  window.location.href = "landing.html";
}

const ua = navigator.userAgent || "";
const isAndroid = /Android/i.test(ua);

/**
 * ✅ NEW: Hide the iOS-style button on Android only.
 * iOS stays exactly the same.
 */
if (isAndroid && pickBtn) {
  pickBtn.style.display = "none";
}

/**
 * ✅ CRITICAL FIX:
 * Now that we have a dedicated camera input (photoInputCamera),
 * DO NOT set capture on the normal input (photoInput).
 * Otherwise Android "gallery" will still behave like camera.
 */
photoInput.removeAttribute("capture");

// ✅ Show Android buttons (if they exist)
if (isAndroid && androidCameraBtn && photoInputCamera) {
  androidCameraBtn.style.display = "block";
  androidCameraBtn.addEventListener("click", () => {
    try {
      photoInputCamera.value = ""; // allow taking the same photo twice
      photoInputCamera.click();
    } catch {}
  });
}

if (isAndroid && androidLibraryBtn && photoInput) {
  androidLibraryBtn.style.display = "block";
  androidLibraryBtn.addEventListener("click", () => {
    try {
      photoInput.value = ""; // allow selecting the same file twice
      photoInput.click();     // opens gallery picker
    } catch {}
  });
}

function setStatus(msg, type = "") {
  statusEl.textContent = msg || "";
  statusEl.classList.remove("ok", "err");
  if (type === "ok") statusEl.classList.add("ok");
  if (type === "err") statusEl.classList.add("err");
}

function setUploading(isUploading) {
  uploading = isUploading;
  uploadBtn.disabled = isUploading || !selectedFile;
  spinner.style.display = isUploading ? "inline-block" : "none";
  btnText.textContent = isUploading ? "מעלה..." : "העלאה";
}

function applyPreviewConstraints() {
  preview.style.width = "100%";
  preview.style.maxHeight = "45vh";
  preview.style.objectFit = "contain";
  const parent = preview.parentElement;
  if (parent) {
    parent.style.maxHeight = "45vh";
    parent.style.overflow = "hidden";
  }
}

function updateUIFromFile() {
  if (!selectedFile) {
    fileNameEl.textContent = "לא נבחרה תמונה";
    preview.style.display = "none";
    uploadBtn.disabled = true;
    return;
  }

  fileNameEl.textContent = selectedFile.name || "נבחרה תמונה";
  applyPreviewConstraints();

  preview.src = URL.createObjectURL(selectedFile);
  preview.style.display = "block";

  uploadBtn.disabled = false;
  setStatus("");

  try {
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch {
    window.scrollTo(0, 0);
  }
}

function readFileFromInput() {
  const f = photoInput.files && photoInput.files[0] ? photoInput.files[0] : null;
  selectedFile = f;
  updateUIFromFile();
}

function readFileFromCameraInput() {
  if (!photoInputCamera) return;
  const f = photoInputCamera.files && photoInputCamera.files[0] ? photoInputCamera.files[0] : null;
  selectedFile = f;
  updateUIFromFile();
}

// Keep your iOS-friendly label behavior.
// On Android, we do NOT preventDefault anymore. It can still work as a fallback.
if (pickBtn) {
  pickBtn.addEventListener("click", () => {
    // no-op; label default will open photoInput
  });
}

function delayedReRead() {
  setTimeout(readFileFromInput, 50);
  setTimeout(readFileFromInput, 150);
  setTimeout(readFileFromInput, 350);

  setTimeout(readFileFromCameraInput, 50);
  setTimeout(readFileFromCameraInput, 150);
  setTimeout(readFileFromCameraInput, 350);
}

window.addEventListener("focus", delayedReRead);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) delayedReRead();
});

photoInput.addEventListener("change", () => {
  readFileFromInput();
  delayedReRead();
});

photoInput.addEventListener("input", () => {
  readFileFromInput();
  delayedReRead();
});

if (photoInputCamera) {
  photoInputCamera.addEventListener("change", () => {
    readFileFromCameraInput();
    delayedReRead();
  });

  photoInputCamera.addEventListener("input", () => {
    readFileFromCameraInput();
    delayedReRead();
  });
}

function isHeicLike(file) {
  const name = (file?.name || "").toLowerCase();
  const type = (file?.type || "").toLowerCase();
  return (
    type.includes("image/heic") ||
    type.includes("image/heif") ||
    name.endsWith(".heic") ||
    name.endsWith(".heif")
  );
}

async function compressImageToJpegBlob(file) {
  if (isHeicLike(file)) {
    throw new Error(
      "נבחר קובץ HEIC/HEIF (נפוץ באייפון/מק). הדפדפן לא מצליח לעבד אותו. " +
      "בבקשה המירו ל-JPG (Export כ-JPEG) או צלמו מחדש בתוך הדפדפן."
    );
  }

  let bitmap = null;
  if ("createImageBitmap" in window) {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      bitmap = null;
    }
  }

  if (!bitmap) {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    bitmap = img;
  }

  const maxSize = 1600;
  let width = bitmap.width;
  let height = bitmap.height;

  if (width > height && width > maxSize) {
    height = Math.round(height * (maxSize / width));
    width = maxSize;
  } else if (height > maxSize) {
    width = Math.round(width * (maxSize / height));
    height = maxSize;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);

  if (bitmap && bitmap.close) {
    try { bitmap.close(); } catch {}
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.75);
  });
}

function uploadWithProgress(formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BACKEND_URL}/upload`, true);
    xhr.setRequestHeader("Accept", "application/json");

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.max(1, Math.min(99, Math.round((e.loaded / e.total) * 100)));
      setStatus("אנא המתן...");
      btnText.textContent = `מעלה... ${pct}%`;
    };

    xhr.onload = () => {
      const raw = xhr.responseText || "";
      const ct = (xhr.getResponseHeader("content-type") || "").toLowerCase();
      const looksJson = ct.includes("application/json") || raw.trim().startsWith("{");

      if (!looksJson) {
        const snippet = raw.trim().replace(/\s+/g, " ").slice(0, 200);
        return reject(new Error(`שגיאת שרת (${xhr.status}). ${snippet || "תגובה לא-JSON"}`));
      }

      let data = null;
      try {
        data = JSON.parse(raw || "{}");
      } catch (_) {
        return reject(new Error(`שגיאת שרת (${xhr.status}). JSON לא תקין`));
      }

      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
        return resolve(data);
      }

      const msg = (data && data.error) ? data.error : "העלאה נכשלה";
      return reject(new Error(msg));
    };

    xhr.onerror = () => reject(new Error("שגיאת רשת. נסו שוב."));
    xhr.ontimeout = () => reject(new Error("תם הזמן להעלאה. נסו שוב."));
    xhr.timeout = 240000;

    xhr.send(formData);
  });
}

uploadBtn.addEventListener("click", async () => {
  if (uploading) return;

  if (!selectedFile) {
    setStatus("❌ לא נבחרה תמונה. נסו לבחור שוב.", "err");
    return;
  }

  const rawName = (nameInput.value || "").trim();
  const safeName = rawName.length ? rawName : "ללא שם";

  const formData = new FormData();

  try {
    setStatus("מכין תמונה...");

    try {
      const compressedBlob = await compressImageToJpegBlob(selectedFile);
      if (!compressedBlob) throw new Error("לא ניתן לדחוס את התמונה");
      formData.append("photo", compressedBlob, "photo.jpg");
    } catch (e) {
      if (isHeicLike(selectedFile)) throw e;
      console.warn("Compression failed, uploading original file:", e);
      formData.append("photo", selectedFile, selectedFile.name || "image");
    }

    formData.append("name", safeName);
    formData.append("visibility", publicCheckbox.checked ? "public" : "private");

    setUploading(true);
    setStatus("מעלה...");

    await uploadWithProgress(formData);

    setStatus("✅ הועלה בהצלחה", "ok");

    selectedFile = null;
    photoInput.value = "";
    if (photoInputCamera) photoInputCamera.value = "";
    nameInput.value = "";
    publicCheckbox.checked = true;
    updateUIFromFile();

    btnText.textContent = "העלאה";
    setTimeout(() => setStatus(""), 3500);
  } catch (err) {
    setStatus(`❌ שגיאה: ${err.message}`, "err");
    btnText.textContent = "העלאה";
  } finally {
    setUploading(false);
  }
});
