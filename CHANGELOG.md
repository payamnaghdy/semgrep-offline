# Changelog

All notable changes to the Semgrep Offline VSCode extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-02-02

### Added
- Smart override detection for LCOM4 to prevent false positives in inheritance scenarios
- Automatic exclusion of stub methods (`pass`, `NotImplementedError`) from SRP analysis
- Automatic exclusion of methods calling `super()` from SRP analysis
- Automatic exclusion of methods with no instance variable usage (likely pure overrides)
- Transparency in diagnostics showing excluded methods and reasons
- Detailed excluded methods section in AI-ready prompts

### Changed
- LCOM4 calculation now focuses only on methods representing new responsibilities
- Updated diagnostic messages to show count of excluded override/stub methods
- Enhanced `MethodInfo` interface to track `callsSuper`, `isStub`, and `stubType` properties

## [1.3.0] - 2026-01-15

### Added
- Interface Segregation Principle (ISP) checks
- IFS (Interface Fatness Score) metric for detecting fat interfaces
- SIR (Stub Implementation Ratio) metric for detecting forced implementations
- Detection of stub methods (`pass`, `...`, `raise NotImplementedError`)
- Configuration options: `ispFatInterfaceThreshold`, `ispSirThreshold`
- `SOLID: Check Interface Segregation Principle (IFS+SIR)` command

## [1.2.0] - 2026-01-10

### Added
- Open/Closed Principle (OCP) checks
- TCD (Type-Check Density) metric
- TFSC (Type-Field Switch Count) metric
- Detection of `isinstance`, `type()`, `instanceof`, and type-field conditionals
- Dependency Inversion Principle (DIP) checks
- DII (Dependency Injection Index) metric
- Detection of direct instantiation in constructors and methods
- Configuration options: `ocpScoreThreshold`, `dipScoreThreshold`
- `SOLID: Check Open/Closed Principle (TCD+TFSC)` command
- `SOLID: Check Dependency Inversion Principle (DII)` command
- MIT License file

## [1.1.0] - 2026-01-05

### Added
- Single Responsibility Principle (SRP) checks
- LCOM4 (Lack of Cohesion of Methods 4) metric implementation
- Class cohesion analysis based on shared instance variables and method calls
- Connected component detection for identifying separate responsibilities
- AI-ready refactoring prompts for Cursor, Copilot, and other AI agents
- Configuration options: `enableSRP`, `srpLcom4Threshold`
- `SOLID: Check Single Responsibility Principle (LCOM4)` command

## [1.0.0] - 2026-01-01

### Added
- Initial release of Semgrep Offline VSCode extension
- 100% offline operation with local rule files only
- Auto-scan on save functionality
- Auto-scan on open functionality (optional)
- Auto-scan on change with debouncing (optional)
- Smart caching to skip unchanged files
- Scan queue to prevent pile-up during rapid edits
- Status bar indicator showing scan status and issue count
- Full diagnostic integration with Problems panel
- Workspace scanning support
- Configurable semgrep path and rules path
- Multi-language support configuration
