const BACKEND_URL = "https://image-sharing-api-1mk9.onrender.com";

const nameInput = document.getElementById("nameInput");
const photoInput = document.getElementById("photoInput");
const fileNameEl = document.getElementById("fileName");
const preview = document.getElementById("preview");
const uploadBtn = document.getElementById("uploadBtn");
const statusEl = document.getElementById("status");
const publicCheckbox = document.getElementById("publicCheckbox");

const btnText = uploadBtn.querySelector(".btnText");
const spinner = uploadBtn.querySelector(".spinner");

let selectedFile = null;
let uploading = false;

// ✅ simple gate: require landing password first
if (localStorage.getItem("landing_ok") !== "1") {
  window.location.href = "landing.html";
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

function updateUIFromFile() {
  if (!selectedFile) {
    fileNameEl.textContent = "לא נבחרה תמונה";
    preview.style.display = "none";
    uploadBtn.disabled = true;
    return;
  }

  fileNameEl.textContent = selectedFile.name || "נבחרה תמונה";
  preview.src = URL.createObjectURL(selectedFile);
  preview.style.display = "block";
  uploadBtn.disabled = false;
  setStatus("");
}

/**
 * iPhone Chrome reliability trick:
 * Sometimes the file appears slightly after the change event.
 */
function readFileFromInput() {
  selectedFile = photoInput.files && photoInput.files[0] ? photoInput.files[0] : null;
  updateUIFromFile();
}

async function compressImage(file) {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();

  const maxSize = 1600; // px
  let { width, height } = img;

  if (width > height && width > maxSize) {
    height *= maxSize / width;
    width = maxSize;
  } else if (height > maxSize) {
    width *= maxSize / height;
    height = maxSize;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      "image/jpeg",
      0.75 // quality (sweet spot)
    );
  });
}

/**
 * ✅ Upload with real progress (better UX on slow networks)
 * Uses XHR because fetch() doesn't provide upload progress events.
 */
function uploadWithProgress(formData) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BACKEND_URL}/upload`, true);

    // Optional: helps backend know we want JSON
    xhr.setRequestHeader("Accept", "application/json");

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;

      const pct = Math.max(1, Math.min(99, Math.round((e.loaded / e.total) * 100)));

      // Keep spinner + disable button via setUploading(true)
      setStatus(`אנא המתן... `);
      btnText.textContent = `מעלה... ${pct}%`;
    };

    xhr.onload = () => {
      // Try parse JSON even on non-200 to extract error message
      let data = null;
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch (_) {
        // If backend returns HTML or something unexpected
        return reject(new Error("תגובה לא תקינה מהשרת"));
      }

      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
        return resolve(data);
      }

      const msg = (data && data.error) ? data.error : "העלאה נכשלה";
      return reject(new Error(msg));
    };

    xhr.onerror = () => reject(new Error("שגיאת רשת. נסו שוב."));
    xhr.ontimeout = () => reject(new Error("תם הזמן להעלאה. נסו שוב."));
    xhr.timeout = 120000; // 2 minutes (adjust if you want)

    xhr.send(formData);
  });
}

photoInput.addEventListener("change", () => {
  readFileFromInput();
  setTimeout(readFileFromInput, 80);
  setTimeout(readFileFromInput, 200);
});

photoInput.addEventListener("input", () => {
  readFileFromInput();
  setTimeout(readFileFromInput, 80);
  setTimeout(readFileFromInput, 200);
});

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
    // ✅ Compress first (already improves speed)
    setStatus("מכין תמונה...");
    const compressedBlob = await compressImage(selectedFile);
    if (!compressedBlob) throw new Error("לא ניתן לדחוס את התמונה");

    formData.append("photo", compressedBlob, "photo.jpg");
    formData.append("name", safeName);
    formData.append("visibility", publicCheckbox.checked ? "public" : "private");

    setUploading(true);
    setStatus("מעלה...");

    // ✅ Use progress upload
    await uploadWithProgress(formData);

    setStatus("✅ הועלה בהצלחה", "ok");

    // Reset for next upload
    selectedFile = null;
    photoInput.value = "";
    nameInput.value = "";
    publicCheckbox.checked = true; // default to everyone
    updateUIFromFile();

    // Restore button text (in case progress overwrote it)
    btnText.textContent = "העלאה";

    setTimeout(() => setStatus(""), 3500);
  } catch (err) {
    setStatus(`❌ שגיאה: ${err.message}`, "err");
    btnText.textContent = "העלאה";
  } finally {
    setUploading(false);
  }
});
