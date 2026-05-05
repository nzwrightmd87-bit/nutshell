#!/usr/bin/env python3
"""Simple desktop UI for local encrypt/decrypt message flow."""

from __future__ import annotations

import secrets
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, ttk

from cipher_engine import CipherError, decrypt_from_cypher, encrypt_to_cypher


class CypherDesktopApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Black Envelope")
        self.geometry("980x680")
        self.minsize(880, 620)
        self._apply_window_icon()
        self._build_ui()

    def _build_ui(self) -> None:
        root = ttk.Frame(self, padding=12)
        root.pack(fill="both", expand=True)
        root.columnconfigure(0, weight=1)
        root.rowconfigure(2, weight=1)

        title = ttk.Label(
            root,
            text="Black Envelope",
            font=("TkDefaultFont", 16, "bold"),
        )
        title.grid(row=0, column=0, sticky="w")

        key_row = ttk.Frame(root)
        key_row.grid(row=1, column=0, sticky="ew", pady=(10, 8))
        key_row.columnconfigure(1, weight=1)

        ttk.Label(key_row, text="Shared passphrase:").grid(row=0, column=0, sticky="w")
        self.passphrase_var = tk.StringVar()
        self.passphrase_entry = ttk.Entry(
            key_row,
            textvariable=self.passphrase_var,
            show="*",
        )
        self.passphrase_entry.grid(row=0, column=1, sticky="ew", padx=(8, 8))

        self.show_key_var = tk.BooleanVar(value=False)
        show_key = ttk.Checkbutton(
            key_row,
            text="Show",
            variable=self.show_key_var,
            command=self._toggle_passphrase_visibility,
        )
        show_key.grid(row=0, column=2, padx=(0, 8))

        ttk.Button(
            key_row,
            text="Generate Strong Key",
            command=self._generate_passphrase,
        ).grid(row=0, column=3)

        self.status_var = tk.StringVar(
            value="Ready. Keep passphrase private and share it over a separate secure channel."
        )
        status = ttk.Label(root, textvariable=self.status_var)
        status.grid(row=3, column=0, sticky="ew", pady=(8, 0))

        panels = ttk.PanedWindow(root, orient="horizontal")
        panels.grid(row=2, column=0, sticky="nsew")

        left = ttk.Frame(panels, padding=8)
        right = ttk.Frame(panels, padding=8)
        panels.add(left, weight=1)
        panels.add(right, weight=1)

        self._build_outgoing_panel(left)
        self._build_incoming_panel(right)

    def _build_outgoing_panel(self, container: ttk.Frame) -> None:
        container.columnconfigure(0, weight=1)
        container.rowconfigure(1, weight=1)
        container.rowconfigure(4, weight=1)

        ttk.Label(container, text="Outgoing Message", font=("TkDefaultFont", 11, "bold")).grid(
            row=0, column=0, sticky="w"
        )
        self.outgoing_plain = tk.Text(container, wrap="word", height=9)
        self.outgoing_plain.grid(row=1, column=0, sticky="nsew", pady=(6, 6))

        action_row = ttk.Frame(container)
        action_row.grid(row=2, column=0, sticky="ew", pady=(0, 6))
        action_row.columnconfigure(0, weight=1)
        ttk.Button(action_row, text="Encrypt Message", command=self._encrypt_ui).grid(
            row=0, column=0, sticky="w"
        )
        ttk.Button(action_row, text="Clear", command=self._clear_outgoing).grid(
            row=0, column=1, sticky="e"
        )

        ttk.Label(container, text="Cyphertext to Send", font=("TkDefaultFont", 11, "bold")).grid(
            row=3, column=0, sticky="w"
        )
        self.outgoing_cipher = tk.Text(container, wrap="word", height=12)
        self.outgoing_cipher.grid(row=4, column=0, sticky="nsew", pady=(6, 6))

        copy_row = ttk.Frame(container)
        copy_row.grid(row=5, column=0, sticky="ew")
        copy_row.columnconfigure(0, weight=1)
        ttk.Button(
            copy_row,
            text="Copy Cyphertext",
            command=lambda: self._copy_text(self.outgoing_cipher),
        ).grid(row=0, column=0, sticky="w")

    def _build_incoming_panel(self, container: ttk.Frame) -> None:
        container.columnconfigure(0, weight=1)
        container.rowconfigure(1, weight=1)
        container.rowconfigure(4, weight=1)

        ttk.Label(container, text="Incoming Cyphertext", font=("TkDefaultFont", 11, "bold")).grid(
            row=0, column=0, sticky="w"
        )
        self.incoming_cipher = tk.Text(container, wrap="word", height=12)
        self.incoming_cipher.grid(row=1, column=0, sticky="nsew", pady=(6, 6))

        action_row = ttk.Frame(container)
        action_row.grid(row=2, column=0, sticky="ew", pady=(0, 6))
        action_row.columnconfigure(0, weight=1)
        ttk.Button(action_row, text="Decrypt Message", command=self._decrypt_ui).grid(
            row=0, column=0, sticky="w"
        )
        ttk.Button(action_row, text="Clear", command=self._clear_incoming).grid(
            row=0, column=1, sticky="e"
        )

        ttk.Label(container, text="Decoded Message", font=("TkDefaultFont", 11, "bold")).grid(
            row=3, column=0, sticky="w"
        )
        self.decoded_plain = tk.Text(container, wrap="word", height=9)
        self.decoded_plain.grid(row=4, column=0, sticky="nsew", pady=(6, 6))

        copy_row = ttk.Frame(container)
        copy_row.grid(row=5, column=0, sticky="ew")
        copy_row.columnconfigure(0, weight=1)
        ttk.Button(
            copy_row,
            text="Copy Decoded Message",
            command=lambda: self._copy_text(self.decoded_plain),
        ).grid(row=0, column=0, sticky="w")

    def _toggle_passphrase_visibility(self) -> None:
        self.passphrase_entry.configure(show="" if self.show_key_var.get() else "*")

    def _generate_passphrase(self) -> None:
        generated = secrets.token_urlsafe(32)
        self.passphrase_var.set(generated)
        self.status_var.set("Generated a strong passphrase. Share it securely with your recipient.")

    def _encrypt_ui(self) -> None:
        plaintext = self._get_text(self.outgoing_plain)
        passphrase = self.passphrase_var.get()
        try:
            token = encrypt_to_cypher(plaintext=plaintext, passphrase=passphrase)
        except CipherError as exc:
            messagebox.showerror("Encryption Error", str(exc), parent=self)
            self.status_var.set("Encryption failed.")
            return

        self._set_text(self.outgoing_cipher, token)
        self.status_var.set("Message encrypted locally. Share only cyphertext.")

    def _decrypt_ui(self) -> None:
        token = self._get_text(self.incoming_cipher)
        passphrase = self.passphrase_var.get()
        try:
            plaintext = decrypt_from_cypher(cyphertext=token, passphrase=passphrase)
        except CipherError as exc:
            messagebox.showerror("Decryption Error", str(exc), parent=self)
            self.status_var.set("Decryption failed.")
            return

        self._set_text(self.decoded_plain, plaintext)
        self.status_var.set("Ciphertext decrypted locally.")

    def _clear_outgoing(self) -> None:
        self._set_text(self.outgoing_plain, "")
        self._set_text(self.outgoing_cipher, "")
        self.status_var.set("Outgoing fields cleared.")

    def _clear_incoming(self) -> None:
        self._set_text(self.incoming_cipher, "")
        self._set_text(self.decoded_plain, "")
        self.status_var.set("Incoming fields cleared.")

    def _copy_text(self, text_widget: tk.Text) -> None:
        value = self._get_text(text_widget)
        if not value:
            self.status_var.set("Nothing to copy.")
            return
        self.clipboard_clear()
        self.clipboard_append(value)
        self.status_var.set("Copied to clipboard.")

    def _apply_window_icon(self) -> None:
        icon_path = Path(__file__).resolve().parents[1] / "execution" / "assets" / "black_envelope_logo.png"
        if not icon_path.is_file():
            return
        try:
            photo = tk.PhotoImage(file=str(icon_path))
            self.iconphoto(True, photo)
            self._icon_ref = photo
        except Exception:
            return

    @staticmethod
    def _get_text(text_widget: tk.Text) -> str:
        return text_widget.get("1.0", "end-1c").strip()

    @staticmethod
    def _set_text(text_widget: tk.Text, value: str) -> None:
        text_widget.delete("1.0", "end")
        text_widget.insert("1.0", value)


def main() -> int:
    app = CypherDesktopApp()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
