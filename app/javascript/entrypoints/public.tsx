import { createRoot } from 'react-dom/client';

import { IntlMessageFormat } from 'intl-messageformat';
import type { MessageDescriptor, PrimitiveType } from 'react-intl';
import { defineMessages } from 'react-intl';

import axios from 'axios';
import { on } from 'delegated-events';
import { throttle } from 'lodash';

import { timeAgoString } from '../mastodon/components/relative_timestamp';
import emojify from '../mastodon/features/emoji/emoji';
import loadKeyboardExtensions from '../mastodon/load_keyboard_extensions';
import { loadLocale, getLocale } from '../mastodon/locales';
import { loadPolyfills } from '../mastodon/polyfills';
import ready from '../mastodon/ready';

import 'cocoon-js-vanilla';

const messages = defineMessages({
  usernameTaken: {
    id: 'username.taken',
    defaultMessage: 'That username is taken. Try another',
  },
  passwordExceedsLength: {
    id: 'password_confirmation.exceeds_maxlength',
    defaultMessage: 'Password confirmation exceeds the maximum password length',
  },
  passwordDoesNotMatch: {
    id: 'password_confirmation.mismatching',
    defaultMessage: 'Password confirmation does not match',
  },
});

const PROFILE_HEADER_OUTPUT_WIDTH = 1500;
const PROFILE_HEADER_OUTPUT_HEIGHT = 500;
const PROFILE_HEADER_ZOOM_MIN = 1;
const PROFILE_HEADER_ZOOM_MAX = 3;
const PROFILE_HEADER_MISSING_PATTERN = /missing\.png(?:$|\?)/;
const PROFILE_HEADER_EDITOR_DB_NAME = 'nutshell-profile-header-editor';
const PROFILE_HEADER_EDITOR_STORE_NAME = 'headers';

type ProfileHeaderSourceType = 'none' | 'file' | 'existing';

interface StoredProfileHeaderSource {
  accountId: string;
  file: Blob;
  fileName: string;
  mimeType: string;
  zoom: number;
  offsetRatio: number;
}

interface ProfileHeaderEditorElements {
  form: HTMLFormElement;
  input: HTMLInputElement;
  preview: HTMLImageElement;
  canvas: HTMLElement;
  stage: HTMLElement;
  viewport: HTMLElement;
  zoomInput: HTMLInputElement;
}

interface ProfileHeaderEditorState {
  accountId: string;
  elements: ProfileHeaderEditorElements;
  sourceType: ProfileHeaderSourceType;
  sourceUrl?: string;
  sourceName: string;
  sourceMimeType: string;
  sourceFile?: File;
  sourceWidth: number;
  sourceHeight: number;
  objectUrl?: string;
  zoom: number;
  offsetRatio: number;
  offsetY: number;
  maxOffsetY: number;
  hasAdjustments: boolean;
  isDragging: boolean;
  dragStartY: number;
  dragStartOffsetY: number;
  selectionToken: number;
  isSubmitting: boolean;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));

const extensionForMimeType = (mimeType: string) => {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/png':
    default:
      return '.png';
  }
};

const replaceFileExtension = (name: string, extension: string) => {
  const index = name.lastIndexOf('.');

  if (index <= 0) return `${name}${extension}`;

  return `${name.slice(0, index)}${extension}`;
};

const loadImageFromUrl = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error('Unable to load image preview.'));
    };
    image.src = url;
  });

const openProfileHeaderEditorDB = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }

    const request = indexedDB.open(PROFILE_HEADER_EDITOR_DB_NAME, 1);

    request.onerror = () => {
      reject(request.error ?? new Error('Unable to open banner editor storage.'));
    };

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(PROFILE_HEADER_EDITOR_STORE_NAME)) {
        database.createObjectStore(PROFILE_HEADER_EDITOR_STORE_NAME, {
          keyPath: 'accountId',
        });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };
  });

const getStoredProfileHeaderSource = async (
  accountId: string,
): Promise<StoredProfileHeaderSource | undefined> => {
  try {
    const database = await openProfileHeaderEditorDB();

    return await new Promise<StoredProfileHeaderSource | undefined>(
      (resolve, reject) => {
        const transaction = database.transaction(
          PROFILE_HEADER_EDITOR_STORE_NAME,
          'readonly',
        );
        const request = transaction
          .objectStore(PROFILE_HEADER_EDITOR_STORE_NAME)
          .get(accountId);

        request.onerror = () => {
          reject(
            request.error ?? new Error('Unable to read banner editor state.'),
          );
        };
        request.onsuccess = () => {
          resolve(request.result as StoredProfileHeaderSource | undefined);
        };

        transaction.oncomplete = () => {
          database.close();
        };
      },
    );
  } catch (error: unknown) {
    console.error(error);
    return undefined;
  }
};

const setStoredProfileHeaderSource = async (
  record: StoredProfileHeaderSource,
): Promise<void> => {
  try {
    const database = await openProfileHeaderEditorDB();

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(
        PROFILE_HEADER_EDITOR_STORE_NAME,
        'readwrite',
      );
      const request = transaction
        .objectStore(PROFILE_HEADER_EDITOR_STORE_NAME)
        .put(record);

      request.onerror = () => {
        reject(
          request.error ?? new Error('Unable to save banner editor state.'),
        );
      };
      transaction.onerror = () => {
        reject(
          transaction.error ?? new Error('Unable to save banner editor state.'),
        );
      };
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
    });
  } catch (error: unknown) {
    console.error(error);
  }
};

const hasRealProfileHeaderImage = (url?: string) =>
  typeof url === 'string' && !PROFILE_HEADER_MISSING_PATTERN.test(url);

const updateProfileHeaderPreviewTransform = (state: ProfileHeaderEditorState) => {
  const { preview, canvas, stage, viewport, zoomInput } = state.elements;

  if (
    state.sourceType === 'none' ||
    state.sourceWidth <= 0 ||
    state.sourceHeight <= 0
  ) {
    stage.style.transform = '';
    preview.style.transform = '';
    preview.style.width = '';
    preview.style.height = '';
    zoomInput.disabled = true;
    canvas.classList.remove('is-active');
    canvas.classList.remove('is-draggable');
    state.offsetRatio = 0;
    state.maxOffsetY = 0;
    state.offsetY = 0;
    state.hasAdjustments = false;
    return;
  }

  const viewportWidth = viewport.clientWidth;
  const viewportHeight = viewport.clientHeight;

  if (viewportWidth === 0 || viewportHeight === 0) {
    return;
  }

  const baseScale = Math.max(
    viewportWidth / state.sourceWidth,
    viewportHeight / state.sourceHeight,
  );
  const scaledWidth = state.sourceWidth * baseScale;
  const scaledHeight = state.sourceHeight * baseScale * state.zoom;

  state.maxOffsetY = Math.max((scaledHeight - viewportHeight) / 2, 0);
  state.offsetY = clamp(
    state.offsetRatio * state.maxOffsetY,
    -state.maxOffsetY,
    state.maxOffsetY,
  );
  state.offsetRatio =
    state.maxOffsetY > 0 ? state.offsetY / state.maxOffsetY : 0;
  state.hasAdjustments =
    state.zoom > PROFILE_HEADER_ZOOM_MIN || Math.abs(state.offsetY) > 0.5;

  stage.style.transform = `translate3d(0, ${state.offsetY}px, 0)`;
  preview.style.width = `${scaledWidth}px`;
  preview.style.height = `${state.sourceHeight * baseScale}px`;
  preview.style.transform = `translate(-50%, -50%) scale(${state.zoom})`;
  zoomInput.disabled = false;
  canvas.classList.add('is-active');
  canvas.classList.toggle('is-draggable', state.maxOffsetY > 0);
};

const buildProcessedProfileHeader = async (
  state: ProfileHeaderEditorState,
): Promise<File | undefined> => {
  if (
    state.sourceType === 'none' ||
    state.sourceWidth <= 0 ||
    state.sourceHeight <= 0
  ) {
    return undefined;
  }

  const sourceFile =
    state.sourceType === 'file' && state.sourceFile
      ? state.sourceFile
      : new File([], state.sourceName, { type: state.sourceMimeType });

  const fallbackUrl =
    state.sourceType === 'file' && state.sourceFile
      ? URL.createObjectURL(state.sourceFile)
      : undefined;
  const imageUrl = state.objectUrl ?? state.sourceUrl ?? fallbackUrl;
  if (!imageUrl) return undefined;

  try {
    const image = await loadImageFromUrl(imageUrl);
    const canvas = document.createElement('canvas');

    canvas.width = PROFILE_HEADER_OUTPUT_WIDTH;
    canvas.height = PROFILE_HEADER_OUTPUT_HEIGHT;

    const context = canvas.getContext('2d');
    if (!context) return state.sourceFile;

    const baseScale = Math.max(
      PROFILE_HEADER_OUTPUT_WIDTH / state.sourceWidth,
      PROFILE_HEADER_OUTPUT_HEIGHT / state.sourceHeight,
    );
    const scaledWidth = state.sourceWidth * baseScale * state.zoom;
    const scaledHeight = state.sourceHeight * baseScale * state.zoom;
    const maxOutputOffsetY = Math.max(
      (scaledHeight - PROFILE_HEADER_OUTPUT_HEIGHT) / 2,
      0,
    );
    const drawX = (PROFILE_HEADER_OUTPUT_WIDTH - scaledWidth) / 2;
    const drawY =
      (PROFILE_HEADER_OUTPUT_HEIGHT - scaledHeight) / 2 +
      state.offsetRatio * maxOutputOffsetY;

    context.drawImage(image, drawX, drawY, scaledWidth, scaledHeight);

    const targetMimeType = ['image/jpeg', 'image/png', 'image/webp'].includes(
      sourceFile.type,
    )
      ? sourceFile.type
      : 'image/png';
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        resolve,
        targetMimeType,
        targetMimeType === 'image/jpeg' ? 0.92 : undefined,
      );
    });

    if (!blob) return state.sourceFile;

    return new File(
      [blob],
      replaceFileExtension(
        sourceFile.name || 'profile-header.png',
        extensionForMimeType(blob.type),
      ),
      { type: blob.type, lastModified: Date.now() },
    );
  } finally {
    if (fallbackUrl) {
      URL.revokeObjectURL(fallbackUrl);
    }
  }
};

const initializeProfileHeaderEditor = () => {
  const form = document.querySelector<HTMLFormElement>('form#edit_profile');
  const input = document.querySelector<HTMLInputElement>('input#account_header');
  const preview = document.querySelector<HTMLImageElement>(
    'img#account_header-preview',
  );
  const canvas = document.querySelector<HTMLElement>(
    '#account_header-preview-canvas',
  );
  const stage = document.querySelector<HTMLElement>(
    '#account_header-preview-stage',
  );
  const viewport = document.querySelector<HTMLElement>(
    '#account_header-preview-viewport',
  );
  const zoomInput =
    document.querySelector<HTMLInputElement>('input#account_header-zoom');
  const accountId = form?.dataset.accountId;

  if (
    !form ||
    !input ||
    !preview ||
    !canvas ||
    !stage ||
    !viewport ||
    !zoomInput ||
    !accountId
  )
    return;

  preview.dataset.originalSrc ??= preview.getAttribute('src') ?? '';

  const state: ProfileHeaderEditorState = {
    accountId,
    elements: { form, input, preview, canvas, stage, viewport, zoomInput },
    sourceType: 'none',
    sourceName: 'profile-header.png',
    sourceMimeType: 'image/png',
    sourceWidth: 0,
    sourceHeight: 0,
    zoom: PROFILE_HEADER_ZOOM_MIN,
    offsetRatio: 0,
    offsetY: 0,
    maxOffsetY: 0,
    hasAdjustments: false,
    isDragging: false,
    dragStartY: 0,
    dragStartOffsetY: 0,
    selectionToken: 0,
    isSubmitting: false,
  };

  const loadHeaderSource = async (
    source?: { file: File } | { url: string },
    savedState?: { zoom?: number; offsetRatio?: number },
  ) => {
    state.selectionToken += 1;
    const token = state.selectionToken;

    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = undefined;
    }

    state.sourceType = 'none';
    state.sourceFile = undefined;
    state.sourceUrl = undefined;
    state.sourceName = 'profile-header.png';
    state.sourceMimeType = 'image/png';
    state.sourceWidth = 0;
    state.sourceHeight = 0;
    state.zoom = clamp(
      savedState?.zoom ?? PROFILE_HEADER_ZOOM_MIN,
      PROFILE_HEADER_ZOOM_MIN,
      PROFILE_HEADER_ZOOM_MAX,
    );
    state.offsetRatio = clamp(savedState?.offsetRatio ?? 0, -1, 1);
    state.offsetY = 0;
    state.maxOffsetY = 0;
    state.hasAdjustments = false;
    zoomInput.value = state.zoom.toFixed(2);

    if (!source) {
      preview.src = preview.dataset.originalSrc ?? preview.src;
      updateProfileHeaderPreviewTransform(state);
      return;
    }

    if ('file' in source) {
      state.sourceType = 'file';
      state.sourceFile = source.file;
      state.sourceName = source.file.name || 'profile-header.png';
      state.sourceMimeType = source.file.type;
      state.objectUrl = URL.createObjectURL(source.file);
      state.sourceUrl = state.objectUrl;
    } else {
      state.sourceType = 'existing';
      state.sourceUrl = source.url;
      const sourcePath = source.url.split('?')[0] ?? source.url;
      const sourceName = sourcePath.split('/').pop();
      state.sourceName = sourceName ?? 'profile-header.png';
    }

    const sourceUrl = state.sourceUrl;
    if (!sourceUrl) return;
    preview.src = sourceUrl;

    try {
      const image = await loadImageFromUrl(sourceUrl);
      if (token !== state.selectionToken) return;

      state.sourceWidth = image.naturalWidth || image.width;
      state.sourceHeight = image.naturalHeight || image.height;
    } catch (error: unknown) {
      if (token !== state.selectionToken) return;

      console.error(error);
      state.sourceType = 'none';
      state.sourceFile = undefined;
      state.sourceUrl = undefined;
      state.sourceWidth = 0;
      state.sourceHeight = 0;
      preview.src = preview.dataset.originalSrc ?? preview.src;
    }

    updateProfileHeaderPreviewTransform(state);
  };

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) {
      void loadHeaderSource({ file });
      return;
    }

    const originalSrc = preview.dataset.originalSrc;
    if (hasRealProfileHeaderImage(originalSrc)) {
      void loadHeaderSource({ url: originalSrc as string });
    } else {
      void loadHeaderSource();
    }
  });

  zoomInput.addEventListener('input', ({ target }) => {
    if (!(target instanceof HTMLInputElement)) return;

    state.zoom = clamp(
      Number(target.value) || PROFILE_HEADER_ZOOM_MIN,
      PROFILE_HEADER_ZOOM_MIN,
      PROFILE_HEADER_ZOOM_MAX,
    );
    updateProfileHeaderPreviewTransform(state);
  });

  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    if (state.sourceType === 'none' || state.maxOffsetY <= 0 || event.button !== 0)
      return;

    event.preventDefault();
    state.isDragging = true;
    state.dragStartY = event.clientY;
    state.dragStartOffsetY = state.offsetRatio;
    canvas.classList.add('is-dragging');
  });

  window.addEventListener('pointermove', (event: PointerEvent) => {
    if (!state.isDragging) return;

    const delta = event.clientY - state.dragStartY;
    const offsetY = clamp(
      state.dragStartOffsetY * state.maxOffsetY + delta,
      -state.maxOffsetY,
      state.maxOffsetY,
    );
    state.offsetRatio = state.maxOffsetY > 0 ? offsetY / state.maxOffsetY : 0;
    updateProfileHeaderPreviewTransform(state);
  });

  window.addEventListener('pointerup', () => {
    if (!state.isDragging) return;

    state.isDragging = false;
    canvas.classList.remove('is-dragging');
  });

  window.addEventListener('pointercancel', () => {
    if (!state.isDragging) return;

    state.isDragging = false;
    canvas.classList.remove('is-dragging');
  });

  window.addEventListener('resize', () => {
    updateProfileHeaderPreviewTransform(state);
  });

  form.addEventListener('submit', (event) => {
    if (state.isSubmitting) return;

    // Process only when user actually adjusted framing/zoom.
    if (state.sourceType === 'none' || !state.hasAdjustments) return;

    event.preventDefault();
    state.isSubmitting = true;

    void buildProcessedProfileHeader(state)
      .then(async (processedFile) => {
        if (state.sourceFile) {
          await setStoredProfileHeaderSource({
            accountId: state.accountId,
            file: state.sourceFile,
            fileName: state.sourceName,
            mimeType: state.sourceMimeType,
            zoom: state.zoom,
            offsetRatio: state.offsetRatio,
          });
        }

        if (processedFile && typeof DataTransfer !== 'undefined') {
          const transfer = new DataTransfer();
          transfer.items.add(processedFile);
          input.files = transfer.files;
        }
      })
      .catch((error: unknown) => {
        console.error(error);
      })
      .finally(() => {
        state.isSubmitting = false;
        form.submit();
      });
  });

  const originalSrc = preview.dataset.originalSrc;
  void getStoredProfileHeaderSource(state.accountId)
    .then((storedSource) => {
      if (storedSource) {
        const file = new File([storedSource.file], storedSource.fileName, {
          type: storedSource.mimeType,
        });

        return loadHeaderSource(
          { file },
          {
            zoom: storedSource.zoom,
            offsetRatio: storedSource.offsetRatio,
          },
        );
      }

      if (hasRealProfileHeaderImage(originalSrc)) {
        return loadHeaderSource({ url: originalSrc });
      }

      updateProfileHeaderPreviewTransform(state);
      return undefined;
    })
    .catch((error: unknown) => {
      console.error(error);
      updateProfileHeaderPreviewTransform(state);
    });
};

function loaded() {
  const { messages: localeData } = getLocale();

  const locale = document.documentElement.lang;

  const dateTimeFormat = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });

  const dateFormat = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const timeFormat = new Intl.DateTimeFormat(locale, {
    timeStyle: 'short',
  });

  const formatMessage = (
    { id, defaultMessage }: MessageDescriptor,
    values?: Record<string, PrimitiveType>,
  ) => {
    let message: string | undefined = undefined;

    if (id) message = localeData[id];

    message ??= defaultMessage as string;

    const messageFormat = new IntlMessageFormat(message, locale);
    return messageFormat.format(values) as string;
  };

  document.querySelectorAll('.emojify').forEach((content) => {
    content.innerHTML = emojify(content.innerHTML);
  });

  document
    .querySelectorAll<HTMLTimeElement>('time.formatted')
    .forEach((content) => {
      const datetime = new Date(content.dateTime);
      const formattedDate = dateTimeFormat.format(datetime);

      content.title = formattedDate;
      content.textContent = formattedDate;
    });

  const isToday = (date: Date) => {
    const today = new Date();

    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    );
  };
  const todayFormat = new IntlMessageFormat(
    localeData['relative_format.today'] ?? 'Today at {time}',
    locale,
  );

  document
    .querySelectorAll<HTMLTimeElement>('time.relative-formatted')
    .forEach((content) => {
      const datetime = new Date(content.dateTime);

      let formattedContent: string;

      if (isToday(datetime)) {
        const formattedTime = timeFormat.format(datetime);

        formattedContent = todayFormat.format({
          time: formattedTime,
        }) as string;
      } else {
        formattedContent = dateFormat.format(datetime);
      }

      const timeGiven = content.dateTime.includes('T');
      content.title = timeGiven
        ? dateTimeFormat.format(datetime)
        : dateFormat.format(datetime);

      content.textContent = formattedContent;
    });

  document
    .querySelectorAll<HTMLTimeElement>('time.time-ago')
    .forEach((content) => {
      const datetime = new Date(content.dateTime);
      const now = new Date();

      const timeGiven = content.dateTime.includes('T');
      content.title = timeGiven
        ? dateTimeFormat.format(datetime)
        : dateFormat.format(datetime);
      content.textContent = timeAgoString(
        {
          formatMessage,
          formatDate: (date: Date, options) =>
            new Intl.DateTimeFormat(locale, options).format(date),
        },
        datetime,
        now.getTime(),
        now.getFullYear(),
        timeGiven,
      );
    });

  updateDefaultQuotePrivacyFromPrivacy(
    document.querySelector('#user_settings_attributes_default_privacy'),
  );

  const reactComponents = document.querySelectorAll('[data-component]');

  if (reactComponents.length > 0) {
    import('../mastodon/containers/media_container')
      .then(({ default: MediaContainer }) => {
        reactComponents.forEach((component) => {
          Array.from(component.children).forEach((child) => {
            component.removeChild(child);
          });
        });

        const content = document.createElement('div');

        const root = createRoot(content);
        root.render(
          <MediaContainer locale={locale} components={reactComponents} />,
        );
        document.body.appendChild(content);

        return true;
      })
      .catch((error: unknown) => {
        console.error(error);
      });
  }

  on(
    'input',
    'input#user_account_attributes_username',
    throttle(
      ({ target }) => {
        if (!(target instanceof HTMLInputElement)) return;

        const checkedUsername = target.value;
        if (checkedUsername && checkedUsername.length > 0) {
          axios
            .get('/api/v1/accounts/lookup', {
              params: { acct: checkedUsername },
            })
            .then(() => {
              // Only update the validity if the result is for the currently-typed username
              if (checkedUsername === target.value) {
                target.setCustomValidity(formatMessage(messages.usernameTaken));
              }

              return true;
            })
            .catch(() => {
              // Only update the validity if the result is for the currently-typed username
              if (checkedUsername === target.value) {
                target.setCustomValidity('');
              }
            });
        } else {
          target.setCustomValidity('');
        }
      },
      500,
      { leading: false, trailing: true },
    ),
  );

  on('input', '#user_password,#user_password_confirmation', () => {
    const password = document.querySelector<HTMLInputElement>(
      'input#user_password',
    );
    const confirmation = document.querySelector<HTMLInputElement>(
      'input#user_password_confirmation',
    );
    if (!confirmation || !password) return;

    if (confirmation.value && confirmation.value.length > password.maxLength) {
      confirmation.setCustomValidity(
        formatMessage(messages.passwordExceedsLength),
      );
    } else if (password.value && password.value !== confirmation.value) {
      confirmation.setCustomValidity(
        formatMessage(messages.passwordDoesNotMatch),
      );
    } else {
      confirmation.setCustomValidity('');
    }
  });

  initializeProfileHeaderEditor();
}

on('change', '#edit_profile input[type=file]', ({ target }) => {
  if (!(target instanceof HTMLInputElement)) return;
  if (target.id === 'account_header') return;

  const preview = document.querySelector<HTMLImageElement>(
    `img#${target.id}-preview`,
  );

  if (!preview) return;

  preview.dataset.originalSrc ??= preview.getAttribute('src') ?? '';

  let file: File | undefined;
  if (target.files) file = target.files[0];

  const url = file ? URL.createObjectURL(file) : preview.dataset.originalSrc;

  if (url) preview.src = url;
});

on('click', '.input-copy input', ({ target }) => {
  if (!(target instanceof HTMLInputElement)) return;

  target.focus();
  target.select();
  target.setSelectionRange(0, target.value.length);
});

on('click', '.input-copy button', ({ target }) => {
  if (!(target instanceof HTMLButtonElement)) return;

  const input = target.parentNode?.querySelector<HTMLInputElement>(
    '.input-copy__wrapper input',
  );

  if (!input) return;

  navigator.clipboard
    .writeText(input.value)
    .then(() => {
      const parent = target.parentElement;

      if (parent) {
        parent.classList.add('copied');

        setTimeout(() => {
          parent.classList.remove('copied');
        }, 700);
      }

      return true;
    })
    .catch((error: unknown) => {
      console.error(error);
    });
});

const toggleSidebar = () => {
  const sidebar = document.querySelector<HTMLUListElement>('.sidebar ul');
  const toggleButton = document.querySelector<HTMLAnchorElement>(
    'a.sidebar__toggle__icon',
  );

  if (!sidebar || !toggleButton) return;

  if (sidebar.classList.contains('visible')) {
    document.body.style.overflow = '';
    toggleButton.setAttribute('aria-expanded', 'false');
  } else {
    document.body.style.overflow = 'hidden';
    toggleButton.setAttribute('aria-expanded', 'true');
  }

  toggleButton.classList.toggle('active');
  sidebar.classList.toggle('visible');
};

on('click', '.sidebar__toggle__icon', () => {
  toggleSidebar();
});

on('keydown', '.sidebar__toggle__icon', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    toggleSidebar();
  }
});

on('mouseover', 'img.custom-emoji', ({ target }) => {
  if (target instanceof HTMLImageElement && target.dataset.original)
    target.src = target.dataset.original;
});
on('mouseout', 'img.custom-emoji', ({ target }) => {
  if (target instanceof HTMLImageElement && target.dataset.static)
    target.src = target.dataset.static;
});

const setInputDisabled = (
  input: HTMLInputElement | HTMLSelectElement,
  disabled: boolean,
) => {
  input.disabled = disabled;

  const wrapper = input.closest('.with_label');
  if (wrapper) {
    wrapper.classList.toggle('disabled', input.disabled);

    const hidden =
      input.type === 'checkbox' &&
      wrapper.querySelector<HTMLInputElement>('input[type=hidden][value="0"]');
    if (hidden) {
      hidden.disabled = input.disabled;
    }
  }
};

const setInputHint = (
  input: HTMLInputElement | HTMLSelectElement,
  hintPrefix: string,
) => {
  const fieldWrapper = input.closest<HTMLElement>('.fields-group > .input');
  if (!fieldWrapper) return;

  const hint = fieldWrapper.dataset[`${hintPrefix}Hint`];
  const hintElement =
    fieldWrapper.querySelector<HTMLSpanElement>(':scope > .hint');

  if (hint) {
    if (hintElement) {
      hintElement.textContent = hint;
    } else {
      const newHintElement = document.createElement('span');
      newHintElement.className = 'hint';
      newHintElement.textContent = hint;
      fieldWrapper.appendChild(newHintElement);
    }
  } else {
    hintElement?.remove();
  }
};

on('change', '#account_statuses_cleanup_policy_enabled', ({ target }) => {
  if (!(target instanceof HTMLInputElement) || !target.form) return;

  target.form
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input:not([type=hidden], #account_statuses_cleanup_policy_enabled), select',
    )
    .forEach((input) => {
      setInputDisabled(input, !target.checked);
    });
});

const updateDefaultQuotePrivacyFromPrivacy = (
  privacySelect: EventTarget | null,
) => {
  if (!(privacySelect instanceof HTMLSelectElement) || !privacySelect.form)
    return;

  const select = privacySelect.form.querySelector<HTMLSelectElement>(
    'select#user_settings_attributes_default_quote_policy',
  );
  if (!select) return;

  setInputHint(select, privacySelect.value);

  if (privacySelect.value === 'private') {
    select.value = 'nobody';
    setInputDisabled(select, true);
  } else {
    setInputDisabled(select, false);
  }
};

on('change', '#user_settings_attributes_default_privacy', ({ target }) => {
  updateDefaultQuotePrivacyFromPrivacy(target);
});

// Empty the honeypot fields in JS in case something like an extension
// automatically filled them.
on('submit', '#registration_new_user,#new_user', () => {
  [
    'user_website',
    'user_confirm_password',
    'registration_user_website',
    'registration_user_confirm_password',
  ].forEach((id) => {
    const field = document.querySelector<HTMLInputElement>(`input#${id}`);
    if (field) {
      field.value = '';
    }
  });
});

on('click', '.rules-list button', ({ target }) => {
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest('button');

  if (!button) {
    return;
  }

  if (button.ariaExpanded === 'true') {
    button.ariaExpanded = 'false';
  } else {
    button.ariaExpanded = 'true';
  }
});

function main() {
  ready(loaded).catch((error: unknown) => {
    console.error(error);
  });
}

loadPolyfills()
  .then(loadLocale)
  .then(main)
  .then(loadKeyboardExtensions)
  .catch((error: unknown) => {
    console.error(error);
  });
