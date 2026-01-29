# Semgrep Offline VSCode Extension

A lightweight VSCode/Cursor extension that runs semgrep with local rules only - completely offline, no registry access required. Also includes SOLID principle checks.

## Features

### Semgrep Integration
- **100% Offline** - Uses only local rule files, no network requests
- **Auto-scan on save** - Automatically scans files when saved
- **Auto-scan on open** - Optionally scan files when opened
- **Auto-scan on change** - Optionally scan as you type (debounced)
- **Smart caching** - Skips scanning unchanged files for instant response
- **Scan queue** - Prevents scan pile-up during rapid edits
- **Status bar indicator** - Shows scan status and issue count
- **Full diagnostic integration** - Errors appear in Problems panel with proper severity levels

### SOLID Principle Checks
- **Single Responsibility Principle (SRP)** - Detects classes violating SRP using LCOM4 metric
- **Open/Closed Principle (OCP)** - Detects type-checking conditionals using TCD+TFSC metrics
- **Dependency Inversion Principle (DIP)** - Detects direct instantiation using DII metric
- **AI-Ready Prompts** - Generates detailed refactoring prompts for AI agents (Cursor, Copilot, etc.)
- **Automatic Detection** - Runs alongside semgrep scans when enabled

## Installation

### From Marketplace (Recommended)

**Open VSX (VSCodium, Cursor, etc.):**
1. Open Extensions panel (`Ctrl+Shift+X`)
2. Search for "Semgrep Offline"
3. Click Install

Or install via command line:
```bash
# For Cursor
cursor --install-extension payamnaghdi.semgrep-offline

# For VSCodium
codium --install-extension payamnaghdi.semgrep-offline
```

### After Installation

Reload the editor: `Ctrl+Shift+P` → "Developer: Reload Window"

## Configuration

### Semgrep Settings

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

### SOLID Principle Settings

#### Single Responsibility Principle (SRP)

| Setting | Default | Description |
|---------|---------|-------------|
| `semgrepOffline.enableSRP` | `false` | Enable SRP check during automatic scans |
| `semgrepOffline.srpLcom4Threshold` | `1` | LCOM4 threshold (1 = ideal, higher = more tolerant) |

#### Open/Closed Principle (OCP)

| Setting | Default | Description |
|---------|---------|-------------|
| `semgrepOffline.enableOCP` | `false` | Enable OCP check during automatic scans |
| `semgrepOffline.ocpScoreThreshold` | `4` | OCP score threshold (lower = stricter) |

#### Dependency Inversion Principle (DIP)

| Setting | Default | Description |
|---------|---------|-------------|
| `semgrepOffline.enableDIP` | `false` | Enable DIP check during automatic scans |
| `semgrepOffline.dipScoreThreshold` | `3` | DIP score threshold (lower = stricter) |

## Commands

### Semgrep Commands

| Command | Description |
|---------|-------------|
| `Semgrep: Scan Current File` | Scan the active file (forces scan, ignores cache) |
| `Semgrep: Scan Workspace` | Scan all files in workspace |
| `Semgrep: Clear All Diagnostics` | Clear all semgrep diagnostics and cache |

### SOLID Commands

| Command | Description |
|---------|-------------|
| `SOLID: Check Single Responsibility Principle (LCOM4)` | Analyze classes for SRP violations |
| `SOLID: Check Open/Closed Principle (TCD+TFSC)` | Analyze methods for OCP violations |
| `SOLID: Check Dependency Inversion Principle (DII)` | Analyze classes for DIP violations |

## SOLID Metrics Explained

### SRP: LCOM4 (Lack of Cohesion of Methods 4)

LCOM4 measures class cohesion by analyzing how methods are connected through shared instance variables and method calls.

**How it works:**
1. Build a graph where each method is a node
2. Connect methods that share instance variables or call each other
3. Count the number of disconnected components

**Interpretation:**
| LCOM4 Value | Meaning |
|-------------|---------|
| 1 | Ideal - all methods are connected (single responsibility) |
| 2+ | Class may have multiple responsibilities |
| N | Class likely has N distinct responsibilities |

**Example violation:**
```python
class UserManager:
    def create_user(self):      # Group 1: uses self.db
        self.db.insert(...)
    
    def delete_user(self):      # Group 1: uses self.db
        self.db.delete(...)
    
    def send_email(self):       # Group 2: uses self.smtp (disconnected!)
        self.smtp.send(...)
    
    def send_sms(self):         # Group 2: uses self.sms (disconnected!)
        self.sms.send(...)

# LCOM4 = 2 (two disconnected groups)
# Suggestion: Split into UserManager and NotificationService
```

---

### OCP: TCD + TFSC (Type-Check Density + Type-Field Switch Count)

Detects code that must be modified (not extended) when new types are added.

**Metrics:**

| Metric | Formula | Description |
|--------|---------|-------------|
| **TCD** | `type_checks / total_lines` | Density of type-checking statements |
| **TFSC** | Count of `.type ==` conditionals | Number of type-field switches |
| **OCP Score** | Weighted sum | Combined violation score |

**Detection weights:**
| Pattern | Weight | Example |
|---------|--------|---------|
| `isinstance(x, T)` | 2.0 | `if isinstance(obj, Dog):` |
| `type(x) == T` | 2.0 | `if type(obj) == Dog:` |
| `x instanceof T` | 2.0 | `if (obj instanceof Dog)` |
| `.type == "X"` | 1.5 | `if shape.type == "circle":` |
| `typeof x` | 1.0 | `if (typeof x === "function")` |

**Example violation:**
```python
def calculate_area(shape):
    if isinstance(shape, Circle):      # OCP violation
        return 3.14 * shape.radius ** 2
    elif isinstance(shape, Rectangle): # Adding Triangle requires modification!
        return shape.width * shape.height

# OCP Score = 4.0
# Suggestion: Use polymorphism - each shape implements its own area() method
```

---

### DIP: DII (Dependency Injection Index)

Measures how dependencies are obtained - injected (good) vs. created internally (bad).

**Metrics:**

| Metric | Formula | Description |
|--------|---------|-------------|
| **DII** | `injected / total_dependencies` | Ratio of injected dependencies (1.0 = ideal) |
| **DIP Score** | `(ctor_inst × 2.0) + (method_inst × 1.5)` | Weighted violation score |

**Detection weights:**
| Pattern | Weight | Example |
|---------|--------|---------|
| Constructor instantiation | 2.0 | `self.db = MySQLDatabase()` |
| Method instantiation | 1.5 | `client = HttpClient()` |

**Example violation:**
```python
class OrderService:
    def __init__(self):
        self.db = MySQLDatabase()        # DIP violation - creates dependency
        self.payment = StripeGateway()   # DIP violation - creates dependency
    
    def process(self, order):
        emailer = EmailService()         # DIP violation - creates dependency
        emailer.send(order.confirmation)

# DIP Score = 2.0 + 2.0 + 1.5 = 5.5
# DII = 0 / 3 = 0% (no injected dependencies)
```

**Fixed version:**
```python
class OrderService:
    def __init__(self, db: Database, payment: PaymentGateway, emailer: EmailService):
        self.db = db              # Injected
        self.payment = payment    # Injected
        self.emailer = emailer    # Injected

# DIP Score = 0
# DII = 3 / 3 = 100%
```

---

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
    "semgrepOffline.languages": ["python"],
    "semgrepOffline.enableSRP": true,
    "semgrepOffline.enableOCP": true,
    "semgrepOffline.enableDIP": true
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

## Development Installation

### Option 1: Symlink

```bash
cd /path/to/semgrep-offline-vscode

npm install
npm run compile

ln -sf "$(pwd)" ~/.cursor/extensions/semgrep-offline

ln -sf "$(pwd)" ~/.vscode/extensions/semgrep-offline
```

### Option 2: Install from folder

1. Open VSCode/Cursor
2. Press `Ctrl+Shift+P`
3. Run "Developer: Install Extension from Location..."
4. Select the `semgrep-offline-vscode` folder

## License

MIT
