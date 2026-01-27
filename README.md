# Semgrep Offline VSCode Extension

A lightweight VSCode/Cursor extension that runs semgrep with local rules only - completely offline, no registry access required.

## Features

- **100% Offline** - Uses only local rule files, no network requests
- **Auto-scan on save** - Automatically scans files when saved
- **Auto-scan on open** - Optionally scan files when opened
- **Auto-scan on change** - Optionally scan as you type (debounced)
- **Smart caching** - Skips scanning unchanged files for instant response
- **Scan queue** - Prevents scan pile-up during rapid edits
- **Status bar indicator** - Shows scan status and issue count
- **Full diagnostic integration** - Errors appear in Problems panel with proper severity levels

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `semgrepOffline.rulesPath` | `semgrep_rules.yaml` | Path to rules file (relative to workspace or absolute) |
| `semgrepOffline.semgrepPath` | `semgrep` | Path to semgrep executable |
| `semgrepOffline.scanOnSave` | `true` | Scan files automatically on save |
| `semgrepOffline.scanOnOpen` | `true` | Scan files when opened |
| `semgrepOffline.scanOnChange` | `false` | Scan files as you type (debounced) |
| `semgrepOffline.scanOnChangeDelay` | `1500` | Debounce delay in milliseconds |
| `semgrepOffline.useCache` | `true` | Skip scanning unchanged files (based on content hash) |
| `semgrepOffline.languages` | `["python"]` | Languages to scan |

## Commands

| Command | Description |
|---------|-------------|
| `Semgrep: Scan Current File` | Scan the active file (forces scan, ignores cache) |
| `Semgrep: Scan Workspace` | Scan all files in workspace |
| `Semgrep: Clear All Diagnostics` | Clear all semgrep diagnostics and cache |

## Installation

### Option 1: Symlink (Development)

```bash
# Clone or copy the extension to your preferred location
cd /path/to/semgrep-offline-vscode

# Install dependencies and build
npm install
npm run compile

# Symlink to Cursor extensions
ln -sf "$(pwd)" ~/.cursor/extensions/semgrep-offline

# Or for VSCode
ln -sf "$(pwd)" ~/.vscode/extensions/semgrep-offline
```

### Option 2: Install from folder

1. Open VSCode/Cursor
2. Press `Ctrl+Shift+P`
3. Run "Developer: Install Extension from Location..."
4. Select the `semgrep-offline-vscode` folder

### After Installation

Reload the editor: `Ctrl+Shift+P` → "Developer: Reload Window"

## Example Configuration

In your project's `.vscode/settings.json`:

```json
{
    "semgrepOffline.rulesPath": "/path/to/your/semgrep_rules.yaml",
    "semgrepOffline.semgrepPath": "/path/to/venv/bin/semgrep",
    "semgrepOffline.scanOnSave": true,
    "semgrepOffline.scanOnOpen": false,
    "semgrepOffline.scanOnChange": false,
    "semgrepOffline.useCache": true,
    "semgrepOffline.languages": ["python"]
}
```

## Performance Notes

- **First scan**: ~3 seconds (semgrep startup overhead)
- **Cached scans**: Instant (skipped if file unchanged)
- **Force scan**: Use `Semgrep: Scan Current File` command to bypass cache

The ~3 second initial scan time is inherent to semgrep's architecture (Python interpreter + rule parsing). The caching system ensures subsequent scans of unchanged files are instant.

## Requirements

- semgrep CLI installed (`pip install semgrep`)
- A local semgrep rules file (YAML format)

## Troubleshooting

### Extension not loading
- Ensure semgrep is installed: `which semgrep` or check your venv
- Check the Output panel: `View` → `Output` → select "Semgrep Offline"

### Scans not running
- Verify `semgrepOffline.semgrepPath` points to a valid semgrep executable
- Verify `semgrepOffline.rulesPath` points to a valid rules file
- Check that your file's language is in `semgrepOffline.languages`

### Cache issues
- Use `Semgrep: Clear All Diagnostics` to clear cache
- Use `Semgrep: Scan Current File` to force a fresh scan

## License

MIT
