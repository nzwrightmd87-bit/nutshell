# Cypher Desktop App Directive

## Goal
Build and run a lightweight local desktop app for copy/paste message encryption and decryption.

## Inputs
- Python 3.10+
- `requirements.txt` dependencies
- Shared passphrase known by sender and recipient

## Execution Scripts
- UI app: `execution/desktop_cypher_app_qt.py`
- Encrypt CLI: `execution/encrypt_message.py`
- Decrypt CLI: `execution/decrypt_message.py`
- Crypto core: `execution/cipher_engine.py`
- Packager (auto OS): `execution/package_desktop_app.py`
- Packager (macOS): `execution/package_macos_app.py`
- Packager (Windows): `execution/package_windows_app.py`

## Procedure
1. Install dependencies: `python3 -m pip install -r requirements.txt`
2. Launch app: `python3 execution/desktop_cypher_app_qt.py`
3. Enter a strong shared passphrase.
4. Paste plaintext into "Outgoing Message", encrypt, and share only the cyphertext.
5. Paste incoming cyphertext into "Incoming Cyphertext", decrypt, and read "Decoded Message".

## Packaging (macOS)
- Script: `execution/package_macos_app.py`
- Command: `python3 execution/package_macos_app.py`
- Output: `dist/Cypher Desktop Messenger.app`

## Packaging (Windows)
- Script: `execution/package_windows_app.py`
- Command: `py execution\package_windows_app.py`
- Output: `dist\Cypher Desktop Messenger\Cypher Desktop Messenger.exe`
- One-file option: `py execution\package_windows_app.py --onefile`

## Packaging (Auto by OS)
- Script: `execution/package_desktop_app.py`
- macOS command: `python3 execution/package_desktop_app.py`
- Windows command: `py execution\package_desktop_app.py`
- Rule: build native bundle on the target OS

## Expected Output
- Outgoing: versioned cyphertext string with prefix `CZ1.`
- Incoming: recovered plaintext message if passphrase and ciphertext are valid

## Edge Cases
- Empty message
- Passphrase shorter than 12 characters
- Wrong passphrase
- Tampered or malformed ciphertext
- Token chunks that do not match the passphrase-specific alphabet map

## Recovery
1. Inspect error text shown by UI/CLI.
2. Verify passphrase and token integrity.
3. Re-run operation.
4. Update this directive if new repeatable failure modes appear.
