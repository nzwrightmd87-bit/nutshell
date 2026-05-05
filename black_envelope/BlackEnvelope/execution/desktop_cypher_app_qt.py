#!/usr/bin/env python3
"""Qt desktop UI for local encrypt/decrypt message and media flow."""

from __future__ import annotations

import mimetypes
import secrets
import sys
from pathlib import Path
from typing import Callable

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QGuiApplication, QIcon, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QFileDialog,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

try:
    from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
    from PySide6.QtMultimediaWidgets import QVideoWidget

    VIDEO_PREVIEW_SUPPORTED = True
except Exception:
    QAudioOutput = None  # type: ignore[assignment]
    QMediaPlayer = None  # type: ignore[assignment]
    QVideoWidget = None  # type: ignore[assignment]
    VIDEO_PREVIEW_SUPPORTED = False

from cipher_engine import (
    CipherError,
    DecryptedFile,
    FILE_TOKEN_PREFIX,
    decrypt_file_from_cypher,
    decrypt_from_cypher,
    encrypt_file_to_cypher,
    encrypt_to_cypher,
)

ATTACHMENT_MARKER = "[Attached media]"
LOADED_FILE_MARKER = "[Loaded encrypted file]"
HIDDEN_TOKEN_MARKER = "[Encrypted media token hidden due size]"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}
MAX_MEDIA_BYTES_FOR_TOKEN = 8 * 1024 * 1024
MAX_TOKEN_CHARS_FOR_CLIPBOARD = 250_000


def _human_size(num_bytes: int) -> str:
    value = float(num_bytes)
    units = ["B", "KB", "MB", "GB", "TB"]
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{int(num_bytes)} B"


def _looks_like_media_file(path: Path) -> bool:
    mime_type, _ = mimetypes.guess_type(str(path))
    if mime_type and (mime_type.startswith("image/") or mime_type.startswith("video/")):
        return True
    suffix = path.suffix.lower()
    return suffix in IMAGE_SUFFIXES or suffix in VIDEO_SUFFIXES


def _is_image_file(filename: str, media_type: str) -> bool:
    return media_type.startswith("image/") or Path(filename).suffix.lower() in IMAGE_SUFFIXES


def _is_video_file(filename: str, media_type: str) -> bool:
    return media_type.startswith("video/") or Path(filename).suffix.lower() in VIDEO_SUFFIXES


class DropAwareTextEdit(QTextEdit):
    """QTextEdit that accepts drag-and-drop image/video files."""

    def __init__(self, *, on_media_drop: Callable[[Path], None], parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._on_media_drop = on_media_drop
        self.setAcceptDrops(True)

    def dragEnterEvent(self, event) -> None:  # type: ignore[override]
        path = self._extract_local_file_from_event(event)
        if path and _looks_like_media_file(path):
            event.acceptProposedAction()
            return
        super().dragEnterEvent(event)

    def dragMoveEvent(self, event) -> None:  # type: ignore[override]
        path = self._extract_local_file_from_event(event)
        if path and _looks_like_media_file(path):
            event.acceptProposedAction()
            return
        super().dragMoveEvent(event)

    def dropEvent(self, event) -> None:  # type: ignore[override]
        path = self._extract_local_file_from_event(event)
        if path and _looks_like_media_file(path):
            self._on_media_drop(path)
            event.acceptProposedAction()
            return
        super().dropEvent(event)

    @staticmethod
    def _extract_local_file_from_event(event) -> Path | None:
        mime_data = event.mimeData()
        if not mime_data or not mime_data.hasUrls():
            return None
        for url in mime_data.urls():
            if url.isLocalFile():
                return Path(url.toLocalFile())
        return None


class CypherDesktopQtWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self._outgoing_media_path: Path | None = None
        self._last_outgoing_token: str | None = None
        self._incoming_loaded_token: str | None = None
        self._decrypted_file: DecryptedFile | None = None
        self._preview_media_path: Path | None = None
        self._updating_outgoing_text = False

        self.video_widget: QVideoWidget | None = None
        self._video_player: QMediaPlayer | None = None
        self._video_audio: QAudioOutput | None = None

        self.setWindowTitle("Black Envelope")
        self.resize(1020, 760)
        self._apply_window_icon()
        self._build_ui()

    def _build_ui(self) -> None:
        central = QWidget(self)
        self.setCentralWidget(central)

        root = QVBoxLayout(central)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(10)

        root.addWidget(self._build_brand_row())
        root.addWidget(self._build_key_row())
        root.addLayout(self._build_message_panels())

        self.status_label = QLabel(
            "Ready. Keep passphrase private and share it over a separate secure channel."
        )
        self.status_label.setWordWrap(True)
        root.addWidget(self.status_label)

    def _build_brand_row(self) -> QWidget:
        panel = QWidget(self)
        row = QHBoxLayout(panel)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(10)

        logo = QLabel(self)
        pixmap = QPixmap(str(self._resource_path("execution/assets/black_envelope_logo.png")))
        if not pixmap.isNull():
            logo.setPixmap(pixmap.scaled(42, 42, Qt.KeepAspectRatio, Qt.SmoothTransformation))
        row.addWidget(logo, alignment=Qt.AlignVCenter)

        title = QLabel("Black Envelope")
        title.setStyleSheet("font-size: 22px; font-weight: 700;")
        row.addWidget(title, alignment=Qt.AlignVCenter)

        row.addStretch(1)
        return panel

    def _build_key_row(self) -> QWidget:
        panel = QWidget(self)
        row = QHBoxLayout(panel)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(8)

        row.addWidget(QLabel("Shared passphrase:"))

        self.passphrase_input = QLineEdit(self)
        self.passphrase_input.setEchoMode(QLineEdit.Password)
        self.passphrase_input.setPlaceholderText("Enter shared secret")
        row.addWidget(self.passphrase_input, stretch=1)

        self.show_key = QCheckBox("Show", self)
        self.show_key.toggled.connect(self._toggle_show_passphrase)
        row.addWidget(self.show_key)

        gen_btn = QPushButton("Generate Strong Key", self)
        gen_btn.clicked.connect(self._generate_passphrase)
        row.addWidget(gen_btn)

        return panel

    def _build_message_panels(self) -> QHBoxLayout:
        layout = QHBoxLayout()
        layout.setSpacing(10)
        layout.addWidget(self._build_outgoing_group(), stretch=1)
        layout.addWidget(self._build_incoming_group(), stretch=1)
        return layout

    def _build_outgoing_group(self) -> QGroupBox:
        group = QGroupBox("Outgoing")
        grid = QGridLayout(group)
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(8)

        grid.addWidget(QLabel("Outgoing Message or Dropped Media"), 0, 0, 1, 2)
        self.outgoing_plain = DropAwareTextEdit(on_media_drop=self._set_outgoing_media_file, parent=self)
        self.outgoing_plain.setPlaceholderText(
            "Type message to encrypt, or drag and drop an image/video file here"
        )
        self.outgoing_plain.textChanged.connect(self._handle_outgoing_text_change)
        grid.addWidget(self.outgoing_plain, 1, 0, 1, 2)

        encrypt_btn = QPushButton("Encrypt Message", self)
        encrypt_btn.clicked.connect(self._encrypt_message)
        grid.addWidget(encrypt_btn, 2, 0)

        clear_btn = QPushButton("Clear", self)
        clear_btn.clicked.connect(self._clear_outgoing)
        grid.addWidget(clear_btn, 2, 1, alignment=Qt.AlignRight)

        grid.addWidget(QLabel("Cyphertext to Send"), 3, 0, 1, 2)
        self.outgoing_cipher = QTextEdit(self)
        self.outgoing_cipher.setPlaceholderText("Encrypted output appears here")
        grid.addWidget(self.outgoing_cipher, 4, 0, 1, 2)

        copy_btn = QPushButton("Copy Cyphertext", self)
        copy_btn.clicked.connect(lambda: self._copy_text(self.outgoing_cipher))
        grid.addWidget(copy_btn, 5, 0, 1, 2, alignment=Qt.AlignLeft)

        attach_btn = QPushButton("Attach Image/Video...", self)
        attach_btn.clicked.connect(self._attach_media_file)
        grid.addWidget(attach_btn, 6, 0, 1, 2, alignment=Qt.AlignLeft)

        return group

    def _build_incoming_group(self) -> QGroupBox:
        group = QGroupBox("Incoming")
        grid = QGridLayout(group)
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(8)

        grid.addWidget(QLabel("Incoming Cyphertext"), 0, 0, 1, 2)
        self.incoming_cipher = QTextEdit(self)
        self.incoming_cipher.setPlaceholderText("Paste cyphertext from sender")
        grid.addWidget(self.incoming_cipher, 1, 0, 1, 2)

        decrypt_btn = QPushButton("Decrypt Message", self)
        decrypt_btn.clicked.connect(self._decrypt_message)
        grid.addWidget(decrypt_btn, 2, 0)

        clear_btn = QPushButton("Clear", self)
        clear_btn.clicked.connect(self._clear_incoming)
        grid.addWidget(clear_btn, 2, 1, alignment=Qt.AlignRight)

        grid.addWidget(QLabel("Decoded Output"), 3, 0, 1, 2)
        self.decoded_plain = QTextEdit(self)
        self.decoded_plain.setPlaceholderText("Plaintext or decrypted media details appear here")
        grid.addWidget(self.decoded_plain, 4, 0, 1, 2)

        self.preview_label = QLabel(self)
        self.preview_label.setMinimumHeight(220)
        self.preview_label.setAlignment(Qt.AlignCenter)
        self.preview_label.setStyleSheet("border: 1px solid #cfcfcf; background: #fafafa; color: #3a3a3a;")
        self.preview_label.hide()
        grid.addWidget(self.preview_label, 5, 0, 1, 2)

        if VIDEO_PREVIEW_SUPPORTED and QVideoWidget and QMediaPlayer and QAudioOutput:
            self.video_widget = QVideoWidget(self)
            self.video_widget.setMinimumHeight(220)
            self.video_widget.hide()
            grid.addWidget(self.video_widget, 6, 0, 1, 2)

            self._video_player = QMediaPlayer(self)
            self._video_audio = QAudioOutput(self)
            self._video_audio.setVolume(0.0)
            self._video_player.setAudioOutput(self._video_audio)
            self._video_player.setVideoOutput(self.video_widget)

        action_row = QWidget(self)
        actions = QHBoxLayout(action_row)
        actions.setContentsMargins(0, 0, 0, 0)
        actions.setSpacing(8)

        copy_btn = QPushButton("Copy Decoded Text", self)
        copy_btn.clicked.connect(lambda: self._copy_text(self.decoded_plain))
        actions.addWidget(copy_btn)

        load_encrypted_btn = QPushButton("Load Encrypted File...", self)
        load_encrypted_btn.clicked.connect(self._load_encrypted_file)
        actions.addWidget(load_encrypted_btn)

        self.download_btn = QPushButton("Download Decrypted File...", self)
        self.download_btn.setEnabled(False)
        self.download_btn.clicked.connect(self._download_decrypted_file)
        actions.addWidget(self.download_btn)

        actions.addStretch(1)
        grid.addWidget(action_row, 7, 0, 1, 2)

        return group

    def _toggle_show_passphrase(self, checked: bool) -> None:
        mode = QLineEdit.Normal if checked else QLineEdit.Password
        self.passphrase_input.setEchoMode(mode)

    def _generate_passphrase(self) -> None:
        self.passphrase_input.setText(secrets.token_urlsafe(32))
        self._set_status("Generated a strong passphrase. Share it securely.")

    def _handle_outgoing_text_change(self) -> None:
        if self._updating_outgoing_text:
            return
        if self._outgoing_media_path is None:
            return

        current = self.outgoing_plain.toPlainText().strip()
        if not current.startswith(ATTACHMENT_MARKER):
            self._outgoing_media_path = None
            self._set_status("Media attachment removed. Encrypt will use text input.")

    def _attach_media_file(self) -> None:
        source_path = self._pick_source_media_file()
        if source_path is None:
            self._set_status("Media selection cancelled.")
            return
        self._set_outgoing_media_file(source_path)

    def _set_outgoing_media_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            QMessageBox.critical(self, "File Error", "Selected file does not exist.")
            self._set_status("Invalid media file selection.")
            return
        if not _looks_like_media_file(path):
            QMessageBox.warning(
                self,
                "Unsupported File",
                "Only image and video files are supported for drag-and-drop encryption.",
            )
            self._set_status("Unsupported file type.")
            return

        self._outgoing_media_path = path
        size_text = _human_size(path.stat().st_size)
        note = (
            f"{ATTACHMENT_MARKER}\n"
            f"File: {path.name}\n"
            f"Size: {size_text}\n"
            "Click Encrypt Message to transform this file into ciphertext."
        )
        self._set_outgoing_plain_text(note)
        self._set_status(f"Attached media: {path.name}. Ready to encrypt.")

    def _encrypt_message(self) -> None:
        passphrase = self.passphrase_input.text()

        if self._outgoing_media_path is not None:
            source_path = self._outgoing_media_path
            try:
                file_size = source_path.stat().st_size
            except OSError as exc:
                QMessageBox.critical(self, "File Error", f"Could not read file metadata:\n{exc}")
                self._set_status("Media file metadata read failed.")
                return
            if file_size > MAX_MEDIA_BYTES_FOR_TOKEN:
                QMessageBox.warning(
                    self,
                    "File Too Large",
                    (
                        "This file is too large for clipboard token transfer.\n\n"
                        f"Limit: {_human_size(MAX_MEDIA_BYTES_FOR_TOKEN)}\n"
                        f"Selected: {_human_size(file_size)}\n\n"
                        "Use a smaller image/video."
                    ),
                )
                self._set_status("Media file is too large for this desktop flow.")
                return
            try:
                file_bytes = source_path.read_bytes()
            except OSError as exc:
                QMessageBox.critical(self, "File Error", f"Could not read file:\n{exc}")
                self._set_status("Media file read failed.")
                return

            media_type = mimetypes.guess_type(str(source_path))[0] or "application/octet-stream"
            try:
                cyphertext = encrypt_file_to_cypher(
                    file_bytes=file_bytes,
                    filename=source_path.name,
                    passphrase=passphrase,
                    media_type=media_type,
                )
            except CipherError as exc:
                QMessageBox.critical(self, "Encryption Error", str(exc))
                self._set_status("Media encryption failed.")
                return

            if len(cyphertext) <= MAX_TOKEN_CHARS_FOR_CLIPBOARD:
                self._last_outgoing_token = cyphertext
                self.outgoing_cipher.setPlainText(cyphertext)
                self._set_status("Media encrypted to token. Copy and paste into Incoming Cyphertext.")
            else:
                saved_path = self._save_encrypted_token_file(cyphertext=cyphertext, source_name=source_path.name)
                self._last_outgoing_token = None
                if saved_path is None:
                    self.outgoing_cipher.setPlainText(
                        (
                            f"{HIDDEN_TOKEN_MARKER}\n"
                            f"Token length: {len(cyphertext):,} characters\n"
                            "Save was cancelled. Use a smaller file to keep copy/paste flow responsive."
                        )
                    )
                    self._set_status("Large token not copied. Save encrypted file to avoid UI freeze.")
                else:
                    self.outgoing_cipher.setPlainText(
                        (
                            f"{HIDDEN_TOKEN_MARKER}\n"
                            f"Token length: {len(cyphertext):,} characters\n"
                            f"Saved encrypted file: {saved_path}\n"
                            "Use Load Encrypted File... on the Incoming side."
                        )
                    )
                    self._set_status("Large media saved as .cyf. Use Load Encrypted File... to decrypt.")
            return

        plaintext = self.outgoing_plain.toPlainText().strip()
        try:
            cyphertext = encrypt_to_cypher(plaintext=plaintext, passphrase=passphrase)
        except CipherError as exc:
            QMessageBox.critical(self, "Encryption Error", str(exc))
            self._set_status("Encryption failed.")
            return

        self._last_outgoing_token = cyphertext
        self.outgoing_cipher.setPlainText(cyphertext)
        self._set_status("Message encrypted locally. Share only cyphertext.")

    def _decrypt_message(self) -> None:
        cyphertext = self._resolve_incoming_cyphertext()
        if cyphertext is None:
            return
        passphrase = self.passphrase_input.text()

        if not cyphertext:
            self._set_status("Nothing to decrypt.")
            return

        if cyphertext.startswith(FILE_TOKEN_PREFIX):
            try:
                decrypted_file = decrypt_file_from_cypher(cyphertext=cyphertext, passphrase=passphrase)
            except CipherError as exc:
                QMessageBox.critical(self, "Decryption Error", str(exc))
                self._set_status("Media decryption failed.")
                return

            self._decrypted_file = decrypted_file
            self.download_btn.setEnabled(True)
            self._show_decrypted_media(decrypted_file)
            self._set_status("Media decrypted. Preview loaded. Use Download to save the file.")
            return

        try:
            plaintext = decrypt_from_cypher(cyphertext=cyphertext, passphrase=passphrase)
        except CipherError as exc:
            QMessageBox.critical(self, "Decryption Error", str(exc))
            self._set_status("Decryption failed.")
            return

        self._decrypted_file = None
        self.download_btn.setEnabled(False)
        self._clear_preview()
        self.decoded_plain.setPlainText(plaintext)
        self._set_status("Cyphertext decrypted locally.")

    def _resolve_incoming_cyphertext(self) -> str | None:
        current = self.incoming_cipher.toPlainText().strip()
        if not current:
            return self._incoming_loaded_token or ""

        if current.startswith(LOADED_FILE_MARKER):
            if self._incoming_loaded_token:
                return self._incoming_loaded_token
            QMessageBox.warning(
                self,
                "Encrypted File Missing",
                "Loaded file token is unavailable. Load the .cyf file again.",
            )
            self._set_status("Loaded file token missing. Reload encrypted file.")
            return None

        if current.startswith(HIDDEN_TOKEN_MARKER):
            QMessageBox.information(
                self,
                "Token Not Present",
                "This is a summary view, not actual ciphertext. Use Load Encrypted File... and decrypt from the .cyf file.",
            )
            self._set_status("Summary text cannot be decrypted. Load encrypted .cyf file.")
            return None

        # Only treat incoming text as a file path when it looks path-like and short.
        path_candidate = current.strip().strip("\"'")
        if len(path_candidate) <= 4096 and "\n" not in path_candidate and "\r" not in path_candidate:
            possible_path = Path(path_candidate).expanduser()
            try:
                if possible_path.is_file() and possible_path.suffix.lower() == ".cyf":
                    token = self._read_token_from_file(possible_path)
                    if token is None:
                        return None
                    return token
            except OSError:
                pass

        return current.lstrip("\ufeff")

    def _show_decrypted_media(self, decrypted_file: DecryptedFile) -> None:
        media_type = (decrypted_file.media_type or "application/octet-stream").strip().lower()
        details = [
            ATTACHMENT_MARKER,
            f"Filename: {decrypted_file.filename}",
            f"Type: {media_type}",
            f"Size: {_human_size(len(decrypted_file.data))}",
        ]
        self.decoded_plain.setPlainText("\n".join(details))
        self._render_media_preview(decrypted_file)

    def _render_media_preview(self, decrypted_file: DecryptedFile) -> None:
        self._clear_preview()
        media_type = (decrypted_file.media_type or "application/octet-stream").strip().lower()

        if _is_image_file(decrypted_file.filename, media_type):
            pixmap = QPixmap()
            if pixmap.loadFromData(decrypted_file.data):
                self.preview_label.setPixmap(
                    pixmap.scaled(420, 260, Qt.KeepAspectRatio, Qt.SmoothTransformation)
                )
                self.preview_label.setText("")
                self.preview_label.show()
            else:
                self._show_preview_text("Image decrypted, but preview could not be rendered.")
            return

        if _is_video_file(decrypted_file.filename, media_type):
            if self._video_player is not None and self.video_widget is not None:
                preview_file = self._write_preview_file(decrypted_file)
                self._preview_media_path = preview_file
                self.video_widget.show()
                self._video_player.setSource(QUrl.fromLocalFile(str(preview_file)))
                self._video_player.play()
            else:
                self._show_preview_text("Video decrypted. Preview is unavailable on this build.")
            return

        self._show_preview_text("File decrypted. Preview is available only for images and videos.")

    def _write_preview_file(self, decrypted_file: DecryptedFile) -> Path:
        previews_dir = Path.cwd() / ".tmp" / "desktop_previews"
        previews_dir.mkdir(parents=True, exist_ok=True)
        safe_name = Path(decrypted_file.filename).name
        preview_path = previews_dir / f"preview_{secrets.token_hex(8)}_{safe_name}"
        preview_path.write_bytes(decrypted_file.data)
        return preview_path

    def _download_decrypted_file(self) -> None:
        if self._decrypted_file is None:
            self._set_status("No decrypted file to download.")
            return

        suggested = self._default_save_dir() / self._decrypted_file.filename
        target_raw, _ = QFileDialog.getSaveFileName(
            self,
            "Download Decrypted File",
            str(suggested),
            "All Files (*)",
        )
        if not target_raw:
            self._set_status("Download cancelled.")
            return

        target_path = Path(target_raw)
        try:
            target_path.write_bytes(self._decrypted_file.data)
        except OSError as exc:
            if getattr(exc, "errno", None) == 30:
                QMessageBox.critical(
                    self,
                    "Read-only Location",
                    (
                        "Could not save because this location is read-only.\n\n"
                        "Choose a writable folder like Downloads or Desktop."
                    ),
                )
                self._set_status("Selected save location is read-only.")
                return
            QMessageBox.critical(self, "File Error", f"Could not save decrypted file:\n{exc}")
            self._set_status("Download failed.")
            return

        self._set_status(f"Decrypted file saved to {target_path.name}.")

    def _load_encrypted_file(self) -> None:
        source_raw, _ = QFileDialog.getOpenFileName(
            self,
            "Load Encrypted File",
            "",
            "Cypher Encrypted Files (*.cyf);;All Files (*)",
        )
        if not source_raw:
            self._set_status("Encrypted file load cancelled.")
            return

        source_path = Path(source_raw)
        token = self._read_token_from_file(source_path)
        if token is None:
            return

        self._incoming_loaded_token = token
        self.incoming_cipher.blockSignals(True)
        self.incoming_cipher.setPlainText(
            (
                f"{LOADED_FILE_MARKER}\n"
                f"File: {source_path.name}\n"
                f"Token length: {len(token):,} characters\n"
                "Click Decrypt Message."
            )
        )
        self.incoming_cipher.blockSignals(False)
        self._set_status("Encrypted file loaded. Click Decrypt Message.")

    def _read_token_from_file(self, source_path: Path) -> str | None:
        try:
            token = source_path.read_text(encoding="utf-8").strip().lstrip("\ufeff")
        except OSError as exc:
            QMessageBox.critical(self, "File Error", f"Could not read encrypted file:\n{exc}")
            self._set_status("Encrypted file read failed.")
            return None
        except UnicodeDecodeError:
            QMessageBox.critical(
                self,
                "File Error",
                "Encrypted file is not valid text. Expected a .cyf file from this app.",
            )
            self._set_status("Encrypted file format is invalid.")
            return None

        if not token:
            QMessageBox.warning(self, "File Error", "Encrypted file is empty.")
            self._set_status("Encrypted file is empty.")
            return None

        return token

    def _save_encrypted_token_file(self, *, cyphertext: str, source_name: str) -> Path | None:
        suggested = self._default_save_dir() / f"{Path(source_name).name}.cyf"
        target_raw, _ = QFileDialog.getSaveFileName(
            self,
            "Save Encrypted File",
            str(suggested),
            "Cypher Encrypted Files (*.cyf);;All Files (*)",
        )
        if not target_raw:
            return None

        target_path = Path(target_raw)
        if target_path.suffix.lower() != ".cyf":
            target_path = target_path.with_name(f"{target_path.name}.cyf")

        try:
            target_path.write_text(cyphertext, encoding="utf-8")
        except OSError as exc:
            if getattr(exc, "errno", None) == 30:
                QMessageBox.critical(
                    self,
                    "Read-only Location",
                    (
                        "Could not save because this location is read-only.\n\n"
                        "Choose a writable folder like Downloads or Desktop."
                    ),
                )
                self._set_status("Selected save location is read-only.")
                return None
            QMessageBox.critical(self, "File Error", f"Could not save encrypted file:\n{exc}")
            self._set_status("Encrypted file save failed.")
            return None
        return target_path

    @staticmethod
    def _default_save_dir() -> Path:
        downloads = Path.home() / "Downloads"
        if downloads.exists() and downloads.is_dir():
            return downloads
        return Path.home()

    def _clear_outgoing(self) -> None:
        self._outgoing_media_path = None
        self._last_outgoing_token = None
        self._set_outgoing_plain_text("")
        self.outgoing_cipher.clear()
        self._set_status("Outgoing fields cleared.")

    def _clear_incoming(self) -> None:
        self.incoming_cipher.clear()
        self._incoming_loaded_token = None
        self.decoded_plain.clear()
        self._decrypted_file = None
        self.download_btn.setEnabled(False)
        self._clear_preview()
        self._set_status("Incoming fields cleared.")

    def _clear_preview(self) -> None:
        if self._video_player is not None:
            self._video_player.stop()
            self._video_player.setSource(QUrl())
        if self.video_widget is not None:
            self.video_widget.hide()

        self.preview_label.clear()
        self.preview_label.hide()

        if self._preview_media_path is not None:
            try:
                self._preview_media_path.unlink(missing_ok=True)
            except OSError:
                pass
            self._preview_media_path = None

    def _show_preview_text(self, message: str) -> None:
        self.preview_label.setPixmap(QPixmap())
        self.preview_label.setText(message)
        self.preview_label.show()

    def _set_outgoing_plain_text(self, value: str) -> None:
        self._updating_outgoing_text = True
        self.outgoing_plain.setPlainText(value)
        self._updating_outgoing_text = False

    def _copy_text(self, widget: QTextEdit) -> None:
        if widget is self.outgoing_cipher and self._last_outgoing_token:
            visible = self.outgoing_cipher.toPlainText().strip()
            if (
                visible.startswith(HIDDEN_TOKEN_MARKER)
                or visible == self._last_outgoing_token
            ):
                QGuiApplication.clipboard().setText(self._last_outgoing_token)
                self._set_status("Copied full cyphertext token to clipboard.")
                return
        elif widget is self.outgoing_cipher:
            visible = self.outgoing_cipher.toPlainText().strip()
            if visible.startswith(HIDDEN_TOKEN_MARKER):
                self._set_status("Large token was saved as .cyf file. Use that file instead of clipboard.")
                return

        value = widget.toPlainText().strip()
        if not value:
            self._set_status("Nothing to copy.")
            return
        QGuiApplication.clipboard().setText(value)
        self._set_status("Copied to clipboard.")

    def _pick_source_media_file(self) -> Path | None:
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "Select Image or Video",
            "",
            (
                "Media Files (*.png *.jpg *.jpeg *.gif *.webp *.bmp *.tif *.tiff *.mp4 *.mov *.avi *.mkv *.webm *.m4v);;"
                "Image Files (*.png *.jpg *.jpeg *.gif *.webp *.bmp *.tif *.tiff);;"
                "Video Files (*.mp4 *.mov *.avi *.mkv *.webm *.m4v);;"
                "All Files (*)"
            ),
        )
        if not file_path:
            return None
        return Path(file_path)

    def _set_status(self, message: str) -> None:
        self.status_label.setText(message)

    def _apply_window_icon(self) -> None:
        icon_path = self._resource_path("execution/assets/black_envelope_icon.png")
        if icon_path.is_file():
            self.setWindowIcon(QIcon(str(icon_path)))

    @staticmethod
    def _resource_path(relative_path: str) -> Path:
        if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
            return Path(getattr(sys, "_MEIPASS")) / relative_path
        return Path(__file__).resolve().parents[1] / relative_path


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Black Envelope")
    app.setApplicationDisplayName("Black Envelope")
    icon_path = CypherDesktopQtWindow._resource_path("execution/assets/black_envelope_icon.png")
    if icon_path.is_file():
        app.setWindowIcon(QIcon(str(icon_path)))
    window = CypherDesktopQtWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
