// Client-side media compression to keep uploads under Cloudflare's 100MB limit.
// Uses browser-native APIs only (Canvas for images, MediaRecorder for video).

const MAX_FILE_SIZE = 90 * 1024 * 1024; // 90MB target (under Cloudflare's 100MB)
const IMAGE_MAX_DIMENSION = 3840; // Max width/height for images
const VIDEO_TARGET_HEIGHT = 720;

/**
 * Compress a File if it exceeds the size threshold.
 * Returns the original file if compression isn't needed or not supported.
 */
export async function compressFile(file) {
  if (file.size <= MAX_FILE_SIZE) {
    return file;
  }

  if (file.type.startsWith('image/')) {
    return compressImage(file);
  }

  if (file.type.startsWith('video/')) {
    return compressVideo(file);
  }

  // Audio or unknown — return as-is
  return file;
}

/**
 * Compress an image using Canvas API.
 * Downscales and re-encodes as JPEG/WebP.
 */
function compressImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;

      // Downscale if exceeds max dimension
      if (width > IMAGE_MAX_DIMENSION || height > IMAGE_MAX_DIMENSION) {
        const ratio = Math.min(IMAGE_MAX_DIMENSION / width, IMAGE_MAX_DIMENSION / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // Try WebP first, fall back to JPEG
      const outputType = 'image/jpeg';
      let quality = 0.85;

      const tryCompress = () => {
        canvas.toBlob(
          (blob) => {
            if (blob && (blob.size <= MAX_FILE_SIZE || quality <= 0.5)) {
              const compressed = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), {
                type: outputType,
                lastModified: file.lastModified,
              });
              resolve(compressed.size < file.size ? compressed : file);
            } else {
              quality -= 0.1;
              tryCompress();
            }
          },
          outputType,
          quality,
        );
      };

      tryCompress();
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };

    img.src = url;
  });
}

/**
 * Compress a video using HTMLVideoElement + Canvas + MediaRecorder.
 * Re-encodes at 720p with reduced bitrate.
 */
function compressVideo(file) {
  return new Promise((resolve) => {
    // Check MediaRecorder support
    if (typeof MediaRecorder === 'undefined') {
      resolve(file);
      return;
    }

    // Check for supported mime types
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8'
        : null;

    if (!mimeType) {
      resolve(file);
      return;
    }

    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.muted = true;
    video.preload = 'auto';

    // Timeout: if compression takes too long, return original
    const timeout = setTimeout(() => {
      cleanup();
      resolve(file);
    }, 5 * 60 * 1000); // 5 minute timeout

    const cleanup = () => {
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };

    video.onloadedmetadata = () => {
      let targetWidth = video.videoWidth;
      let targetHeight = video.videoHeight;

      // Only downscale if larger than 720p
      if (targetHeight > VIDEO_TARGET_HEIGHT) {
        const ratio = VIDEO_TARGET_HEIGHT / targetHeight;
        targetWidth = Math.round(targetWidth * ratio);
        targetHeight = VIDEO_TARGET_HEIGHT;
        // Ensure even dimensions (required by most codecs)
        targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth + 1;
        targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight + 1;
      }

      // Calculate target bitrate: aim for 80% of MAX_FILE_SIZE
      const targetBytes = MAX_FILE_SIZE * 0.8;
      const duration = video.duration;
      // bits per second, minus ~128kbps for audio
      const videoBitsPerSecond = Math.min(
        ((targetBytes * 8) / duration) - 128000,
        2500000, // cap at 2.5 Mbps
      );

      if (videoBitsPerSecond < 200000) {
        // Video too long for meaningful compression under limit
        cleanup();
        resolve(file);
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');

      const stream = canvas.captureStream(30);

      // Add audio track if the video has one
      try {
        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaElementSource(video);
        const dest = audioCtx.createMediaStreamDestination();
        source.connect(dest);
        source.connect(audioCtx.destination); // needed for playback
        dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
      } catch {
        // No audio or AudioContext not available — continue without audio
      }

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: Math.max(videoBitsPerSecond, 200000),
      });

      const chunks = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };

      recorder.onstop = () => {
        cleanup();

        const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
        const ext = mimeType.includes('webm') ? 'webm' : 'mp4';
        const compressed = new File(
          [blob],
          file.name.replace(/\.[^.]+$/, `.${ext}`),
          { type: mimeType.split(';')[0], lastModified: file.lastModified },
        );

        // Only use compressed version if it's actually smaller
        resolve(compressed.size < file.size ? compressed : file);
      };

      recorder.onerror = () => {
        cleanup();
        resolve(file);
      };

      recorder.start(1000); // Collect data every second

      const drawFrame = () => {
        if (video.paused || video.ended) {
          recorder.stop();
          return;
        }
        ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
        requestAnimationFrame(drawFrame);
      };

      video.onended = () => {
        recorder.stop();
      };

      video.play().then(() => {
        drawFrame();
      }).catch(() => {
        cleanup();
        resolve(file);
      });
    };

    video.onerror = () => {
      cleanup();
      resolve(file);
    };

    video.src = url;
  });
}
