import express from "express";
import multer from "multer";
import cors from "cors";
import sharp from "sharp";
import fs from "fs";

import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";

const app = express();

// If you want to lock CORS down later, set FRONTEND_ORIGINS="https://britstern2026-jpg.github.io"
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow curl / same-origin / server-to-server
      if (!origin) return cb(null, true);

      // if not configured, keep behavior similar to your original `app.use(cors())`
      // (open CORS), to avoid breaking during setup.
      if (FRONTEND_ORIGINS.length === 0) return cb(null, true);

      return FRONTEND_ORIGINS.includes(origin)
        ? cb(null, true)
        : cb(new Error(`CORS blocked origin: ${origin}`), false);
    },
    allowedHeaders: ["Content-Type", "x-gallery-password"],
    methods: ["GET", "POST", "OPTIONS"]
  })
);

const upload = multer({ dest: "uploads/" });

// ==========================
// ✅ Cloudflare R2 Config (S3-compatible)
// ==========================
const R2_BUCKET = process.env.R2_BUCKET || "image-sharing-bucket";
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";

// Signed URL expiry (same logic as your 7 days in GCS)
const SIGNED_URL_EXPIRES_SECONDS = Number(
  process.env.SIGNED_URL_EXPIRES_SECONDS || 7 * 24 * 60 * 60
);

const R2_ENDPOINT = R2_ACCOUNT_ID
  ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  : "";

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials:
    R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
      ? { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
      : undefined
});

function safeTrim(v, fallback) {
  const s = (v || "").toString().trim();
  return s ? s : fallback;
}

function sanitizeForKey(name) {
  // keep it close to your original behavior but avoid weird keys:
  // convert spaces -> underscore, remove problematic chars
  return safeTrim(name, "photo")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "photo";
}

async function signGet(key) {
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: SIGNED_URL_EXPIRES_SECONDS });
}

async function headMetadata(key) {
  const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  return head?.Metadata || {};
}

// ==========================
// ✅ Health check
// ==========================
app.get("/", (req, res) => {
  res.send("✅ Backend is running. Use POST /upload to upload photos.");
});

// ==========================
// ✅ Upload endpoint (ORIGINAL + THUMB)
// ==========================
app.post("/upload", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const rawName = safeTrim(req.body.name, "photo");
    const nameForKey = sanitizeForKey(rawName);

    const visibility = safeTrim(req.body.visibility, "private"); // keep your default
    const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    const originalName = `${nameForKey}_${timestamp}.${ext}`;
    const thumbName = `thumbs/${nameForKey}_${timestamp}.jpg`;

    // ✅ Create thumbnail locally
    const thumbPath = `${req.file.path}_thumb.jpg`;

    // ✅ IMPORTANT FIX (kept from your code):
    // Bake rotation + force orientation=1 so thumbs never appear sideways in any browser
    await sharp(req.file.path)
      .rotate()
      .withMetadata({ orientation: 1 })
      .resize({ width: 600 })
      .jpeg({ quality: 70 })
      .toFile(thumbPath);

    // ✅ Upload original to R2
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: originalName,
        Body: fs.createReadStream(req.file.path),
        ContentType: req.file.mimetype,
        Metadata: {
          visibility,
          thumb: thumbName
        }
      })
    );

    // ✅ Upload thumbnail to R2
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: thumbName,
        Body: fs.createReadStream(thumbPath),
        ContentType: "image/jpeg",
        Metadata: {
          visibility,
          isthumb: "true"
        }
      })
    );

    // cleanup temp files
    fs.unlink(req.file.path, () => {});
    fs.unlink(thumbPath, () => {});

    res.json({
      ok: true,
      bucket: R2_BUCKET,
      objectName: originalName,
      thumbObject: thumbName,
      visibility
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// ==========================
// ✅ Photos endpoint (returns thumb + full)
// ==========================
app.get("/photos", async (req, res) => {
  try {
    const requestPassword = safeTrim(req.header("x-gallery-password"), "");
    const isAdmin = requestPassword === ADMIN_PASSWORD;

    // List all objects (event scale)
    const allKeys = [];
    let ContinuationToken = undefined;

    do {
      const out = await s3.send(
        new ListObjectsV2Command({
          Bucket: R2_BUCKET,
          ContinuationToken
        })
      );

      (out.Contents || []).forEach((o) => {
        if (o?.Key) allKeys.push({ key: o.Key, lastModified: o.LastModified });
      });

      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken);

    // newest first (same intent as your GCS updated sort)
    allKeys.sort((a, b) => {
      const ta = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const tb = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return tb - ta;
    });

    // ✅ remove thumbnails from list (we link them via metadata)
    const originals = allKeys.filter((o) => !o.key.startsWith("thumbs/"));

    // filter public unless admin (visibility is stored in object metadata)
    const visibleOriginals = [];
    for (const o of originals) {
      const meta = await headMetadata(o.key);
      const vis = safeTrim(meta.visibility, "private");
      if (isAdmin || vis === "public") visibleOriginals.push({ ...o, meta });
    }

    const photos = await Promise.all(
      visibleOriginals.map(async ({ key, lastModified, meta }) => {
        const thumbPath = meta.thumb;

        const signedUrl = await signGet(key);

        let signedThumbUrl = signedUrl; // fallback = full image
        if (thumbPath) {
          signedThumbUrl = await signGet(thumbPath);
        }

        // Try to head for contentType/size (optional but matches your response fields)
        let contentType = null;
        let size = null;
        let updated = lastModified || null;
        try {
          const head = await s3.send(
            new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key })
          );
          contentType = head.ContentType || null;
          size = head.ContentLength != null ? String(head.ContentLength) : null;
          updated = head.LastModified || updated;
        } catch {
          // ignore
        }

        return {
          name: key,
          signedUrl,
          signedThumbUrl,
          visibility: safeTrim(meta.visibility, "private"),
          updated,
          size,
          contentType
        };
      })
    );

    res.json({ ok: true, admin: isAdmin, photos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch photos" });
  }
});

// ==========================
// ✅ Start server
// ==========================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
