(() => {
  // === CONSTANTS ===
  const API = "";
  const SESSION_STORAGE_KEY = "blackenvelope:session:v1";
  const KEY_BACKUP_VERSION = 1;
  const ENCRYPTED_KEY_BACKUP_VERSION = 1;
  const ENCRYPTED_KEY_BACKUP_PBKDF2_ITERATIONS = 250000;
  const ENCRYPTED_KEY_BACKUP_MAX_BYTES = 300000;
  const MESSAGE_ENVELOPE_VERSION = 1;
  const MAX_MEDIA_FILE_BYTES = 10 * 1024 * 1024; // 10MB per attachment (post-compression cap)
  const MAX_MEDIA_SOURCE_BYTES = 50 * 1024 * 1024; // max raw media size accepted before compression
  const MEDIA_AUTO_COMPRESS_THRESHOLD_BYTES = 1 * 1024 * 1024; // compress media above 1MB
  const ACTIVE_FEED_PAGE_LIMIT = 40;
  const ACTIVE_FEED_REALTIME_PULL_LIMIT = 8;
  const ACTIVE_FEED_SCROLL_TOP_THRESHOLD = 80;
  const NOTIFICATION_PAGE_LIMIT = 10;
  const NOTIFICATION_SCROLL_BOTTOM_THRESHOLD = 60;
  const AVATAR_COLORS = ["#e17076","#7bc862","#e5ca77","#65aadd","#a695e7","#ee7aae","#6ec9cb"];
  const CONV_CACHE_KEY = "blackenvelope:conv-cache:v1";
  const CONV_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const ADMIN_USERS_HASH_ROUTE = "#/admin/users";

  // === STATE ===
  const state = {
    token: null,
    me: null,
    myPrivateKey: null,
    myPublicJwk: null,

    friends: new Map(),
    groups: new Map(),
    groupTopics: new Map(),
    groupMembers: new Map(),

    incomingFriendRequests: [],
    outgoingFriendRequests: [],
    pendingGroupInvites: [],

    activeType: null,
    activeFriend: null,
    activeGroupId: null,
    activeGroupTopic: "all",
    activeFeedKey: "",
    activeRows: [],
    activeHasMore: false,
    activeNextBeforeId: null,
    activeFeedLoading: false,
    activeFeedLoadingOlder: false,
    activeFeedRequestSeq: 0,
    activeFeedPendingRealtimePull: false,

    conversationPreviews: new Map(),
    searchMode: false,
    searchQuery: "",
    mobileView: "sidebar",
    activeModal: null,
    fabOpen: false,
    pendingAttachment: null,
    billingCheckoutUrl: "",
    activeViewMode: "all",
    pendingResetToken: "",
    googleIdToken: "",
    googleSuggestedUsername: "",
    authRegisterBusy: false,
    publicConfig: null,
    sendBusy: false,
    adminUsersPageOpen: false,
    adminUsersPageLoading: false,

    ws: null,
    wsHeartbeatTimer: null,
    wsLastSeenAt: 0,

    notificationSoundEnabled: true,
    _notifUnreadCount: 0,
    pushSubscription: null,
    notificationRows: [],
    notificationHasMore: false,
    notificationNextBeforeId: null,
    notificationLoading: false,

    mention: {
      open: false,
      query: "",
      atPos: 0,
      caretPos: 0,
      users: [],
      activeIndex: 0,
    },

    voiceRecorder: {
      mediaRecorder: null,
      chunks: [],
      timerInterval: null,
      startTime: 0,
    },

    // legacy compat
    inviteSuggestionUsers: [],
    inviteSuggestionIndex: -1,
  };

  // === UTILITIES ===
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const KDF_INFO = enc.encode("blackenvelope-v1");
  const $ = (id) => document.getElementById(id);
  let searchTimer = null;
  let inviteSearchTimer = null;
  let mentionTimer = null;
  let publicConfigPromise = null;

  function avatarColor(name) {
    let hash = 0;
    for (const ch of (name || "")) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  function avatarLetter(name) {
    return (name || "?").charAt(0).toUpperCase();
  }

  function createAvatarEl(name, cls, avatarB64) {
    const el = document.createElement("div");
    el.className = "avatar" + (cls ? " " + cls : "");
    if (avatarB64) {
      el.style.backgroundImage = "url(" + avatarB64 + ")";
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
      el.classList.add("has-image");
      el.textContent = "";
    } else {
      el.style.background = avatarColor(name);
      el.textContent = avatarLetter(name);
    }
    return el;
  }

  function scrollMessagesAreaToBottom(area) {
    if (!area) return;
    area.scrollTop = area.scrollHeight;
  }

  function scheduleMessagesAreaBottomLock(area) {
    if (!area) return;
    const stick = () => scrollMessagesAreaToBottom(area);

    // Immediate + delayed passes to handle async layout changes (media/font sizing).
    stick();
    requestAnimationFrame(() => requestAnimationFrame(stick));
    setTimeout(stick, 120);
    setTimeout(stick, 320);

    const mediaEls = area.querySelectorAll(
      "img.bubble-media-image, video.bubble-media-video, audio.bubble-media-audio"
    );
    for (const mediaEl of mediaEls) {
      const tag = mediaEl.tagName;
      if (tag === "IMG") {
        if (!mediaEl.complete) mediaEl.addEventListener("load", stick, { once: true });
        continue;
      }
      if ((tag === "VIDEO" || tag === "AUDIO") && Number(mediaEl.readyState) < 1) {
        mediaEl.addEventListener("loadedmetadata", stick, { once: true });
      }
    }
  }

  function formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.floor((today - msgDay) / 86400000);

    if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function formatDateDivider(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.floor((today - msgDay) / 86400000);

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }

  function showToast(msg, type = "") {
    const container = $("toastContainer");
    const toast = document.createElement("div");
    toast.className = "toast" + (type ? " " + type : "");
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = "toastOut 0.25s ease forwards";
      setTimeout(() => toast.remove(), 250);
    }, 3000);
  }

  // === IN-APP CONFIRM / PROMPT (replaces window.confirm & window.prompt for iOS PWA) ===

  function confirmAsync(message, options = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      const card = document.createElement("div");
      card.className = "confirm-card";

      const msg = document.createElement("div");
      msg.className = "confirm-msg";
      msg.textContent = message;
      card.appendChild(msg);

      const btns = document.createElement("div");
      btns.className = "confirm-btns";

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "confirm-btn cancel";
      cancelBtn.textContent = options.cancelLabel || "Cancel";
      cancelBtn.addEventListener("click", () => { overlay.remove(); resolve(false); });
      btns.appendChild(cancelBtn);

      const okBtn = document.createElement("button");
      okBtn.className = "confirm-btn ok" + (options.danger ? " danger" : "");
      okBtn.textContent = options.okLabel || "Confirm";
      okBtn.addEventListener("click", () => { overlay.remove(); resolve(true); });
      btns.appendChild(okBtn);

      card.appendChild(btns);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      okBtn.focus();
    });
  }

  function askPassphraseAsync({ confirmPassphrase, purpose }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      const card = document.createElement("div");
      card.className = "confirm-card passphrase-card";

      const title = document.createElement("div");
      title.className = "confirm-msg";
      title.textContent = "Enter a recovery passphrase to " + purpose + ".";
      card.appendChild(title);

      const input1 = document.createElement("input");
      input1.type = "password";
      input1.className = "passphrase-input";
      input1.placeholder = "Recovery passphrase (12+ chars)";
      input1.autocomplete = "off";
      card.appendChild(input1);

      let input2 = null;
      if (confirmPassphrase) {
        input2 = document.createElement("input");
        input2.type = "password";
        input2.className = "passphrase-input";
        input2.placeholder = "Confirm passphrase";
        input2.autocomplete = "off";
        card.appendChild(input2);
      }

      const errEl = document.createElement("div");
      errEl.className = "passphrase-error";
      card.appendChild(errEl);

      const btns = document.createElement("div");
      btns.className = "confirm-btns";

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "confirm-btn cancel";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => { overlay.remove(); resolve(null); });
      btns.appendChild(cancelBtn);

      const okBtn = document.createElement("button");
      okBtn.className = "confirm-btn ok";
      okBtn.textContent = "Submit";
      okBtn.addEventListener("click", () => {
        const passphrase = input1.value.trim();
        if (passphrase.length < 12) {
          errEl.textContent = "Passphrase must be at least 12 characters.";
          input1.focus();
          return;
        }
        if (confirmPassphrase && passphrase !== (input2 ? input2.value.trim() : "")) {
          errEl.textContent = "Passphrases do not match.";
          if (input2) input2.focus();
          return;
        }
        overlay.remove();
        resolve(passphrase);
      });
      btns.appendChild(okBtn);

      card.appendChild(btns);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      // Submit on Enter
      const onKey = (e) => { if (e.key === "Enter") okBtn.click(); };
      input1.addEventListener("keydown", onKey);
      if (input2) input2.addEventListener("keydown", onKey);

      input1.focus();
    });
  }

  function bytesToB64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function b64ToBytes(value) {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${Math.round(bytes)} B`;
  }

  function mediaTopType(mime) {
    return String(mime || "").split("/")[0].toLowerCase();
  }

  function pickMediaRecorderMime(candidates) {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
      return "";
    }
    for (const candidate of candidates) {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    }
    return "";
  }

  function waitForLoadedMetadata(mediaEl) {
    return new Promise((resolve, reject) => {
      if (mediaEl.readyState >= 1) {
        resolve();
        return;
      }
      let settled = false;
      const finish = (fn) => (evt) => {
        if (settled) return;
        settled = true;
        mediaEl.removeEventListener("loadedmetadata", onLoaded);
        mediaEl.removeEventListener("error", onError);
        fn(evt);
      };
      const onLoaded = finish(() => resolve());
      const onError = finish(() => reject(new Error("Unable to read selected media file.")));
      mediaEl.addEventListener("loadedmetadata", onLoaded, { once: true });
      mediaEl.addEventListener("error", onError, { once: true });
    });
  }

  function blobToFile(blob, name, mimeOverride) {
    const mime = mimeOverride || blob.type || "application/octet-stream";
    try {
      return new File([blob], name, { type: mime, lastModified: Date.now() });
    } catch (_e) {
      // Safari fallback when File constructor is unavailable.
      blob.name = name;
      blob.lastModified = Date.now();
      return blob;
    }
  }

  function swapFileExtension(filename, nextExt) {
    if (!nextExt) return filename || "attachment";
    const rawName = String(filename || "attachment");
    const dot = rawName.lastIndexOf(".");
    const base = dot > 0 ? rawName.slice(0, dot) : rawName;
    return `${base}.${nextExt}`;
  }

  function extensionForMime(mime, fallback = "bin") {
    const normalized = String(mime || "").toLowerCase();
    if (normalized.includes("image/webp")) return "webp";
    if (normalized.includes("image/jpeg")) return "jpg";
    if (normalized.includes("video/webm")) return "webm";
    if (normalized.includes("video/mp4")) return "mp4";
    if (normalized.includes("audio/webm")) return "webm";
    if (normalized.includes("audio/ogg")) return "ogg";
    if (normalized.includes("audio/mp4")) return "m4a";
    return fallback;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Image compression failed."));
          return;
        }
        resolve(blob);
      }, mime, quality);
    });
  }

  async function loadImageElementFromFile(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Unable to load selected image."));
      });
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function compressImageFile(file, maxBytes) {
    const sourceMime = String(file.type || "");
    if (sourceMime.includes("gif") || sourceMime.includes("svg")) return null;

    const img = await loadImageElementFromFile(file);
    const sourceW = Math.max(1, img.naturalWidth || img.width || 1);
    const sourceH = Math.max(1, img.naturalHeight || img.height || 1);
    const qualityLevels = [0.82, 0.72, 0.62, 0.52, 0.42];
    const maxEdges = [1920, 1600, 1280, 1024];
    const targetMime = "image/webp";

    let bestBlob = null;
    for (const maxEdge of maxEdges) {
      const scale = Math.min(1, maxEdge / Math.max(sourceW, sourceH));
      const width = Math.max(1, Math.round(sourceW * scale));
      const height = Math.max(1, Math.round(sourceH * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(img, 0, 0, width, height);
      for (const q of qualityLevels) {
        const blob = await canvasToBlob(canvas, targetMime, q);
        if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
        if (blob.size <= maxBytes) return blob;
      }
    }
    return bestBlob;
  }

  function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  async function transcodeMediaWithRecorder(file, opts) {
    const {
      kind,
      maxBytes,
      targetMimeCandidates,
      maxEdge = 1280,
      fps = 24,
      minBitrate = 240000,
      maxBitrate = 1800000,
      defaultDuration = 15,
    } = opts;

    if (typeof MediaRecorder === "undefined") return null;
    if (typeof document === "undefined") return null;

    const recorderMime = pickMediaRecorderMime(targetMimeCandidates || []);
    if (!recorderMime) return null;

    const url = URL.createObjectURL(file);
    const mediaEl = document.createElement(kind === "video" ? "video" : "audio");
    mediaEl.preload = "metadata";
    mediaEl.src = url;
    mediaEl.muted = true;
    mediaEl.playsInline = true;

    let recorder = null;
    let animationId = 0;
    let captureStream = null;
    let sourceStream = null;
    let drawTimer = null;
    const chunks = [];
    const cleanup = () => {
      if (drawTimer) clearInterval(drawTimer);
      if (animationId) cancelAnimationFrame(animationId);
      if (captureStream) captureStream.getTracks().forEach((t) => t.stop());
      if (sourceStream) sourceStream.getTracks().forEach((t) => t.stop());
      try { mediaEl.pause(); } catch (_e) {}
      mediaEl.removeAttribute("src");
      mediaEl.load();
      URL.revokeObjectURL(url);
    };

    try {
      await waitForLoadedMetadata(mediaEl);
      const durationRaw = Number(mediaEl.duration);
      const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : defaultDuration;
      const bitrateTarget = clampNumber(
        Math.floor((maxBytes * 8 * 0.9) / duration),
        minBitrate,
        maxBitrate,
      );

      let recorderStream = null;
      if (kind === "video") {
        if (typeof HTMLCanvasElement === "undefined") return null;
        const sourceW = Math.max(2, Number(mediaEl.videoWidth) || 1280);
        const sourceH = Math.max(2, Number(mediaEl.videoHeight) || 720);
        const scale = Math.min(1, maxEdge / Math.max(sourceW, sourceH));
        const width = Math.max(2, Math.floor((sourceW * scale) / 2) * 2);
        const height = Math.max(2, Math.floor((sourceH * scale) / 2) * 2);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx || typeof canvas.captureStream !== "function") return null;
        captureStream = canvas.captureStream(fps);
        if (typeof mediaEl.captureStream === "function") {
          sourceStream = mediaEl.captureStream();
        } else if (typeof mediaEl.mozCaptureStream === "function") {
          sourceStream = mediaEl.mozCaptureStream();
        }
        if (sourceStream) sourceStream.getAudioTracks().forEach((track) => captureStream.addTrack(track));
        drawTimer = setInterval(() => {
          try {
            if (!mediaEl.paused && !mediaEl.ended) ctx.drawImage(mediaEl, 0, 0, width, height);
          } catch (_e) {}
        }, Math.max(16, Math.round(1000 / fps)));
        const drawFrame = () => {
          try {
            if (!mediaEl.paused && !mediaEl.ended) ctx.drawImage(mediaEl, 0, 0, width, height);
          } catch (_e) {}
          animationId = requestAnimationFrame(drawFrame);
        };
        drawFrame();
        recorderStream = captureStream;
      } else {
        if (typeof mediaEl.captureStream === "function") {
          sourceStream = mediaEl.captureStream();
        } else if (typeof mediaEl.mozCaptureStream === "function") {
          sourceStream = mediaEl.mozCaptureStream();
        }
        if (!sourceStream) return null;
        recorderStream = sourceStream;
      }

      const recorderOpts = kind === "video"
        ? {
            mimeType: recorderMime,
            videoBitsPerSecond: bitrateTarget,
            audioBitsPerSecond: 64000,
          }
        : {
            mimeType: recorderMime,
            audioBitsPerSecond: bitrateTarget,
          };

      recorder = new MediaRecorder(recorderStream, recorderOpts);
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };

      await new Promise((resolve, reject) => {
        const fail = (reason) => {
          const err = reason instanceof Error ? reason : new Error(String(reason || "Compression failed."));
          if (recorder && recorder.state !== "inactive") {
            try { recorder.stop(); } catch (_e) {}
          }
          reject(err);
        };
        recorder.onerror = (event) => fail(event?.error || new Error("Compression failed."));
        recorder.onstop = () => resolve();
        mediaEl.onended = () => {
          if (recorder.state !== "inactive") {
            try { recorder.stop(); } catch (_e) {}
          }
        };
        try {
          recorder.start(500);
        } catch (err) {
          fail(err);
          return;
        }
        Promise.resolve(mediaEl.play())
          .then(() => {
            if (!Number.isFinite(mediaEl.duration) || mediaEl.duration <= 0) {
              setTimeout(() => {
                if (recorder.state !== "inactive") {
                  try { recorder.stop(); } catch (_e) {}
                }
              }, 10000);
            }
          })
          .catch(() => fail(new Error("Unable to play media for compression.")));
      });

      const outBlob = new Blob(chunks, { type: recorderMime });
      return outBlob.size > 0 ? outBlob : null;
    } finally {
      cleanup();
    }
  }

  async function maybeCompressMediaFile(file) {
    const topType = mediaTopType(file.type);
    if (!["image", "video", "audio"].includes(topType)) {
      return { file, compressed: false, reason: "not-media" };
    }
    if (file.size <= MEDIA_AUTO_COMPRESS_THRESHOLD_BYTES) {
      return { file, compressed: false, reason: "already-small" };
    }

    let compressedBlob = null;
    if (topType === "image") {
      compressedBlob = await compressImageFile(file, MAX_MEDIA_FILE_BYTES);
    } else if (topType === "video") {
      compressedBlob = await transcodeMediaWithRecorder(file, {
        kind: "video",
        maxBytes: MAX_MEDIA_FILE_BYTES,
        targetMimeCandidates: [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm",
        ],
        maxEdge: 1280,
        fps: 24,
        minBitrate: 280000,
        maxBitrate: 1800000,
        defaultDuration: 60,
      });
    } else if (topType === "audio") {
      compressedBlob = await transcodeMediaWithRecorder(file, {
        kind: "audio",
        maxBytes: MAX_MEDIA_FILE_BYTES,
        targetMimeCandidates: [
          "audio/webm;codecs=opus",
          "audio/ogg;codecs=opus",
          "audio/webm",
          "audio/ogg",
        ],
        minBitrate: 24000,
        maxBitrate: 128000,
        defaultDuration: 30,
      });
    }

    if (!compressedBlob) {
      return { file, compressed: false, reason: "unsupported" };
    }
    if (compressedBlob.size >= file.size) {
      return { file, compressed: false, reason: "no-gain" };
    }
    const nextMime = compressedBlob.type || file.type || "application/octet-stream";
    const nextName = swapFileExtension(file.name || "attachment", extensionForMime(nextMime, "bin"));
    return {
      file: blobToFile(compressedBlob, nextName, nextMime),
      compressed: true,
      originalSize: file.size,
      compressedSize: compressedBlob.size,
    };
  }

  function buildMediaDataUrl(media) {
    if (!media || !media.data_b64) return "";
    const mime = media.mime || "application/octet-stream";
    return `data:${mime};base64,${media.data_b64}`;
  }

  function normalizeAttachment(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || "attachment").slice(0, 180);
    const mime = String(raw.mime || "application/octet-stream").slice(0, 120);
    const size = Number(raw.size || 0);
    const dataB64 = String(raw.data_b64 || "");
    if (!dataB64) return null;
    if (!Number.isFinite(size) || size < 0) return null;
    return { name, mime, size, data_b64: dataB64 };
  }

  function parseMessageContent(plaintext) {
    if (!plaintext) {
      return { type: "text", text: "[unable to decrypt]", media: null, undecryptable: true };
    }
    try {
      const obj = JSON.parse(plaintext);
      if (
        obj &&
        typeof obj === "object" &&
        obj.__be === 1 &&
        Number(obj.v) === MESSAGE_ENVELOPE_VERSION
      ) {
        const media = normalizeAttachment(obj.media);
        return {
          type: media ? "media" : "text",
          text: typeof obj.text === "string" ? obj.text : "",
          media,
          undecryptable: false,
        };
      }
    } catch (_e) {}
    return { type: "text", text: plaintext, media: null, undecryptable: false };
  }

  function previewTextFromContent(content) {
    if (!content || content.undecryptable) return "[unable to decrypt]";
    if (content.type === "media" && content.media) {
      const topType = String(content.media.mime || "").split("/")[0];
      const label = topType === "image"
        ? "Photo"
        : topType === "video"
          ? "Video"
          : topType === "audio"
            ? "Audio"
            : "File";
      if (content.text) return `${label}: ${content.text.slice(0, 50)}`;
      return `${label}: ${content.media.name || "attachment"}`;
    }
    return content.text ? content.text.slice(0, 50) : "";
  }

  function buildEncryptedMessageEnvelope(text, attachment) {
    const cleanText = String(text || "");
    if (!attachment) return cleanText;
    return JSON.stringify({
      __be: 1,
      v: MESSAGE_ENVELOPE_VERSION,
      type: "media",
      text: cleanText,
      media: attachment,
    });
  }

  function clearPendingAttachment() {
    state.pendingAttachment = null;
    $("mediaInput").value = "";
    $("attachmentName").textContent = "";
    $("attachmentPreview").classList.add("hidden");
  }

  function updatePendingAttachmentUI() {
    if (!state.pendingAttachment) {
      $("attachmentName").textContent = "";
      $("attachmentPreview").classList.add("hidden");
      return;
    }
    const a = state.pendingAttachment;
    $("attachmentName").textContent = `${a.name} (${Math.max(1, Math.round(a.size / 1024))} KB)`;
    $("attachmentPreview").classList.remove("hidden");
  }

  async function setPendingAttachmentFromFile(file) {
    assert(Boolean(file), "No file selected.");
    const initialMime = String(file.type || "application/octet-stream");
    const topType = mediaTopType(initialMime);

    if (["image", "video", "audio"].includes(topType)) {
      if (file.size > MAX_MEDIA_SOURCE_BYTES) {
        throw new Error(`Raw media too large. Max ${formatBytes(MAX_MEDIA_SOURCE_BYTES)} before compression.`);
      }
    } else if (file.size > MAX_MEDIA_FILE_BYTES) {
      throw new Error(`File too large. Max ${formatBytes(MAX_MEDIA_FILE_BYTES)}.`);
    }

    let workingFile = file;
    let compressionInfo = null;
    let compressionError = null;
    if (["image", "video", "audio"].includes(topType)) {
      if (file.size > MEDIA_AUTO_COMPRESS_THRESHOLD_BYTES) {
        showToast("Optimizing media before send...");
      }
      try {
        const result = await maybeCompressMediaFile(file);
        workingFile = result.file;
        compressionInfo = result.compressed ? result : null;
      } catch (err) {
        compressionError = err instanceof Error ? err : new Error("Automatic compression failed.");
      }
    }

    if (workingFile.size > MAX_MEDIA_FILE_BYTES) {
      if (compressionError) {
        throw new Error(`Could not compress enough for upload: ${compressionError.message}`);
      }
      throw new Error(`File too large after compression. Max ${formatBytes(MAX_MEDIA_FILE_BYTES)}.`);
    }

    const bytes = new Uint8Array(await workingFile.arrayBuffer());
    state.pendingAttachment = {
      name: String(workingFile.name || "attachment").slice(0, 180),
      mime: String(workingFile.type || "application/octet-stream").slice(0, 120),
      size: workingFile.size,
      data_b64: bytesToB64(bytes),
    };
    updatePendingAttachmentUI();
    if (compressionInfo && compressionInfo.originalSize && compressionInfo.compressedSize) {
      showToast(
        `Attached ${state.pendingAttachment.name} (${formatBytes(compressionInfo.originalSize)} → ${formatBytes(compressionInfo.compressedSize)})`
      );
    } else if (compressionError) {
      showToast(`Attached without compression: ${compressionError.message}`);
    } else {
      showToast(`Attached ${state.pendingAttachment.name}`);
    }
  }

  // === VOICE RECORDING ===
  const VOICE_MAX_SECONDS = 120;

  function voiceMimeType() {
    const types = [
      "audio/ogg; codecs=opus",
      "audio/webm; codecs=opus",
      "audio/webm",
      "audio/mp4",
    ];
    for (const t of types) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  async function startVoiceRecording() {
    if (state.voiceRecorder.mediaRecorder) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (_e) {
      showToast("Microphone permission denied.", "error");
      return;
    }

    const mime = voiceMimeType();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    state.voiceRecorder.chunks = [];
    state.voiceRecorder.startTime = Date.now();
    state.voiceRecorder.mediaRecorder = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.voiceRecorder.chunks.push(e.data);
    };

    recorder.onstop = async () => {
      const actualMime = recorder.mimeType || "audio/webm";
      const ext = actualMime.includes("ogg") ? "ogg" : actualMime.includes("mp4") ? "m4a" : "webm";
      const blob = new Blob(state.voiceRecorder.chunks, { type: actualMime });
      state.voiceRecorder.chunks = [];

      if (blob.size > MAX_MEDIA_FILE_BYTES) {
        showToast("Voice message too long (max 10 MB).", "error");
        return;
      }
      if (blob.size < 1000) return; // discard very short recordings

      const bytes = new Uint8Array(await blob.arrayBuffer());
      state.pendingAttachment = {
        name: `voice-message.${ext}`,
        mime: actualMime,
        size: blob.size,
        data_b64: bytesToB64(bytes),
        isVoice: true,
      };
      updatePendingAttachmentUI();
    };

    recorder.start(250);

    $("micBtn").classList.add("recording");
    $("voiceRecordingBar").classList.remove("hidden");
    $("attachBtn").disabled = true;

    state.voiceRecorder.timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - state.voiceRecorder.startTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      $("voiceTimer").textContent = `${m}:${s.toString().padStart(2, "0")}`;
      if (elapsed >= VOICE_MAX_SECONDS) stopVoiceRecording(true);
    }, 500);
  }

  function stopVoiceRecording(autoSend = false) {
    const { mediaRecorder, timerInterval } = state.voiceRecorder;
    if (!mediaRecorder) return;

    clearInterval(timerInterval);
    state.voiceRecorder.timerInterval = null;

    if (mediaRecorder.stream) {
      mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    }
    mediaRecorder.stop();
    state.voiceRecorder.mediaRecorder = null;

    $("micBtn").classList.remove("recording");
    $("voiceRecordingBar").classList.add("hidden");
    $("voiceTimer").textContent = "0:00";
    $("attachBtn").disabled = false;

    if (autoSend) {
      setTimeout(() => { if (state.pendingAttachment) sendMessage(); }, 200);
    }
  }

  function cancelVoiceRecording() {
    const { mediaRecorder, timerInterval } = state.voiceRecorder;
    if (!mediaRecorder) return;

    clearInterval(timerInterval);
    state.voiceRecorder.timerInterval = null;

    if (mediaRecorder.stream) {
      mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    }
    try { mediaRecorder.stop(); } catch (_e) { /* may already be stopped */ }
    state.voiceRecorder.mediaRecorder = null;
    state.voiceRecorder.chunks = [];

    $("micBtn").classList.remove("recording");
    $("voiceRecordingBar").classList.add("hidden");
    $("voiceTimer").textContent = "0:00";
    $("attachBtn").disabled = false;
  }

  // === CRYPTO (unchanged) ===
  function b64u(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function ub64u(value) {
    const pad = "=".repeat((4 - (value.length % 4)) % 4);
    const raw = atob((value + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    const out = new Uint8Array(n);
    crypto.getRandomValues(out);
    return out;
  }

  function assert(ok, message) {
    if (!ok) throw new Error(message);
  }

  function normalizeUsername(raw) {
    let v = (raw || "").trim().toLowerCase();
    while (v.startsWith("@")) v = v.slice(1);
    return v;
  }

  function parsePublicJwk(raw) {
    try { return JSON.parse(raw); } catch (_e) { return null; }
  }

  function buildMeState(user) {
    return {
      id: user && user.id,
      username: user && user.username ? String(user.username) : "",
      email: user && user.email ? String(user.email) : "",
      has_public_key: Boolean(user && user.has_public_key),
      display_name: user && user.display_name ? String(user.display_name) : "",
      avatar_b64: user && user.avatar_b64 ? String(user.avatar_b64) : "",
      is_admin: Boolean(user && user.is_admin),
      bio: user && user.bio ? String(user.bio) : "",
      location: user && user.location ? String(user.location) : "",
      link: user && user.link ? String(user.link) : "",
      status: user && user.status ? String(user.status) : "",
      created_at: user && user.created_at ? Number(user.created_at) : 0,
      has_key_backup: Boolean(user && user.has_key_backup),
      subscription_status: user && user.subscription_status ? String(user.subscription_status) : "",
      subscription_active: user && typeof user.subscription_active === "boolean"
        ? user.subscription_active
        : true,
      subscription_exempt: Boolean(user && user.subscription_exempt),
      subscription_charged_through_date: user && user.subscription_charged_through_date
        ? String(user.subscription_charged_through_date) : "",
      subscription_id: user && user.subscription_id ? String(user.subscription_id) : "",
    };
  }

  // === SESSION / KEY STORAGE ===
  function keyStorageKey(username) {
    return `blackenvelope:keypair:${username}`;
  }

  function persistSession() {
    if (!state.token) return;
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: state.token }));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  function saveConversationListToCache() {
    if (!state.me) return;
    try {
      const entries = [];
      for (const [key, preview] of state.conversationPreviews) {
        entries.push([key, preview]);
      }
      localStorage.setItem(
        CONV_CACHE_KEY + ":" + state.me.username,
        JSON.stringify({ ts: Date.now(), entries })
      );
    } catch (_e) { /* localStorage full or unavailable */ }
  }

  function loadConversationListFromCache() {
    if (!state.me) return;
    try {
      const raw = localStorage.getItem(CONV_CACHE_KEY + ":" + state.me.username);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - parsed.ts > CONV_CACHE_MAX_AGE_MS) return;
      for (const [key, preview] of parsed.entries) {
        state.conversationPreviews.set(key, preview);
      }
      renderConversationList();
    } catch (_e) { /* corrupted cache */ }
  }

  function safeFilenamePart(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "user";
  }

  // === API ===
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Content-Type", "application/json");
    if (state.token) headers.set("Authorization", "Bearer " + state.token);
    const timeoutMs = Number(options.timeout_ms || 0);
    const fetchOptions = { ...options, headers };
    delete fetchOptions.timeout_ms;

    let timeoutId = null;
    if (timeoutMs > 0 && !fetchOptions.signal) {
      const controller = new AbortController();
      fetchOptions.signal = controller.signal;
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    let res;
    try {
      res = await fetch(API + path, fetchOptions);
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      if (err && err.name === "AbortError") {
        throw new Error("Request timed out. Check your connection and try again.");
      }
      throw err;
    }
    if (timeoutId) clearTimeout(timeoutId);

    let body = {};
    try { body = await res.json(); } catch (_e) {}
    if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
    // Check for storage warning header
    if (res.headers.get("X-Storage-Warning") === "approaching-limit") {
      showToast("You're running low on storage. Check Settings > Storage Usage.", "error");
    }
    return body;
  }

  // === KEY MANAGEMENT ===
  async function generateLocalKeyPair(username) {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
    localStorage.setItem(keyStorageKey(username), JSON.stringify({ pub, priv }));
    return { pub, priv };
  }

  async function importStoredKeyPair(username) {
    const raw = localStorage.getItem(keyStorageKey(username));
    if (!raw) return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_e) { return null; }
    if (!parsed.pub || !parsed.priv) return null;
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      parsed.priv,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    return { pub: parsed.pub, privateKey };
  }

  async function applyImportedKeypair(parsed, options = {}) {
    assert(Boolean(state.me), "You must be logged in.");
    const showToastOnComplete = options.showToast !== false;
    const sourceLabel = options.sourceLabel || "imported";

    if (parsed.username && parsed.username !== state.me.username) {
      throw new Error(`This key belongs to @${parsed.username}, not @${state.me.username}.`);
    }

    const privateKey = await crypto.subtle.importKey(
      "jwk",
      parsed.priv,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );

    // Validate public key shape and curve compatibility.
    await crypto.subtle.importKey(
      "jwk",
      parsed.pub,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );

    localStorage.setItem(
      keyStorageKey(state.me.username),
      JSON.stringify({ pub: parsed.pub, priv: parsed.priv })
    );

    state.myPrivateKey = privateKey;
    state.myPublicJwk = parsed.pub;

    await api("/api/me/public-key", {
      method: "POST",
      body: JSON.stringify({ public_key: JSON.stringify(state.myPublicJwk) }),
    });

    $("keyLabel").textContent = "Key: " + sourceLabel;
    await refreshKeyId();

    if (state.activeType) {
      await refreshActiveConversation();
    }
    refreshConversationPreviews().catch(() => {});

    if (showToastOnComplete) {
      showToast(`Key ${sourceLabel}.`);
    }
  }

  async function refreshKeyId() {
    if (!state.myPublicJwk) {
      $("keyIdLabel").textContent = "Key ID: n/a";
      return;
    }
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(JSON.stringify(state.myPublicJwk)));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    $("keyIdLabel").textContent = "Key ID: " + hex.slice(0, 16);
  }

  async function ensureKeyReady() {
    const username = state.me.username;
    let local = await importStoredKeyPair(username);
    if (!local) {
      let hasSyncedBackup = false;
      try {
        const backupMeta = await api("/api/me/key-backup");
        hasSyncedBackup = Boolean(backupMeta && backupMeta.has_backup);
      } catch (_e) {
        hasSyncedBackup = false;
      }

      if (hasSyncedBackup) {
        const shouldRestore = await confirmAsync(
          "No local key found on this device.\n\nAn encrypted synced key backup exists for your account.\n\nRestore it now, or cancel to generate a new local key.",
          { okLabel: "Restore", cancelLabel: "New Key" }
        );
        if (shouldRestore) {
          const passphrase = await askPassphraseAsync({
            confirmPassphrase: false,
            purpose: "restore your synced key",
          });
          if (passphrase !== null) {
            try {
              await restoreSyncedEncryptedKeyBackup({ passphrase, quiet: true });
            } catch (e) {
              showToast("Restore failed: " + e.message, "error");
            }
            local = await importStoredKeyPair(username);
            if (local) showToast("Synced key restored on this device.");
          }
        }
      }
    }

    if (!local) {
      const pair = await generateLocalKeyPair(username);
      local = await importStoredKeyPair(username);
      if (!local) throw new Error("Failed to create local keypair.");
      await api("/api/me/public-key", {
        method: "POST",
        body: JSON.stringify({ public_key: JSON.stringify(pair.pub) }),
      });
    }
    state.myPrivateKey = local.privateKey;
    state.myPublicJwk = local.pub;

    const remote = await api("/api/me/public-key");
    if ((remote.public_key || "") !== JSON.stringify(local.pub)) {
      await api("/api/me/public-key", {
        method: "POST",
        body: JSON.stringify({ public_key: JSON.stringify(local.pub) }),
      });
    }
    $("keyLabel").textContent = "Key: synced";
    await refreshKeyId();
  }

  async function syncKey() {
    await ensureKeyReady();
    showToast("Public key synchronized.");
  }

  async function exportKeyBackup() {
    assert(Boolean(state.me), "You must be logged in.");
    if (!state.myPrivateKey || !state.myPublicJwk) {
      await ensureKeyReady();
    }
    assert(Boolean(state.myPrivateKey) && Boolean(state.myPublicJwk), "Key is not ready.");

    const priv = await crypto.subtle.exportKey("jwk", state.myPrivateKey);
    const backup = {
      app: "BlackEnvelope",
      kind: "key-backup",
      version: KEY_BACKUP_VERSION,
      username: state.me.username,
      exported_at: new Date().toISOString(),
      keypair: {
        pub: state.myPublicJwk,
        priv,
      },
    };

    const payload = JSON.stringify(backup, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `blackenvelope-key-${safeFilenamePart(state.me.username)}-${stamp}.json`;

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    showToast("Key backup exported. Store it securely.");
  }

  function parseKeyBackupObject(data) {
    if (!data || typeof data !== "object") {
      throw new Error("Backup file is invalid.");
    }

    const keypair = (data.keypair && typeof data.keypair === "object")
      ? data.keypair
      : data;

    if (!keypair.pub || !keypair.priv || typeof keypair.pub !== "object" || typeof keypair.priv !== "object") {
      throw new Error("Backup file is missing keypair.pub/keypair.priv.");
    }

    return {
      username: typeof data.username === "string" ? normalizeUsername(data.username) : "",
      pub: keypair.pub,
      priv: keypair.priv,
    };
  }

  function parseKeyBackup(raw) {
    return parseKeyBackupObject(JSON.parse(raw));
  }

  // askRecoveryPassphrase is now async — delegates to askPassphraseAsync
  async function askRecoveryPassphrase({ confirmPassphrase, purpose }) {
    return askPassphraseAsync({ confirmPassphrase, purpose });
  }

  async function deriveBackupCipherKey(passphrase, salt, iterations) {
    const passKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256",
      },
      passKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptBackupWithPassphrase(backupObject, passphrase) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveBackupCipherKey(passphrase, salt, ENCRYPTED_KEY_BACKUP_PBKDF2_ITERATIONS);
    const plainBytes = enc.encode(JSON.stringify(backupObject));
    const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plainBytes);

    return JSON.stringify({
      app: "BlackEnvelope",
      kind: "encrypted-key-backup",
      version: ENCRYPTED_KEY_BACKUP_VERSION,
      kdf: {
        name: "PBKDF2",
        hash: "SHA-256",
        iterations: ENCRYPTED_KEY_BACKUP_PBKDF2_ITERATIONS,
        salt_b64: bytesToB64(salt),
      },
      cipher: {
        name: "AES-GCM",
        iv_b64: bytesToB64(iv),
        ct_b64: bytesToB64(new Uint8Array(ctBuf)),
      },
      meta: {
        username: backupObject.username || "",
        created_at: new Date().toISOString(),
      },
    });
  }

  function parseEncryptedBackupEnvelope(raw) {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!data || typeof data !== "object") {
      throw new Error("Encrypted backup is invalid.");
    }
    if (data.kind !== "encrypted-key-backup" || Number(data.version) !== ENCRYPTED_KEY_BACKUP_VERSION) {
      throw new Error("Unsupported encrypted backup format.");
    }
    const iterations = Number(data?.kdf?.iterations || 0);
    const saltB64 = String(data?.kdf?.salt_b64 || "");
    const ivB64 = String(data?.cipher?.iv_b64 || "");
    const ctB64 = String(data?.cipher?.ct_b64 || "");
    if (!iterations || !saltB64 || !ivB64 || !ctB64) {
      throw new Error("Encrypted backup is missing fields.");
    }
    return { iterations, saltB64, ivB64, ctB64 };
  }

  async function decryptBackupWithPassphrase(encryptedPayload, passphrase) {
    const envelope = parseEncryptedBackupEnvelope(encryptedPayload);
    const salt = b64ToBytes(envelope.saltB64);
    const iv = b64ToBytes(envelope.ivB64);
    const ct = b64ToBytes(envelope.ctB64);
    const key = await deriveBackupCipherKey(passphrase, salt, envelope.iterations);
    let plainBuf;
    try {
      plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    } catch (_e) {
      throw new Error("Wrong recovery passphrase or corrupted backup.");
    }
    const raw = dec.decode(new Uint8Array(plainBuf));
    return parseKeyBackup(raw);
  }

  async function refreshKeyBackupStatus() {
    try {
      const data = await api("/api/me/key-backup");
      if (state.me) state.me.has_key_backup = Boolean(data.has_backup);
      updateSettingsProfile();
    } catch (_e) { /* best effort */ }
  }

  async function ensureRequiredKeyBackup() {
    if (!state.me || !state.token) return false;

    await refreshKeyBackupStatus();
    if (state.me.has_key_backup) return true;

    // Require passphrase-based key backup before entering the app.
    while (state.me && state.token && !state.me.has_key_backup) {
      const proceed = await confirmAsync(
        "To protect your account recovery, you must set a recovery passphrase and back up your key before continuing.\n\nPath: Settings -> Profile -> Backup Key to Server.",
        { okLabel: "Set Passphrase + Backup", cancelLabel: "Log Out" }
      );
      if (!proceed) {
        handleLogout(false);
        showToast("Key backup is required before using BlackEnvelope.", "error");
        return false;
      }

      try {
        await syncEncryptedKeyBackup();
        await refreshKeyBackupStatus();
      } catch (e) {
        showToast("Backup failed: " + e.message, "error");
      }

      if (!state.me || !state.token) return false;
      if (!state.me.has_key_backup) {
        showToast("Backup not completed. Please finish passphrase setup.", "error");
      }
    }

    return Boolean(state.me && state.token && state.me.has_key_backup);
  }

  async function syncEncryptedKeyBackup() {
    assert(Boolean(state.me), "You must be logged in.");
    if (!state.myPrivateKey || !state.myPublicJwk) {
      await ensureKeyReady();
    }
    assert(Boolean(state.myPrivateKey) && Boolean(state.myPublicJwk), "Key is not ready.");

    const passphrase = await askRecoveryPassphrase({
      confirmPassphrase: true,
      purpose: "encrypt and sync your key backup",
    });
    if (passphrase === null) return;

    const priv = await crypto.subtle.exportKey("jwk", state.myPrivateKey);
    const backupObject = {
      app: "BlackEnvelope",
      kind: "key-backup",
      version: KEY_BACKUP_VERSION,
      username: state.me.username,
      exported_at: new Date().toISOString(),
      keypair: {
        pub: state.myPublicJwk,
        priv,
      },
    };

    const backupCiphertext = await encryptBackupWithPassphrase(backupObject, passphrase);
    if (backupCiphertext.length > ENCRYPTED_KEY_BACKUP_MAX_BYTES) {
      throw new Error("Encrypted backup is too large.");
    }

    await api("/api/me/key-backup", {
      method: "POST",
      body: JSON.stringify({ backup_ciphertext: backupCiphertext }),
    });

    showToast("Encrypted key backup synced.");
  }

  async function restoreSyncedEncryptedKeyBackup(options = {}) {
    assert(Boolean(state.me), "You must be logged in.");
    const quiet = Boolean(options.quiet);
    const remote = await api("/api/me/key-backup");
    if (!remote || !remote.has_backup || !remote.backup_ciphertext) {
      throw new Error("No encrypted synced key backup found.");
    }

    const passphrase = options.passphrase ?? await askRecoveryPassphrase({
      confirmPassphrase: false,
      purpose: "restore your synced key backup",
    });
    if (passphrase === null) return false;

    const parsed = await decryptBackupWithPassphrase(remote.backup_ciphertext, passphrase);
    await applyImportedKeypair(parsed, {
      showToast: !quiet,
      sourceLabel: quiet ? "restored" : "restored + published",
    });
    if (!quiet) showToast("Synced key restored on this device.");
    return true;
  }

  async function deleteSyncedEncryptedKeyBackup() {
    assert(Boolean(state.me), "You must be logged in.");
    const ok = await confirmAsync("Delete your encrypted synced key backup from the server?", { danger: true });
    if (!ok) return;
    await api("/api/me/key-backup", { method: "DELETE" });
    showToast("Encrypted synced key deleted.");
  }

  async function regenerateKeypairAndStartFresh() {
    assert(Boolean(state.me), "You must be logged in.");
    const username = state.me.username;

    const pair = await generateLocalKeyPair(username);
    const local = await importStoredKeyPair(username);
    if (!local) throw new Error("Failed to regenerate local key.");

    state.myPrivateKey = local.privateKey;
    state.myPublicJwk = pair.pub;

    await api("/api/me/public-key", {
      method: "POST",
      body: JSON.stringify({ public_key: JSON.stringify(state.myPublicJwk) }),
    });

    // Remove old encrypted backup so restore cannot pull the previous key by mistake.
    try {
      await api("/api/me/key-backup", { method: "DELETE" });
    } catch (_e) {}

    $("keyLabel").textContent = "Key: regenerated";
    await refreshKeyId();

    if (state.activeType) {
      await refreshActiveConversation();
    }
    refreshConversationPreviews().catch(() => {});
    showToast("New key generated. Old messages are no longer decryptable.");

    const backupNow = await confirmAsync("Back up this new key now?", { okLabel: "Back Up", cancelLabel: "Skip" });
    if (backupNow) {
      await syncEncryptedKeyBackup();
    } else {
      showToast("Back up your new key soon to avoid future loss.", "error");
    }
  }

  async function importKeyBackupFromFile(file) {
    assert(Boolean(state.me), "You must be logged in.");
    assert(Boolean(file), "Please choose a backup file.");
    if (file.size > 1024 * 1024) {
      throw new Error("Backup file is too large.");
    }

    const text = await file.text();
    const parsed = parseKeyBackup(text);
    await applyImportedKeypair(parsed, { sourceLabel: "imported + published" });
  }

  // === ENCRYPTION (unchanged) ===
  async function deriveMessageKey(privateKey, publicJwk, saltBytes) {
    const publicKey = await crypto.subtle.importKey(
      "jwk", publicJwk, { name: "ECDH", namedCurve: "P-256" }, true, []
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "ECDH", public: publicKey }, privateKey, 256
    );
    const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: KDF_INFO },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function sealForPublicKey(plaintext, recipientPublicJwk) {
    const eph = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
    );
    const ephPubJwk = await crypto.subtle.exportKey("jwk", eph.publicKey);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveMessageKey(eph.privateKey, recipientPublicJwk, salt);
    const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
    return {
      epk: ephPubJwk,
      salt: b64u(salt),
      iv: b64u(iv),
      ct: b64u(new Uint8Array(ctBuf)),
    };
  }

  async function openSealedBox(box) {
    const key = await deriveMessageKey(state.myPrivateKey, box.epk, ub64u(box.salt));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ub64u(box.iv) }, key, ub64u(box.ct)
    );
    return dec.decode(new Uint8Array(plain));
  }

  async function encryptDirectPayload(plaintext, friendPublicJwk) {
    return {
      v: 1,
      alg: "ECDH-P256-HKDF-SHA256-AES256GCM",
      to_recipient: await sealForPublicKey(plaintext, friendPublicJwk),
      to_sender: await sealForPublicKey(plaintext, state.myPublicJwk),
    };
  }

  async function decryptDirectPayload(payload, direction) {
    if (payload.to_recipient && payload.to_sender) {
      const box = direction === "incoming" ? payload.to_recipient : payload.to_sender;
      return openSealedBox(box);
    }
    if (payload.epk && payload.salt && payload.iv && payload.ct) {
      return openSealedBox(payload);
    }
    throw new Error("Unsupported direct payload format.");
  }

  async function encryptGroupPayload(plaintext, membersMap) {
    const boxes = {};
    for (const [username, member] of membersMap.entries()) {
      boxes[username] = await sealForPublicKey(plaintext, member.publicJwk);
    }
    if (!boxes[state.me.username]) {
      boxes[state.me.username] = await sealForPublicKey(plaintext, state.myPublicJwk);
    }
    return { v: 1, alg: "ECDH-P256-HKDF-SHA256-AES256GCM", boxes };
  }

  async function decryptGroupPayload(payload) {
    const box = payload && payload.boxes ? payload.boxes[state.me.username] : null;
    if (!box) throw new Error("No encrypted box for this user.");
    return openSealedBox(box);
  }

  // === AUTH UI ===
  function showAuth(show) {
    $("authSection").classList.toggle("hidden", !show);
    $("appSection").classList.toggle("hidden", show);
    document.body.classList.toggle("auth-active", show);
  }

  function isNutshellSsoEnabled(config = state.publicConfig) {
    return Boolean(config && config.nutshell_sso_enabled);
  }

  function setNutshellGateLinks(config = state.publicConfig, message = "") {
    const launchUrl = config && typeof config.nutshell_launch_url === "string" && config.nutshell_launch_url.trim()
      ? config.nutshell_launch_url.trim()
      : "http://127.0.0.1:3000/black_envelope";
    const homeUrl = config && typeof config.nutshell_public_url === "string" && config.nutshell_public_url.trim()
      ? config.nutshell_public_url.trim()
      : "http://127.0.0.1:3000";

    $("authNutshellLaunch").href = launchUrl;
    $("authNutshellHome").href = homeUrl;
    $("authNutshellMessage").textContent = message || "Sign in through Nutshell first. Paid Nutshell members are brought into Nutshell's BlackEnvelope automatically for private messages and groups.";
  }

  function showNutshellGate(message = "") {
    setNutshellGateLinks(state.publicConfig, message);
    showAuth(true);
    switchAuthTab("nutshell");
  }

  function switchAuthTab(tab) {
    let view = tab || "login";
    if (isNutshellSsoEnabled() && !["nutshell", "reset-password", "link-email"].includes(view)) {
      view = "nutshell";
    }

    const showTabs = !isNutshellSsoEnabled() && (view === "login" || view === "register");
    const tabs = $("authTabs");
    if (tabs) tabs.classList.toggle("hidden", !showTabs);

    for (const btn of document.querySelectorAll(".auth-tab")) {
      btn.classList.toggle("active", showTabs && btn.dataset.auth === view);
    }
    $("authLogin").classList.toggle("hidden", view !== "login");
    $("authRegister").classList.toggle("hidden", view !== "register");
    $("authForgotPassword").classList.toggle("hidden", view !== "forgot-password");
    $("authResetPassword").classList.toggle("hidden", view !== "reset-password");
    $("authLinkEmail").classList.toggle("hidden", view !== "link-email");
    $("authGoogleUsername").classList.toggle("hidden", view !== "google-username");
    $("authNutshell").classList.toggle("hidden", view !== "nutshell");
    if (view !== "login") clearAuthBillingPrompt();
  }

  function _resetTokenFromHash() {
    const hash = window.location.hash || "";
    const prefix = "#/reset-password";
    if (!hash.startsWith(prefix)) return "";
    const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
    const token = new URLSearchParams(query).get("token");
    return typeof token === "string" ? token.trim() : "";
  }

  function _clearResetHashRoute() {
    const hash = window.location.hash || "";
    if (!hash.startsWith("#/reset-password")) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  function _isAdminUsersHashRoute() {
    const hash = window.location.hash || "";
    return hash === ADMIN_USERS_HASH_ROUTE || hash.startsWith(ADMIN_USERS_HASH_ROUTE + "?");
  }

  function _clearAdminUsersHashRoute() {
    if (!_isAdminUsersHashRoute()) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  function openResetFlowFromUrl() {
    const token = _resetTokenFromHash();
    if (!token) return false;
    state.pendingResetToken = token;
    showAuth(true);
    switchAuthTab("reset-password");
    clearAuthBillingPrompt();
    $("resetNewPassword").focus();
    return true;
  }

  function syncHashDrivenViews() {
    const resetOpen = openResetFlowFromUrl();
    if (resetOpen) {
      closeAdminUsersPage();
      return;
    }

    if (_isAdminUsersHashRoute()) {
      if (!state.token || !state.me) {
        closeAdminUsersPage();
        return;
      }
      if (!state.me.is_admin) {
        closeAdminUsersPage();
        _clearAdminUsersHashRoute();
        showToast("Admin access required.", "error");
        return;
      }
      openAdminUsersPage();
      return;
    }

    closeAdminUsersPage();
  }

  async function _fetchPublicConfig() {
    if (!publicConfigPromise) {
      publicConfigPromise = fetch(API + "/api/config/public", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }).then(async (res) => {
        if (!res.ok) return {};
        try {
          return await res.json();
        } catch (_e) {
          return {};
        }
      }).catch(() => ({}));
    }

    const config = await publicConfigPromise;
    state.publicConfig = config || {};
    return state.publicConfig;
  }

  async function initGoogleSignIn() {
    const googleBtn = $("googleSignInBtn");
    if (!googleBtn) return;

    const config = await _fetchPublicConfig();
    if (isNutshellSsoEnabled(config)) {
      googleBtn.classList.add("hidden");
      return;
    }
    const clientId = config && typeof config.google_client_id === "string"
      ? config.google_client_id.trim()
      : "";
    if (!clientId) {
      googleBtn.classList.add("hidden");
      return;
    }

    const waitForGoogleSdk = () => new Promise((resolve) => {
      if (window.google && window.google.accounts && window.google.accounts.id) {
        resolve(true);
        return;
      }
      const started = Date.now();
      const interval = setInterval(() => {
        if (window.google && window.google.accounts && window.google.accounts.id) {
          clearInterval(interval);
          resolve(true);
          return;
        }
        if (Date.now() - started > 8000) {
          clearInterval(interval);
          resolve(false);
        }
      }, 200);
    });

    const ready = await waitForGoogleSdk();
    if (!ready || !window.google || !window.google.accounts || !window.google.accounts.id) {
      googleBtn.classList.add("hidden");
      return;
    }

    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (response) => {
        handleGoogleCredentialResponse(response).catch((e) => {
          showToast("Google sign-in failed: " + e.message, "error");
        });
      },
      auto_select: false,
    });
    window.google.accounts.id.renderButton(googleBtn, {
      theme: "filled_black",
      size: "large",
      width: 320,
      text: "signin_with",
      shape: "pill",
    });
  }

  async function handleGoogleCredentialResponse(response) {
    const idToken = response && typeof response.credential === "string" ? response.credential.trim() : "";
    if (!idToken) throw new Error("Missing Google credential.");
    state.googleIdToken = idToken;
    clearAuthBillingPrompt();

    const res = await fetch(API + "/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: idToken }),
    });
    let data = {};
    try { data = await res.json(); } catch (_e) {}

    if (res.status === 402 && data && data.subscription_required) {
      showAuthBillingPrompt(
        data.detail || "Active Nutshell subscription required to use BlackEnvelope.",
        typeof data.checkout_url === "string" ? data.checkout_url : "",
      );
      showToast("Subscription required. Complete checkout, then try Google sign-in again.", "error");
      return;
    }

    if (data && data.needs_username) {
      const suggested = typeof data.username_suggestion === "string" ? data.username_suggestion.trim() : "";
      state.googleSuggestedUsername = suggested;
      $("googleNewUsername").value = suggested;
      $("googleNewAccessCode").value = "";
      switchAuthTab("google-username");
      $("googleNewUsername").focus();
      return;
    }

    if (!res.ok) {
      throw new Error(data.detail || `HTTP ${res.status}`);
    }
    if (!data || typeof data.token !== "string" || !data.token.trim()) {
      throw new Error("Google login response missing token.");
    }

    state.token = data.token;
    state.me = buildMeState(data.user || {});
    persistSession();
    await enterAppIfRecoveryReady();
  }

  async function handleGoogleUsernameSubmit() {
    if (!state.googleIdToken) {
      throw new Error("Google session expired. Click Google sign-in again.");
    }
    const username = $("googleNewUsername").value.trim();
    const promoCode = $("googleNewAccessCode").value.trim();
    if (!username) throw new Error("Username is required.");

    const res = await fetch(API + "/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id_token: state.googleIdToken,
        username,
        promo_code: promoCode,
      }),
    });
    let data = {};
    try { data = await res.json(); } catch (_e) {}

    if (res.status === 402 && data && data.subscription_required) {
      showAuthBillingPrompt(
        data.detail || "Active Nutshell subscription required to use BlackEnvelope.",
        typeof data.checkout_url === "string" ? data.checkout_url : "",
      );
      showToast("Subscription required. Complete checkout, then log in again.", "error");
      return;
    }
    if (!res.ok) {
      throw new Error(data.detail || `HTTP ${res.status}`);
    }
    if (!data || typeof data.token !== "string" || !data.token.trim()) {
      throw new Error("Google sign-up response missing token.");
    }

    state.token = data.token;
    state.me = buildMeState(data.user || {});
    persistSession();
    await enterAppIfRecoveryReady();
  }

  function clearAuthBillingPrompt() {
    const notice = $("billingNotice");
    const checkoutBtn = $("billingCheckoutBtn");
    state.billingCheckoutUrl = "";
    if (notice) {
      notice.textContent = "";
      notice.classList.add("hidden");
    }
    if (checkoutBtn) {
      checkoutBtn.classList.add("hidden");
    }
  }

  function showAuthBillingPrompt(message, checkoutUrl) {
    const notice = $("billingNotice");
    const checkoutBtn = $("billingCheckoutBtn");
    state.billingCheckoutUrl = typeof checkoutUrl === "string" ? checkoutUrl : "";
    if (notice) {
      notice.textContent = message || "Active Nutshell subscription required to use BlackEnvelope.";
      notice.classList.remove("hidden");
    }
    if (checkoutBtn) {
      if (state.billingCheckoutUrl) {
        checkoutBtn.classList.remove("hidden");
      } else {
        checkoutBtn.classList.add("hidden");
      }
    }
  }

  // === PAYMENT VERIFICATION (post-checkout redirect) ===

  async function checkPaymentPending() {
    const params = new URLSearchParams(window.location.search);
    const ppToken = params.get("payment_pending");
    if (!ppToken) return false;

    // Clean URL immediately
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState(null, "", cleanUrl);

    const overlay = $("paymentVerifyOverlay");
    const msgEl = $("paymentVerifyMsg");
    const spinnerEl = $("paymentVerifySpinner");
    if (!overlay) return false;

    overlay.classList.remove("hidden");
    msgEl.textContent = "Verifying your payment...";

    const MAX_ATTEMPTS = 10;
    const POLL_INTERVAL = 3000;
    let username = "";

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        const res = await fetch(API + "/api/billing/payment-status?token=" + encodeURIComponent(ppToken));
        const data = await res.json();

        if (data.status === "active") {
          username = data.username || "";
          spinnerEl.classList.add("done");
          msgEl.textContent = "Payment confirmed! You can now log in.";
          await new Promise((r) => setTimeout(r, 2000));
          overlay.classList.add("hidden");
          switchAuthTab("login");
          if (username) $("loginUsername").value = username;
          $("loginPassword").focus();
          return true;
        }

        // Token is invalid/expired or user not found — stop polling
        if (res.status === 400 || data.status === "not_found") {
          spinnerEl.classList.add("done");
          msgEl.textContent = "Could not verify payment. Please log in and try again, or contact support.";
          await new Promise((r) => setTimeout(r, 3000));
          overlay.classList.add("hidden");
          switchAuthTab("login");
          return false;
        }
      } catch (_e) {
        // Network error — update message but keep trying
        msgEl.textContent = "Connection issue — retrying...";
      }
      if (i < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      }
    }

    // Timed out — still processing
    spinnerEl.classList.add("done");
    msgEl.textContent = "Payment is still being processed. Try logging in — if it doesn\u2019t work yet, wait a minute and try again.";
    await new Promise((r) => setTimeout(r, 3000));
    overlay.classList.add("hidden");
    switchAuthTab("login");
    return false;
  }

  // === SETTINGS PANEL ===
  function toggleSettings(open) {
    const isOpen = open !== undefined ? open : !$("settingsPanel").classList.contains("open");
    $("settingsOverlay").classList.toggle("open", isOpen);
    $("settingsPanel").classList.toggle("open", isOpen);
  }

  function updateSettingsProfile() {
    if (!state.me) return;
    const name = state.me.username;
    $("settingsName").textContent = "@" + name;
    const avatarEl = $("settingsAvatar");
    if (state.me.avatar_b64) {
      avatarEl.style.background = "url(" + state.me.avatar_b64 + ") center / cover no-repeat";
      avatarEl.classList.add("has-image");
      avatarEl.textContent = "";
    } else {
      avatarEl.style.background = avatarColor(name);
      avatarEl.classList.remove("has-image");
      avatarEl.textContent = avatarLetter(name);
    }
    const displayNameEl = $("settingsDisplayName");
    if (displayNameEl) {
      displayNameEl.textContent = state.me.display_name || "";
    }
    const keyStatusEl = $("settingsKeyStatus");
    if (keyStatusEl) {
      const backed = state.me.has_key_backup;
      keyStatusEl.innerHTML = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:'
        + (backed ? "var(--success)" : "var(--danger)")
        + ';margin-right:5px;vertical-align:middle;"></span>'
        + (backed ? "Key backed up" : "Key not backed up");
    }
    const adminSection = $("adminSettingsSection");
    if (adminSection) {
      adminSection.classList.toggle("hidden", !state.me.is_admin);
    }
    // Update notification sound toggle status
    const notifStatus = $("notifSoundStatus");
    if (notifStatus) {
      notifStatus.textContent = state.notificationSoundEnabled ? "On" : "Off";
    }
    updateBillingStatusBadge();
  }

  // === MODALS ===
  function showModal(title, renderFn) {
    $("modalTitle").textContent = title;
    const body = $("modalBody");
    body.innerHTML = "";
    renderFn(body);
    $("modalOverlay").classList.add("open");
    state.activeModal = title;
  }

  function hideModal() {
    $("modalOverlay").classList.remove("open");
    state.activeModal = null;
  }

  // === MOBILE NAV ===
  function handleMobileNav(view) {
    state.mobileView = view;
    const isMobile = window.innerWidth <= 768;
    if (!isMobile) return;
    // On mobile, sidebar is always in the grid flow.
    // Chat panel uses position:fixed and is toggled via mobile-visible.
    $("chatPanel").classList.toggle("mobile-visible", view === "chat");
  }

  // === CONVERSATION LIST ===
  function renderConversationList() {
    const list = $("conversationList");
    list.innerHTML = "";

    const entries = [];
    for (const f of state.friends.values()) {
      const preview = state.conversationPreviews.get("friend:" + f.username);
      entries.push({
        type: "friend",
        key: f.username,
        name: f.username,
        prefix: "@",
        timestamp: preview ? preview.timestamp : 0,
        previewText: preview ? preview.text : "",
        unread: preview ? preview.unread : 0,
        avatar_b64: f.avatar_b64 || "",
      });
    }
    for (const g of state.groups.values()) {
      const preview = state.conversationPreviews.get("group:" + g.id);
      entries.push({
        type: "group",
        key: String(g.id),
        name: g.name,
        prefix: "#",
        is_global_feed: Boolean(g.is_global_feed),
        timestamp: preview ? preview.timestamp : 0,
        previewText: preview ? preview.text : "",
        unread: preview ? preview.unread : 0,
      });
    }

    // Pin global feed first, then sort by timestamp desc, then alphabetically
    entries.sort((a, b) => {
      const aPinned = Boolean(a.type === "group" && a.is_global_feed);
      const bPinned = Boolean(b.type === "group" && b.is_global_feed);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      return a.name.localeCompare(b.name);
    });

    if (!entries.length) {
      list.innerHTML = '<div style="padding:24px 16px;text-align:center;color:var(--muted);">No conversations yet. Search for users to get started.</div>';
      return;
    }

    for (const e of entries) {
      const isActive = state.activeType === e.type &&
        String(state[e.type === "friend" ? "activeFriend" : "activeGroupId"]) === e.key;

      const btn = document.createElement("button");
      btn.className = "conversation-item" + (isActive ? " active" : "");

      const avatar = createAvatarEl(e.name, "", e.avatar_b64);

      const info = document.createElement("div");
      info.className = "conversation-info";

      const nameEl = document.createElement("div");
      nameEl.className = "conversation-name";
      nameEl.textContent = e.prefix + e.name;

      const previewEl = document.createElement("div");
      previewEl.className = "conversation-preview";
      previewEl.textContent = e.previewText || (e.type === "group" ? "Group chat" : "Start a conversation");

      info.appendChild(nameEl);
      info.appendChild(previewEl);

      const meta = document.createElement("div");
      meta.className = "conversation-meta";

      if (e.timestamp) {
        const timeEl = document.createElement("div");
        timeEl.className = "conversation-time";
        timeEl.textContent = formatTime(e.timestamp);
        meta.appendChild(timeEl);
      }

      if (e.unread > 0) {
        const badge = document.createElement("div");
        badge.className = "conversation-badge";
        badge.textContent = String(e.unread);
        meta.appendChild(badge);
      }

      btn.appendChild(avatar);
      btn.appendChild(info);
      btn.appendChild(meta);

      btn.addEventListener("click", () => {
        if (e.type === "friend") selectActiveFriend(e.key);
        else selectActiveGroup(Number(e.key));
      });

      list.appendChild(btn);
    }
  }

  // Render batching: avoids re-rendering the whole conversation list many times
  // during preview refresh or bursts of websocket events.
  let conversationListRenderQueued = false;
  function scheduleConversationListRender() {
    if (conversationListRenderQueued) return;
    conversationListRenderQueued = true;
    requestAnimationFrame(() => {
      conversationListRenderQueued = false;
      renderConversationList();
    });
  }

  // === NOTIFICATION BADGE ===
  function updateNotificationBadge(explicitCount) {
    const badge = $("notificationCount");
    if (typeof explicitCount === "number") {
      state._notifUnreadCount = explicitCount;
    }
    // Combine server notification count with local friend-request/invite counts
    const serverCount = state._notifUnreadCount || 0;
    const localCount = state.incomingFriendRequests.length + state.pendingGroupInvites.length;
    const count = serverCount + localCount;
    if (count > 0) {
      badge.textContent = String(count);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  function refreshNotificationBadge() {
    api("/api/notifications/unread-count").then((data) => {
      updateNotificationBadge(data.unread_count || 0);
    }).catch(() => {});
  }

  function relativeTime(ts) {
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }

  function toggleNotificationDropdown() {
    const dd = $("notificationDropdown");
    if (dd.classList.contains("hidden")) {
      showNotificationDropdown();
    } else {
      dd.classList.add("hidden");
    }
  }

  function buildCombinedNotifications() {
    const combined = [];

    // Add server notifications (likes, mentions)
    for (const n of state.notificationRows) {
      combined.push(n);
    }

    // Add pending friend requests from local state (not in DB)
    for (const fr of state.incomingFriendRequests) {
      combined.push({
        id: "fr_" + (fr.from_username || fr.username),
        type: "friend_request",
        source_username: fr.from_username || fr.username,
        is_read: false,
        created_at: fr.created_at || Math.floor(Date.now() / 1000),
        _local: true,
      });
    }

    // Add pending group invites from local state (not in DB)
    for (const gi of state.pendingGroupInvites) {
      combined.push({
        id: "gi_" + gi.group_id,
        type: "group_invite",
        source_username: gi.invited_by || gi.from_username || "Someone",
        group_name: gi.group_name || "",
        is_read: false,
        created_at: gi.created_at || Math.floor(Date.now() / 1000),
        _local: true,
      });
    }

    // Sort combined by created_at descending
    combined.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    return combined;
  }

  function renderNotificationDropdownList() {
    const list = $("notificationDropdownList");
    const combined = buildCombinedNotifications();

    if (combined.length === 0) {
      list.innerHTML = state.notificationLoading
        ? '<div class="notification-empty">Loading...</div>'
        : '<div class="notification-empty">No notifications yet</div>';
      return;
    }

    list.innerHTML = "";
    for (const n of combined) {
      const row = document.createElement("div");
      row.className = "notification-row" + (n.is_read ? "" : " unread");
      if (n.id) row.dataset.notifId = n.id;

      let icon = "";
      let text = "";
      if (n.type === "like") {
        icon = "\uD83D\uDC4D";
        text = `<strong>${n.source_username || "Someone"}</strong> liked your message`;
        if (n.group_name) text += ` in ${n.group_name}`;
      } else if (n.type === "mention") {
        icon = "@";
        text = `<strong>${n.source_username || "Someone"}</strong> mentioned you`;
        if (n.group_name) text += ` in ${n.group_name}`;
      } else if (n.type === "friend_request") {
        icon = "\uD83D\uDC64";
        text = `<strong>${n.source_username || "Someone"}</strong> sent you a friend request`;
      } else if (n.type === "group_invite") {
        icon = "\uD83D\uDC65";
        text = `<strong>${n.source_username || "Someone"}</strong> invited you to a group`;
        if (n.group_name) text += ` <strong>${n.group_name}</strong>`;
      } else {
        icon = "\uD83D\uDD14";
        text = "New notification";
      }

      row.innerHTML = `
        <div class="notification-row-icon">${icon}</div>
        <div class="notification-row-body">
          <div class="notification-row-text">${text}</div>
          <div class="notification-row-time">${relativeTime(n.created_at)}</div>
        </div>
      `;

      row.addEventListener("click", () => handleNotificationClick(n));
      list.appendChild(row);
    }

    if (state.notificationLoading && state.notificationHasMore) {
      const loading = document.createElement("div");
      loading.className = "notification-empty";
      loading.textContent = "Loading more...";
      list.appendChild(loading);
    }
  }

  async function loadNotificationPage(options = {}) {
    const reset = Boolean(options.reset);
    if (state.notificationLoading) return;
    if (!reset && (!state.notificationHasMore || !state.notificationNextBeforeId)) return;

    if (reset) {
      state.notificationRows = [];
      state.notificationHasMore = false;
      state.notificationNextBeforeId = null;
      $("notificationDropdownList").innerHTML = '<div class="notification-empty">Loading...</div>';
    }

    state.notificationLoading = true;
    try {
      let url = `/api/notifications?limit=${NOTIFICATION_PAGE_LIMIT}`;
      if (!reset && state.notificationNextBeforeId) {
        url += `&before_id=${encodeURIComponent(String(state.notificationNextBeforeId))}`;
      }
      const data = await api(url);
      const notifications = data.notifications || [];
      updateNotificationBadge(data.unread_count || 0);

      if (reset) {
        state.notificationRows = notifications;
      } else {
        const seen = new Set(state.notificationRows.map((n) => String(n.id)));
        for (const n of notifications) {
          const key = String(n.id);
          if (seen.has(key)) continue;
          seen.add(key);
          state.notificationRows.push(n);
        }
      }

      const pagination = data.pagination || {};
      state.notificationHasMore = Boolean(pagination.has_more);
      const nextBeforeId = Number(pagination.next_before_id);
      state.notificationNextBeforeId =
        Number.isFinite(nextBeforeId) && nextBeforeId > 0 ? nextBeforeId : null;
    } catch (_e) {
      $("notificationDropdownList").innerHTML = '<div class="notification-empty">Failed to load notifications</div>';
      return;
    } finally {
      state.notificationLoading = false;
    }

    renderNotificationDropdownList();
  }

  function maybeLoadMoreNotifications() {
    const dd = $("notificationDropdown");
    const list = $("notificationDropdownList");
    if (!dd || !list || dd.classList.contains("hidden")) return;
    if (state.notificationLoading || !state.notificationHasMore || !state.notificationNextBeforeId) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (distanceFromBottom > NOTIFICATION_SCROLL_BOTTOM_THRESHOLD) return;
    loadNotificationPage({ reset: false }).catch(() => {});
  }

  function showNotificationDropdown() {
    const dd = $("notificationDropdown");
    dd.classList.remove("hidden");
    loadNotificationPage({ reset: true }).catch(() => {});
  }

  function handleNotificationClick(n) {
    // Mark as read (only for server-side notifications with real IDs)
    if (!n._local && n.id) {
      state.notificationRows = state.notificationRows.map((row) =>
        Number(row.id) === Number(n.id) ? { ...row, is_read: true } : row
      );
      api("/api/notifications/read", {
        method: "POST",
        body: JSON.stringify({ id: n.id }),
      }).catch(() => {});
    }

    // Close dropdown
    $("notificationDropdown").classList.add("hidden");

    // Navigate to the relevant conversation
    if (n.message_id && (n.type === "like" || n.type === "mention")) {
      navigateToNotificationMessage(n);
    } else if (n.type === "friend_request" || n.type === "group_invite") {
      showFriendsModal();
    }

    refreshNotificationBadge();
  }

  async function navigateToNotificationMessage(n) {
    try {
      const ctx = await api(`/api/messages/${n.message_id}/context`);
      if (!ctx || !ctx.found) {
        showToast("Message not found.", "warn");
        return;
      }

      const messagesAfter = ctx.messages_after || 0;
      const PAGE_LIMIT = ACTIVE_FEED_PAGE_LIMIT;

      if (ctx.message_type === "direct" && ctx.friend_username) {
        if (state.friends.has(ctx.friend_username)) {
          await selectActiveFriend(ctx.friend_username);
          if (messagesAfter <= PAGE_LIMIT * 5) {
            setTimeout(() => scrollToMessage(n.message_id), 500);
          } else {
            showToast("This message is further back in the conversation.");
          }
        }
      } else if (ctx.message_type === "group" && ctx.group_id) {
        if (state.groups.has(ctx.group_id)) {
          await selectActiveGroup(ctx.group_id);
          if (ctx.topic_id) {
            const topics = state.groupTopics.get(ctx.group_id) || [];
            const topic = topics.find(t => t.id === ctx.topic_id);
            if (topic) {
              await selectGroupTopic(ctx.topic_id);
            }
          }
          if (messagesAfter <= PAGE_LIMIT * 5) {
            setTimeout(() => scrollToMessage(n.message_id), 500);
          } else {
            showToast("This message is further back in the conversation.");
          }
        }
      }
    } catch (_e) {
      showToast("Could not navigate to message.", "error");
    }
  }

  function scrollToMessage(messageId) {
    const el = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("message-highlight");
      setTimeout(() => el.classList.remove("message-highlight"), 2500);
      return;
    }
    // Message not in current view — it may be further up
    showToast("Scroll up to find this message.");
  }

  // === CHAT PANEL ===
  function showChatEmpty() {
    $("chatEmpty").style.display = "";
    const active = $("chatActive");
    active.classList.add("hidden");
    active.style.display = "none";
    clearPendingAttachment();
    // On mobile, hide the chat panel so sidebar is visible
    $("chatPanel").classList.remove("mobile-visible");
    state.mobileView = "sidebar";
  }

  function showChatActive() {
    $("chatEmpty").style.display = "none";
    const active = $("chatActive");
    active.classList.remove("hidden");
    active.style.display = "flex";
  }

  function updateChatHeader() {
    if (state.activeType === "friend" && state.activeFriend) {
      const name = state.activeFriend;
      const friend = state.friends.get(name);
      $("chatName").textContent = "@" + name;
      $("chatStatus").textContent = "encrypted chat";
      const av = $("chatAvatar");
      const avatarB64 = friend ? friend.avatar_b64 : "";
      if (avatarB64) {
        av.style.backgroundImage = "url(" + avatarB64 + ")";
        av.style.backgroundSize = "cover";
        av.style.backgroundPosition = "center";
        av.style.background = "";
        av.classList.add("has-image");
        av.textContent = "";
      } else {
        av.style.backgroundImage = "";
        av.classList.remove("has-image");
        av.style.background = avatarColor(name);
        av.textContent = avatarLetter(name);
      }
      $("chatInfoBtn").classList.add("hidden");
      $("topicsBar").classList.add("hidden");
    } else if (state.activeType === "group" && state.activeGroupId) {
      const g = state.groups.get(state.activeGroupId);
      const name = g ? g.name : "Group";
      $("chatName").textContent = "#" + name;
      const members = state.groupMembers.get(state.activeGroupId);
      $("chatStatus").textContent = members ? members.size + " members" : "group chat";
      const av = $("chatAvatar");
      av.style.backgroundImage = "";
      av.classList.remove("has-image");
      av.style.background = avatarColor(name);
      av.textContent = avatarLetter(name);
      $("chatInfoBtn").classList.remove("hidden");
      renderTopicsBar();
    }
  }

  // === TOPICS BAR ===
  function renderTopicsBar() {
    const bar = $("topicsBar");
    if (!state.activeGroupId) {
      bar.classList.add("hidden");
      return;
    }
    bar.classList.remove("hidden");
    bar.innerHTML = "";

    const allChip = document.createElement("button");
    allChip.className = "topic-chip" + (state.activeGroupTopic === "all" ? " active" : "");
    allChip.textContent = "All";
    allChip.addEventListener("click", () => selectGroupTopic("all"));
    bar.appendChild(allChip);

    const topics = state.groupTopics.get(state.activeGroupId) || [];
    for (const t of topics) {
      const chip = document.createElement("button");
      chip.className = "topic-chip" + (String(state.activeGroupTopic) === String(t.id) ? " active" : "");
      chip.textContent = t.title;
      chip.addEventListener("click", () => selectGroupTopic(t.id));
      bar.appendChild(chip);
    }
  }

  // === MESSAGE RENDERING ===
  function renderMessageBubbles(rows, includeTopic, isGroupView = false, options = {}) {
    const area = $("messagesArea");
    const preserveScrollOnPrepend = Boolean(options.preserveScrollOnPrepend);
    const previousScrollHeight = Number(options.previousScrollHeight || 0);
    const previousScrollTop = Number(options.previousScrollTop || 0);
    const stickToBottom = options.stickToBottom !== false;
    const showLoadOlderHint = Boolean(options.showLoadOlderHint);
    area.innerHTML = "";

    if (!rows.length) {
      area.innerHTML = '<div class="no-messages">No messages yet. Say hi!</div>';
      return;
    }

    if (showLoadOlderHint) {
      const hint = document.createElement("div");
      hint.className = "load-older-hint";
      hint.textContent = "Scroll up to load older messages";
      area.appendChild(hint);
    }

    let lastDate = "";
    let lastSender = "";
    let lastDirection = "";
    let currentGroup = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const dateStr = formatDateDivider(row.created_at);

      // Date divider
      if (dateStr !== lastDate) {
        const divider = document.createElement("div");
        divider.className = "date-divider";
        divider.innerHTML = "<span>" + dateStr + "</span>";
        area.appendChild(divider);
        lastDate = dateStr;
        lastSender = "";
        currentGroup = null;
      }

      if (row.row_type === "group_member_joined") {
        const banner = document.createElement("div");
        banner.className = "group-join-banner";
        const text = document.createElement("span");
        const joinedUsername = String(row.joined_username || "someone");
        text.textContent = `@${joinedUsername} joined the group`;
        banner.appendChild(text);
        area.appendChild(banner);
        lastSender = "";
        lastDirection = "";
        currentGroup = null;
        continue;
      }

      const direction = row.direction === "incoming" ? "in" : "out";
      const sender = direction === "in" ? (row.sender_username || "unknown") : "you";

      // New bubble group if sender/direction changes
      const sameSender = sender === lastSender && direction === lastDirection;
      if (!sameSender) {
        currentGroup = document.createElement("div");
        currentGroup.className = "bubble-group " + direction;

        // Show sender name in group views (both incoming and outgoing)
        if (isGroupView || (direction === "in" && includeTopic)) {
          const senderName = direction === "out"
            ? (state.me ? state.me.username : "you")
            : sender;
          const senderEl = document.createElement("div");
          senderEl.className = "bubble-sender";
          senderEl.style.color = avatarColor(senderName);
          senderEl.textContent = "@" + senderName;
          senderEl.style.cursor = "pointer";
          senderEl.addEventListener("click", (e) => {
            e.stopPropagation();
            showProfileModal(senderName);
          });
          currentGroup.appendChild(senderEl);
        }

        area.appendChild(currentGroup);
      }

      // Bubble
      const bubble = document.createElement("div");
      if (row.id != null) bubble.dataset.msgId = row.id;
      const isFirst = !sameSender;
      const nextRow = rows[i + 1];
      const nextSender = nextRow ? (nextRow.direction === "incoming" ? (nextRow.sender_username || "unknown") : "you") : "";
      const nextDirection = nextRow ? (nextRow.direction === "incoming" ? "in" : "out") : "";
      const nextDate = nextRow ? formatDateDivider(nextRow.created_at) : "";
      const isLast = nextSender !== sender || nextDirection !== direction || nextDate !== dateStr;

      bubble.className = "bubble " + direction +
        (isFirst ? " first" : "") +
        (isLast ? " last" : "");

      const content = row.content || parseMessageContent(row.plaintext);
      if (content.media) {
        const mediaWrap = document.createElement("div");
        mediaWrap.className = "bubble-media";
        const mediaUrl = buildMediaDataUrl(content.media);
        const topType = String(content.media.mime || "").split("/")[0];

        if (topType === "image") {
          const img = document.createElement("img");
          img.className = "bubble-media-image";
          img.src = mediaUrl;
          img.alt = content.media.name || "image";
          img.loading = "lazy";
          mediaWrap.appendChild(img);
        } else if (topType === "video") {
          const video = document.createElement("video");
          video.className = "bubble-media-video";
          video.src = mediaUrl;
          video.controls = true;
          video.preload = "metadata";
          mediaWrap.appendChild(video);
        } else if (topType === "audio") {
          const audio = document.createElement("audio");
          const isVoice = (attachment.name || "").startsWith("voice-message.");
          audio.className = "bubble-media-audio" + (isVoice ? " voice-message" : "");
          audio.src = mediaUrl;
          audio.controls = true;
          audio.preload = "metadata";
          mediaWrap.appendChild(audio);
        }

        const fileLink = document.createElement("a");
        fileLink.className = "bubble-media-link";
        fileLink.href = mediaUrl;
        fileLink.download = content.media.name || "attachment";
        fileLink.target = "_blank";
        fileLink.rel = "noopener noreferrer";
        fileLink.textContent = `Download ${content.media.name || "attachment"}`;
        mediaWrap.appendChild(fileLink);
        bubble.appendChild(mediaWrap);
      }

      const textValue = content.undecryptable
        ? "[unable to decrypt]"
        : String(content.text || "");
      if (textValue) {
        const textEl = document.createElement("div");
        textEl.className = "bubble-text";
        textEl.innerHTML = composerToHighlightedHtml(textValue);
        bubble.appendChild(textEl);
      }
      if (content.undecryptable) {
        const hintEl = document.createElement("div");
        hintEl.className = "bubble-undecryptable-hint";
        hintEl.textContent =
          "Open Settings -> Profile and use Restore Key from Server. Then use Backup Key to Server so this does not happen again.";
        bubble.appendChild(hintEl);
      }

      const metaEl = document.createElement("div");
      metaEl.className = "bubble-meta";

      if (includeTopic && row.topic_title) {
        const topicEl = document.createElement("span");
        topicEl.className = "bubble-topic";
        topicEl.textContent = row.topic_title;
        metaEl.appendChild(topicEl);
      }

      const myId = state.me && state.me.id;
      const isSiteAdmin = Boolean(state.me && state.me.is_admin);
      const isSender = myId != null && row.sender_id === myId;
      const groupRole = (isGroupView && row.group_id != null && state.groups.get(row.group_id))
        ? state.groups.get(row.group_id).role
        : (isGroupView && state.activeGroupId && state.groups.get(state.activeGroupId))
          ? state.groups.get(state.activeGroupId).role
          : "";
      const isGroupAdmin = isGroupView && (groupRole === "owner" || groupRole === "admin");
      const canDelete = isSender || isGroupAdmin || isSiteAdmin;

      if (row.id != null) {
        const actions = document.createElement("div");
        actions.className = "bubble-actions";

        // Like button
        const likeBtn = document.createElement("button");
        likeBtn.type = "button";
        likeBtn.className = "bubble-action-btn like-btn";
        const likes = row.likes || [];
        const likeCount = row.like_count || likes.length || 0;
        const iLiked = likes.some(l => l.user_id === myId);
        if (iLiked) likeBtn.classList.add("liked");
        likeBtn.title = iLiked ? "Unlike" : "Like";
        likeBtn.innerHTML = "\uD83D\uDC4D" + (likeCount > 0 ? " " + likeCount : "");
        likeBtn.dataset.messageId = row.id;
        likeBtn.dataset.messageType = isGroupView ? "group" : "direct";
        if (isGroupView) likeBtn.dataset.groupId = row.group_id || state.activeGroupId;
        likeBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleMessageLike(row.id, isGroupView ? "group" : "direct", isGroupView ? (row.group_id || state.activeGroupId) : null);
        });
        actions.appendChild(likeBtn);

        // Like avatar stack
        if (likeCount > 0) {
          const avatarStack = document.createElement("div");
          avatarStack.className = "like-avatar-stack";
          avatarStack.dataset.messageId = row.id;
          avatarStack.dataset.messageType = isGroupView ? "group" : "direct";
          const displayLikes = likes.slice(0, 3);
          displayLikes.forEach((liker, idx) => {
            const av = createAvatarEl(liker.username, "xs", liker.avatar_b64);
            av.style.marginLeft = idx > 0 ? "-6px" : "0";
            av.style.zIndex = String(displayLikes.length - idx);
            avatarStack.appendChild(av);
          });
          if (likeCount > 3) {
            const more = document.createElement("span");
            more.className = "like-more-count";
            more.textContent = "+" + (likeCount - 3);
            avatarStack.appendChild(more);
          }
          avatarStack.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            showLikesOverlay(row.id, likes);
          });
          actions.appendChild(avatarStack);
        }

        // Delete button (conditional)
        if (canDelete) {
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "bubble-action-btn danger";
          delBtn.title = "Delete message";
          delBtn.textContent = "Delete";
          delBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const label = isSender ? "Delete this message?" : "Delete this message as admin?";
            if (!await confirmAsync(label + " This cannot be undone.", { danger: true })) return;
            if (isGroupView) {
              deleteGroupMessage(row.group_id || state.activeGroupId, row.id)
                .then(() => showToast("Message deleted."))
                .catch((err) => showToast("Delete failed: " + err.message, "error"));
            } else {
              deleteDirectMessage(row.id)
                .then(() => showToast("Message deleted."))
                .catch((err) => showToast("Delete failed: " + err.message, "error"));
            }
          });
          actions.appendChild(delBtn);
        }

        metaEl.appendChild(actions);
      }

      const timeEl = document.createElement("span");
      timeEl.className = "bubble-time";
      timeEl.textContent = row.created_at
        ? new Date(row.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
      metaEl.appendChild(timeEl);

      bubble.appendChild(metaEl);
      currentGroup.appendChild(bubble);

      lastSender = sender;
      lastDirection = direction;
    }

    if (preserveScrollOnPrepend) {
      const nextHeight = area.scrollHeight;
      area.scrollTop = Math.max(0, nextHeight - previousScrollHeight + previousScrollTop);
      return;
    }
    if (stickToBottom) scheduleMessagesAreaBottomLock(area);
  }

  // === DATA REFRESH ===
  async function refreshFriends() {
    const data = await api("/api/friends");
    state.friends.clear();
    for (const f of data.friends || []) {
      const jwk = parsePublicJwk(f.public_key || "");
      if (!jwk) continue;
      state.friends.set(f.username, {
        id: f.id,
        username: f.username,
        publicJwk: jwk,
        display_name: f.display_name || "",
        avatar_b64: f.avatar_b64 || "",
      });
      // Seed preview timestamp from server so sorting works immediately
      const previewKey = "friend:" + f.username;
      const existing = state.conversationPreviews.get(previewKey);
      const serverTs = f.last_message_at || 0;
      if (!existing || (serverTs > 0 && existing.timestamp < serverTs)) {
        state.conversationPreviews.set(previewKey, {
          text: existing ? existing.text : "",
          timestamp: serverTs,
          unread: existing ? existing.unread : 0,
        });
      }
    }
    scheduleConversationListRender();
  }

  async function refreshFriendRequests() {
    const [incoming, outgoing] = await Promise.all([
      api("/api/friend-requests/pending"),
      api("/api/friend-requests/outgoing"),
    ]);
    state.incomingFriendRequests = incoming.requests || [];
    state.outgoingFriendRequests = outgoing.requests || [];
    updateNotificationBadge();
  }

  async function refreshGroups() {
    const data = await api("/api/groups");
    state.groups.clear();
    for (const g of data.groups || []) {
      state.groups.set(g.id, { ...g });
      // Seed preview timestamp from server so sorting works immediately
      const previewKey = "group:" + g.id;
      const existing = state.conversationPreviews.get(previewKey);
      const serverTs = g.last_message_at || 0;
      if (!existing || (serverTs > 0 && existing.timestamp < serverTs)) {
        state.conversationPreviews.set(previewKey, {
          text: existing ? existing.text : "",
          timestamp: serverTs,
          unread: existing ? existing.unread : 0,
        });
      }
    }

    if (state.activeType === "group" && state.activeGroupId && !state.groups.has(state.activeGroupId)) {
      state.activeType = null;
      state.activeGroupId = null;
      state.activeGroupTopic = "all";
      showChatEmpty();
    }
    scheduleConversationListRender();
  }

  async function refreshGroupInvites() {
    const data = await api("/api/group-invites/pending");
    state.pendingGroupInvites = data.invites || [];
    updateNotificationBadge();
  }

  async function refreshGroupContext(groupId) {
    const [membersData, topicsData] = await Promise.all([
      api(`/api/groups/${groupId}/members`),
      api(`/api/groups/${groupId}/topics`),
    ]);

    const membersMap = new Map();
    for (const m of membersData.members || []) {
      const jwk = parsePublicJwk(m.public_key || "");
      if (!jwk) continue;
      const joinedAt = Number(m.joined_at || 0);
      membersMap.set(m.username, {
        id: m.id, username: m.username, role: m.role, publicJwk: jwk,
        joined_at: Number.isFinite(joinedAt) && joinedAt > 0 ? Math.trunc(joinedAt) : 0,
      });
    }
    state.groupMembers.set(groupId, membersMap);
    state.groupTopics.set(groupId, topicsData.topics || []);

    const g = state.groups.get(groupId);
    if (g) {
      g.can_manage_members = Boolean(membersData.can_manage_members);
      g.can_remove_members = Boolean(membersData.can_remove_members);
      g.member_count = (membersData.members || []).length;
      g.topic_count = (topicsData.topics || []).length;
    }

    if (
      state.activeType === "group" &&
      state.activeGroupId === groupId &&
      state.activeGroupTopic !== "all"
    ) {
      const exists = (topicsData.topics || []).some((t) => String(t.id) === String(state.activeGroupTopic));
      if (!exists) state.activeGroupTopic = "all";
    }

    if (state.activeType === "group" && state.activeGroupId === groupId) {
      updateChatHeader();
      renderTopicsBar();
    }
  }

  function activeConversationKey() {
    if (state.activeType === "friend" && state.activeFriend) return `friend:${state.activeFriend}`;
    if (state.activeType === "group" && state.activeGroupId) return `group:${state.activeGroupId}:topic:${state.activeGroupTopic}`;
    return "";
  }

  function resetActiveFeedState(conversationKey = "") {
    state.activeFeedKey = conversationKey;
    state.activeRows = [];
    state.activeHasMore = false;
    state.activeNextBeforeId = null;
    state.activeFeedLoading = false;
    state.activeFeedLoadingOlder = false;
    state.activeFeedPendingRealtimePull = false;
  }

  function updateGroupComposerState() {
    if (!(state.activeType === "group" && state.activeGroupId)) return;
    const composer = $("composer");
    const sendBtn = $("sendBtn");
    const attachBtn = $("attachBtn");
    const micBtn = $("micBtn");

    if (state.sendBusy) {
      composer.disabled = true;
      composer.placeholder = "Sending...";
      sendBtn.disabled = true;
      attachBtn.disabled = true;
      if (micBtn) micBtn.disabled = true;
      return;
    }

    if (state.activeGroupTopic === "all") {
      const topics = state.groupTopics.get(state.activeGroupId) || [];
      if (topics.length === 0) {
        composer.disabled = true;
        composer.placeholder = "Create a topic first...";
        sendBtn.disabled = true;
        attachBtn.disabled = true;
        clearPendingAttachment();
      } else {
        composer.disabled = false;
        composer.placeholder = "Message (#" + topics[0].title + ")";
        sendBtn.disabled = false;
        attachBtn.disabled = false;
      }
      return;
    }

    composer.disabled = false;
    composer.placeholder = "Message";
    sendBtn.disabled = false;
    attachBtn.disabled = false;
    if (micBtn) micBtn.disabled = false;
  }

  async function fetchActiveConversationRows(limit = ACTIVE_FEED_PAGE_LIMIT, beforeId = null) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || ACTIVE_FEED_PAGE_LIMIT, 200));
    const safeBeforeId = beforeId == null ? null : Number(beforeId);
    let data = { messages: [] };

    if (state.activeType === "friend" && state.activeFriend) {
      let url = `/api/messages/with/${encodeURIComponent(state.activeFriend)}?limit=${safeLimit}`;
      if (Number.isFinite(safeBeforeId) && safeBeforeId > 0) {
        url += `&before_id=${encodeURIComponent(String(Math.trunc(safeBeforeId)))}`;
      }
      data = await api(url);
      const rows = [];
      for (const m of data.messages || []) {
        let plaintext = "";
        try { plaintext = await decryptDirectPayload(m.payload, m.direction); } catch (_e) { plaintext = ""; }
        rows.push({ ...m, plaintext, content: parseMessageContent(plaintext) });
      }
      const pagination = data.pagination || {};
      const hasMore = pagination.has_more != null ? Boolean(pagination.has_more) : rows.length >= safeLimit;
      let nextBeforeId = pagination.next_before_id;
      if ((nextBeforeId == null || Number(nextBeforeId) < 1) && hasMore && rows.length) {
        nextBeforeId = rows[0].id;
      }
      return {
        rows,
        hasMore,
        nextBeforeId: Number.isFinite(Number(nextBeforeId)) && Number(nextBeforeId) > 0
          ? Number(nextBeforeId)
          : null,
      };
    }

    if (state.activeType === "group" && state.activeGroupId) {
      updateGroupComposerState();
      let url;
      if (state.activeGroupTopic === "all") {
        url = `/api/groups/${state.activeGroupId}/messages?limit=${safeLimit}`;
      } else {
        url = `/api/groups/${state.activeGroupId}/topics/${state.activeGroupTopic}/messages?limit=${safeLimit}`;
      }
      if (Number.isFinite(safeBeforeId) && safeBeforeId > 0) {
        url += `&before_id=${encodeURIComponent(String(Math.trunc(safeBeforeId)))}`;
      }
      data = await api(url);
      const rows = [];
      for (const m of data.messages || []) {
        let plaintext = "";
        try { plaintext = await decryptGroupPayload(m.payload); } catch (_e) { plaintext = ""; }
        rows.push({ ...m, plaintext, content: parseMessageContent(plaintext) });
      }
      const pagination = data.pagination || {};
      const hasMore = pagination.has_more != null ? Boolean(pagination.has_more) : rows.length >= safeLimit;
      let nextBeforeId = pagination.next_before_id;
      if ((nextBeforeId == null || Number(nextBeforeId) < 1) && hasMore && rows.length) {
        nextBeforeId = rows[0].id;
      }
      return {
        rows,
        hasMore,
        nextBeforeId: Number.isFinite(Number(nextBeforeId)) && Number(nextBeforeId) > 0
          ? Number(nextBeforeId)
          : null,
      };
    }

    return { rows: [], hasMore: false, nextBeforeId: null };
  }

  function mergeConversationRows(existingRows, incomingRows, prepend = false) {
    const merged = prepend
      ? [...(incomingRows || []), ...(existingRows || [])]
      : [...(existingRows || []), ...(incomingRows || [])];
    const seen = new Set();
    const out = [];
    let fallbackIndex = 0;
    for (const row of merged) {
      if (!row) continue;
      const key = row.id != null ? `id:${row.id}` : `fallback:${row.created_at || 0}:${fallbackIndex++}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    out.sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
    return out;
  }

  function collectGroupJoinEventRows(groupId) {
    const members = state.groupMembers.get(groupId);
    if (!members || members.size === 0) return [];

    const events = [];
    for (const member of members.values()) {
      if (!member) continue;
      const username = String(member.username || "").trim();
      const joinedAt = Number(member.joined_at || 0);
      if (!username || !Number.isFinite(joinedAt) || joinedAt <= 0) continue;
      events.push({
        row_type: "group_member_joined",
        event_key: `member-joined:${groupId}:${username}:${Math.trunc(joinedAt)}`,
        group_id: groupId,
        joined_username: username,
        created_at: Math.trunc(joinedAt),
      });
    }

    events.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at - b.created_at;
      return String(a.joined_username || "").localeCompare(String(b.joined_username || ""));
    });
    return events;
  }

  function mergeRenderableRows(messageRows, systemRows) {
    const merged = [...(messageRows || []), ...(systemRows || [])];
    const seen = new Set();
    const out = [];
    let fallbackIndex = 0;
    for (const row of merged) {
      if (!row) continue;
      const key = row.id != null
        ? `id:${row.id}`
        : row.event_key
          ? `event:${row.event_key}`
          : `fallback:${row.created_at || 0}:${fallbackIndex++}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }

    out.sort((a, b) => {
      const aCreatedAt = Number(a.created_at || 0);
      const bCreatedAt = Number(b.created_at || 0);
      if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;

      const aIsSystem = a.row_type === "group_member_joined";
      const bIsSystem = b.row_type === "group_member_joined";
      if (aIsSystem !== bIsSystem) return aIsSystem ? -1 : 1;
      if (aIsSystem && bIsSystem) {
        return String(a.event_key || "").localeCompare(String(b.event_key || ""));
      }
      return Number(a.id || 0) - Number(b.id || 0);
    });
    return out;
  }

  function renderActiveConversationRows(options = {}) {
    if (!state.activeType) return;
    const isGroup = state.activeType === "group";

    let rows = state.activeRows;
    if (state.activeViewMode === "relevant") {
      rows = [...rows].sort((a, b) => {
        const aLikes = a.like_count || (a.likes ? a.likes.length : 0);
        const bLikes = b.like_count || (b.likes ? b.likes.length : 0);
        if (bLikes !== aLikes) return bLikes - aLikes;
        return Number(b.id || 0) - Number(a.id || 0);
      });
    } else if (state.activeViewMode === "mentions") {
      const myUsername = state.me ? state.me.username : "";
      const mentionRe = new RegExp("(^|\\s)@" + myUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:\\s|$)", "i");
      rows = rows.filter(r => {
        const text = (r.content && r.content.text) || r.plaintext || "";
        return mentionRe.test(text);
      });
    }

    if (
      isGroup &&
      state.activeViewMode === "all" &&
      state.activeGroupId &&
      state.activeGroupTopic === "all"
    ) {
      rows = mergeRenderableRows(rows, collectGroupJoinEventRows(state.activeGroupId));
    }

    renderMessageBubbles(
      rows,
      isGroup && state.activeGroupTopic === "all",
      isGroup,
      {
        ...options,
        showLoadOlderHint: state.activeViewMode === "all" && (state.activeHasMore || state.activeFeedLoadingOlder),
      }
    );
  }

  function updateActiveConversationPreviewFromRows() {
    if (state.activeType === "friend" && state.activeFriend) {
      const friendPreviewKey = "friend:" + state.activeFriend;
      if (state.activeRows.length > 0) {
        const last = state.activeRows[state.activeRows.length - 1];
        state.conversationPreviews.set(friendPreviewKey, {
          text: previewTextFromContent(last.content),
          timestamp: last.created_at || 0,
          unread: 0,
        });
      } else {
        state.conversationPreviews.set(friendPreviewKey, { text: "", timestamp: 0, unread: 0 });
      }
      renderConversationList();
      return;
    }

    if (state.activeType === "group" && state.activeGroupId) {
      const groupPreviewKey = "group:" + state.activeGroupId;
      if (state.activeRows.length > 0) {
        const last = state.activeRows[state.activeRows.length - 1];
        state.conversationPreviews.set(groupPreviewKey, {
          text: previewTextFromContent(last.content),
          timestamp: last.created_at || 0,
          unread: 0,
        });
      } else {
        state.conversationPreviews.set(groupPreviewKey, { text: "", timestamp: 0, unread: 0 });
      }
      renderConversationList();
    }
  }

  async function loadActiveConversationPage(options = {}) {
    const reset = Boolean(options.reset);
    const older = Boolean(options.older);
    const limit = options.limit || ACTIVE_FEED_PAGE_LIMIT;
    const key = activeConversationKey();
    if (!key) return;

    const shouldReset = reset || state.activeFeedKey !== key;
    if (shouldReset) resetActiveFeedState(key);

    if (older) {
      if (state.activeFeedLoadingOlder || !state.activeHasMore || !state.activeNextBeforeId) return;
    } else if (state.activeFeedLoading) {
      return;
    }

    const requestSeq = ++state.activeFeedRequestSeq;
    if (older) state.activeFeedLoadingOlder = true;
    else state.activeFeedLoading = true;

    const area = $("messagesArea");
    const previousScrollHeight = older ? area.scrollHeight : 0;
    const previousScrollTop = older ? area.scrollTop : 0;
    if (!older && state.activeRows.length === 0) {
      area.innerHTML = '<div class="no-messages">Loading messages...</div>';
    }

    try {
      const beforeId = older ? state.activeNextBeforeId : null;
      const page = await fetchActiveConversationRows(limit, beforeId);
      if (state.activeFeedKey !== key || requestSeq !== state.activeFeedRequestSeq) return;

      state.activeRows = older
        ? mergeConversationRows(state.activeRows, page.rows, true)
        : page.rows;

      state.activeHasMore = Boolean(page.hasMore);
      if (state.activeHasMore) {
        state.activeNextBeforeId = page.nextBeforeId != null
          ? page.nextBeforeId
          : (state.activeRows.length ? Number(state.activeRows[0].id) : null);
      } else {
        state.activeNextBeforeId = null;
      }

      renderActiveConversationRows({
        preserveScrollOnPrepend: older,
        previousScrollHeight,
        previousScrollTop,
        stickToBottom: !older,
      });
      if (!older) updateActiveConversationPreviewFromRows();
    } finally {
      if (requestSeq === state.activeFeedRequestSeq) {
        if (older) state.activeFeedLoadingOlder = false;
        else state.activeFeedLoading = false;
        const shouldDrainPending = state.activeFeedPendingRealtimePull
          && state.activeFeedKey === key
          && !state.activeFeedLoading
          && !state.activeFeedLoadingOlder;
        if (shouldDrainPending) {
          state.activeFeedPendingRealtimePull = false;
          pullLatestIntoActiveConversation().catch(() => {});
        }
      }
    }
  }

  async function pullLatestIntoActiveConversation(limit = ACTIVE_FEED_REALTIME_PULL_LIMIT) {
    const key = activeConversationKey();
    if (!key) return;
    if (state.activeFeedLoading || state.activeFeedLoadingOlder) {
      state.activeFeedPendingRealtimePull = true;
      return;
    }
    state.activeFeedPendingRealtimePull = false;

    const area = $("messagesArea");
    const distanceFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
    const stickToBottom = distanceFromBottom < 120;

    const requestSeq = ++state.activeFeedRequestSeq;
    state.activeFeedLoading = true;
    try {
      const page = await fetchActiveConversationRows(limit, null);
      if (state.activeFeedKey !== key || requestSeq !== state.activeFeedRequestSeq) return;

      const previousRows = state.activeRows;
      const mergedRows = mergeConversationRows(previousRows, page.rows, false);
      const changed = mergedRows.length !== previousRows.length
        || (
          mergedRows.length > 0 &&
          previousRows.length > 0 &&
          Number(mergedRows[mergedRows.length - 1].id || 0) !== Number(previousRows[previousRows.length - 1].id || 0)
        );
      state.activeRows = mergedRows;

      state.activeHasMore = state.activeHasMore || Boolean(page.hasMore);
      if (state.activeHasMore && !state.activeNextBeforeId && state.activeRows.length) {
        state.activeNextBeforeId = Number(state.activeRows[0].id);
      }

      if (changed) {
        renderActiveConversationRows({ stickToBottom });
        updateActiveConversationPreviewFromRows();
      }
    } finally {
      if (requestSeq === state.activeFeedRequestSeq) {
        state.activeFeedLoading = false;
        const shouldDrainPending = state.activeFeedPendingRealtimePull
          && state.activeFeedKey === key
          && !state.activeFeedLoading
          && !state.activeFeedLoadingOlder;
        if (shouldDrainPending) {
          state.activeFeedPendingRealtimePull = false;
          pullLatestIntoActiveConversation(limit).catch(() => {});
        }
      }
    }
  }

  async function maybeLoadOlderActiveConversation() {
    if (!state.activeType) return;
    if (state.activeFeedLoadingOlder || !state.activeHasMore || !state.activeNextBeforeId) return;
    const area = $("messagesArea");
    if (!area) return;
    if (area.scrollTop > ACTIVE_FEED_SCROLL_TOP_THRESHOLD) return;
    await loadActiveConversationPage({ older: true });
  }

  async function refreshActiveConversation() {
    await loadActiveConversationPage({ reset: true });
  }

  // === CONVERSATION SELECTION ===
  async function selectActiveFriend(username) {
    if (!state.friends.has(username)) {
      showToast("Friend not found.", "error");
      return;
    }
    state.activeType = "friend";
    state.activeFriend = username;
    state.activeGroupId = null;
    state.activeGroupTopic = "all";

    // Clear unread for this conversation
    clearUnread("friend:" + username);

    showChatActive();
    updateChatHeader();
    renderConversationList();
    handleMobileNav("chat");
    resetViewToggle();
    $("viewToggleBar").classList.remove("hidden");

    // Reset composer
    const composer = $("composer");
    composer.disabled = false;
    composer.placeholder = "Message";
    $("sendBtn").disabled = false;
    $("attachBtn").disabled = false;
    $("micBtn").disabled = false;
    clearPendingAttachment();

    await refreshActiveConversation();
  }

  async function selectActiveGroup(groupId) {
    if (!state.groups.has(groupId)) {
      showToast("Group not found.", "error");
      return;
    }
    state.activeType = "group";
    state.activeGroupId = groupId;
    state.activeFriend = null;
    state.activeGroupTopic = "all";
    clearPendingAttachment();

    // Clear unread for this conversation
    clearUnread("group:" + groupId);

    showChatActive();
    renderConversationList();
    handleMobileNav("chat");
    resetViewToggle();
    $("viewToggleBar").classList.remove("hidden");

    await refreshGroupContext(groupId);
    updateChatHeader();
    await refreshActiveConversation();
  }

  async function selectGroupTopic(topicIdOrAll) {
    assert(state.activeType === "group" && state.activeGroupId, "Select a group first.");
    state.activeGroupTopic = topicIdOrAll;
    renderTopicsBar();
    await refreshActiveConversation();
  }

  // === SENDING MESSAGES ===
  function sendMentionHints(text, messageId, messageType, groupId, topicId, friendUsername) {
    const mentionRe = /(^|\s)@([a-z0-9_-]{3,32})/gi;
    let match;
    const mentioned = new Set();
    while ((match = mentionRe.exec(text)) !== null) {
      const username = match[2].toLowerCase();
      if (state.me && username === state.me.username) continue;
      if (mentioned.has(username)) continue;
      mentioned.add(username);
      // @everyone → notify all group members via dedicated endpoint
      if (username === "everyone") {
        if (messageType === "group" && groupId) {
          api("/api/notifications/mention-everyone", {
            method: "POST",
            body: JSON.stringify({
              message_id: messageId,
              group_id: groupId,
              topic_id: topicId || null,
            }),
          }).catch(() => {});
        }
        continue;
      }
      api("/api/notifications/mention", {
        method: "POST",
        body: JSON.stringify({
          mentioned_username: username,
          message_id: messageId,
          message_type: messageType,
          group_id: groupId || null,
          topic_id: topicId || null,
          friend_username: friendUsername || null,
        }),
      }).catch(() => {});
    }
  }

  async function sendDirectMessage() {
    assert(state.activeType === "friend" && state.activeFriend, "Select a friend chat first.");
    const text = $("composer").value.trim();
    const attachment = state.pendingAttachment;
    assert(text.length > 0 || attachment, "Message is empty.");

    const friend = state.friends.get(state.activeFriend);
    const plaintext = buildEncryptedMessageEnvelope(text, attachment);
    const payload = await encryptDirectPayload(plaintext, friend.publicJwk);
    const result = await api("/api/messages/send", {
      method: "POST",
      body: JSON.stringify({ recipient_username: friend.username, payload }),
    });
    if (text && result && result.id) {
      sendMentionHints(text, result.id, "direct", null, null, friend.username);
    }
    $("composer").value = "";
    hideMentionSuggestions();
    updateComposerOverlay();
    clearPendingAttachment();
    autoResizeComposer();
    await refreshActiveConversation();
  }

  async function sendGroupMessage() {
    assert(state.activeType === "group" && state.activeGroupId, "Select a group first.");

    let targetTopicId = state.activeGroupTopic;
    if (targetTopicId === "all") {
      const topics = state.groupTopics.get(state.activeGroupId) || [];
      assert(topics.length > 0, "No topics in this group. Create one first.");
      targetTopicId = topics[0].id;
    }

    const text = $("composer").value.trim();
    const attachment = state.pendingAttachment;
    assert(text.length > 0 || attachment, "Message is empty.");

    const membersMap = state.groupMembers.get(state.activeGroupId);
    assert(Boolean(membersMap) && membersMap.size > 0, "Group members not loaded.");

    const plaintext = buildEncryptedMessageEnvelope(text, attachment);
    const payload = await encryptGroupPayload(plaintext, membersMap);
    const result = await api(`/api/groups/${state.activeGroupId}/messages/send`, {
      method: "POST",
      body: JSON.stringify({ topic_id: targetTopicId, payload }),
    });
    if (text && result && result.id) {
      sendMentionHints(text, result.id, "group", state.activeGroupId, targetTopicId, null);
    }
    $("composer").value = "";
    hideMentionSuggestions();
    updateComposerOverlay();
    clearPendingAttachment();
    autoResizeComposer();
    await refreshActiveConversation();
  }

  function setComposerSending(isSending) {
    const composer = $("composer");
    const sendBtn = $("sendBtn");
    const attachBtn = $("attachBtn");
    const micBtn = $("micBtn");

    if (isSending) {
      composer.disabled = true;
      composer.placeholder = "Sending...";
      sendBtn.disabled = true;
      attachBtn.disabled = true;
      if (micBtn) micBtn.disabled = true;
      return;
    }

    if (state.activeType === "group") {
      updateGroupComposerState();
    } else if (state.activeType === "friend") {
      composer.disabled = false;
      composer.placeholder = "Message";
      sendBtn.disabled = false;
      attachBtn.disabled = false;
      if (micBtn) micBtn.disabled = false;
    } else {
      composer.disabled = true;
      sendBtn.disabled = true;
      attachBtn.disabled = true;
      if (micBtn) micBtn.disabled = true;
    }
  }

  async function sendMessage() {
    if (state.sendBusy) return;
    if (state.activeType !== "friend" && state.activeType !== "group") return;

    state.sendBusy = true;
    setComposerSending(true);
    try {
      if (state.activeType === "friend") {
        await sendDirectMessage();
      } else {
        await sendGroupMessage();
      }
    } catch (e) {
      showToast("Send failed: " + e.message, "error");
    } finally {
      state.sendBusy = false;
      setComposerSending(false);
    }
  }

  // === MESSAGE DELETION ===
  async function deleteDirectMessage(messageId) {
    await api(`/api/messages/${messageId}`, { method: "DELETE" });
    await refreshActiveConversation();
  }

  async function deleteGroupMessage(groupId, messageId) {
    await api(`/api/groups/${groupId}/messages/${messageId}`, { method: "DELETE" });
    await refreshActiveConversation();
  }

  // === LIKE ACTIONS ===
  async function toggleMessageLike(messageId, messageType, groupId) {
    try {
      let url;
      if (messageType === "group" && groupId) {
        url = `/api/groups/${groupId}/messages/${messageId}/like`;
      } else {
        url = `/api/messages/${messageId}/like`;
      }
      await api(url, { method: "POST", body: JSON.stringify({}) });
    } catch (err) {
      showToast("Like failed: " + err.message, "error");
    }
  }

  function showLikesOverlay(messageId, likes) {
    showModal("Liked by", (body) => {
      if (!likes || likes.length === 0) {
        body.textContent = "No likes yet.";
        return;
      }
      const list = document.createElement("div");
      list.className = "likes-list";
      likes.forEach(liker => {
        const row = document.createElement("div");
        row.className = "likes-list-item";
        const av = createAvatarEl(liker.username, "sm", liker.avatar_b64);
        row.appendChild(av);
        const nameEl = document.createElement("span");
        nameEl.className = "likes-list-username";
        nameEl.textContent = "@" + liker.username;
        nameEl.style.color = avatarColor(liker.username);
        row.appendChild(nameEl);
        const myUsername = state.me && state.me.username;
        if (liker.username !== myUsername && !state.friends.has(liker.username)) {
          const addBtn = document.createElement("button");
          addBtn.className = "primary-btn sm";
          addBtn.textContent = "Add Friend";
          addBtn.addEventListener("click", () => {
            sendFriendRequest(liker.username)
              .then(() => { addBtn.disabled = true; addBtn.textContent = "Sent"; })
              .catch(err => showToast(err.message, "error"));
          });
          row.appendChild(addBtn);
        }
        list.appendChild(row);
      });
      body.appendChild(list);
    });
  }

  function updateLikeUI(messageId, likes, count, messageType) {
    const likeBtn = document.querySelector(`.like-btn[data-message-id="${messageId}"]`);
    if (!likeBtn) return;
    const myId = state.me && state.me.id;
    const iLiked = likes.some(l => l.user_id === myId);
    likeBtn.classList.toggle("liked", iLiked);
    likeBtn.title = iLiked ? "Unlike" : "Like";
    likeBtn.innerHTML = "\uD83D\uDC4D" + (count > 0 ? " " + count : "");
    const actions = likeBtn.parentElement;
    let stack = actions.querySelector(".like-avatar-stack");
    if (count > 0) {
      if (!stack) {
        stack = document.createElement("div");
        stack.className = "like-avatar-stack";
        stack.dataset.messageId = messageId;
        stack.dataset.messageType = messageType;
        likeBtn.after(stack);
      }
      stack.innerHTML = "";
      const displayLikes = likes.slice(0, 3);
      displayLikes.forEach((liker, idx) => {
        const av = createAvatarEl(liker.username, "xs", liker.avatar_b64);
        av.style.marginLeft = idx > 0 ? "-6px" : "0";
        av.style.zIndex = String(displayLikes.length - idx);
        stack.appendChild(av);
      });
      if (count > 3) {
        const more = document.createElement("span");
        more.className = "like-more-count";
        more.textContent = "+" + (count - 3);
        stack.appendChild(more);
      }
      stack.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showLikesOverlay(messageId, likes);
      };
    } else if (stack) {
      stack.remove();
    }
  }

  function resetViewToggle() {
    state.activeViewMode = "all";
    document.querySelectorAll(".view-toggle-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.view === "all");
    });
  }

  // === FRIEND ACTIONS ===
  async function sendFriendRequest(username) {
    await api("/api/friend-requests", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    showToast(`Friend request sent to @${normalizeUsername(username)}.`);
    await Promise.all([refreshFriendRequests(), refreshFriends()]);
  }

  async function acceptFriendRequest(requestId) {
    await api(`/api/friend-requests/${requestId}/accept`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    showToast("Friend request accepted.");
    await Promise.all([refreshFriendRequests(), refreshFriends()]);
  }

  async function declineFriendRequest(requestId) {
    await api(`/api/friend-requests/${requestId}/decline`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    showToast("Friend request declined.");
    await refreshFriendRequests();
  }

  async function removeFriend(username) {
    await api(`/api/friends/${encodeURIComponent(username)}`, { method: "DELETE" });
    if (state.activeType === "friend" && state.activeFriend === username) {
      state.activeType = null;
      state.activeFriend = null;
      showChatEmpty();
    }
    showToast(`Removed @${username} from friends.`);
    await refreshFriends();
  }

  // === GROUP ACTIONS ===
  async function createGroup(name) {
    const res = await api("/api/groups", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await refreshGroups();
    await refreshGroupContext(res.group.id);
    showToast("Group created.");
    hideModal();
    await selectActiveGroup(res.group.id);
  }

  async function inviteGroupMember(groupId, username) {
    await api(`/api/groups/${groupId}/invites`, {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    showToast(`Invite sent to @${username}.`);
  }

  async function removeGroupMember(groupId, username) {
    await api(`/api/groups/${groupId}/members/${encodeURIComponent(username)}`, { method: "DELETE" });
    await refreshGroupContext(groupId);
    await refreshGroups();
    showToast(`Removed @${username} from group.`);
  }

  async function createTopic(groupId, title) {
    await api(`/api/groups/${groupId}/topics`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    await refreshGroupContext(groupId);
    showToast("Topic created.");
  }

  async function deleteTopic(groupId, topicId) {
    await api(`/api/groups/${groupId}/topics/${topicId}`, { method: "DELETE" });
    await refreshGroupContext(groupId);
    if (state.activeType === "group" && state.activeGroupId === groupId && String(state.activeGroupTopic) === String(topicId)) {
      state.activeGroupTopic = "all";
      await refreshActiveConversation();
    }
    showToast("Topic deleted.");
  }

  async function deleteGroup(groupId) {
    await api(`/api/groups/${groupId}`, { method: "DELETE" });
    if (state.activeType === "group" && state.activeGroupId === groupId) {
      state.activeType = null;
      state.activeGroupId = null;
      state.activeGroupTopic = "all";
      showChatEmpty();
    }
    state.groupTopics.delete(groupId);
    state.groupMembers.delete(groupId);
    await refreshGroups();
    showToast("Group deleted.");
    hideModal();
  }

  async function acceptGroupInvite(inviteId) {
    const res = await api(`/api/group-invites/${inviteId}/accept`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await Promise.all([refreshGroupInvites(), refreshGroups()]);
    if (res.invite && res.invite.group_id) {
      await refreshGroupContext(res.invite.group_id);
      await selectActiveGroup(res.invite.group_id);
    }
    showToast("Group invite accepted.");
  }

  async function declineGroupInvite(inviteId) {
    await api(`/api/group-invites/${inviteId}/decline`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await refreshGroupInvites();
    showToast("Group invite declined.");
  }

  // === SEARCH ===
  async function queryUsersForAutocomplete(query, limit = 12) {
    const res = await api(`/api/users/search?q=${encodeURIComponent(query)}&limit=${limit}`);
    return res.users || [];
  }

  function renderSearchResults(users) {
    const container = $("searchResults");
    container.innerHTML = "";

    if (!users.length) {
      container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);">No users found</div>';
      return;
    }

    for (const user of users) {
      const item = document.createElement("button");
      item.className = "search-result-item";

      const avatar = createAvatarEl(user.username);

      const info = document.createElement("div");
      info.className = "search-result-info";

      const nameEl = document.createElement("div");
      nameEl.className = "search-result-name";
      nameEl.textContent = "@" + user.username;

      const statusEl = document.createElement("div");
      statusEl.className = "search-result-status";
      if (state.friends.has(user.username)) {
        statusEl.textContent = "Friend";
      } else if (user.is_friend) {
        statusEl.textContent = "Friend";
      } else {
        statusEl.textContent = "User";
      }

      info.appendChild(nameEl);
      info.appendChild(statusEl);
      item.appendChild(avatar);
      item.appendChild(info);

      if (state.friends.has(user.username)) {
        item.addEventListener("click", () => {
          exitSearch();
          selectActiveFriend(user.username);
        });
      } else {
        const addBtn = document.createElement("button");
        addBtn.className = "alt";
        addBtn.textContent = "Add";
        addBtn.style.flexShrink = "0";
        addBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          sendFriendRequest(user.username).catch((err) => showToast("Request failed: " + err.message, "error"));
        });
        item.appendChild(addBtn);
      }

      container.appendChild(item);
    }
  }

  function enterSearch() {
    state.searchMode = true;
    $("conversationList").classList.add("hidden");
    $("searchResults").classList.remove("hidden");
  }

  function exitSearch() {
    state.searchMode = false;
    state.searchQuery = "";
    $("searchInput").value = "";
    $("conversationList").classList.remove("hidden");
    $("searchResults").classList.add("hidden");
  }

  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    const query = normalizeUsername($("searchInput").value);
    state.searchQuery = query;

    if (!query) {
      exitSearch();
      return;
    }

    enterSearch();
    searchTimer = setTimeout(async () => {
      try {
        const users = await queryUsersForAutocomplete(query, 20);
        if (state.searchQuery === query) {
          renderSearchResults(users);
        }
      } catch (e) {
        showToast("Search failed: " + e.message, "error");
      }
    }, 200);
  }

  // === MODAL RENDERERS ===

  // New Group Modal
  function showNewGroupModal() {
    showModal("New Group", (body) => {
      const section = document.createElement("div");
      section.className = "modal-section";

      const label = document.createElement("label");
      label.textContent = "Group Name";

      const row = document.createElement("div");
      row.className = "modal-row";

      const input = document.createElement("input");
      input.placeholder = "Enter group name";
      input.id = "modalGroupName";

      const btn = document.createElement("button");
      btn.textContent = "Create";
      btn.addEventListener("click", () => {
        const name = input.value.trim();
        if (!name) { showToast("Group name is required.", "error"); return; }
        createGroup(name).catch((e) => showToast("Create failed: " + e.message, "error"));
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") btn.click();
      });

      row.appendChild(input);
      row.appendChild(btn);
      section.appendChild(label);
      section.appendChild(row);
      body.appendChild(section);

      setTimeout(() => input.focus(), 100);
    });
  }

  // New Chat Modal (search for user to start DM)
  function showNewChatModal() {
    showModal("New Chat", (body) => {
      const section = document.createElement("div");
      section.className = "modal-section";

      const label = document.createElement("label");
      label.textContent = "Search for a user";

      const input = document.createElement("input");
      input.placeholder = "@username";

      const results = document.createElement("div");
      results.className = "invite-suggestions hidden";

      let timer = null;
      input.addEventListener("input", () => {
        if (timer) clearTimeout(timer);
        const q = normalizeUsername(input.value);
        if (!q) { results.classList.add("hidden"); results.innerHTML = ""; return; }
        timer = setTimeout(async () => {
          try {
            const users = await queryUsersForAutocomplete(q, 10);
            results.innerHTML = "";
            if (!users.length) {
              results.classList.add("hidden");
              return;
            }
            results.classList.remove("hidden");
            for (const u of users) {
              const item = document.createElement("button");
              item.className = "suggestion-item";
              item.textContent = "@" + u.username + (state.friends.has(u.username) ? " (friend)" : "");
              item.addEventListener("click", () => {
                hideModal();
                if (state.friends.has(u.username)) {
                  selectActiveFriend(u.username);
                } else {
                  sendFriendRequest(u.username).catch((e) => showToast(e.message, "error"));
                }
              });
              results.appendChild(item);
            }
          } catch (_e) { results.classList.add("hidden"); }
        }, 200);
      });

      section.appendChild(label);
      section.appendChild(input);
      section.appendChild(results);
      body.appendChild(section);

      setTimeout(() => input.focus(), 100);
    });
  }

  // Group Info Modal
  function showGroupInfoModal(groupId) {
    const g = state.groups.get(groupId);
    if (!g) return;

    showModal("#" + g.name + " — Info", (body) => {
      // Members
      const membersSection = document.createElement("div");
      membersSection.className = "modal-section";
      const membersLabel = document.createElement("label");
      membersLabel.textContent = "Members";
      membersSection.appendChild(membersLabel);

      const memberList = document.createElement("div");
      memberList.className = "member-list";
      const members = state.groupMembers.get(groupId);
      if (members) {
        for (const [, m] of members) {
          const item = document.createElement("div");
          item.className = "member-item";

          const av = createAvatarEl(m.username, "sm");
          const name = document.createElement("span");
          name.className = "member-name";
          name.textContent = "@" + m.username;
          const role = document.createElement("span");
          role.className = "member-role";
          role.textContent = m.role;

          item.appendChild(av);
          item.appendChild(name);
          item.appendChild(role);
          memberList.appendChild(item);
        }
      }
      membersSection.appendChild(memberList);
      body.appendChild(membersSection);

      if (g.is_global_feed) {
        const noteSection = document.createElement("div");
        noteSection.className = "modal-section";
        noteSection.innerHTML =
          '<div style="font-size:13px;color:var(--muted);line-height:1.45;">' +
          "<strong>BlackEnvelope Feed</strong> is automatic. Everyone in the app is added to this feed and can chat here." +
          "</div>";
        body.appendChild(noteSection);
        return;
      }

      // Invite
      const inviteSection = document.createElement("div");
      inviteSection.className = "modal-section";
      const inviteLabel = document.createElement("label");
      inviteLabel.textContent = "Invite Member";
      const inviteRow = document.createElement("div");
      inviteRow.className = "modal-row";
      const inviteInput = document.createElement("input");
      inviteInput.placeholder = "@username";
      const inviteBtn = document.createElement("button");
      inviteBtn.textContent = "Invite";

      const inviteSuggestions = document.createElement("div");
      inviteSuggestions.className = "invite-suggestions hidden";

      inviteInput.addEventListener("input", () => {
        if (inviteSearchTimer) clearTimeout(inviteSearchTimer);
        const q = normalizeUsername(inviteInput.value);
        if (!q) { inviteSuggestions.classList.add("hidden"); inviteSuggestions.innerHTML = ""; return; }
        inviteSearchTimer = setTimeout(async () => {
          try {
            const users = await queryUsersForAutocomplete(q, 12);
            const filtered = users.filter((u) => !members || !members.has(u.username));
            inviteSuggestions.innerHTML = "";
            if (!filtered.length) { inviteSuggestions.classList.add("hidden"); return; }
            inviteSuggestions.classList.remove("hidden");
            for (const u of filtered) {
              const item = document.createElement("button");
              item.className = "suggestion-item";
              item.textContent = "@" + u.username;
              item.addEventListener("click", () => {
                inviteInput.value = "@" + u.username;
                inviteSuggestions.classList.add("hidden");
              });
              inviteSuggestions.appendChild(item);
            }
          } catch (_e) { inviteSuggestions.classList.add("hidden"); }
        }, 180);
      });

      inviteBtn.addEventListener("click", () => {
        const username = normalizeUsername(inviteInput.value);
        if (!username) return;
        inviteGroupMember(groupId, username)
          .then(() => { inviteInput.value = ""; inviteSuggestions.classList.add("hidden"); })
          .catch((e) => showToast("Invite failed: " + e.message, "error"));
      });

      inviteRow.appendChild(inviteInput);
      inviteRow.appendChild(inviteBtn);
      inviteSection.appendChild(inviteLabel);
      inviteSection.appendChild(inviteRow);
      inviteSection.appendChild(inviteSuggestions);
      body.appendChild(inviteSection);

      // Remove member — only visible to group owner and site admin
      if (g.can_remove_members) {
        const removeSection = document.createElement("div");
        removeSection.className = "modal-section";
        const removeLabel = document.createElement("label");
        removeLabel.textContent = "Remove Member";
        const removeRow = document.createElement("div");
        removeRow.className = "modal-row";
        const removeInput = document.createElement("input");
        removeInput.placeholder = "@username";
        const removeBtn = document.createElement("button");
        removeBtn.className = "danger";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
          const username = normalizeUsername(removeInput.value);
          if (!username) return;
          removeGroupMember(groupId, username)
            .then(() => { removeInput.value = ""; showGroupInfoModal(groupId); })
            .catch((e) => showToast("Remove failed: " + e.message, "error"));
        });
        removeRow.appendChild(removeInput);
        removeRow.appendChild(removeBtn);
        removeSection.appendChild(removeLabel);
        removeSection.appendChild(removeRow);
        body.appendChild(removeSection);
      }

      // Topics
      const topicsSection = document.createElement("div");
      topicsSection.className = "modal-section";
      const topicsLabel = document.createElement("label");
      topicsLabel.textContent = "Topics";
      topicsSection.appendChild(topicsLabel);

      const topics = state.groupTopics.get(groupId) || [];
      if (topics.length) {
        const topicList = document.createElement("div");
        topicList.className = "member-list";
        for (const t of topics) {
          const item = document.createElement("div");
          item.className = "member-item";
          const name = document.createElement("span");
          name.className = "member-name";
          name.textContent = t.title;
          const delBtn = document.createElement("button");
          delBtn.className = "danger ghost";
          delBtn.textContent = "Delete";
          delBtn.style.fontSize = "12px";
          delBtn.addEventListener("click", () => {
            deleteTopic(groupId, t.id)
              .then(() => showGroupInfoModal(groupId))
              .catch((e) => showToast("Delete failed: " + e.message, "error"));
          });
          item.appendChild(name);
          item.appendChild(delBtn);
          topicList.appendChild(item);
        }
        topicsSection.appendChild(topicList);
      }

      const newTopicRow = document.createElement("div");
      newTopicRow.className = "modal-row";
      newTopicRow.style.marginTop = "8px";
      const topicInput = document.createElement("input");
      topicInput.placeholder = "New topic title";
      const topicBtn = document.createElement("button");
      topicBtn.textContent = "Create Topic";
      topicBtn.addEventListener("click", () => {
        const title = topicInput.value.trim();
        if (!title) return;
        createTopic(groupId, title)
          .then(() => showGroupInfoModal(groupId))
          .catch((e) => showToast("Create topic failed: " + e.message, "error"));
      });
      newTopicRow.appendChild(topicInput);
      newTopicRow.appendChild(topicBtn);
      topicsSection.appendChild(newTopicRow);
      body.appendChild(topicsSection);

      // Delete Group
      const dangerSection = document.createElement("div");
      dangerSection.className = "modal-section";
      dangerSection.style.marginTop = "8px";
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "danger";
      deleteBtn.textContent = "Delete Group";
      deleteBtn.style.width = "100%";
      deleteBtn.addEventListener("click", async () => {
        if (await confirmAsync("Are you sure you want to delete this group?", { danger: true })) {
          deleteGroup(groupId).catch((e) => showToast("Delete failed: " + e.message, "error"));
        }
      });
      dangerSection.appendChild(deleteBtn);
      body.appendChild(dangerSection);
    });
  }

  // Friend Requests / Friends Modal
  function showFriendsModal() {
    toggleSettings(false);
    showModal("Friends & Requests", (body) => {
      // Incoming requests
      if (state.incomingFriendRequests.length > 0) {
        const section = document.createElement("div");
        section.className = "modal-section";
        const label = document.createElement("label");
        label.textContent = "Incoming Requests";
        section.appendChild(label);

        const list = document.createElement("div");
        list.className = "member-list";
        for (const r of state.incomingFriendRequests) {
          const item = document.createElement("div");
          item.className = "member-item";
          const av = createAvatarEl(r.requester_username, "sm");
          const name = document.createElement("span");
          name.className = "member-name";
          name.textContent = "@" + r.requester_username;
          const actions = document.createElement("div");
          actions.style.display = "flex";
          actions.style.gap = "4px";
          const acceptBtn = document.createElement("button");
          acceptBtn.className = "success";
          acceptBtn.textContent = "Accept";
          acceptBtn.style.fontSize = "12px";
          acceptBtn.style.padding = "4px 10px";
          acceptBtn.addEventListener("click", () => {
            acceptFriendRequest(r.id).then(() => showFriendsModal()).catch((e) => showToast(e.message, "error"));
          });
          const declineBtn = document.createElement("button");
          declineBtn.className = "danger";
          declineBtn.textContent = "Decline";
          declineBtn.style.fontSize = "12px";
          declineBtn.style.padding = "4px 10px";
          declineBtn.addEventListener("click", () => {
            declineFriendRequest(r.id).then(() => showFriendsModal()).catch((e) => showToast(e.message, "error"));
          });
          actions.appendChild(acceptBtn);
          actions.appendChild(declineBtn);
          item.appendChild(av);
          item.appendChild(name);
          item.appendChild(actions);
          list.appendChild(item);
        }
        section.appendChild(list);
        body.appendChild(section);
      }

      // Pending group invites
      if (state.pendingGroupInvites.length > 0) {
        const section = document.createElement("div");
        section.className = "modal-section";
        const label = document.createElement("label");
        label.textContent = "Group Invites";
        section.appendChild(label);

        const list = document.createElement("div");
        list.className = "member-list";
        for (const inv of state.pendingGroupInvites) {
          const item = document.createElement("div");
          item.className = "member-item";
          const av = createAvatarEl(inv.group_name, "sm");
          const info = document.createElement("span");
          info.className = "member-name";
          info.textContent = "#" + inv.group_name + " from @" + inv.invited_by_username;
          const actions = document.createElement("div");
          actions.style.display = "flex";
          actions.style.gap = "4px";
          const acceptBtn = document.createElement("button");
          acceptBtn.className = "success";
          acceptBtn.textContent = "Accept";
          acceptBtn.style.fontSize = "12px";
          acceptBtn.style.padding = "4px 10px";
          acceptBtn.addEventListener("click", () => {
            acceptGroupInvite(inv.id).then(() => hideModal()).catch((e) => showToast(e.message, "error"));
          });
          const declineBtn = document.createElement("button");
          declineBtn.className = "danger";
          declineBtn.textContent = "Decline";
          declineBtn.style.fontSize = "12px";
          declineBtn.style.padding = "4px 10px";
          declineBtn.addEventListener("click", () => {
            declineGroupInvite(inv.id).then(() => showFriendsModal()).catch((e) => showToast(e.message, "error"));
          });
          actions.appendChild(acceptBtn);
          actions.appendChild(declineBtn);
          item.appendChild(av);
          item.appendChild(info);
          item.appendChild(actions);
          list.appendChild(item);
        }
        section.appendChild(list);
        body.appendChild(section);
      }

      // Outgoing requests
      if (state.outgoingFriendRequests.length > 0) {
        const section = document.createElement("div");
        section.className = "modal-section";
        const label = document.createElement("label");
        label.textContent = "Outgoing Requests";
        section.appendChild(label);

        const list = document.createElement("div");
        list.className = "member-list";
        for (const r of state.outgoingFriendRequests) {
          const item = document.createElement("div");
          item.className = "member-item";
          const av = createAvatarEl(r.target_username, "sm");
          const name = document.createElement("span");
          name.className = "member-name";
          name.textContent = "@" + r.target_username;
          const status = document.createElement("span");
          status.className = "member-role";
          status.textContent = "pending";
          item.appendChild(av);
          item.appendChild(name);
          item.appendChild(status);
          list.appendChild(item);
        }
        section.appendChild(list);
        body.appendChild(section);
      }

      // Friend list
      const friendSection = document.createElement("div");
      friendSection.className = "modal-section";
      const friendLabel = document.createElement("label");
      friendLabel.textContent = "Friends";
      friendSection.appendChild(friendLabel);

      const friends = Array.from(state.friends.values()).sort((a, b) => a.username.localeCompare(b.username));
      if (!friends.length) {
        const empty = document.createElement("div");
        empty.style.color = "var(--muted)";
        empty.style.fontSize = "13px";
        empty.textContent = "No friends yet. Search for users to add friends.";
        friendSection.appendChild(empty);
      } else {
        const list = document.createElement("div");
        list.className = "member-list";
        for (const f of friends) {
          const item = document.createElement("div");
          item.className = "member-item";
          const av = createAvatarEl(f.username, "sm");
          const name = document.createElement("span");
          name.className = "member-name";
          name.textContent = "@" + f.username;
          name.style.cursor = "pointer";
          name.addEventListener("click", () => { hideModal(); selectActiveFriend(f.username); });

          const removeBtn = document.createElement("button");
          removeBtn.className = "danger ghost";
          removeBtn.textContent = "Remove";
          removeBtn.style.fontSize = "12px";
          removeBtn.addEventListener("click", () => {
            removeFriend(f.username).then(() => showFriendsModal()).catch((e) => showToast(e.message, "error"));
          });

          item.appendChild(av);
          item.appendChild(name);
          item.appendChild(removeBtn);
          list.appendChild(item);
        }
        friendSection.appendChild(list);
      }
      body.appendChild(friendSection);
    });
  }

  // === WEBSOCKET ===
  function clearWsHeartbeat() {
    if (state.wsHeartbeatTimer) {
      clearInterval(state.wsHeartbeatTimer);
      state.wsHeartbeatTimer = null;
    }
  }

  function startWsHeartbeat() {
    clearWsHeartbeat();
    state.wsLastSeenAt = Date.now();
    state.wsHeartbeatTimer = setInterval(() => {
      if (!state.token || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
      // If we haven't seen any frame in a while, force reconnect.
      if (Date.now() - state.wsLastSeenAt > 90000) {
        try { state.ws.close(); } catch (_e) {}
        return;
      }
      try { state.ws.send("ping"); } catch (_e) {}
    }, 25000);
  }

  function connectSocket() {
    if (!state.token) return;
    if (state.ws) { state.ws.close(); state.ws = null; }
    clearWsHeartbeat();

    const proto = location.protocol === "https:" ? "wss" : "ws";
    state.ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);

    state.ws.onopen = () => {
      $("wsLabel").textContent = "WS: connected";
      state.wsLastSeenAt = Date.now();
      startWsHeartbeat();
    };

    state.ws.onclose = () => {
      $("wsLabel").textContent = "WS: disconnected";
      clearWsHeartbeat();
      // Auto-reconnect after 3 seconds if still logged in
      if (state.token) {
        setTimeout(() => {
          if (state.token && (!state.ws || state.ws.readyState === WebSocket.CLOSED)) {
            connectSocket();
          }
        }, 3000);
      }
    };

    state.ws.onerror = () => {
      $("wsLabel").textContent = "WS: error";
    };

    state.ws.onmessage = async (ev) => {
      state.wsLastSeenAt = Date.now();
      let data = {};
      try { data = JSON.parse(ev.data); } catch (_e) {}
      const t = data.type;

      if (t === "connected" || t === "pong") return;

      if (t === "new_message") {
        const m = data.message || {};
        const myId = state.me && state.me.id;
        const myUsername = state.me && state.me.username;
        const isSelf = (myId != null && m.sender_id === myId) || m.sender_username === myUsername;
        const friendKey = isSelf ? m.recipient_username : m.sender_username;

        // Is this for the currently active DM conversation?
        const isActiveConversation = state.activeType === "friend" && state.activeFriend === friendKey;

        if (isActiveConversation) {
          await pullLatestIntoActiveConversation();
        } else if (friendKey) {
          // Not viewing this conversation — increment unread and update preview
          // without re-fetching the whole conversation.
          try {
            const direction = isSelf ? "outgoing" : "incoming";
            let text = "";
            try { text = await decryptDirectPayload(m.payload, direction); } catch (_e) { text = ""; }
            const content = parseMessageContent(text);
            const previewKey = "friend:" + friendKey;
            const existing = state.conversationPreviews.get(previewKey);
            const currentUnread = existing ? existing.unread : 0;
            state.conversationPreviews.set(previewKey, {
              text: previewTextFromContent(content),
              timestamp: m.created_at || 0,
              unread: currentUnread + 1,
            });
            scheduleConversationListRender();
          } catch (_e) {
            await updateSinglePreview("friend", friendKey, true);
          }
        }

        if (!isSelf && !isActiveConversation) {
          playNotificationSound();
          showBrowserNotification(m.sender_username || "Message", "New message");
        }
      }

      if (t === "direct_message_deleted") {
        const sender = data.sender_username;
        const recipient = data.recipient_username;
        const myUsername = state.me && state.me.username;
        if (!sender || !recipient || !myUsername) return;
        const friendKey = sender === myUsername ? recipient : sender;
        const isActiveConversation = state.activeType === "friend" && state.activeFriend === friendKey;
        if (isActiveConversation) {
          await refreshActiveConversation();
        } else if (friendKey) {
          await updateSinglePreview("friend", friendKey, false);
        }
      }

      if (t === "new_group_message") {
        const m = data.message || {};
        const myId = state.me && state.me.id;
        const myUsername = state.me && state.me.username;
        const isSelf = (myId != null && m.sender_id === myId) || m.sender_username === myUsername;
        const groupId = m.group_id;
        const isActiveConversation = state.activeType === "group" && state.activeGroupId === groupId;

        const isCurrentTopicView = isActiveConversation && (
          state.activeGroupTopic === "all" ||
          String(state.activeGroupTopic) === String(m.topic_id)
        );

        if (isCurrentTopicView) {
          await pullLatestIntoActiveConversation();
        } else if (isActiveConversation && groupId) {
          await updateSinglePreview("group", groupId, false);
        } else if (groupId) {
          await updateSinglePreview("group", groupId, true);
        }

        if (!isSelf && !isActiveConversation) {
          playNotificationSound();
          const group = state.groups.get(groupId);
          const groupName = group ? group.name : "Group";
          showBrowserNotification(groupName, (m.sender_username || "Someone") + ": New message");
        }
      }

      if (t === "friend_request" || t === "friend_request_resolved" || t === "friend_removed") {
        await Promise.all([refreshFriendRequests(), refreshFriends()]);
      }

      if (t === "group_invite") {
        await refreshGroupInvites();
      }

      if (
        t === "group_member_added" ||
        t === "group_invite_resolved" ||
        t === "group_topic_deleted" ||
        t === "group_message_deleted" ||
        t === "group_member_removed" ||
        t === "group_deleted"
      ) {
        await refreshGroups();
        await refreshGroupInvites();
        if (state.activeType === "group" && state.activeGroupId && state.groups.has(state.activeGroupId)) {
          await refreshGroupContext(state.activeGroupId);
          await refreshActiveConversation();
        }
      }

      if (t === "message_like_updated") {
        const msgId = data.message_id;
        const newLikes = data.likes || [];
        const newCount = data.like_count || newLikes.length;
        const targetRow = state.activeRows.find(r => r.id === msgId);
        if (targetRow) {
          targetRow.likes = newLikes;
          targetRow.like_count = newCount;
          updateLikeUI(msgId, newLikes, newCount, data.message_type || "direct");
        }
      }

      if (t === "notification_new") {
        state._notifUnreadCount = (state._notifUnreadCount || 0) + 1;
        updateNotificationBadge();
      }

      if (t === "subscription_update") {
        if (state.me) {
          state.me.subscription_status = data.subscription_status || state.me.subscription_status;
          state.me.subscription_active = typeof data.subscription_active === "boolean"
            ? data.subscription_active : state.me.subscription_active;
          state.me.subscription_charged_through_date = data.charged_through_date || "";
        }
        const level = data.level === "error" ? "error" : data.level === "warn" ? "warn" : "";
        if (data.message) showToast(data.message, level);
        updateBillingStatusBadge();
        if (data.subscription_active === false) {
          handleLogout(false);
          showAuth(true);
          showAuthBillingPrompt(
            data.message || "Your subscription has ended. Please renew to continue.",
            ""
          );
        }
      }
    };
  }

  // === CONVERSATION PREVIEWS ===
  function clearUnread(previewKey) {
    const existing = state.conversationPreviews.get(previewKey);
    if (existing && existing.unread > 0) {
      existing.unread = 0;
      state.conversationPreviews.set(previewKey, existing);
    }
  }

  async function updateSinglePreview(type, key, incrementUnread = false) {
    try {
      const previewKey = type + ":" + key;
      const existing = state.conversationPreviews.get(previewKey);
      const currentUnread = existing ? existing.unread : 0;

      if (type === "friend") {
        const data = await api(`/api/messages/with/${encodeURIComponent(key)}?limit=1`);
        const messages = data.messages || [];
        if (messages.length > 0) {
          const last = messages[messages.length - 1];
          let text = "";
          try { text = await decryptDirectPayload(last.payload, last.direction); } catch (_e) {}
          const content = parseMessageContent(text);
          state.conversationPreviews.set(previewKey, {
            text: previewTextFromContent(content),
            timestamp: last.created_at || 0,
            unread: incrementUnread ? currentUnread + 1 : currentUnread,
          });
        } else {
          state.conversationPreviews.set(previewKey, {
            text: "",
            timestamp: 0,
            unread: incrementUnread ? currentUnread + 1 : currentUnread,
          });
        }
      } else if (type === "group") {
        const data = await api(`/api/groups/${key}/messages?limit=1`);
        const messages = data.messages || [];
        if (messages.length > 0) {
          const last = messages[messages.length - 1];
          let text = "";
          try { text = await decryptGroupPayload(last.payload); } catch (_e) {}
          const content = parseMessageContent(text);
          state.conversationPreviews.set(previewKey, {
            text: previewTextFromContent(content),
            timestamp: last.created_at || 0,
            unread: incrementUnread ? currentUnread + 1 : currentUnread,
          });
        } else {
          state.conversationPreviews.set(previewKey, {
            text: "",
            timestamp: 0,
            unread: incrementUnread ? currentUnread + 1 : currentUnread,
          });
        }
      }
      scheduleConversationListRender();
    } catch (_e) { /* best effort */ }
  }

  async function refreshConversationPreviews() {
    // Load previews for all conversations in parallel (called once at login)
    try {
      const tasks = [];
      for (const f of state.friends.values()) {
        tasks.push(updateSinglePreview("friend", f.username));
      }
      for (const g of state.groups.values()) {
        tasks.push(updateSinglePreview("group", g.id));
      }
      await Promise.allSettled(tasks);
    } catch (_e) { /* best effort */ }
  }

  // === COMPOSER ===
  function autoResizeComposer() {
    const el = $("composer");
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function composerToHighlightedHtml(text) {
    const escaped = escapeHtml(text || "");
    return escaped.replace(
      /(^|\s)@([a-z0-9_-]{3,32})/gi,
      (match, prefix, username) => {
        const normalized = String(username || "").toLowerCase();
        if (normalized === "everyone") {
          return `${prefix}<span class="mention mention-everyone" style="color:#f5a623;font-weight:700">@${username}</span>`;
        }
        const color = avatarColor(normalized);
        return `${prefix}<span class="mention" style="color:${color}">@${username}</span>`;
      }
    );
  }

  function syncComposerOverlayScroll() {
    const el = $("composer");
    const inner = $("composerOverlayInner");
    if (!el || !inner) return;
    inner.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
  }

  function updateComposerOverlay() {
    const el = $("composer");
    const inner = $("composerOverlayInner");
    if (!el || !inner) return;
    // Add a trailing newline so the overlay height matches textarea behavior,
    // especially when the last line is empty.
    inner.innerHTML = composerToHighlightedHtml(el.value) + "\n";
    syncComposerOverlayScroll();
  }

  function getMentionTrigger() {
    const el = $("composer");
    if (!el) return null;
    const caretPos = el.selectionStart;
    if (caretPos == null) return null;
    const before = String(el.value || "").slice(0, caretPos);
    const m = before.match(/(^|\s)@([a-z0-9_-]{0,32})$/i);
    if (!m) return null;
    const rawQuery = String(m[2] || "");
    return {
      query: rawQuery.toLowerCase(),
      atPos: before.length - rawQuery.length - 1,
      caretPos,
    };
  }

  function hideMentionSuggestions() {
    state.mention.open = false;
    state.mention.query = "";
    state.mention.users = [];
    state.mention.activeIndex = 0;
    const box = $("mentionSuggestions");
    if (box) {
      box.classList.add("hidden");
      box.innerHTML = "";
    }
  }

  function renderMentionSuggestions() {
    const box = $("mentionSuggestions");
    if (!box) return;

    const users = state.mention.users || [];
    if (!state.mention.open || users.length === 0) {
      hideMentionSuggestions();
      return;
    }

    box.innerHTML = "";
    box.classList.remove("hidden");

    users.forEach((u, idx) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "suggestion-item" + (idx === state.mention.activeIndex ? " active" : "");

      const name = document.createElement("span");
      name.className = "mention-suggestion-username";
      if (u.isEveryone) {
        name.style.color = "#f5a623";
        name.style.fontWeight = "700";
        name.textContent = "@everyone — notify all members";
      } else {
        name.style.color = avatarColor(u.username);
        name.textContent = "@" + u.username;
      }

      item.appendChild(name);
      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        insertMention(u.username);
      });
      box.appendChild(item);
    });
  }

  async function getMentionCandidates(query, limit = 12) {
    const q = String(query || "").toLowerCase();

    // Prefer group members when composing inside a group.
    if (state.activeType === "group" && state.activeGroupId) {
      const members = state.groupMembers.get(state.activeGroupId);
      if (members && members.size) {
        const out = [];
        // Add @everyone for group owners, group admins, and site admins
        const group = state.groups.get(state.activeGroupId);
        const myRole = group ? group.role : "";
        const isSiteAdmin = Boolean(state.me && state.me.is_admin);
        const isGlobalFeed = Boolean(group && group.is_global_feed);
        const canTagEveryone = isGlobalFeed || myRole === "owner" || myRole === "admin" || isSiteAdmin;
        if (canTagEveryone && (!q || "everyone".startsWith(q) || "everyone".includes(q))) {
          out.push({ username: "everyone", isEveryone: true });
        }
        for (const [username] of members) {
          if (state.me && username === state.me.username) continue;
          if (!q || username.startsWith(q) || username.includes(q)) {
            out.push({ username });
          }
        }
        out.sort((a, b) => {
          if (a.isEveryone) return -1;
          if (b.isEveryone) return 1;
          return a.username.localeCompare(b.username);
        });
        return out.slice(0, limit);
      }
    }

    // In DMs, prefer your active friend first, then other friends.
    if (state.activeType === "friend" && state.activeFriend) {
      const out = [];
      const friend = String(state.activeFriend);
      if (!q || friend.startsWith(q) || friend.includes(q)) {
        out.push({ username: friend });
      }
      for (const f of state.friends.values()) {
        if (f.username === friend) continue;
        if (!q || f.username.startsWith(q) || f.username.includes(q)) {
          out.push({ username: f.username });
        }
      }
      out.sort((a, b) => a.username.localeCompare(b.username));
      return out.slice(0, limit);
    }

    // Fallback to global user search (requires public key).
    const users = await queryUsersForAutocomplete(q, limit);
    return (users || []).map((u) => ({ username: u.username }));
  }

  async function refreshMentionSuggestions() {
    const trigger = getMentionTrigger();
    if (!trigger) {
      hideMentionSuggestions();
      return;
    }

    state.mention.open = true;
    state.mention.query = trigger.query;
    state.mention.atPos = trigger.atPos;
    state.mention.caretPos = trigger.caretPos;

    if (mentionTimer) clearTimeout(mentionTimer);
    mentionTimer = setTimeout(async () => {
      try {
        const users = await getMentionCandidates(state.mention.query, 12);
        // Trigger may have changed while awaiting.
        const latest = getMentionTrigger();
        if (!latest || latest.query !== state.mention.query || latest.atPos !== state.mention.atPos) {
          return;
        }
        state.mention.users = users;
        state.mention.activeIndex = 0;
        renderMentionSuggestions();
      } catch (_e) {
        hideMentionSuggestions();
      }
    }, 180);
  }

  function insertMention(username) {
    const el = $("composer");
    if (!el) return;

    const trigger = getMentionTrigger();
    const insert = "@" + String(username || "").toLowerCase() + " ";

    if (trigger) {
      el.setRangeText(insert, trigger.atPos, trigger.caretPos, "end");
    } else {
      const pos = el.selectionStart != null ? el.selectionStart : String(el.value || "").length;
      el.setRangeText(insert, pos, pos, "end");
    }

    hideMentionSuggestions();
    updateComposerOverlay();
    autoResizeComposer();
    el.focus();
  }

  function handleComposerInput() {
    autoResizeComposer();
    updateComposerOverlay();
    refreshMentionSuggestions();
  }

  // === NOTIFICATIONS ===
  function playNotificationSound() {
    if (!state.notificationSoundEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (_e) { /* Audio not available */ }
  }

  async function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      subscribeToPush().catch(() => {});
      return;
    }
    if (Notification.permission === "denied") return;
    // iOS requires a user gesture to trigger the permission prompt.
    // Show a banner the user can tap instead of calling requestPermission() directly.
    showNotificationBanner();
  }

  function showNotificationBanner() {
    if (document.getElementById("pushBanner")) return;
    const banner = document.createElement("div");
    banner.id = "pushBanner";
    banner.className = "push-banner";
    banner.innerHTML =
      '<span>Enable push notifications to get alerts when the app is closed.</span>' +
      '<button id="pushBannerAllow" class="push-banner-btn">Enable</button>' +
      '<button id="pushBannerDismiss" class="push-banner-dismiss">&times;</button>';
    document.getElementById("appSection").prepend(banner);
    document.getElementById("pushBannerAllow").addEventListener("click", async () => {
      const result = await Notification.requestPermission().catch(() => "denied");
      banner.remove();
      if (result === "granted") {
        subscribeToPush().catch(() => {});
        showToast("Notifications enabled!");
      }
    });
    document.getElementById("pushBannerDismiss").addEventListener("click", () => {
      banner.remove();
    });
  }

  function showBrowserNotification(title, body) {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (document.hasFocus()) return;
    try {
      new Notification("Nutshell's BlackEnvelope - " + title, { body });
    } catch (_e) {}
  }

  function urlB64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function subscribeToPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (Notification.permission !== "granted") return;

    try {
      const reg = await navigator.serviceWorker.ready;
      const keyData = await api("/api/push/public-key");
      const vapidPublicKey = keyData.public_key;
      if (!vapidPublicKey) return;

      const keyBytes = urlB64ToUint8Array(vapidPublicKey);
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes,
        });
      }

      const json = sub.toJSON();
      await api("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify({
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
        }),
      });
      state.pushSubscription = sub;
    } catch (_e) {
      // Push is an enhancement, not a requirement
    }
  }

  // === PROFILE & SETTINGS MODALS ===

  function formatJoinDate(ts) {
    if (!ts) return "";
    return "Joined " + new Date(ts * 1000).toLocaleDateString([], { month: "long", year: "numeric" });
  }

  function _renderProfileHeader(body, data, isOwn) {
    const header = document.createElement("div");
    header.className = "profile-modal-header";

    const avatarWrap = document.createElement("div");
    avatarWrap.style.position = "relative";
    const av = createAvatarEl(data.username, "lg", data.avatar_b64);
    avatarWrap.appendChild(av);

    if (isOwn) {
      const camBtn = document.createElement("button");
      camBtn.className = "change-avatar-btn";
      camBtn.title = "Change photo";
      camBtn.innerHTML = "&#128247;";
      camBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        $("avatarInput").value = "";
        $("avatarInput").click();
      });
      avatarWrap.appendChild(camBtn);
    }
    header.appendChild(avatarWrap);

    const username = document.createElement("div");
    username.className = "profile-modal-username";
    username.textContent = "@" + data.username;
    header.appendChild(username);

    if (data.display_name) {
      const dn = document.createElement("div");
      dn.className = "profile-modal-displayname";
      dn.textContent = data.display_name;
      header.appendChild(dn);
    }

    if (data.status) {
      const st = document.createElement("div");
      st.className = "profile-modal-status";
      st.textContent = data.status;
      header.appendChild(st);
    }

    body.appendChild(header);
  }

  function _renderProfileDetails(body, data) {
    if (data.bio) {
      const bioEl = document.createElement("div");
      bioEl.className = "profile-modal-bio modal-section";
      bioEl.textContent = data.bio;
      body.appendChild(bioEl);
    }

    const meta = document.createElement("div");
    meta.className = "profile-modal-meta modal-section";

    if (data.location) {
      const row = document.createElement("div");
      row.className = "profile-modal-meta-row";
      row.innerHTML = '<span style="font-size:14px">&#128205;</span> ' + escapeHtml(data.location);
      meta.appendChild(row);
    }

    if (data.link) {
      const row = document.createElement("div");
      row.className = "profile-modal-meta-row";
      const linkEl = document.createElement("a");
      linkEl.href = data.link.startsWith("http") ? data.link : "https://" + data.link;
      linkEl.target = "_blank";
      linkEl.rel = "noopener noreferrer";
      linkEl.textContent = data.link.replace(/^https?:\/\//, "");
      row.innerHTML = '<span style="font-size:14px">&#128279;</span> ';
      row.appendChild(linkEl);
      meta.appendChild(row);
    }

    if (data.created_at) {
      const row = document.createElement("div");
      row.className = "profile-modal-meta-row";
      row.innerHTML = '<span style="font-size:14px">&#128197;</span> ' + escapeHtml(formatJoinDate(data.created_at));
      meta.appendChild(row);
    }

    if (meta.children.length) body.appendChild(meta);
  }

  function _renderKeyManagement(body) {
    const section = document.createElement("div");
    section.className = "profile-key-section modal-section";

    const label = document.createElement("div");
    label.className = "profile-key-section-label";
    label.textContent = "Key Management";
    section.appendChild(label);

    // Backup status indicator
    const indicator = document.createElement("div");
    indicator.className = "key-backup-indicator";
    const dot = document.createElement("span");
    dot.className = "key-backup-dot " + (state.me.has_key_backup ? "backed-up" : "not-backed-up");
    indicator.appendChild(dot);
    const statusText = document.createElement("span");
    statusText.textContent = state.me.has_key_backup ? "Key backed up" : "Key not backed up";
    statusText.style.color = state.me.has_key_backup ? "var(--success)" : "var(--danger)";
    indicator.appendChild(statusText);
    section.appendChild(indicator);

    function addKeyBtn(text, icon, handler, isDanger) {
      const btn = document.createElement("button");
      btn.className = "profile-key-btn" + (isDanger ? " danger" : "");
      btn.innerHTML = '<span style="font-size:16px">' + icon + "</span> " + escapeHtml(text);
      btn.addEventListener("click", handler);
      section.appendChild(btn);
    }

    addKeyBtn("Backup Key to Server", "&#11014;&#65039;", () => {
      hideModal();
      syncEncryptedKeyBackup()
        .then(() => refreshKeyBackupStatus())
        .catch((e) => showToast("Backup failed: " + e.message, "error"));
    });

    addKeyBtn("Restore Key from Server", "&#11015;&#65039;", () => {
      hideModal();
      restoreSyncedEncryptedKeyBackup()
        .then(() => refreshKeyBackupStatus())
        .catch((e) => showToast("Restore failed: " + e.message, "error"));
    });

    // Advanced toggle
    const advToggle = document.createElement("button");
    advToggle.className = "profile-key-btn";
    advToggle.innerHTML = '<span style="font-size:16px">&#9881;</span> Advanced Key Options <span class="settings-chevron" style="margin-left:auto">&#9662;</span>';
    const advSection = document.createElement("div");
    advSection.className = "hidden";
    advToggle.addEventListener("click", () => {
      advSection.classList.toggle("hidden");
    });
    section.appendChild(advToggle);

    const advInner = document.createElement("div");
    advInner.style.cssText = "display:flex;flex-direction:column;gap:4px;padding-left:8px;";

    function addAdvBtn(text, icon, handler, isDanger) {
      const btn = document.createElement("button");
      btn.className = "profile-key-btn" + (isDanger ? " danger" : "");
      btn.innerHTML = '<span style="font-size:16px">' + icon + "</span> " + escapeHtml(text);
      btn.addEventListener("click", handler);
      advInner.appendChild(btn);
    }

    addAdvBtn("Copy Public Key", "&#128203;", () => {
      hideModal();
      copyPublicKey().catch((e) => showToast("Copy failed: " + e.message, "error"));
    });
    addAdvBtn("Export Key (JSON)", "&#128190;", () => {
      hideModal();
      exportKeyBackup().catch((e) => showToast("Export failed: " + e.message, "error"));
    });
    addAdvBtn("Import Key (JSON)", "&#128228;", () => {
      hideModal();
      const picker = $("importKeyFile");
      picker.value = "";
      picker.click();
    });
    addAdvBtn("Generate New Key (Reset)", "&#128257;", () => {
      hideModal();
      showRegenerateKeyModal();
    }, true);
    addAdvBtn("Delete Server Backup", "&#128465;", () => {
      hideModal();
      deleteSyncedEncryptedKeyBackup()
        .then(() => refreshKeyBackupStatus())
        .catch((e) => showToast("Delete failed: " + e.message, "error"));
    }, true);

    advSection.appendChild(advInner);
    section.appendChild(advSection);
    body.appendChild(section);
  }

  async function showProfileModal(username) {
    const isOwn = username === (state.me && state.me.username);

    if (isOwn) {
      showModal("My Profile", (body) => {
        _renderProfileHeader(body, state.me, true);

        // Key backup indicator in header area
        const keyStatus = document.createElement("div");
        keyStatus.className = "key-backup-indicator";
        keyStatus.style.justifyContent = "center";
        const dot = document.createElement("span");
        dot.className = "key-backup-dot " + (state.me.has_key_backup ? "backed-up" : "not-backed-up");
        keyStatus.appendChild(dot);
        const statusText = document.createElement("span");
        statusText.textContent = state.me.has_key_backup ? "Key backed up" : "Key not backed up";
        statusText.style.color = state.me.has_key_backup ? "var(--success)" : "var(--danger)";
        statusText.style.fontSize = "12px";
        keyStatus.appendChild(statusText);
        body.appendChild(keyStatus);

        _renderProfileDetails(body, state.me);

        // Action buttons
        const actions = document.createElement("div");
        actions.className = "profile-modal-actions modal-section";

        const editBtn = document.createElement("button");
        editBtn.className = "primary-btn";
        editBtn.textContent = "Edit Profile";
        editBtn.addEventListener("click", () => { hideModal(); showEditProfileModal(); });
        actions.appendChild(editBtn);

        const usernameBtn = document.createElement("button");
        usernameBtn.textContent = "Change Username";
        usernameBtn.addEventListener("click", () => { hideModal(); showChangeUsernameModal(); });
        actions.appendChild(usernameBtn);

        body.appendChild(actions);

        _renderKeyManagement(body);
      });
    } else {
      // Other user — show loading, then fetch
      showModal("Profile", (body) => {
        body.innerHTML = '<div class="profile-loading">Loading...</div>';
      });
      try {
        const data = await api(`/api/users/${encodeURIComponent(username)}/profile`);
        showModal("@" + data.username, (body) => {
          _renderProfileHeader(body, data, false);
          _renderProfileDetails(body, data);

          // Action buttons
          const actions = document.createElement("div");
          actions.className = "profile-modal-actions modal-section";

          if (data.is_friend) {
            const msgBtn = document.createElement("button");
            msgBtn.className = "primary-btn";
            msgBtn.textContent = "Send Message";
            msgBtn.addEventListener("click", () => {
              hideModal();
              selectActiveFriend(data.username);
            });
            actions.appendChild(msgBtn);
          } else if (data.has_pending_request) {
            const pendingBtn = document.createElement("button");
            pendingBtn.className = "primary-btn";
            pendingBtn.textContent = "Request Sent";
            pendingBtn.disabled = true;
            actions.appendChild(pendingBtn);
          } else {
            const addBtn = document.createElement("button");
            addBtn.className = "primary-btn";
            addBtn.textContent = "Add Friend";
            addBtn.addEventListener("click", async () => {
              try {
                await sendFriendRequest(data.username);
                addBtn.textContent = "Request Sent";
                addBtn.disabled = true;
              } catch (e) {
                showToast("Failed: " + e.message, "error");
              }
            });
            actions.appendChild(addBtn);
          }

          body.appendChild(actions);
        });
      } catch (e) {
        showModal("Profile", (body) => {
          body.textContent = "Could not load profile: " + e.message;
        });
      }
    }
  }

  function showEditProfileModal() {
    showModal("Edit Profile", (container) => {
      const form = document.createElement("div");
      form.className = "profile-edit-form";

      function addField(labelText, placeholder, value, maxLen, type) {
        const label = document.createElement("label");
        label.textContent = labelText;
        form.appendChild(label);
        if (type === "textarea") {
          const ta = document.createElement("textarea");
          ta.placeholder = placeholder;
          ta.value = value;
          ta.maxLength = maxLen;
          ta.rows = 3;
          ta.style.cssText = "width:100%;resize:vertical;font-family:inherit;font-size:inherit;";
          form.appendChild(ta);
          return ta;
        }
        const input = document.createElement("input");
        input.placeholder = placeholder;
        input.value = value;
        input.maxLength = maxLen;
        form.appendChild(input);
        return input;
      }

      const displayNameInput = addField("Display Name", "Display name (optional)", (state.me && state.me.display_name) || "", 32);
      const statusInput = addField("Status", "What's on your mind?", (state.me && state.me.status) || "", 100);
      const bioInput = addField("Bio", "Tell people about yourself", (state.me && state.me.bio) || "", 500, "textarea");
      const locationInput = addField("Location", "City, Country", (state.me && state.me.location) || "", 100);
      const linkInput = addField("Link", "https://example.com", (state.me && state.me.link) || "", 200);

      const btn = document.createElement("button");
      btn.className = "primary-btn";
      btn.textContent = "Save";
      btn.addEventListener("click", async () => {
        try {
          const result = await api("/api/me/profile", {
            method: "PUT",
            body: JSON.stringify({
              display_name: displayNameInput.value.trim(),
              status: statusInput.value.trim(),
              bio: bioInput.value.trim(),
              location: locationInput.value.trim(),
              link: linkInput.value.trim(),
            }),
          });
          state.me.display_name = result.display_name;
          state.me.bio = result.bio;
          state.me.location = result.location;
          state.me.link = result.link;
          state.me.status = result.status;
          updateSettingsProfile();
          hideModal();
          showToast("Profile updated.");
        } catch (e) {
          showToast("Update failed: " + e.message, "error");
        }
      });
      form.appendChild(btn);
      container.appendChild(form);
    });
  }

  function showChangeUsernameModal() {
    showModal("Change Username", (container) => {
      const form = document.createElement("div");
      form.className = "profile-edit-form";

      const label1 = document.createElement("label");
      label1.textContent = "New Username";
      form.appendChild(label1);

      const usernameInput = document.createElement("input");
      usernameInput.placeholder = "New username (3-32 chars)";
      usernameInput.value = "";
      usernameInput.maxLength = 32;
      form.appendChild(usernameInput);

      const label2 = document.createElement("label");
      label2.textContent = "Current Password (required)";
      form.appendChild(label2);

      const passwordInput = document.createElement("input");
      passwordInput.type = "password";
      passwordInput.placeholder = "Enter current password";
      form.appendChild(passwordInput);

      const btn = document.createElement("button");
      btn.className = "primary-btn";
      btn.textContent = "Change Username";
      btn.addEventListener("click", async () => {
        try {
          const result = await api("/api/me/username", {
            method: "PUT",
            body: JSON.stringify({
              new_username: usernameInput.value.trim(),
              current_password: passwordInput.value,
            }),
          });
          // Update local state with new username
          const oldUsername = state.me.username;
          state.me.username = result.username;
          // Update localStorage key storage key
          const oldKey = "blackenvelope:keypair:" + oldUsername;
          const newKey = "blackenvelope:keypair:" + result.username;
          const keypairData = localStorage.getItem(oldKey);
          if (keypairData) {
            localStorage.setItem(newKey, keypairData);
            localStorage.removeItem(oldKey);
          }
          persistSession();
          updateSettingsProfile();
          hideModal();
          showToast("Username changed to @" + result.username);
          // Refresh everything to update references
          await Promise.all([refreshFriends(), refreshGroups()]);
          renderConversationList();
        } catch (e) {
          showToast("Change failed: " + e.message, "error");
        }
      });
      form.appendChild(btn);
      container.appendChild(form);
    });
  }

  async function handleAvatarUpload(file) {
    if (!file) return;
    if (file.size > 200 * 1024) {
      showToast("Image must be under 200KB.", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUri = reader.result;
        const result = await api("/api/me/profile", {
          method: "PUT",
          body: JSON.stringify({ avatar_b64: dataUri }),
        });
        state.me.avatar_b64 = result.avatar_b64;
        updateSettingsProfile();
        showToast("Profile picture updated.");
      } catch (e) {
        showToast("Upload failed: " + e.message, "error");
      }
    };
    reader.readAsDataURL(file);
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  async function loadStorageBrief() {
    try {
      const data = await api("/api/me/storage");
      const brief = $("storageUsageBrief");
      if (brief) {
        brief.textContent = formatBytes(data.total_bytes) + " / " + formatBytes(data.limit_bytes);
      }
    } catch (_e) {}
  }

  function updateBillingStatusBadge() {
    if (!state.me) return;
    const statusEl = $("subscriptionStatusShort");
    const section = $("subscriptionSettingsSection");
    if (!statusEl || !section) return;

    const status = state.me.subscription_status;
    const active = state.me.subscription_active;

    if (!status || status === "NONE" || state.me.subscription_exempt || state.me.is_admin) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");

    if (!active) {
      statusEl.textContent = "Expired";
      statusEl.style.color = "var(--danger)";
    } else if (status === "CANCELED") {
      statusEl.textContent = "Canceling";
      statusEl.style.color = "#ffd98c";
    } else if (status === "ACTIVE" || status === "PENDING") {
      statusEl.textContent = "Active";
      statusEl.style.color = "var(--muted)";
    } else {
      statusEl.textContent = "Issues";
      statusEl.style.color = "#ffd98c";
    }
  }

  function showSubscriptionModal() {
    toggleSettings(false);
    showModal("Subscription", async (container) => {
      container.innerHTML = '<div style="color:var(--muted);padding:12px;">Loading...</div>';
      try {
        const data = await api("/api/billing/status");
        container.innerHTML = "";

        if (!data.billing_enabled) {
          container.innerHTML = '<div style="color:var(--muted);padding:12px;">Billing is not configured.</div>';
          return;
        }

        if (data.is_admin || data.subscription_exempt) {
          const notice = document.createElement("div");
          notice.style.cssText = "color:var(--muted);font-size:13px;padding:12px 0;";
          notice.textContent = "Your account has complimentary access.";
          container.appendChild(notice);
          return;
        }

        const statusSection = document.createElement("div");
        statusSection.style.cssText = "padding:8px 0;";
        const statusLabel = document.createElement("div");
        statusLabel.style.cssText = "font-size:13px;color:var(--muted);line-height:1.5;";

        const status = data.subscription_status;
        const active = data.subscription_active;
        const charged = data.charged_through_date;

        if (status === "ACTIVE" || status === "PENDING") {
          statusLabel.innerHTML = '<strong style="color:#7bc862;">Active</strong>';
          if (charged) statusLabel.innerHTML += " \u2014 next billing date " + charged;
        } else if (status === "CANCELED") {
          statusLabel.innerHTML = '<strong style="color:#ffd98c;">Canceled</strong>';
          if (charged) statusLabel.innerHTML += " \u2014 access until " + charged;
        } else if (!active) {
          statusLabel.innerHTML = '<strong style="color:var(--danger);">Inactive</strong>';
          if (data.grace_end_date) statusLabel.innerHTML += " \u2014 grace period ends " + data.grace_end_date;
        } else {
          statusLabel.innerHTML = '<strong style="color:#ffd98c;">Payment Issue</strong>';
          if (data.grace_end_date) statusLabel.innerHTML += " \u2014 grace period ends " + data.grace_end_date;
        }
        statusSection.appendChild(statusLabel);
        container.appendChild(statusSection);

        if (data.subscription_id && (status === "ACTIVE" || status === "PENDING")) {
          const cancelBtn = document.createElement("button");
          cancelBtn.className = "danger ghost";
          cancelBtn.style.cssText = "margin-top:12px;font-size:13px;";
          cancelBtn.textContent = "Cancel Subscription";
          cancelBtn.addEventListener("click", async () => {
            const endNote = charged ? " Your access will continue until " + charged + "." : "";
            if (!await confirmAsync("Cancel your subscription?" + endNote + "\n\nYou will not be charged again.", { danger: true, okLabel: "Cancel Subscription" })) return;
            try {
              cancelBtn.disabled = true;
              cancelBtn.textContent = "Canceling...";
              const result = await api("/api/billing/cancel", { method: "POST" });
              showToast(result.message || "Subscription canceled.");
              if (state.me) {
                state.me.subscription_status = result.subscription_status || "CANCELED";
                state.me.subscription_charged_through_date = result.charged_through_date || "";
              }
              updateBillingStatusBadge();
              hideModal();
            } catch (e) {
              cancelBtn.disabled = false;
              cancelBtn.textContent = "Cancel Subscription";
              showToast("Cancellation failed: " + e.message, "error");
            }
          });
          container.appendChild(cancelBtn);
        }

        if (!active || status === "CANCELED") {
          const renewBtn = document.createElement("button");
          renewBtn.className = "primary-btn";
          renewBtn.style.cssText = "width:100%;margin-top:12px;";
          renewBtn.textContent = status === "CANCELED" ? "Resubscribe" : "Update Payment Method";
          renewBtn.addEventListener("click", async () => {
            try {
              renewBtn.disabled = true;
              const linkData = await api("/api/billing/checkout-link", { method: "POST" });
              if (linkData.checkout_url) {
                window.location.href = linkData.checkout_url;
              } else {
                showToast("No checkout link available.", "error");
                renewBtn.disabled = false;
              }
            } catch (e) {
              renewBtn.disabled = false;
              showToast("Failed: " + e.message, "error");
            }
          });
          container.appendChild(renewBtn);
        }
      } catch (e) {
        container.innerHTML = '<div style="color:var(--danger);padding:12px;">Failed to load billing info: ' + e.message + '</div>';
      }
    });
  }

  function showStorageModal() {
    showModal("Storage Usage", async (container) => {
      container.innerHTML = '<div style="color:var(--muted);padding:12px;">Loading...</div>';
      try {
        const data = await api("/api/me/storage");
        container.innerHTML = "";

        const pct = Math.min(100, Math.round((data.total_bytes / data.limit_bytes) * 100));
        const barClass = pct >= 90 ? "critical" : pct >= 70 ? "warn" : "";

        const summary = document.createElement("div");
        summary.className = "storage-summary";
        summary.textContent = formatBytes(data.total_bytes) + " of " + formatBytes(data.limit_bytes) + " used (" + pct + "%)";
        container.appendChild(summary);

        const bar = document.createElement("div");
        bar.className = "storage-bar";
        const fill = document.createElement("div");
        fill.className = "storage-bar-fill" + (barClass ? " " + barClass : "");
        fill.style.width = pct + "%";
        bar.appendChild(fill);
        container.appendChild(bar);

        // Conversations breakdown
        const allItems = [
          ...(data.conversations || []).map(c => ({ name: "@" + c.username, bytes: c.bytes, count: c.message_count })),
          ...(data.groups || []).map(g => ({ name: g.name, bytes: g.bytes, count: g.message_count })),
        ].sort((a, b) => b.bytes - a.bytes);

        if (allItems.length > 0) {
          const heading = document.createElement("div");
          heading.style.cssText = "font-size:12px;color:var(--muted);margin:12px 0 4px;";
          heading.textContent = "Breakdown by conversation";
          container.appendChild(heading);

          const list = document.createElement("ul");
          list.className = "storage-breakdown";
          for (const item of allItems) {
            const li = document.createElement("li");
            li.className = "storage-breakdown-item";
            const nameEl = document.createElement("span");
            nameEl.className = "storage-name";
            nameEl.textContent = item.name + " (" + item.count + " msgs)";
            const sizeEl = document.createElement("span");
            sizeEl.className = "storage-size";
            sizeEl.textContent = formatBytes(item.bytes);
            li.appendChild(nameEl);
            li.appendChild(sizeEl);
            list.appendChild(li);
          }
          container.appendChild(list);
        }

        // Update brief
        const brief = $("storageUsageBrief");
        if (brief) {
          brief.textContent = formatBytes(data.total_bytes) + " / " + formatBytes(data.limit_bytes);
        }
      } catch (e) {
        container.innerHTML = '<div style="color:var(--danger);padding:12px;">Failed to load storage data.</div>';
      }
    });
  }

  // Docs modal (user-facing help)
  function showDocsModal(scrollToId) {
    if (typeof toggleSettings === "function") toggleSettings(false);
    showModal("Docs", (body) => {
      const wrap = document.createElement("div");
      wrap.className = "docs";

      const intro = document.createElement("div");
      intro.className = "docs-callout";
      intro.innerHTML = "<strong>Nutshell's BlackEnvelope</strong> is end-to-end encrypted. Your private key stays on your device. The server stores encrypted ciphertext only — not even we can read your messages.";
      wrap.appendChild(intro);

      const addSection = (id, title, items, opts = {}) => {
        const section = document.createElement("div");
        section.className = "docs-section";
        section.id = id;

        const h = document.createElement("h4");
        h.textContent = title;
        section.appendChild(h);

        if (opts.note) {
          const note = document.createElement("div");
          note.className = "docs-note";
          note.textContent = opts.note;
          section.appendChild(note);
        }

        if (opts.html) {
          const div = document.createElement("div");
          div.innerHTML = opts.html;
          section.appendChild(div);
        }

        if (items && items.length) {
          const ul = document.createElement("ul");
          for (const it of items) {
            const li = document.createElement("li");
            if (it.includes("<")) { li.innerHTML = it; } else { li.textContent = it; }
            ul.appendChild(li);
          }
          section.appendChild(ul);
        }
        wrap.appendChild(section);
      };

      const installHost = escapeHtml(window.location.host || window.location.hostname || "this BlackEnvelope site");

      // --- Registration & Login ---
      addSection("docs-registration", "Registration & Login", [
        "Register: choose a username, enter your email, choose a password (12+ characters), and optionally enter a promo code.",
        "Login: use your username + password, or use <strong>Sign in with Google</strong>.",
        "Forgot your password? Use the <strong>Forgot password?</strong> link on the login screen to get a reset link by email.",
        "Promo codes are optional for new signups. A valid <strong>free</strong> promo code skips billing; otherwise normal billing applies.",
        "Your encryption key is generated automatically the first time you log in on a device.",
        "If you log in on a new device, you'll need to restore your key backup to read old messages (see Key Management below).",
      ]);

      // --- Account Recovery ---
      addSection("docs-recovery", "Account Recovery & Email", [
        "Password reset links are sent to your account email and expire after a short time.",
        "If your account does not have an email yet, you'll be asked to add one after login before entering the app.",
        "This email requirement protects account recovery and helps prevent permanent lockouts.",
      ], {
        note: "Keep your email up to date so you can always recover your account."
      });

      // --- Google Sign-In ---
      addSection("docs-google", "Google Sign-In", [
        "Tap <strong>Sign in with Google</strong> on the login screen.",
        "If your Google email matches an existing account email, BlackEnvelope links and signs you in.",
        "For a brand new Google account, you'll choose a username and can optionally enter a promo code.",
        "If you don't see the Google button, Google sign-in is not enabled on this server.",
      ]);

      // --- Phone App Setup ---
      addSection("docs-phone-setup", "Phone App Setup", [
        "<strong>BlackEnvelope works as a phone app.</strong> Add it to your home screen and it runs full-screen like a native app.",
      ], {
        html: '<div class="docs-subsection">' +
          '<h5>iPhone</h5><ol>' +
          '<li>Open <strong>' + installHost + '</strong> in Safari</li>' +
          '<li>Tap the <strong>Share</strong> button (square with arrow at the bottom)</li>' +
          '<li>Tap <strong>Add to Home Screen</strong></li>' +
          '<li>Open the app from the home screen icon (not Safari)</li></ol></div>' +
          '<div class="docs-subsection">' +
          '<h5>Android</h5><ol>' +
          '<li>Open <strong>' + installHost + '</strong> in Chrome</li>' +
          '<li>Tap the <strong>three dots menu</strong> (top right)</li>' +
          '<li>Tap <strong>Install app</strong> or <strong>Add to Home Screen</strong></li></ol></div>'
      });

      // --- Push Notifications ---
      addSection("docs-push", "Push Notifications", [
        "Push notifications alert you when someone sends a message and the app is closed.",
        "When you first log in, a banner appears asking you to enable notifications. Tap <strong>Enable</strong> and then <strong>Allow</strong> on the system prompt.",
        "Notifications only work when the app is opened from the home screen icon (not from the browser).",
      ], {
        html: '<div class="docs-subsection">' +
          '<h5>iPhone — Required One-Time Setting</h5>' +
          '<p>On iPhone you must enable a Safari setting before notifications will work:</p><ol>' +
          '<li>Open <strong>Settings</strong> on your iPhone</li>' +
          '<li>Go to <strong>Safari → Advanced → Feature Flags</strong></li>' +
          '<li>Scroll down and turn <strong>Notifications</strong> ON (green)</li>' +
          '<li>Then open BlackEnvelope from the home screen and tap Enable on the banner</li></ol>' +
          '<div class="docs-img-wrap"><img src="ios-notifications-setting.png" alt="iPhone Feature Flags — Notifications toggle" class="docs-img" /></div>' +
          '<p class="docs-note">This only needs to be done once. After enabling, notifications work automatically.</p></div>' +
          '<div class="docs-subsection">' +
          '<h5>Android</h5>' +
          '<p>Notifications should work automatically. If you missed the prompt, go to your phone\'s Settings → Apps → BlackEnvelope → Notifications and turn them on.</p></div>'
      });

      // --- Navigating the App ---
      addSection("docs-navigation", "Navigating the App", [
        "The left sidebar shows all your conversations — both direct messages and groups.",
        "Use the <strong>Search</strong> bar to find users by @username or filter your conversations.",
        "The <strong>+</strong> button (bottom right) lets you start a New Chat or create a New Group.",
        "The <strong>hamburger menu</strong> (top left ☰) opens Settings with profile, key management, and other options.",
        "The <strong>bell</strong> (top right 🔔) opens your notification center.",
      ]);

      // --- Friends ---
      addSection("docs-friends", "Find Users & Add Friends", [
        "Use the Search box to look up users by @username.",
        "Tap <strong>Add</strong> to send a friend request. Messaging is only allowed after they accept.",
        "The bell icon shows incoming friend requests — tap to accept or decline.",
        "Remove a friend from Settings → Friends & Requests.",
      ]);

      // --- Direct Messages ---
      addSection("docs-dm", "Direct Messages", [
        "Click a friend's conversation in the sidebar to open the chat.",
        "Type your message and press <strong>Send</strong> or hit <strong>Enter</strong> (Shift+Enter for a new line).",
        "Messages update in real time via WebSocket.",
        "All messages are end-to-end encrypted — only you and the recipient can read them.",
      ]);

      // --- Groups & Topics ---
      addSection("docs-groups", "Groups & Topics", [
        "All users are automatically added to <strong>#BlackEnvelope Feed</strong>, an open chat for the whole app.",
        "Create a group: press <strong>+</strong> → New Group.",
        "Groups have <strong>topics</strong> — like separate channels within the group.",
        "Use <strong>All</strong> to view messages from all topics, or select a topic to focus.",
        "Tap the <strong>(i)</strong> button to view members, invite people, create/delete topics, or manage the group.",
        "Any group member can invite new people to the group.",
        "Only the group owner can remove members.",
      ]);

      // --- Likes & View Toggle ---
      addSection("docs-likes", "Likes & View Modes", [
        "Tap the <strong>thumbs-up</strong> on any message to like it. Tap again to unlike.",
        "Liked messages show avatar stacks of who liked them. Tap the avatars to see the full list.",
        "Use the <strong>view toggle bar</strong> (below topics) to switch between:" ,
        "<strong>All</strong> — every message in the conversation.",
        "<strong>Most Relevant</strong> — messages with the most likes.",
        "<strong>My Tags</strong> — messages where you were @mentioned.",
      ]);

      // --- Voice Messages ---
      addSection("docs-voice", "Voice Messages", [
        "Tap the <strong>microphone button</strong> (🎤) next to the text box to start recording.",
        "A recording bar appears with a timer. Tap the <strong>send arrow</strong> to send, or <strong>✕</strong> to cancel.",
        "Maximum recording length is 2 minutes. It auto-sends when the limit is reached.",
        "Voice messages are fully end-to-end encrypted, just like text and files.",
        "Recipients see an audio player in the message bubble and can tap to play.",
      ]);

      // --- Media Attachments ---
      addSection("docs-attachments", "Media & File Attachments", [
        "Tap the <strong>paperclip</strong> (📎) to attach an image, video, audio file, or document.",
        "A preview appears above the text box before you send.",
        "Media files are auto-compressed on your device before encryption when possible.",
        "Attachments are encrypted end-to-end and stored inside the message.",
        "Maximum file size is 10 MB per message.",
      ]);

      // --- Mentions ---
      addSection("docs-mentions", "Mentions (@)", [
        "Type <strong>@</strong> followed by a username to mention someone (e.g. @nick).",
        "A suggestion dropdown appears as you type — tap a name to insert the mention.",
        "The mentioned person gets a notification in their bell and can tap it to jump to the message.",
        "Use the <strong>My Tags</strong> view mode to see all messages where you were mentioned.",
      ]);

      // --- Notification Center ---
      addSection("docs-bell", "Notification Center (Bell)", [
        "The <strong>bell icon</strong> (🔔) in the top bar shows all your activity.",
        "Notifications include: likes on your messages, @mentions, friend requests, and group invites.",
        "The red badge shows how many unread notifications you have.",
        "Tap a notification to jump to that message in the conversation.",
        "Tap <strong>Mark all read</strong> to clear the badge.",
      ]);

      // --- Key Management ---
      addSection("docs-keys", "Key Management (Important)", [
        "Your encryption keypair is generated locally on each device. <strong>If you lose the key, you cannot decrypt old messages.</strong>",
        "Key management is located in your <strong>Profile</strong> — tap your avatar/name in the settings panel to open it.",
        "Your profile shows a <strong>green dot</strong> if your key is backed up, or a <strong>red dot</strong> if it's not. Back up your key as soon as possible.",
        "<strong>Backup Key to Server</strong> — encrypts your key with a passphrase and stores it on the server. <em>Highly recommended.</em>",
        "<strong>Restore Key from Server</strong> — restores your key on a new device using your passphrase.",
        "<strong>Export Key (JSON)</strong> — saves your key as an offline backup file.",
        "<strong>Import Key (JSON)</strong> — restores your key from a backup file.",
        "<strong>Generate New Key (Reset)</strong> — creates a new key and starts fresh. Old messages will show as <em>unable to decrypt</em>.",
        "<strong>Delete Server Backup</strong> — removes the encrypted key backup from the server (does not delete your local key).",
      ]);

      // --- Profiles ---
      addSection("docs-profiles", "Profiles", [
        "Tap your <strong>avatar/name</strong> in the settings panel to open your profile.",
        "Your profile shows your avatar, username, display name, status, bio, location, link, and join date.",
        "<strong>Edit Profile</strong> — update your display name, status, bio, location, and link.",
        "<strong>Change Username</strong> — requires your current password.",
        "<strong>Change Photo</strong> — tap the camera icon on your avatar to upload a new photo.",
        "Tap any <strong>@username</strong> in a conversation to view that person's profile.",
        "From another user's profile you can <strong>Send Message</strong> (if friends) or <strong>Add Friend</strong>.",
      ]);

      // --- Account ---
      addSection("docs-account", "Account", [
        "<strong>Notification Sound</strong> — toggle the in-app message notification sound on or off (in Settings).",
        "<strong>Logout</strong> — signs out of this device. Your local key stays in the browser unless you clear site data.",
        "<strong>Delete Account</strong> — permanently deletes your account and all server-side data. This cannot be undone.",
      ]);

      // --- Storage ---
      addSection("docs-storage", "Storage Usage", [
        "Settings → Storage Usage shows how much encrypted message data you have stored.",
        "There is a per-user storage limit. The server may delete your oldest sent messages if you exceed it.",
      ]);

      // --- Troubleshooting ---
      const trouble = document.createElement("div");
      trouble.className = "docs-callout danger";
      trouble.id = "docs-troubleshooting";
      trouble.innerHTML =
        "<strong>Troubleshooting</strong><br/><br/>" +
        "<strong>\"Unable to decrypt\" messages:</strong> You are missing the correct key. Open your Profile and use Restore Key from Server, or import your exported key JSON file.<br/><br/>" +
        "<strong>App won't load or feels stuck:</strong> Try a hard refresh — on desktop press Ctrl+Shift+R (Cmd+Shift+R on Mac). On your phone, close the app completely and reopen it.<br/><br/>" +
        "<strong>Notifications not working on iPhone:</strong> Make sure you turned on the Notifications feature flag (Settings → Safari → Advanced → Feature Flags → Notifications). The app must also be opened from the home screen icon, not Safari.<br/><br/>" +
        "<strong>Voice recording not working:</strong> Make sure you allowed microphone access when prompted. On iPhone, check Settings → Safari → Microphone.";
      wrap.appendChild(trouble);

      body.appendChild(wrap);

      if (scrollToId) {
        setTimeout(() => {
          const el = document.getElementById(scrollToId);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 100);
      }
    });
  }

  function showLoginDocsModal() {
    showModal("Help", (body) => {
      const wrap = document.createElement("div");
      wrap.className = "docs";

      const intro = document.createElement("div");
      intro.className = "docs-callout";
      intro.innerHTML = "<strong>Nutshell's BlackEnvelope</strong> — encrypted messages and groups for paid Nutshell members.";
      wrap.appendChild(intro);

      if (isNutshellSsoEnabled()) {
        const launchUrl = state.publicConfig && typeof state.publicConfig.nutshell_launch_url === "string"
          ? state.publicConfig.nutshell_launch_url
          : "http://127.0.0.1:3000/black_envelope";
        const homeUrl = state.publicConfig && typeof state.publicConfig.nutshell_public_url === "string"
          ? state.publicConfig.nutshell_public_url
          : "http://127.0.0.1:3000";

        const access = document.createElement("div");
        access.className = "docs-section";
        access.innerHTML =
          "<h4>How access works</h4>" +
          "<p>Nutshell's BlackEnvelope is part of Nutshell. You do not create a separate BlackEnvelope account anymore.</p>" +
          "<ul>" +
          "<li>Sign in through Nutshell first.</li>" +
          "<li>Paid Nutshell members get a BlackEnvelope account automatically.</li>" +
          "<li>If you open the BlackEnvelope URL directly, use the Continue from Nutshell button to come back through the main app.</li>" +
          "</ul>" +
          `<p><a href="${escapeHtml(launchUrl)}" target="_self">Continue from Nutshell</a> or <a href="${escapeHtml(homeUrl)}" target="_self">go to Nutshell</a>.</p>`;
        wrap.appendChild(access);
        body.appendChild(wrap);
        return;
      }

      const addSection = (title, items, opts = {}) => {
        const section = document.createElement("div");
        section.className = "docs-section";
        const h = document.createElement("h4");
        h.textContent = title;
        section.appendChild(h);
        if (opts.html) {
          const div = document.createElement("div");
          div.innerHTML = opts.html;
          section.appendChild(div);
        }
        if (items && items.length) {
          const ul = document.createElement("ul");
          for (const it of items) {
            const li = document.createElement("li");
            if (it.includes("<")) { li.innerHTML = it; } else { li.textContent = it; }
            ul.appendChild(li);
          }
          section.appendChild(ul);
        }
        wrap.appendChild(section);
      };

      const installHost = escapeHtml(window.location.host || window.location.hostname || "this BlackEnvelope site");

      addSection("How to Register", [
        "Tap the <strong>Register</strong> tab above.",
        "Choose a <strong>username</strong> — this is how other users will find you.",
        "Enter your <strong>email</strong> — used for password recovery.",
        "Choose a <strong>password</strong> — must be at least 12 characters.",
        "Optionally enter a <strong>Promo Code</strong>.",
        "Tap <strong>Create Account</strong>.",
      ], {
        html: '<p class="docs-note">Promo codes are optional. A valid free promo code skips billing; otherwise normal billing flow applies.</p>'
      });

      addSection("How to Login", [
        "Tap the <strong>Login</strong> tab above.",
        "Enter the <strong>username</strong> and <strong>password</strong> you registered with, then tap <strong>Login</strong>.",
        "Or tap <strong>Sign in with Google</strong>.",
      ]);

      addSection("Forgot Password (Email Reset)", [
        "Tap <strong>Forgot password?</strong> on the login screen.",
        "Enter your account email and tap <strong>Send Reset Link</strong>.",
        "Open the email, tap the reset link, and set a new password.",
        "Reset links expire, so use the newest email if you request more than one.",
      ]);

      addSection("Google Sign-In", [
        "If your Google email matches an existing account email, you'll be signed into that account.",
        "If it's your first time with Google, you'll choose a username and can optionally enter a promo code.",
        "If the Google button is missing, Google sign-in is not enabled on this server.",
      ]);

      addSection("Accounts Missing Email (Legacy Users)", [
        "Some older accounts were created without an email.",
        "Those users are now prompted to add an email before they can enter the app.",
        "This enables password reset and prevents account lockout.",
      ]);

      addSection("Logging In on a New Device", [
        "Your encryption key is stored locally in your browser. When you log in on a new device, your old messages may show as <em>unable to decrypt</em>.",
        "To fix this, open your <strong>Profile</strong> (tap your avatar in Settings) → <strong>Restore Key from Server</strong> and enter the passphrase you used when you backed up your key.",
        "If you never backed up your key, you won't be able to read old messages on the new device — but new messages going forward will work fine.",
      ]);

      addSection("Phone App Setup", null, {
        html: '<p>BlackEnvelope can be added to your phone\'s home screen and works like a regular app.</p>' +
          '<div class="docs-subsection"><h5>iPhone</h5><ol>' +
          '<li>Open <strong>' + installHost + '</strong> in Safari</li>' +
          '<li>Tap the <strong>Share</strong> button (square with arrow)</li>' +
          '<li>Tap <strong>Add to Home Screen</strong></li></ol></div>' +
          '<div class="docs-subsection"><h5>Android</h5><ol>' +
          '<li>Open <strong>' + installHost + '</strong> in Chrome</li>' +
          '<li>Tap the <strong>three dots</strong> menu → <strong>Install app</strong></li></ol></div>'
      });

      const trouble = document.createElement("div");
      trouble.className = "docs-callout danger";
      trouble.innerHTML = "<strong>Need help?</strong><br/>If you're blocked at login, first check your username/password (or use Forgot password). If you just paid, wait a moment and try again with the same account you paid with. If you're asked to add an email, complete that step to continue.";
      wrap.appendChild(trouble);

      body.appendChild(wrap);
    });
  }

  function setAdminUsersPageVisible(open) {
    const page = $("adminUsersPage");
    if (!page) return;
    page.classList.toggle("hidden", !open);
    page.classList.toggle("open", open);
    state.adminUsersPageOpen = open;
  }

  function renderAdminUsersPageLoading() {
    const body = $("adminUsersPageBody");
    if (!body) return;
    body.innerHTML = '<div class="admin-users-page-state">Loading users...</div>';
  }

  function renderAdminUsersPageError(message) {
    const body = $("adminUsersPageBody");
    if (!body) return;
    body.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "admin-users-page-state error";
    msg.textContent = message || "Failed to load users.";
    body.appendChild(msg);
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "alt";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => {
      loadAdminUsersPage().catch(() => {});
    });
    body.appendChild(retryBtn);
  }

  function renderAdminUsersPageList(users) {
    const body = $("adminUsersPageBody");
    if (!body) return;
    body.innerHTML = "";

    const summary = document.createElement("div");
    summary.className = "admin-users-page-summary";
    summary.textContent = `${users.length} user${users.length === 1 ? "" : "s"} total`;
    body.appendChild(summary);

    const list = document.createElement("div");
    list.className = "member-list admin-users-page-list";

    for (const user of users) {
      const item = document.createElement("div");
      item.className = "member-item";

      const avatar = createAvatarEl(user.username, "sm");
      const name = document.createElement("span");
      name.className = "member-name";
      const labels = [];
      if (user.is_admin) labels.push("admin");
      if (user.subscription_exempt) labels.push("grandfathered");
      if (user.username === state.me.username) labels.push("you");
      name.textContent = "@" + user.username + (labels.length ? ` (${labels.join(", ")})` : "");

      const actions = document.createElement("div");
      actions.className = "admin-users-actions";

      const exemptBtn = document.createElement("button");
      exemptBtn.type = "button";
      exemptBtn.className = "ghost admin-users-action-btn";
      exemptBtn.textContent = user.subscription_exempt ? "Revoke Free" : "Grant Free";
      if (user.is_admin) {
        exemptBtn.disabled = true;
        exemptBtn.style.opacity = "0.5";
      }
      exemptBtn.addEventListener("click", async () => {
        const newValue = !user.subscription_exempt;
        const action = newValue ? "grant free access to" : "revoke free access from";
        if (!await confirmAsync(`${action} @${user.username}?`)) return;
        try {
          await api(`/api/admin/users/${encodeURIComponent(user.username)}/exempt`, {
            method: "PATCH",
            body: JSON.stringify({ subscription_exempt: newValue }),
          });
          showToast(newValue ? `Granted free access to @${user.username}.` : `Revoked free access from @${user.username}.`);
          loadAdminUsersPage().catch(() => {});
        } catch (e) {
          showToast("Update failed: " + e.message, "error");
        }
      });

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "danger ghost admin-users-action-btn";
      removeBtn.textContent = "Remove";
      const cantRemove = user.username === state.me.username || user.is_admin;
      removeBtn.disabled = cantRemove;
      if (cantRemove) removeBtn.style.opacity = "0.5";
      removeBtn.addEventListener("click", async () => {
        if (!await confirmAsync(`Remove @${user.username} from BlackEnvelope? This cannot be undone.`, { danger: true })) return;
        try {
          await api(`/api/admin/users/${encodeURIComponent(user.username)}`, { method: "DELETE" });
          showToast(`Removed @${user.username}.`);
          loadAdminUsersPage().catch(() => {});
        } catch (e) {
          showToast("Remove failed: " + e.message, "error");
        }
      });

      actions.appendChild(exemptBtn);
      actions.appendChild(removeBtn);

      item.appendChild(avatar);
      item.appendChild(name);
      item.appendChild(actions);
      list.appendChild(item);
    }

    body.appendChild(list);
  }

  async function loadAdminUsersPage() {
    if (state.adminUsersPageLoading) return;
    state.adminUsersPageLoading = true;
    renderAdminUsersPageLoading();
    try {
      const data = await api("/api/admin/users");
      const users = (data.users || []).slice().sort((a, b) => a.username.localeCompare(b.username));
      renderAdminUsersPageList(users);
    } catch (_e) {
      renderAdminUsersPageError("Failed to load users.");
    } finally {
      state.adminUsersPageLoading = false;
    }
  }

  function openAdminUsersPage() {
    if (!(state.me && state.me.is_admin)) return;
    toggleSettings(false);
    const alreadyOpen = state.adminUsersPageOpen;
    setAdminUsersPageVisible(true);
    if (!alreadyOpen) loadAdminUsersPage().catch(() => {});
  }

  function closeAdminUsersPage() {
    setAdminUsersPageVisible(false);
  }

  function navigateToAdminUsersPage() {
    toggleSettings(false);
    if (!(state.me && state.me.is_admin)) {
      showToast("Admin access required.", "error");
      return;
    }
    if (_isAdminUsersHashRoute()) {
      syncHashDrivenViews();
      return;
    }
    window.location.hash = "/admin/users";
  }

  function navigateBackFromAdminUsersPage() {
    if (_isAdminUsersHashRoute()) {
      if (window.history.length > 1) {
        window.history.back();
        setTimeout(() => {
          if (_isAdminUsersHashRoute()) {
            _clearAdminUsersHashRoute();
            syncHashDrivenViews();
          }
        }, 120);
        return;
      }
      _clearAdminUsersHashRoute();
    }
    syncHashDrivenViews();
  }

  function showAdminAccessCodeModal() {
    toggleSettings(false);
    showModal("Admin: Promo Codes", async (container) => {
      container.innerHTML = '<div style="color:var(--muted);padding:12px;">Loading...</div>';
      let data;
      try {
        data = await api("/api/admin/access-codes");
      } catch (_e) {
        container.innerHTML = '<div style="color:var(--danger);padding:12px;">Failed to load promo codes.</div>';
        return;
      }

      container.innerHTML = "";
      const status = document.createElement("div");
      status.style.cssText = "font-size:13px;color:var(--muted);line-height:1.45;";
      const count = Number(data.count || 0);
      status.textContent = count > 0
        ? `${count} promo code${count === 1 ? "" : "s"} configured. Only codes marked [free] skip billing.`
        : "No promo codes configured. All new users follow normal billing.";
      container.appendChild(status);

      const label = document.createElement("label");
      label.textContent = "Add Promo Code";
      container.appendChild(label);

      const input = document.createElement("input");
      input.type = "password";
      input.placeholder = "6+ characters";
      input.maxLength = 128;
      container.appendChild(input);

      const freeRow = document.createElement("label");
      freeRow.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-top:8px;";
      const freeCheckbox = document.createElement("input");
      freeCheckbox.type = "checkbox";
      freeCheckbox.id = "newAccessCodeFreeCheckbox";
      const freeText = document.createElement("span");
      freeText.textContent = "Grant free access (skip billing) for users who register with this code";
      freeRow.appendChild(freeCheckbox);
      freeRow.appendChild(freeText);
      container.appendChild(freeRow);

      if (count > 0) {
        const listLabel = document.createElement("label");
        listLabel.textContent = "Current Codes (Hash Preview)";
        container.appendChild(listLabel);

        const list = document.createElement("div");
        list.className = "member-list";
        for (const code of data.codes || []) {
          const item = document.createElement("div");
          item.className = "member-item";

          const name = document.createElement("span");
          name.className = "member-name";
          const createdBy = code.created_by_username ? ` by @${code.created_by_username}` : "";
          const freeTag = code.grants_free_access ? " [free]" : "";
          name.textContent = `#${code.id} ${code.hash_preview}${freeTag}${createdBy}`;

          const delBtn = document.createElement("button");
          delBtn.className = "danger ghost";
          delBtn.textContent = "Delete";
          delBtn.style.fontSize = "12px";
          delBtn.addEventListener("click", async () => {
            if (!await confirmAsync(`Delete promo code #${code.id}?`, { danger: true })) return;
            try {
              await api(`/api/admin/access-codes/${code.id}`, { method: "DELETE" });
              showToast(`Promo code #${code.id} deleted.`);
              showAdminAccessCodeModal();
            } catch (e) {
              showToast("Delete failed: " + e.message, "error");
            }
          });

          item.appendChild(name);
          item.appendChild(delBtn);
          list.appendChild(item);
        }
        container.appendChild(list);
      }

      const row = document.createElement("div");
      row.className = "modal-row";

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Add Promo Code";
      saveBtn.addEventListener("click", async () => {
        const code = input.value.trim();
        if (code.length < 6) {
          showToast("Promo code must be at least 6 characters.", "error");
          return;
        }
        try {
          await api("/api/admin/access-codes", {
            method: "POST",
            body: JSON.stringify({
              access_code: code,
              grants_free_access: Boolean(freeCheckbox.checked),
            }),
          });
          showToast(freeCheckbox.checked ? "Free promo code added." : "Promo code added.");
          showAdminAccessCodeModal();
        } catch (e) {
          showToast("Update failed: " + e.message, "error");
        }
      });

      const clearBtn = document.createElement("button");
      clearBtn.className = "danger ghost";
      clearBtn.textContent = "Delete All Promo Codes";
      clearBtn.disabled = count === 0;
      clearBtn.addEventListener("click", async () => {
        if (!await confirmAsync("Delete all promo codes?", { danger: true })) return;
        try {
          await api("/api/admin/access-code", { method: "DELETE" });
          showToast("All promo codes deleted.");
          showAdminAccessCodeModal();
        } catch (e) {
          showToast("Delete failed: " + e.message, "error");
        }
      });

      row.appendChild(saveBtn);
      row.appendChild(clearBtn);
      container.appendChild(row);
    });
  }

  async function downloadAdminUsersCsv() {
    toggleSettings(false);
    assert(Boolean(state.token), "Not authenticated.");
    assert(Boolean(state.me && state.me.is_admin), "Admin access required.");
    showToast("Preparing CSV export...");

    const isIOSLike = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const pendingWindow = isIOSLike ? window.open("", "_blank") : null;
    if (pendingWindow) {
      try {
        pendingWindow.document.write("<p style='font-family:sans-serif;padding:18px;'>Preparing CSV export...</p>");
      } catch (_e) {}
    }

    const headers = new Headers();
    headers.set("Authorization", "Bearer " + state.token);
    const res = await fetch(API + "/api/admin/export/users.csv", {
      method: "GET",
      headers,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.detail) detail = body.detail;
      } catch (_e) {}
      throw new Error(detail);
    }

    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename=\"?([^\";]+)\"?/i);
    const filename = match && match[1] ? match[1] : "blackenvelope-users-export.csv";
    const blob = await res.blob();

    // Mobile Safari frequently ignores the anchor `download` flow for blob URLs.
    // Try native share first when available.
    if (navigator.share && typeof File !== "undefined") {
      try {
        const shareFile = new File([blob], filename, { type: "text/csv" });
        const canShare = !navigator.canShare || navigator.canShare({ files: [shareFile] });
        if (canShare) {
          await navigator.share({ files: [shareFile], title: filename });
          if (pendingWindow) pendingWindow.close();
          showToast("Users CSV exported.");
          return;
        }
      } catch (_e) {}
    }

    const url = URL.createObjectURL(blob);
    if (pendingWindow) {
      pendingWindow.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }
    showToast("Users CSV exported.");
  }

  function showRegenerateKeyModal() {
    showModal("Generate New Key", (container) => {
      const warning = document.createElement("div");
      warning.style.cssText = "color:var(--danger);font-size:13px;line-height:1.45;";
      warning.textContent = "This replaces your current key. You will lose access to old messages and start fresh.";
      container.appendChild(warning);

      const note = document.createElement("div");
      note.style.cssText = "color:var(--muted);font-size:12px;line-height:1.45;";
      note.textContent = "After generating, the app will prompt you to back up the new key with a passphrase.";
      container.appendChild(note);

      const label = document.createElement("label");
      label.textContent = 'Type RESET to confirm';
      container.appendChild(label);

      const confirmInput = document.createElement("input");
      confirmInput.placeholder = "RESET";
      confirmInput.maxLength = 32;
      container.appendChild(confirmInput);

      const regenerateBtn = document.createElement("button");
      regenerateBtn.className = "danger";
      regenerateBtn.textContent = "Generate New Key";
      regenerateBtn.addEventListener("click", async () => {
        const confirmText = confirmInput.value.trim().toUpperCase();
        if (confirmText !== "RESET") {
          showToast('Type "RESET" to continue.', "error");
          return;
        }
        regenerateBtn.disabled = true;
        try {
          await regenerateKeypairAndStartFresh();
          hideModal();
        } catch (e) {
          showToast("Key regeneration failed: " + e.message, "error");
        } finally {
          regenerateBtn.disabled = false;
        }
      });
      container.appendChild(regenerateBtn);
    });
  }

  function showDeleteAccountModal() {
    showModal("Delete Account", (container) => {
      const warning = document.createElement("div");
      warning.style.cssText = "color:var(--danger);font-size:13px;line-height:1.45;";
      warning.textContent = "This is permanent. Your account, keys, direct messages, and sent group messages will be removed.";
      container.appendChild(warning);

      const label1 = document.createElement("label");
      label1.textContent = 'Type DELETE to confirm';
      container.appendChild(label1);

      const confirmInput = document.createElement("input");
      confirmInput.placeholder = "DELETE";
      confirmInput.maxLength = 32;
      container.appendChild(confirmInput);

      const label2 = document.createElement("label");
      label2.textContent = "Current Password";
      container.appendChild(label2);

      const passwordInput = document.createElement("input");
      passwordInput.type = "password";
      passwordInput.placeholder = "Enter current password";
      container.appendChild(passwordInput);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "danger";
      deleteBtn.textContent = "Permanently Delete Account";
      deleteBtn.addEventListener("click", async () => {
        try {
          const confirmText = confirmInput.value.trim();
          const currentPassword = passwordInput.value;
          if (!currentPassword) {
            showToast("Current password is required.", "error");
            return;
          }
          await api("/api/me/delete-account", {
            method: "POST",
            body: JSON.stringify({
              current_password: currentPassword,
              confirm_text: confirmText,
            }),
          });
          hideModal();
          handleLogout(false);
          showToast("Account deleted.");
        } catch (e) {
          showToast("Delete failed: " + e.message, "error");
        }
      });
      container.appendChild(deleteBtn);
    });
  }

  // === APP LIFECYCLE ===
  async function enterApp(statusMsg = "") {
    // Show app shell immediately — user sees UI right away
    showAuth(false);
    clearAuthBillingPrompt();
    updateSettingsProfile();
    showChatEmpty();

    // Restore stale conversation list from cache instantly
    loadConversationListFromCache();
    $("conversationList").classList.add("is-loading");

    connectSocket();

    // Key generation must complete before decryption works
    await ensureKeyReady();
    const backupReady = await ensureRequiredKeyBackup();
    if (!backupReady) return;

    // Background loads — non-blocking
    Promise.all([
      refreshFriends(),
      refreshFriendRequests(),
      refreshGroups(),
      refreshGroupInvites(),
    ]).then(() => {
      $("conversationList").classList.remove("is-loading");
      renderConversationList();
      saveConversationListToCache();
      // Now that friends/groups are loaded, fetch actual last-message previews
      refreshConversationPreviews().then(() => {
        saveConversationListToCache();
      }).catch(() => {});
    }).catch(() => {
      $("conversationList").classList.remove("is-loading");
    });

    // Non-critical loads — fire and forget
    api("/api/me/settings").then((settings) => {
      state.notificationSoundEnabled = settings.notification_sound_enabled !== false;
      updateSettingsProfile();
    }).catch(() => {});

    requestNotificationPermission();
    refreshNotificationBadge();
    loadStorageBrief().catch(() => {});
    syncHashDrivenViews();

    if (statusMsg) showToast(statusMsg);
  }

  async function enterAppIfRecoveryReady(statusMsg = "") {
    const email = state.me && state.me.email ? String(state.me.email).trim() : "";
    if (email) {
      await enterApp(statusMsg);
      return;
    }
    showAuth(true);
    switchAuthTab("link-email");
    $("linkEmailInput").value = "";
    $("linkEmailInput").focus();
    showToast("Add your email to enable account recovery.");
  }

  async function restoreSession() {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return false;

    let parsed;
    try { parsed = JSON.parse(raw); } catch (_e) { clearSession(); return false; }
    const token = parsed && typeof parsed.token === "string" ? parsed.token.trim() : "";
    if (!token) { clearSession(); return false; }

    state.token = token;
    try {
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.set("Authorization", "Bearer " + state.token);
      const res = await fetch(API + "/api/me", { headers });
      let body = {};
      try { body = await res.json(); } catch (_e) {}

      if (res.status === 402 && body && body.subscription_required) {
        state.token = null;
        state.me = null;
        clearSession();
        const config = await _fetchPublicConfig();
        if (isNutshellSsoEnabled(config)) {
          showNutshellGate(body.detail || "An active Nutshell membership is required to use BlackEnvelope.");
          return false;
        }
        showAuth(true);
        switchAuthTab("login");
        showAuthBillingPrompt(
          body.detail || "Active Nutshell subscription required to use BlackEnvelope.",
          typeof body.checkout_url === "string" ? body.checkout_url : "",
        );
        return false;
      }
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);

      state.me = buildMeState(body);
      await enterAppIfRecoveryReady("Session restored.");
      return true;
    } catch (_e) {
      state.token = null;
      state.me = null;
      clearSession();
      return false;
    }
  }

  async function handleRegister() {
    if (state.authRegisterBusy) return;
    const username = $("regUsername").value.trim();
    const email = $("regEmail").value.trim();
    const password = $("regPassword").value;
    const promoCode = $("regAccessCode").value.trim();
    if (!username) throw new Error("Username is required.");
    if (!email) throw new Error("Email is required.");
    if (password.length < 12) throw new Error("Password must be at least 12 characters.");

    const regBtn = $("regBtn");
    const originalLabel = regBtn.textContent;
    state.authRegisterBusy = true;
    regBtn.disabled = true;
    regBtn.textContent = "Creating...";
    clearAuthBillingPrompt();

    try {
      const result = await api("/api/register", {
        method: "POST",
        timeout_ms: 20000,
        body: JSON.stringify({ username, email, password, promo_code: promoCode }),
      });

      // If billing is enabled, redirect to Square checkout immediately
      if (result && result.checkout_url) {
        showToast("Account created — redirecting to payment...");
        setTimeout(() => {
          window.location.href = result.checkout_url;
        }, 800);
        return;
      }

      // No billing required (admin, exempt, or billing not enabled)
      $("loginUsername").value = username;
      $("loginPassword").value = password;
      $("regAccessCode").value = "";
      switchAuthTab("login");
      clearAuthBillingPrompt();
      showToast("Account created. Log in now.");
    } finally {
      state.authRegisterBusy = false;
      regBtn.disabled = false;
      regBtn.textContent = originalLabel;
    }
  }

  async function handleLogin() {
    const username = $("loginUsername").value.trim();
    const password = $("loginPassword").value;
    clearAuthBillingPrompt();
    const res = await fetch(API + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    let data = {};
    try { data = await res.json(); } catch (_e) {}

    if (res.status === 402 && data && data.subscription_required) {
      showAuthBillingPrompt(
        data.detail || "Active Nutshell subscription required to use BlackEnvelope.",
        typeof data.checkout_url === "string" ? data.checkout_url : "",
      );
      showToast("Subscription required. Complete checkout, then log in again.", "error");
      return;
    }
    if (!res.ok) {
      throw new Error(data.detail || `HTTP ${res.status}`);
    }
    if (!data || typeof data.token !== "string" || !data.token.trim()) {
      throw new Error("Login response missing token.");
    }

    state.token = data.token;
    state.me = buildMeState(data.user || {});
    persistSession();
    await enterAppIfRecoveryReady();
  }

  async function handleForgotPassword() {
    const email = $("forgotEmail").value.trim();
    const result = await api("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    showToast(result.detail || "If that email is registered, a reset link has been sent.");
    $("forgotEmail").value = "";
    switchAuthTab("login");
  }

  async function handleResetPassword() {
    const token = state.pendingResetToken || _resetTokenFromHash();
    const newPassword = $("resetNewPassword").value;
    const confirmPassword = $("resetConfirmPassword").value;
    if (!token) {
      throw new Error("Missing reset token. Open the reset link from your email again.");
    }
    if (newPassword !== confirmPassword) {
      throw new Error("Passwords do not match.");
    }
    await api("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, new_password: newPassword }),
    });
    state.pendingResetToken = "";
    _clearResetHashRoute();
    $("resetNewPassword").value = "";
    $("resetConfirmPassword").value = "";
    switchAuthTab("login");
    showToast("Password reset successful. You can log in now.");
  }

  async function handleLinkEmail() {
    if (!state.token || !state.me) {
      throw new Error("Session expired. Log in again.");
    }
    const email = $("linkEmailInput").value.trim();
    const result = await api("/api/me/email", {
      method: "PUT",
      body: JSON.stringify({ email }),
    });
    state.me.email = String(result.email || email).trim();
    await enterApp("Email saved. Account recovery is now enabled.");
  }

  function handleLogout(showToastMessage = true) {
    const currentUsername = state.me && state.me.username ? state.me.username : "";
    if (state.ws) state.ws.close();
    clearWsHeartbeat();

    // Unsubscribe from push notifications
    if (state.pushSubscription) {
      const ep = state.pushSubscription.endpoint;
      state.pushSubscription.unsubscribe().catch(() => {});
      api("/api/push/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ endpoint: ep }),
      }).catch(() => {});
      state.pushSubscription = null;
    }

    state.token = null;
    state.me = null;
    clearSession();

    state.myPrivateKey = null;
    state.myPublicJwk = null;
    state.friends.clear();
    state.groups.clear();
    state.groupTopics.clear();
    state.groupMembers.clear();
    state.incomingFriendRequests = [];
    state.outgoingFriendRequests = [];
    state.pendingGroupInvites = [];
    state.activeType = null;
    state.activeFriend = null;
    state.activeGroupId = null;
    state.activeGroupTopic = "all";
    state.activeFeedKey = "";
    state.activeRows = [];
    state.activeHasMore = false;
    state.activeNextBeforeId = null;
    state.activeFeedLoading = false;
    state.activeFeedLoadingOlder = false;
    state.activeFeedRequestSeq = 0;
    state.activeFeedPendingRealtimePull = false;
    try {
      if (currentUsername) localStorage.removeItem(CONV_CACHE_KEY + ":" + currentUsername);
    } catch (_e) { /* ignore */ }
    state.conversationPreviews.clear();

    $("composer").value = "";
    hideMentionSuggestions();
    updateComposerOverlay();
    autoResizeComposer();
    $("keyLabel").textContent = "Key: unknown";
    $("keyIdLabel").textContent = "Key ID: n/a";
    $("wsLabel").textContent = "WS: disconnected";

    renderConversationList();
    showChatEmpty();
    toggleSettings(false);
    closeAdminUsersPage();
    _clearAdminUsersHashRoute();
    if (isNutshellSsoEnabled()) {
      showNutshellGate("Continue from Nutshell to open BlackEnvelope again.");
    } else {
      showAuth(true);
      switchAuthTab("login");
    }
    clearAuthBillingPrompt();
    if (showToastMessage) showToast("Logged out.");
  }

  async function copyPublicKey() {
    assert(Boolean(state.myPublicJwk), "No key loaded.");
    await navigator.clipboard.writeText(JSON.stringify(state.myPublicJwk));
    showToast("Public key copied.");
  }

  async function refreshAll() {
    await Promise.all([refreshFriends(), refreshFriendRequests(), refreshGroups(), refreshGroupInvites()]);
    if (state.activeType === "group" && state.activeGroupId && state.groups.has(state.activeGroupId)) {
      await refreshGroupContext(state.activeGroupId);
    }
    if (state.activeType) await refreshActiveConversation();
    showToast("Refreshed.");
  }

  // === FAB ===
  function toggleFab() {
    state.fabOpen = !state.fabOpen;
    $("fabMenu").classList.toggle("open", state.fabOpen);
    $("fabBtn").textContent = state.fabOpen ? "\u00D7" : "+";
  }

  function closeFab() {
    state.fabOpen = false;
    $("fabMenu").classList.remove("open");
    $("fabBtn").textContent = "+";
  }

  // === EVENT LISTENERS ===

  // Auth tabs
  for (const btn of document.querySelectorAll(".auth-tab")) {
    btn.addEventListener("click", () => switchAuthTab(btn.dataset.auth));
  }

  // Auth forms
  $("regBtn").addEventListener("click", () => handleRegister().catch((e) => showToast("Register failed: " + e.message, "error")));
  $("loginBtn").addEventListener("click", () => handleLogin().catch((e) => showToast("Login failed: " + e.message, "error")));
  $("forgotBtn").addEventListener("click", () => handleForgotPassword().catch((e) => showToast("Reset failed: " + e.message, "error")));
  $("resetBtn").addEventListener("click", () => handleResetPassword().catch((e) => showToast("Reset failed: " + e.message, "error")));
  $("linkEmailBtn").addEventListener("click", () => handleLinkEmail().catch((e) => showToast("Email update failed: " + e.message, "error")));
  $("googleUsernameBtn").addEventListener("click", () => handleGoogleUsernameSubmit().catch((e) => showToast("Google sign-in failed: " + e.message, "error")));
  $("forgotPasswordLink").addEventListener("click", (e) => {
    e.preventDefault();
    switchAuthTab("forgot-password");
    $("forgotEmail").focus();
  });
  $("backToLoginFromForgot").addEventListener("click", (e) => {
    e.preventDefault();
    switchAuthTab("login");
  });
  $("backToLoginFromReset").addEventListener("click", (e) => {
    e.preventDefault();
    state.pendingResetToken = "";
    _clearResetHashRoute();
    switchAuthTab("login");
  });
  $("backToLoginFromGoogleUsername").addEventListener("click", (e) => {
    e.preventDefault();
    state.googleIdToken = "";
    switchAuthTab("login");
  });
  $("authHelpBtn").addEventListener("click", () => showLoginDocsModal());
  const billingCheckoutBtn = $("billingCheckoutBtn");
  if (billingCheckoutBtn) {
    billingCheckoutBtn.addEventListener("click", () => {
      if (!state.billingCheckoutUrl) {
        showToast("No checkout link is available yet.", "error");
        return;
      }
      window.location.href = state.billingCheckoutUrl;
    });
  }

  // Auth enter key
  $("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });
  $("regPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") $("regBtn").click(); });
  $("regEmail").addEventListener("keydown", (e) => { if (e.key === "Enter") $("regBtn").click(); });
  $("regAccessCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("regBtn").click(); });
  $("forgotEmail").addEventListener("keydown", (e) => { if (e.key === "Enter") $("forgotBtn").click(); });
  $("resetConfirmPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") $("resetBtn").click(); });
  $("linkEmailInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("linkEmailBtn").click(); });
  $("googleNewAccessCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("googleUsernameBtn").click(); });

  // Settings
  $("hamburgerBtn").addEventListener("click", () => toggleSettings(true));
  $("settingsOverlay").addEventListener("click", () => toggleSettings(false));
  $("deleteAccountBtn").addEventListener("click", () => { toggleSettings(false); showDeleteAccountModal(); });
  $("logoutBtn").addEventListener("click", () => { toggleSettings(false); handleLogout(); });
  // Profile
  $("settingsProfile").addEventListener("click", () => {
    toggleSettings(false);
    if (state.me) showProfileModal(state.me.username);
  });
  $("avatarInput").addEventListener("change", () => {
    const file = $("avatarInput").files && $("avatarInput").files[0];
    if (file) handleAvatarUpload(file);
  });
  // General
  $("notifSoundToggle").addEventListener("click", async () => {
    state.notificationSoundEnabled = !state.notificationSoundEnabled;
    $("notifSoundStatus").textContent = state.notificationSoundEnabled ? "On" : "Off";
    try {
      await api("/api/me/settings", {
        method: "PUT",
        body: JSON.stringify({ notification_sound_enabled: state.notificationSoundEnabled }),
      });
    } catch (_e) {}
  });
  $("refreshAllBtn").addEventListener("click", () => { toggleSettings(false); refreshAll().catch((e) => showToast("Refresh failed: " + e.message, "error")); });
  $("friendsBtn").addEventListener("click", () => showFriendsModal());
  $("docsBtn").addEventListener("click", () => showDocsModal());
  $("adminUsersBtn").addEventListener("click", () => navigateToAdminUsersPage());
  $("adminExportCsvBtn").addEventListener("click", () => {
    downloadAdminUsersCsv().catch((e) => showToast("Export failed: " + e.message, "error"));
  });
  $("adminAccessCodeBtn").addEventListener("click", () => showAdminAccessCodeModal());
  $("adminUsersPageBackBtn").addEventListener("click", () => navigateBackFromAdminUsersPage());
  // Subscription
  $("subscriptionBtn").addEventListener("click", () => showSubscriptionModal());
  // Data Storage
  $("storageBtn").addEventListener("click", () => { toggleSettings(false); showStorageModal(); });
  // Key management buttons are now in the profile modal (showProfileModal)
  $("importKeyFile").addEventListener("change", () => {
    const file = $("importKeyFile").files && $("importKeyFile").files[0];
    if (!file) return;
    importKeyBackupFromFile(file)
      .catch((e) => showToast("Import failed: " + e.message, "error"))
      .finally(() => { $("importKeyFile").value = ""; });
  });

  // Notifications
  $("notificationBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleNotificationDropdown();
  });
  $("markAllReadBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    api("/api/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) })
      .then(() => {
        state.notificationRows = state.notificationRows.map((n) => ({ ...n, is_read: true }));
        refreshNotificationBadge();
        renderNotificationDropdownList();
      })
      .catch(() => {});
  });
  $("notificationDropdownList").addEventListener("scroll", () => {
    maybeLoadMoreNotifications();
  });
  // Close notification dropdown when clicking outside
  document.addEventListener("click", (e) => {
    const dd = $("notificationDropdown");
    if (!dd.classList.contains("hidden") && !dd.contains(e.target) && e.target !== $("notificationBtn")) {
      dd.classList.add("hidden");
    }
  });

  // Search
  $("searchInput").addEventListener("input", scheduleSearch);
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Escape") exitSearch();
  });

  // FAB
  $("fabBtn").addEventListener("click", toggleFab);
  for (const item of document.querySelectorAll(".fab-menu-item")) {
    item.addEventListener("click", () => {
      closeFab();
      if (item.dataset.action === "new-group") showNewGroupModal();
      if (item.dataset.action === "new-chat") showNewChatModal();
    });
  }

  // Chat actions
  $("backBtn").addEventListener("click", () => handleMobileNav("sidebar"));
  $("chatInfoBtn").addEventListener("click", () => {
    if (state.activeType === "group" && state.activeGroupId) {
      showGroupInfoModal(state.activeGroupId);
    }
  });
  $("messagesArea").addEventListener("scroll", () => {
    maybeLoadOlderActiveConversation().catch(() => {});
  });
  $("messagesArea").addEventListener("click", (e) => {
    const mention = e.target.closest(".mention:not(.mention-everyone)");
    if (mention) {
      e.stopPropagation();
      const text = mention.textContent || "";
      const username = text.replace(/^@/, "").trim().toLowerCase();
      if (username) showProfileModal(username);
    }
  });

  // View toggle
  document.querySelectorAll(".view-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.view;
      if (state.activeViewMode === mode) return;
      state.activeViewMode = mode;
      document.querySelectorAll(".view-toggle-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderActiveConversationRows();
    });
  });

  // Send
  $("sendBtn").addEventListener("click", sendMessage);
  $("attachBtn").addEventListener("click", () => {
    if ($("attachBtn").disabled) return;
    $("mediaInput").value = "";
    $("mediaInput").click();
  });
  $("mediaInput").addEventListener("change", () => {
    const file = $("mediaInput").files && $("mediaInput").files[0];
    if (!file) return;
    setPendingAttachmentFromFile(file).catch((e) => {
      clearPendingAttachment();
      showToast("Attach failed: " + e.message, "error");
    });
  });
  $("micBtn").addEventListener("click", () => {
    if ($("micBtn").disabled) return;
    if (state.voiceRecorder.mediaRecorder) {
      stopVoiceRecording(false);
    } else {
      startVoiceRecording();
    }
  });
  $("voiceCancelBtn").addEventListener("click", cancelVoiceRecording);
  $("voiceSendBtn").addEventListener("click", () => stopVoiceRecording(true));
  $("attachmentClearBtn").addEventListener("click", () => {
    clearPendingAttachment();
  });

  // Composer
  $("composer").addEventListener("input", handleComposerInput);
  $("composer").addEventListener("scroll", syncComposerOverlayScroll);
  $("composer").addEventListener("click", () => refreshMentionSuggestions());
  $("composer").addEventListener("keyup", () => refreshMentionSuggestions());
  $("composer").addEventListener("blur", () => {
    // Allow clicks on suggestion items without the blur handler tearing down the menu first.
    setTimeout(() => {
      const active = document.activeElement;
      if (active && active.closest && active.closest("#mentionSuggestions")) return;
      hideMentionSuggestions();
    }, 0);
  });
  $("composer").addEventListener("keydown", (e) => {
    if (state.mention.open && (state.mention.users || []).length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.mention.activeIndex = Math.min(state.mention.activeIndex + 1, state.mention.users.length - 1);
        renderMentionSuggestions();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.mention.activeIndex = Math.max(state.mention.activeIndex - 1, 0);
        renderMentionSuggestions();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideMentionSuggestions();
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        const chosen = state.mention.users[state.mention.activeIndex];
        if (chosen && chosen.username) insertMention(chosen.username);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Modal
  $("modalClose").addEventListener("click", hideModal);
  $("modalOverlay").addEventListener("click", (e) => {
    if (e.target === $("modalOverlay")) hideModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.adminUsersPageOpen) navigateBackFromAdminUsersPage();
      else if (state.activeModal) hideModal();
      else if (state.fabOpen) closeFab();
    }
  });

  // Close FAB on outside click
  document.addEventListener("click", (e) => {
    if (state.fabOpen && !e.target.closest("#fabBtn") && !e.target.closest("#fabMenu")) {
      closeFab();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!state.token) return;
    if (document.visibilityState === "visible" && (!state.ws || state.ws.readyState !== WebSocket.OPEN)) {
      connectSocket();
    }
  });

  // Mobile resize handler
  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) {
      // Desktop: remove mobile classes, let grid handle layout
      $("chatPanel").classList.remove("mobile-visible");
    }
  });

  // === INIT ===
  updateComposerOverlay();
  autoResizeComposer();
  showAuth(true);
  showChatEmpty();
  initGoogleSignIn().catch(() => {});
  const hasResetToken = Boolean(_resetTokenFromHash());
  if (hasResetToken) openResetFlowFromUrl();
  window.addEventListener("hashchange", () => {
    syncHashDrivenViews();
  });
  if (hasResetToken) {
    showToast("Enter a new password to finish resetting your account.");
  } else {
    restoreSession()
      .then((ok) => {
        if (!ok) {
          _fetchPublicConfig().then((config) => {
            if (isNutshellSsoEnabled(config)) {
              showNutshellGate();
              return;
            }

            // Check if this is a post-payment redirect from Square
            checkPaymentPending().then((handled) => {
              if (!handled) showToast("Ready. Log in to continue.");
            });
          });
        }
        syncHashDrivenViews();
      })
      .catch((_e) => {
        clearSession();
        _fetchPublicConfig().then((config) => {
          if (isNutshellSsoEnabled(config)) {
            showNutshellGate();
            return;
          }

          checkPaymentPending().then((handled) => {
            if (!handled) showToast("Ready. Log in to continue.");
          });
        });
        syncHashDrivenViews();
      });
  }

  // === SERVICE WORKER REGISTRATION ===
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
        const checkForUpdates = () => reg.update().catch(() => {});
        checkForUpdates();

        // Periodically ask browser to check for updated SW script.
        setInterval(() => {
          checkForUpdates();
        }, 60 * 1000);

        const checkUpdatesOnVisible = () => {
          if (document.visibilityState === "visible") checkForUpdates();
        };
        window.addEventListener("focus", checkUpdatesOnVisible);
        window.addEventListener("online", checkUpdatesOnVisible);
        document.addEventListener("visibilitychange", checkUpdatesOnVisible);

        if (reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              newWorker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });

        let refreshing = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          if (refreshing) return;
          refreshing = true;
          window.location.reload();
        });
      } catch (err) {
        console.warn("SW registration failed:", err);
      }
    });
  }
})();
