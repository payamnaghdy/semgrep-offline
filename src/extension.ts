import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';

interface SemgrepResult {
    results: SemgrepFinding[];
    errors: SemgrepError[];
}

interface SemgrepFinding {
    check_id: string;
    path: string;
    start: { line: number; col: number };
    end: { line: number; col: number };
    extra: {
        message: string;
        severity: string;
        metadata?: Record<string, unknown>;
        lines?: string;
    };
}

interface SemgrepError {
    message: string;
    level: string;
}

let diagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
const debounceTimers = new Map<string, NodeJS.Timeout>();
const fileHashCache = new Map<string, string>();
let semgrepProcess: ChildProcess | null = null;
let isScanning = false;
const scanQueue: vscode.TextDocument[] = [];

function debounce(key: string, fn: () => void, delay: number): void {
    const existingTimer = debounceTimers.get(key);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
        debounceTimers.delete(key);
        fn();
    }, delay);
    debounceTimers.set(key, timer);
}

function getFileHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Semgrep Offline');
    diagnosticCollection = vscode.languages.createDiagnosticCollection('semgrep-offline');
    
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(shield) Semgrep';
    statusBarItem.tooltip = 'Semgrep Offline - Click to scan current file';
    statusBarItem.command = 'semgrep-offline.scanFile';
    
    context.subscriptions.push(diagnosticCollection);
    context.subscriptions.push(outputChannel);
    context.subscriptions.push(statusBarItem);

    const scanFileCommand = vscode.commands.registerCommand('semgrep-offline.scanFile', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            scanFile(editor.document, true);
        }
    });

    const scanWorkspaceCommand = vscode.commands.registerCommand('semgrep-offline.scanWorkspace', () => {
        scanWorkspace();
    });

    const clearCommand = vscode.commands.registerCommand('semgrep-offline.clearDiagnostics', () => {
        diagnosticCollection.clear();
        fileHashCache.clear();
        outputChannel.appendLine('Cleared all diagnostics and cache');
    });

    context.subscriptions.push(scanFileCommand, scanWorkspaceCommand, clearCommand);

    const config = vscode.workspace.getConfiguration('semgrepOffline');
    const supportedLanguages = config.get<string[]>('languages') || ['python'];

    if (config.get<boolean>('scanOnSave')) {
        context.subscriptions.push(
            vscode.workspace.onDidSaveTextDocument((document) => {
                if (shouldScanDocument(document, supportedLanguages)) {
                    scanFile(document, true);
                }
            })
        );
    }

    if (config.get<boolean>('scanOnOpen')) {
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument((document) => {
                if (shouldScanDocument(document, supportedLanguages)) {
                    scanFile(document, false);
                }
            })
        );
    }

    if (config.get<boolean>('scanOnChange')) {
        const debounceDelay = config.get<number>('scanOnChangeDelay') || 1500;
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                const document = event.document;
                if (shouldScanDocument(document, supportedLanguages) && event.contentChanges.length > 0) {
                    debounce(document.uri.toString(), () => scanFile(document, false), debounceDelay);
                }
            })
        );
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && shouldScanDocument(editor.document, supportedLanguages)) {
                statusBarItem.show();
            } else {
                statusBarItem.hide();
            }
        })
    );

    if (vscode.window.activeTextEditor) {
        const doc = vscode.window.activeTextEditor.document;
        if (shouldScanDocument(doc, supportedLanguages)) {
            statusBarItem.show();
            if (config.get<boolean>('scanOnOpen')) {
                scanFile(doc, false);
            }
        }
    }

    outputChannel.appendLine('Semgrep Offline extension activated');
}

function shouldScanDocument(document: vscode.TextDocument, supportedLanguages: string[]): boolean {
    return supportedLanguages.includes(document.languageId) && document.uri.scheme === 'file';
}

function getConfig(): { semgrepPath: string; rulesPath: string; useCache: boolean } {
    const config = vscode.workspace.getConfiguration('semgrepOffline');
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    
    let rulesPath = config.get<string>('rulesPath') || 'semgrep_rules.yaml';
    if (!path.isAbsolute(rulesPath) && workspaceFolder) {
        rulesPath = path.join(workspaceFolder, rulesPath);
    }
    
    let semgrepPath = config.get<string>('semgrepPath') || 'semgrep';
    if (!path.isAbsolute(semgrepPath) && workspaceFolder && semgrepPath !== 'semgrep') {
        semgrepPath = path.join(workspaceFolder, semgrepPath);
    }
    
    const useCache = config.get<boolean>('useCache') ?? true;
    
    return { semgrepPath, rulesPath, useCache };
}

async function scanFile(document: vscode.TextDocument, force: boolean): Promise<void> {
    const filePath = document.uri.fsPath;
    const { semgrepPath, rulesPath, useCache } = getConfig();
    
    if (useCache && !force) {
        const currentHash = getFileHash(document.getText());
        const cachedHash = fileHashCache.get(filePath);
        if (cachedHash === currentHash) {
            outputChannel.appendLine(`Skipping ${path.basename(filePath)} (unchanged)`);
            return;
        }
    }
    
    if (isScanning) {
        if (!scanQueue.find(d => d.uri.toString() === document.uri.toString())) {
            scanQueue.push(document);
        }
        return;
    }
    
    isScanning = true;
    statusBarItem.text = '$(sync~spin) Scanning...';
    outputChannel.appendLine(`Scanning: ${filePath}`);
    
    try {
        const results = await runSemgrep(semgrepPath, rulesPath, filePath);
        const diagnostics = parseSemgrepResults(results, filePath);
        diagnosticCollection.set(document.uri, diagnostics);
        
        if (useCache) {
            fileHashCache.set(filePath, getFileHash(document.getText()));
        }
        
        statusBarItem.text = diagnostics.length > 0 
            ? `$(shield) Semgrep (${diagnostics.length})` 
            : '$(shield) Semgrep ✓';
        
        outputChannel.appendLine(`Found ${diagnostics.length} issue(s) in ${path.basename(filePath)}`);
    } catch (error) {
        statusBarItem.text = '$(shield) Semgrep ⚠';
        outputChannel.appendLine(`Error scanning ${filePath}: ${error}`);
    } finally {
        isScanning = false;
        processQueue();
    }
}

function processQueue(): void {
    if (scanQueue.length > 0) {
        const nextDoc = scanQueue.shift()!;
        scanFile(nextDoc, false);
    }
}

async function scanWorkspace(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
    }
    
    const { semgrepPath, rulesPath } = getConfig();
    
    statusBarItem.text = '$(sync~spin) Scanning workspace...';
    outputChannel.appendLine(`Scanning workspace: ${workspaceFolder}`);
    
    try {
        const results = await runSemgrep(semgrepPath, rulesPath, workspaceFolder);
        
        diagnosticCollection.clear();
        fileHashCache.clear();
        
        const fileGroups = new Map<string, vscode.Diagnostic[]>();
        
        for (const finding of results.results) {
            const absPath = path.isAbsolute(finding.path) 
                ? finding.path 
                : path.join(workspaceFolder, finding.path);
            
            if (!fileGroups.has(absPath)) {
                fileGroups.set(absPath, []);
            }
            
            const diagnostic = createDiagnostic(finding);
            fileGroups.get(absPath)!.push(diagnostic);
        }
        
        for (const [filePath, diagnostics] of fileGroups) {
            diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
        }
        
        const totalIssues = results.results.length;
        statusBarItem.text = totalIssues > 0 
            ? `$(shield) Semgrep (${totalIssues})` 
            : '$(shield) Semgrep ✓';
        
        outputChannel.appendLine(`Workspace scan complete: ${totalIssues} issue(s) in ${fileGroups.size} file(s)`);
        vscode.window.showInformationMessage(`Semgrep: Found ${totalIssues} issue(s) in ${fileGroups.size} file(s)`);
    } catch (error) {
        statusBarItem.text = '$(shield) Semgrep ⚠';
        outputChannel.appendLine(`Error scanning workspace: ${error}`);
        vscode.window.showErrorMessage(`Semgrep workspace scan failed: ${error}`);
    }
}

function runSemgrep(semgrepPath: string, rulesPath: string, targetPath: string): Promise<SemgrepResult> {
    return new Promise((resolve, reject) => {
        const args = [
            '--config', rulesPath,
            '--json',
            '--metrics=off',
            '--disable-version-check',
            '--oss-only',
            '--no-git-ignore',
            '-j', '1',
            targetPath
        ];
        
        outputChannel.appendLine(`Running: ${semgrepPath} ${args.join(' ')}`);
        
        const proc = spawn(semgrepPath, args, {
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        });
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        proc.on('close', (code) => {
            if (stderr && !stderr.includes('UserWarning')) {
                outputChannel.appendLine(`Semgrep stderr: ${stderr}`);
            }
            
            try {
                const result = JSON.parse(stdout) as SemgrepResult;
                resolve(result);
            } catch (e) {
                if (code === 0 && !stdout.trim()) {
                    resolve({ results: [], errors: [] });
                } else {
                    reject(new Error(`Failed to parse semgrep output: ${e}\nStdout: ${stdout}\nStderr: ${stderr}`));
                }
            }
        });
        
        proc.on('error', (error) => {
            reject(new Error(`Failed to run semgrep: ${error.message}`));
        });
    });
}

function parseSemgrepResults(results: SemgrepResult, filePath: string): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    
    for (const finding of results.results) {
        const findingPath = path.isAbsolute(finding.path) 
            ? finding.path 
            : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', finding.path);
        
        if (path.normalize(findingPath) === path.normalize(filePath)) {
            diagnostics.push(createDiagnostic(finding));
        }
    }
    
    return diagnostics;
}

function createDiagnostic(finding: SemgrepFinding): vscode.Diagnostic {
    const startLine = Math.max(0, finding.start.line - 1);
    const startCol = Math.max(0, finding.start.col - 1);
    const endLine = Math.max(0, finding.end.line - 1);
    const endCol = Math.max(0, finding.end.col - 1);
    
    const range = new vscode.Range(startLine, startCol, endLine, endCol);
    
    const severity = mapSeverity(finding.extra.severity);
    
    const diagnostic = new vscode.Diagnostic(
        range,
        `${finding.extra.message}`,
        severity
    );
    
    diagnostic.source = 'semgrep';
    diagnostic.code = finding.check_id;
    
    return diagnostic;
}

function mapSeverity(severity: string): vscode.DiagnosticSeverity {
    switch (severity.toUpperCase()) {
        case 'ERROR':
            return vscode.DiagnosticSeverity.Error;
        case 'WARNING':
            return vscode.DiagnosticSeverity.Warning;
        case 'INFO':
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Warning;
    }
}

export function deactivate() {
    if (diagnosticCollection) {
        diagnosticCollection.dispose();
    }
    if (outputChannel) {
        outputChannel.dispose();
    }
    if (semgrepProcess) {
        semgrepProcess.kill();
    }
    debounceTimers.forEach(timer => clearTimeout(timer));
}
