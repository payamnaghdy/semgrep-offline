import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import * as crypto from 'crypto';

interface ClassInfo {
    name: string;
    startLine: number;
    endLine: number;
    methods: MethodInfo[];
    instanceVariables: Set<string>;
}

interface MethodInfo {
    name: string;
    startLine: number;
    endLine: number;
    usedVariables: Set<string>;
    calledMethods: Set<string>;
}

interface LCOM4Result {
    className: string;
    lcom4Value: number;
    connectedComponents: string[][];
    suggestion: string;
}

interface OCPViolation {
    line: number;
    type: 'instanceof' | 'type_equality' | 'type_field' | 'typeof';
    code: string;
}

interface OCPResult {
    className: string;
    methodName: string;
    startLine: number;
    tcd: number;
    tfsc: number;
    ocpScore: number;
    violations: OCPViolation[];
    suggestion: string;
}

interface DIPViolation {
    line: number;
    type: 'constructor_instantiation' | 'method_instantiation' | 'no_injection' | 'concrete_parameter';
    code: string;
    className: string;
}

interface DIPResult {
    className: string;
    startLine: number;
    constructorInstantiations: number;
    methodInstantiations: number;
    injectedDependencies: number;
    totalDependencies: number;
    dii: number;
    dipScore: number;
    violations: DIPViolation[];
    suggestion: string;
}

interface ISPViolation {
    line: number;
    type: 'fat_interface' | 'empty_implementation' | 'not_implemented_error';
    methodName: string;
    code: string;
}

interface ISPResult {
    className: string;
    startLine: number;
    isInterface: boolean;
    abstractMethodCount: number;
    emptyImplementations: number;
    notImplementedErrors: number;
    ifs: number;
    sir: number;
    ispScore: number;
    violations: ISPViolation[];
    suggestion: string;
}

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
            const config = vscode.workspace.getConfiguration('semgrepOffline');
            if (config.get<boolean>('enableSRP')) {
                checkSingleResponsibility(editor.document, true);
            }
            if (config.get<boolean>('enableOCP')) {
                checkOpenClosed(editor.document, true);
            }
            if (config.get<boolean>('enableDIP')) {
                checkDependencyInversion(editor.document, true);
            }
            if (config.get<boolean>('enableISP')) {
                checkInterfaceSegregation(editor.document, true);
            }
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

    const srpCheckCommand = vscode.commands.registerCommand('semgrep-offline.checkSRP', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            checkSingleResponsibility(editor.document);
        }
    });

    const ocpCheckCommand = vscode.commands.registerCommand('semgrep-offline.checkOCP', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            checkOpenClosed(editor.document);
        }
    });

    const dipCheckCommand = vscode.commands.registerCommand('semgrep-offline.checkDIP', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            checkDependencyInversion(editor.document);
        }
    });

    const ispCheckCommand = vscode.commands.registerCommand('semgrep-offline.checkISP', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            checkInterfaceSegregation(editor.document);
        }
    });

    context.subscriptions.push(scanFileCommand, scanWorkspaceCommand, clearCommand, srpCheckCommand, ocpCheckCommand, dipCheckCommand, ispCheckCommand);

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            const config = vscode.workspace.getConfiguration('semgrepOffline');
            const supportedLanguages = config.get<string[]>('languages') || ['python'];
            if (config.get<boolean>('scanOnSave') && shouldScanDocument(document, supportedLanguages)) {
                scanFile(document, true);
                if (config.get<boolean>('enableSRP')) {
                    checkSingleResponsibility(document, true);
                }
                if (config.get<boolean>('enableOCP')) {
                    checkOpenClosed(document, true);
                }
                if (config.get<boolean>('enableDIP')) {
                    checkDependencyInversion(document, true);
                }
                if (config.get<boolean>('enableISP')) {
                    checkInterfaceSegregation(document, true);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
            const config = vscode.workspace.getConfiguration('semgrepOffline');
            const supportedLanguages = config.get<string[]>('languages') || ['python'];
            if (config.get<boolean>('scanOnOpen') && shouldScanDocument(document, supportedLanguages)) {
                scanFile(document, false);
                if (config.get<boolean>('enableSRP')) {
                    checkSingleResponsibility(document, true);
                }
                if (config.get<boolean>('enableOCP')) {
                    checkOpenClosed(document, true);
                }
                if (config.get<boolean>('enableDIP')) {
                    checkDependencyInversion(document, true);
                }
                if (config.get<boolean>('enableISP')) {
                    checkInterfaceSegregation(document, true);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            const config = vscode.workspace.getConfiguration('semgrepOffline');
            const supportedLanguages = config.get<string[]>('languages') || ['python'];
            const document = event.document;
            if (config.get<boolean>('scanOnChange') && shouldScanDocument(document, supportedLanguages) && event.contentChanges.length > 0) {
                const debounceDelay = config.get<number>('scanOnChangeDelay') || 1500;
                debounce(document.uri.toString(), () => {
                    scanFile(document, false);
                    if (config.get<boolean>('enableSRP')) {
                        checkSingleResponsibility(document, true);
                    }
                    if (config.get<boolean>('enableOCP')) {
                        checkOpenClosed(document, true);
                    }
                    if (config.get<boolean>('enableDIP')) {
                        checkDependencyInversion(document, true);
                    }
                    if (config.get<boolean>('enableISP')) {
                        checkInterfaceSegregation(document, true);
                    }
                }, debounceDelay);
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            const config = vscode.workspace.getConfiguration('semgrepOffline');
            const supportedLanguages = config.get<string[]>('languages') || ['python'];
            if (editor && shouldScanDocument(editor.document, supportedLanguages)) {
                statusBarItem.show();
            } else {
                statusBarItem.hide();
            }
        })
    );

    const initialConfig = vscode.workspace.getConfiguration('semgrepOffline');
    const initialLanguages = initialConfig.get<string[]>('languages') || ['python'];
    if (vscode.window.activeTextEditor) {
        const doc = vscode.window.activeTextEditor.document;
        if (shouldScanDocument(doc, initialLanguages)) {
            statusBarItem.show();
            if (initialConfig.get<boolean>('scanOnOpen')) {
                scanFile(doc, false);
                if (initialConfig.get<boolean>('enableSRP')) {
                    checkSingleResponsibility(doc, true);
                }
                if (initialConfig.get<boolean>('enableOCP')) {
                    checkOpenClosed(doc, true);
                }
                if (initialConfig.get<boolean>('enableDIP')) {
                    checkDependencyInversion(doc, true);
                }
                if (initialConfig.get<boolean>('enableISP')) {
                    checkInterfaceSegregation(doc, true);
                }
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
        const semgrepDiagnostics = parseSemgrepResults(results, filePath);
        const existingDiagnostics = diagnosticCollection.get(document.uri) || [];
        const srpDiagnostics = existingDiagnostics.filter(d => d.source === 'solid-srp');
        diagnosticCollection.set(document.uri, [...semgrepDiagnostics, ...srpDiagnostics]);
        
        if (useCache) {
            fileHashCache.set(filePath, getFileHash(document.getText()));
        }
        
        statusBarItem.text = semgrepDiagnostics.length > 0 
            ? `$(shield) Semgrep (${semgrepDiagnostics.length})` 
            : '$(shield) Semgrep ✓';
        
        outputChannel.appendLine(`Found ${semgrepDiagnostics.length} issue(s) in ${path.basename(filePath)}`);
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

async function checkSingleResponsibility(document: vscode.TextDocument, silent: boolean = false): Promise<void> {
    const config = vscode.workspace.getConfiguration('semgrepOffline');
    const threshold = config.get<number>('srpLcom4Threshold') || 1;
    
    const text = document.getText();
    const classes = parseClasses(text, document.languageId);
    
    if (classes.length === 0) {
        if (!silent) {
            vscode.window.showInformationMessage('No classes found in the current file.');
        }
        return;
    }
    
    const results: LCOM4Result[] = [];
    const diagnostics: vscode.Diagnostic[] = [];
    
    for (const classInfo of classes) {
        const lcom4Result = calculateLCOM4(classInfo);
        results.push(lcom4Result);
        
        if (lcom4Result.lcom4Value > threshold) {
            const range = new vscode.Range(
                classInfo.startLine, 0,
                classInfo.startLine, 100
            );
            
            const prompt = generateSRPPrompt([lcom4Result], document.uri.fsPath);
            
            const diagnostic = new vscode.Diagnostic(
                range,
                `SRP Violation: Class '${classInfo.name}' has LCOM4=${lcom4Result.lcom4Value}. ${lcom4Result.suggestion}\n\n--- Agent Prompt ---\n${prompt}`,
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = 'solid-srp';
            diagnostic.code = 'LCOM4';
            diagnostics.push(diagnostic);
        }
    }
    
    const existingDiagnostics = diagnosticCollection.get(document.uri) || [];
    const nonSrpDiagnostics = existingDiagnostics.filter(d => d.source !== 'solid-srp');
    diagnosticCollection.set(document.uri, [...nonSrpDiagnostics, ...diagnostics]);
    
    const violatingClasses = results.filter(r => r.lcom4Value > threshold);
    
    if (!silent) {
        if (violatingClasses.length > 0) {
            const prompt = generateSRPPrompt(violatingClasses, document.uri.fsPath);
            outputChannel.appendLine('\n=== SRP Analysis Result ===');
            outputChannel.appendLine(prompt);
            outputChannel.show();
            
            const action = await vscode.window.showWarningMessage(
                `Found ${violatingClasses.length} class(es) potentially violating Single Responsibility Principle.`,
                'View Details',
                'Copy Prompt'
            );
            
            if (action === 'Copy Prompt') {
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage('SRP analysis prompt copied to clipboard.');
            } else if (action === 'View Details') {
                outputChannel.show();
            }
        } else {
            vscode.window.showInformationMessage('All classes pass the Single Responsibility Principle check.');
        }
    } else if (violatingClasses.length > 0) {
        outputChannel.appendLine(`SRP: Found ${violatingClasses.length} violation(s) in ${path.basename(document.uri.fsPath)}`);
    }
}

function parseClasses(text: string, languageId: string): ClassInfo[] {
    const classes: ClassInfo[] = [];
    const lines = text.split('\n');
    
    if (languageId === 'python') {
        return parsePythonClasses(lines);
    } else if (languageId === 'typescript' || languageId === 'javascript' || languageId === 'typescriptreact' || languageId === 'javascriptreact') {
        return parseTypeScriptClasses(lines);
    }
    
    return classes;
}

function parsePythonClasses(lines: string[]): ClassInfo[] {
    const classes: ClassInfo[] = [];
    let currentClass: ClassInfo | null = null;
    let currentMethod: MethodInfo | null = null;
    let classIndent = 0;
    let methodIndent = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        const indent = line.length - trimmed.length;
        
        const classMatch = trimmed.match(/^class\s+(\w+)/);
        if (classMatch) {
            if (currentClass) {
                if (currentMethod) {
                    currentClass.methods.push(currentMethod);
                }
                currentClass.endLine = i - 1;
                classes.push(currentClass);
            }
            currentClass = {
                name: classMatch[1],
                startLine: i,
                endLine: i,
                methods: [],
                instanceVariables: new Set()
            };
            currentMethod = null;
            classIndent = indent;
            continue;
        }
        
        if (currentClass && indent <= classIndent && trimmed.length > 0 && !classMatch) {
            if (currentMethod) {
                currentClass.methods.push(currentMethod);
            }
            currentClass.endLine = i - 1;
            classes.push(currentClass);
            currentClass = null;
            currentMethod = null;
            continue;
        }
        
        if (currentClass) {
            const methodMatch = trimmed.match(/^def\s+(\w+)\s*\(/);
            if (methodMatch) {
                if (currentMethod) {
                    currentClass.methods.push(currentMethod);
                }
                currentMethod = {
                    name: methodMatch[1],
                    startLine: i,
                    endLine: i,
                    usedVariables: new Set(),
                    calledMethods: new Set()
                };
                methodIndent = indent;
                continue;
            }
            
            if (currentMethod && indent > methodIndent) {
                currentMethod.endLine = i;
                
                const selfVarMatches = line.matchAll(/self\.(\w+)/g);
                for (const match of selfVarMatches) {
                    const varName = match[1];
                    if (!varName.startsWith('_') || !varName.endsWith('_')) {
                        if (line.includes(`self.${varName}(`) || line.includes(`self.${varName} (`)) {
                            currentMethod.calledMethods.add(varName);
                        } else {
                            currentMethod.usedVariables.add(varName);
                            currentClass.instanceVariables.add(varName);
                        }
                    }
                }
            }
        }
    }
    
    if (currentClass) {
        if (currentMethod) {
            currentClass.methods.push(currentMethod);
        }
        currentClass.endLine = lines.length - 1;
        classes.push(currentClass);
    }
    
    return classes;
}

function parseTypeScriptClasses(lines: string[]): ClassInfo[] {
    const classes: ClassInfo[] = [];
    let currentClass: ClassInfo | null = null;
    let currentMethod: MethodInfo | null = null;
    let braceCount = 0;
    let classStartBrace = 0;
    let methodStartBrace = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        
        const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
        if (classMatch && braceCount === 0) {
            currentClass = {
                name: classMatch[1],
                startLine: i,
                endLine: i,
                methods: [],
                instanceVariables: new Set()
            };
            classStartBrace = braceCount;
        }
        
        const openBraces = (line.match(/{/g) || []).length;
        const closeBraces = (line.match(/}/g) || []).length;
        braceCount += openBraces - closeBraces;
        
        if (currentClass) {
            const methodMatch = trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(/);
            if (methodMatch && !trimmed.startsWith('constructor') && braceCount === classStartBrace + 1) {
                if (currentMethod) {
                    currentClass.methods.push(currentMethod);
                }
                currentMethod = {
                    name: methodMatch[1],
                    startLine: i,
                    endLine: i,
                    usedVariables: new Set(),
                    calledMethods: new Set()
                };
                methodStartBrace = braceCount;
            }
            
            if (currentMethod && braceCount > methodStartBrace) {
                currentMethod.endLine = i;
                
                const thisVarMatches = line.matchAll(/this\.(\w+)/g);
                for (const match of thisVarMatches) {
                    const varName = match[1];
                    if (line.includes(`this.${varName}(`) || line.includes(`this.${varName} (`)) {
                        currentMethod.calledMethods.add(varName);
                    } else {
                        currentMethod.usedVariables.add(varName);
                        currentClass.instanceVariables.add(varName);
                    }
                }
            }
            
            if (currentMethod && braceCount <= methodStartBrace && closeBraces > 0) {
                currentClass.methods.push(currentMethod);
                currentMethod = null;
            }
            
            if (braceCount === 0 && currentClass) {
                currentClass.endLine = i;
                classes.push(currentClass);
                currentClass = null;
            }
        }
    }
    
    return classes;
}

function calculateLCOM4(classInfo: ClassInfo): LCOM4Result {
    const methods = classInfo.methods.filter(m => !m.name.startsWith('__') || m.name === '__init__');
    
    if (methods.length <= 1) {
        return {
            className: classInfo.name,
            lcom4Value: 1,
            connectedComponents: [methods.map(m => m.name)],
            suggestion: 'Class has 0 or 1 method, LCOM4 is trivially 1.'
        };
    }
    
    const adjacency = new Map<string, Set<string>>();
    for (const method of methods) {
        adjacency.set(method.name, new Set());
    }
    
    for (let i = 0; i < methods.length; i++) {
        for (let j = i + 1; j < methods.length; j++) {
            const m1 = methods[i];
            const m2 = methods[j];
            
            const sharedVars = [...m1.usedVariables].filter(v => m2.usedVariables.has(v));
            const m1CallsM2 = m1.calledMethods.has(m2.name);
            const m2CallsM1 = m2.calledMethods.has(m1.name);
            
            if (sharedVars.length > 0 || m1CallsM2 || m2CallsM1) {
                adjacency.get(m1.name)!.add(m2.name);
                adjacency.get(m2.name)!.add(m1.name);
            }
        }
    }
    
    const visited = new Set<string>();
    const components: string[][] = [];
    
    for (const method of methods) {
        if (!visited.has(method.name)) {
            const component: string[] = [];
            const stack = [method.name];
            
            while (stack.length > 0) {
                const current = stack.pop()!;
                if (!visited.has(current)) {
                    visited.add(current);
                    component.push(current);
                    
                    for (const neighbor of adjacency.get(current) || []) {
                        if (!visited.has(neighbor)) {
                            stack.push(neighbor);
                        }
                    }
                }
            }
            
            components.push(component);
        }
    }
    
    const suggestion = generateLCOM4Suggestion(classInfo.name, components);
    
    return {
        className: classInfo.name,
        lcom4Value: components.length,
        connectedComponents: components,
        suggestion
    };
}

function generateLCOM4Suggestion(className: string, components: string[][]): string {
    if (components.length <= 1) {
        return 'Class appears to be cohesive.';
    }
    
    const componentDescriptions = components.map((comp, idx) => 
        `Group ${idx + 1}: ${comp.join(', ')}`
    ).join('; ');
    
    return `Consider splitting into ${components.length} classes. Method groups: ${componentDescriptions}`;
}

function generateSRPPrompt(violations: LCOM4Result[], filePath: string): string {
    const fileName = path.basename(filePath);
    
    let prompt = `# Single Responsibility Principle Violation Analysis\n\n`;
    prompt += `**File:** ${fileName}\n\n`;
    prompt += `The following class(es) may violate the Single Responsibility Principle based on LCOM4 analysis:\n\n`;
    
    for (const violation of violations) {
        prompt += `## Class: ${violation.className}\n`;
        prompt += `- **LCOM4 Score:** ${violation.lcom4Value} (ideal is 1)\n`;
        prompt += `- **Connected Components:** ${violation.lcom4Value}\n\n`;
        prompt += `### Method Groups (disconnected responsibilities):\n`;
        
        for (let i = 0; i < violation.connectedComponents.length; i++) {
            const component = violation.connectedComponents[i];
            prompt += `${i + 1}. **Responsibility ${i + 1}:** ${component.join(', ')}\n`;
        }
        
        prompt += `\n### Recommended Refactoring:\n`;
        prompt += `This class has ${violation.lcom4Value} disconnected groups of methods that don't share state or call each other. `;
        prompt += `Consider extracting each group into its own class:\n\n`;
        
        for (let i = 0; i < violation.connectedComponents.length; i++) {
            const component = violation.connectedComponents[i];
            const suggestedName = `${violation.className}${getSuggestedSuffix(i, violation.connectedComponents.length)}`;
            prompt += `- Create \`${suggestedName}\` with methods: ${component.join(', ')}\n`;
        }
        
        prompt += `\n`;
    }
    
    prompt += `---\n`;
    prompt += `**Action Required:** Please refactor the above class(es) to follow the Single Responsibility Principle. `;
    prompt += `Each new class should have one clear responsibility and all its methods should be cohesive (working on the same data/state).\n`;
    
    return prompt;
}

function getSuggestedSuffix(index: number, total: number): string {
    if (total === 2) {
        return index === 0 ? 'Core' : 'Helper';
    }
    const suffixes = ['Core', 'Manager', 'Handler', 'Service', 'Processor', 'Builder', 'Factory', 'Provider'];
    return suffixes[index % suffixes.length];
}

async function checkOpenClosed(document: vscode.TextDocument, silent: boolean = false): Promise<void> {
    const config = vscode.workspace.getConfiguration('semgrepOffline');
    const threshold = config.get<number>('ocpScoreThreshold') || 4;
    
    const text = document.getText();
    const lines = text.split('\n');
    const classes = parseClasses(text, document.languageId);
    
    if (classes.length === 0) {
        if (!silent) {
            vscode.window.showInformationMessage('No classes found in the current file.');
        }
        return;
    }
    
    const results: OCPResult[] = [];
    const diagnostics: vscode.Diagnostic[] = [];
    
    for (const classInfo of classes) {
        for (const method of classInfo.methods) {
            const methodLines = lines.slice(method.startLine, method.endLine + 1);
            const methodText = methodLines.join('\n');
            
            const violations = detectOCPViolations(methodText, method.startLine, document.languageId);
            
            if (violations.length > 0) {
                const tcd = calculateTCD(violations, methodLines.length);
                const tfsc = calculateTFSC(violations);
                const ocpScore = calculateOCPScore(violations);
                
                const result: OCPResult = {
                    className: classInfo.name,
                    methodName: method.name,
                    startLine: method.startLine,
                    tcd,
                    tfsc,
                    ocpScore,
                    violations,
                    suggestion: generateOCPSuggestion(violations, ocpScore)
                };
                
                results.push(result);
                
                if (ocpScore > threshold) {
                    const range = new vscode.Range(method.startLine, 0, method.startLine, 100);
                    const prompt = generateOCPPrompt([result], document.uri.fsPath);
                    
                    const diagnostic = new vscode.Diagnostic(
                        range,
                        `OCP Violation: Method '${method.name}' in class '${classInfo.name}' has OCP Score=${ocpScore.toFixed(1)}. ${result.suggestion}\n\n--- Agent Prompt ---\n${prompt}`,
                        vscode.DiagnosticSeverity.Warning
                    );
                    diagnostic.source = 'solid-ocp';
                    diagnostic.code = 'OCP';
                    diagnostics.push(diagnostic);
                }
            }
        }
    }
    
    const existingDiagnostics = diagnosticCollection.get(document.uri) || [];
    const nonOcpDiagnostics = existingDiagnostics.filter(d => d.source !== 'solid-ocp');
    diagnosticCollection.set(document.uri, [...nonOcpDiagnostics, ...diagnostics]);
    
    const violatingMethods = results.filter(r => r.ocpScore > threshold);
    
    if (!silent) {
        if (violatingMethods.length > 0) {
            const prompt = generateOCPPrompt(violatingMethods, document.uri.fsPath);
            outputChannel.appendLine('\n=== OCP Analysis Result ===');
            outputChannel.appendLine(prompt);
            outputChannel.show();
            
            const action = await vscode.window.showWarningMessage(
                `Found ${violatingMethods.length} method(s) potentially violating Open/Closed Principle.`,
                'View Details',
                'Copy Prompt'
            );
            
            if (action === 'Copy Prompt') {
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage('OCP analysis prompt copied to clipboard.');
            } else if (action === 'View Details') {
                outputChannel.show();
            }
        } else {
            vscode.window.showInformationMessage('All methods pass the Open/Closed Principle check.');
        }
    } else if (violatingMethods.length > 0) {
        outputChannel.appendLine(`OCP: Found ${violatingMethods.length} violation(s) in ${path.basename(document.uri.fsPath)}`);
    }
}

function detectOCPViolations(methodText: string, startLine: number, languageId: string): OCPViolation[] {
    if (languageId === 'python') {
        return detectPythonOCPViolations(methodText, startLine);
    } else if (languageId === 'typescript' || languageId === 'javascript' || languageId === 'typescriptreact' || languageId === 'javascriptreact') {
        return detectTypeScriptOCPViolations(methodText, startLine);
    }
    return [];
}

function detectPythonOCPViolations(methodText: string, startLine: number): OCPViolation[] {
    const violations: OCPViolation[] = [];
    const lines = methodText.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = startLine + i;
        
        const isinstanceMatches = line.matchAll(/isinstance\s*\(\s*\w+\s*,\s*[\w.]+\s*\)/g);
        for (const match of isinstanceMatches) {
            violations.push({
                line: lineNumber,
                type: 'instanceof',
                code: match[0]
            });
        }
        
        const typeEqualityMatches = line.matchAll(/type\s*\(\s*\w+\s*\)\s*[=!]=\s*[\w.]+/g);
        for (const match of typeEqualityMatches) {
            violations.push({
                line: lineNumber,
                type: 'type_equality',
                code: match[0]
            });
        }
        
        const typeFieldMatches = line.matchAll(/\.\s*(type|kind|_type|__type__|category|variant)\s*[=!]=\s*["']?\w+["']?/g);
        for (const match of typeFieldMatches) {
            violations.push({
                line: lineNumber,
                type: 'type_field',
                code: match[0]
            });
        }
        
        const matchCasePattern = /^\s*case\s+["']?\w+["']?\s*:/;
        if (matchCasePattern.test(line)) {
            violations.push({
                line: lineNumber,
                type: 'type_field',
                code: line.trim()
            });
        }
    }
    
    return violations;
}

function detectTypeScriptOCPViolations(methodText: string, startLine: number): OCPViolation[] {
    const violations: OCPViolation[] = [];
    const lines = methodText.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNumber = startLine + i;
        
        const instanceofMatches = line.matchAll(/\w+\s+instanceof\s+\w+/g);
        for (const match of instanceofMatches) {
            violations.push({
                line: lineNumber,
                type: 'instanceof',
                code: match[0]
            });
        }
        
        const typeofMatches = line.matchAll(/typeof\s+\w+\s*[=!]==?\s*["']\w+["']/g);
        for (const match of typeofMatches) {
            if (!line.includes("typeof") || 
                !(line.includes("'string'") || line.includes('"string"') ||
                  line.includes("'number'") || line.includes('"number"') ||
                  line.includes("'boolean'") || line.includes('"boolean"') ||
                  line.includes("'undefined'") || line.includes('"undefined"'))) {
                violations.push({
                    line: lineNumber,
                    type: 'typeof',
                    code: match[0]
                });
            }
        }
        
        const typeFieldMatches = line.matchAll(/\.\s*(type|kind|_type|__type|category|variant|discriminator)\s*[=!]==?\s*["']?\w+["']?/g);
        for (const match of typeFieldMatches) {
            violations.push({
                line: lineNumber,
                type: 'type_field',
                code: match[0]
            });
        }
        
        const switchCasePattern = /^\s*case\s+["']?\w+["']?\s*:/;
        if (switchCasePattern.test(line)) {
            const nearSwitch = methodText.substring(0, methodText.indexOf(line));
            if (/switch\s*\(\s*\w+\.(type|kind|_type|category|variant|discriminator)\s*\)/i.test(nearSwitch)) {
                violations.push({
                    line: lineNumber,
                    type: 'type_field',
                    code: line.trim()
                });
            }
        }
    }
    
    return violations;
}

function calculateTCD(violations: OCPViolation[], totalLines: number): number {
    const typeChecks = violations.filter(v => v.type === 'instanceof' || v.type === 'type_equality' || v.type === 'typeof').length;
    return totalLines > 0 ? typeChecks / totalLines : 0;
}

function calculateTFSC(violations: OCPViolation[]): number {
    return violations.filter(v => v.type === 'type_field').length;
}

function calculateOCPScore(violations: OCPViolation[]): number {
    let score = 0;
    for (const v of violations) {
        switch (v.type) {
            case 'instanceof':
                score += 2.0;
                break;
            case 'type_equality':
                score += 2.0;
                break;
            case 'typeof':
                score += 1.0;
                break;
            case 'type_field':
                score += 1.5;
                break;
        }
    }
    return score;
}

function generateOCPSuggestion(violations: OCPViolation[], ocpScore: number): string {
    if (ocpScore <= 4) {
        return 'Minor type-checking detected. Consider if polymorphism would be beneficial.';
    }
    
    const instanceofCount = violations.filter(v => v.type === 'instanceof' || v.type === 'type_equality').length;
    const typeFieldCount = violations.filter(v => v.type === 'type_field').length;
    
    if (instanceofCount > typeFieldCount) {
        return 'Consider using polymorphism (Strategy/Visitor pattern) instead of instanceof checks.';
    } else {
        return 'Consider using polymorphism or discriminated unions instead of type-field switches.';
    }
}

function generateOCPPrompt(violations: OCPResult[], filePath: string): string {
    const fileName = path.basename(filePath);
    
    let prompt = `# Open/Closed Principle Violation Analysis\n\n`;
    prompt += `**File:** ${fileName}\n\n`;
    prompt += `The following method(s) may violate the Open/Closed Principle:\n\n`;
    
    for (const violation of violations) {
        prompt += `## Class: ${violation.className}, Method: ${violation.methodName}\n`;
        prompt += `- **OCP Score:** ${violation.ocpScore.toFixed(1)} (threshold exceeded)\n`;
        prompt += `- **Type-Check Density (TCD):** ${(violation.tcd * 100).toFixed(1)}%\n`;
        prompt += `- **Type-Field Switch Count (TFSC):** ${violation.tfsc}\n\n`;
        
        prompt += `### Detected Violations:\n`;
        const groupedViolations = new Map<string, OCPViolation[]>();
        for (const v of violation.violations) {
            const key = v.type;
            if (!groupedViolations.has(key)) {
                groupedViolations.set(key, []);
            }
            groupedViolations.get(key)!.push(v);
        }
        
        for (const [type, items] of groupedViolations) {
            const typeLabel = type === 'instanceof' ? 'isinstance/instanceof checks' :
                             type === 'type_equality' ? 'type() equality checks' :
                             type === 'typeof' ? 'typeof checks' : 'type-field conditionals';
            prompt += `- **${typeLabel}:** ${items.length}\n`;
            for (const item of items.slice(0, 3)) {
                prompt += `  - Line ${item.line + 1}: \`${item.code}\`\n`;
            }
            if (items.length > 3) {
                prompt += `  - ... and ${items.length - 3} more\n`;
            }
        }
        
        prompt += `\n### Recommended Refactoring:\n`;
        prompt += `${violation.suggestion}\n\n`;
        prompt += `**Patterns to consider:**\n`;
        prompt += `1. **Strategy Pattern:** Extract each type-specific behavior into separate strategy classes\n`;
        prompt += `2. **Polymorphism:** Move behavior into subclasses and use method overriding\n`;
        prompt += `3. **Visitor Pattern:** If operations vary independently from object structure\n`;
        prompt += `4. **Factory + Registry:** Register handlers for each type dynamically\n\n`;
    }
    
    prompt += `---\n`;
    prompt += `**Action Required:** Refactor to eliminate type-checking conditionals. `;
    prompt += `New types should be addable without modifying existing code.\n`;
    
    return prompt;
}

async function checkDependencyInversion(document: vscode.TextDocument, silent: boolean = false): Promise<void> {
    const config = vscode.workspace.getConfiguration('semgrepOffline');
    const threshold = config.get<number>('dipScoreThreshold') || 3;
    
    const text = document.getText();
    const classes = parseClassesWithConstructors(text, document.languageId);
    
    if (classes.length === 0) {
        if (!silent) {
            vscode.window.showInformationMessage('No classes found in the current file.');
        }
        return;
    }
    
    const results: DIPResult[] = [];
    const diagnostics: vscode.Diagnostic[] = [];
    
    for (const classInfo of classes) {
        const dipResult = analyzeDIP(classInfo, text, document.languageId);
        
        if (dipResult.dipScore > 0) {
            results.push(dipResult);
            
            if (dipResult.dipScore >= threshold) {
                const range = new vscode.Range(classInfo.startLine, 0, classInfo.startLine, 100);
                const prompt = generateDIPPrompt([dipResult], document.uri.fsPath);
                
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `DIP Violation: Class '${classInfo.name}' has DIP Score=${dipResult.dipScore.toFixed(1)}, DII=${(dipResult.dii * 100).toFixed(0)}%. ${dipResult.suggestion}\n\n--- Agent Prompt ---\n${prompt}`,
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.source = 'solid-dip';
                diagnostic.code = 'DIP';
                diagnostics.push(diagnostic);
            }
        }
    }
    
    const existingDiagnostics = diagnosticCollection.get(document.uri) || [];
    const nonDipDiagnostics = existingDiagnostics.filter(d => d.source !== 'solid-dip');
    diagnosticCollection.set(document.uri, [...nonDipDiagnostics, ...diagnostics]);
    
    const violatingClasses = results.filter(r => r.dipScore >= threshold);
    
    if (!silent) {
        if (violatingClasses.length > 0) {
            const prompt = generateDIPPrompt(violatingClasses, document.uri.fsPath);
            outputChannel.appendLine('\n=== DIP Analysis Result ===');
            outputChannel.appendLine(prompt);
            outputChannel.show();
            
            const action = await vscode.window.showWarningMessage(
                `Found ${violatingClasses.length} class(es) potentially violating Dependency Inversion Principle.`,
                'View Details',
                'Copy Prompt'
            );
            
            if (action === 'Copy Prompt') {
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage('DIP analysis prompt copied to clipboard.');
            } else if (action === 'View Details') {
                outputChannel.show();
            }
        } else {
            vscode.window.showInformationMessage('All classes pass the Dependency Inversion Principle check.');
        }
    } else if (violatingClasses.length > 0) {
        outputChannel.appendLine(`DIP: Found ${violatingClasses.length} violation(s) in ${path.basename(document.uri.fsPath)}`);
    }
}

interface ClassWithConstructor extends ClassInfo {
    constructorStartLine: number;
    constructorEndLine: number;
    constructorParams: string[];
}

function parseClassesWithConstructors(text: string, languageId: string): ClassWithConstructor[] {
    const baseClasses = parseClasses(text, languageId);
    const lines = text.split('\n');
    const result: ClassWithConstructor[] = [];
    
    for (const classInfo of baseClasses) {
        const classWithCtor: ClassWithConstructor = {
            ...classInfo,
            constructorStartLine: -1,
            constructorEndLine: -1,
            constructorParams: []
        };
        
        if (languageId === 'python') {
            const initMethod = classInfo.methods.find(m => m.name === '__init__');
            if (initMethod) {
                classWithCtor.constructorStartLine = initMethod.startLine;
                classWithCtor.constructorEndLine = initMethod.endLine;
                const initLine = lines[initMethod.startLine];
                const paramMatch = initLine.match(/def\s+__init__\s*\(\s*self\s*,?\s*([^)]*)\)/);
                if (paramMatch && paramMatch[1]) {
                    classWithCtor.constructorParams = paramMatch[1].split(',').map(p => p.trim()).filter(p => p.length > 0);
                }
            }
        } else if (languageId === 'typescript' || languageId === 'javascript' || languageId === 'typescriptreact' || languageId === 'javascriptreact') {
            for (let i = classInfo.startLine; i <= classInfo.endLine; i++) {
                const line = lines[i];
                if (/^\s*constructor\s*\(/.test(line)) {
                    classWithCtor.constructorStartLine = i;
                    let braceCount = 0;
                    let foundStart = false;
                    for (let j = i; j <= classInfo.endLine; j++) {
                        const ctorLine = lines[j];
                        for (const char of ctorLine) {
                            if (char === '{') {
                                foundStart = true;
                                braceCount++;
                            } else if (char === '}') {
                                braceCount--;
                            }
                        }
                        if (foundStart && braceCount === 0) {
                            classWithCtor.constructorEndLine = j;
                            break;
                        }
                    }
                    const ctorMatch = line.match(/constructor\s*\(([^)]*)\)/);
                    if (ctorMatch && ctorMatch[1]) {
                        classWithCtor.constructorParams = ctorMatch[1].split(',').map(p => p.trim()).filter(p => p.length > 0);
                    }
                    break;
                }
            }
        }
        
        result.push(classWithCtor);
    }
    
    return result;
}

function analyzeDIP(classInfo: ClassWithConstructor, text: string, languageId: string): DIPResult {
    const violations: DIPViolation[] = [];
    const lines = text.split('\n');
    
    let constructorInstantiations = 0;
    let methodInstantiations = 0;
    const instantiatedClasses = new Set<string>();
    
    if (languageId === 'python') {
        if (classInfo.constructorStartLine >= 0) {
            for (let i = classInfo.constructorStartLine; i <= classInfo.constructorEndLine; i++) {
                const line = lines[i];
                const instantiations = detectPythonInstantiations(line);
                for (const inst of instantiations) {
                    if (!isExcludedClass(inst, languageId)) {
                        constructorInstantiations++;
                        instantiatedClasses.add(inst);
                        violations.push({
                            line: i,
                            type: 'constructor_instantiation',
                            code: line.trim(),
                            className: inst
                        });
                    }
                }
            }
        }
        
        for (const method of classInfo.methods) {
            if (method.name === '__init__') continue;
            for (let i = method.startLine; i <= method.endLine; i++) {
                const line = lines[i];
                const instantiations = detectPythonInstantiations(line);
                for (const inst of instantiations) {
                    if (!isExcludedClass(inst, languageId)) {
                        methodInstantiations++;
                        instantiatedClasses.add(inst);
                        violations.push({
                            line: i,
                            type: 'method_instantiation',
                            code: line.trim(),
                            className: inst
                        });
                    }
                }
            }
        }
    } else if (languageId === 'typescript' || languageId === 'javascript' || languageId === 'typescriptreact' || languageId === 'javascriptreact') {
        if (classInfo.constructorStartLine >= 0) {
            for (let i = classInfo.constructorStartLine; i <= classInfo.constructorEndLine; i++) {
                const line = lines[i];
                const instantiations = detectTypeScriptInstantiations(line);
                for (const inst of instantiations) {
                    if (!isExcludedClass(inst, languageId)) {
                        constructorInstantiations++;
                        instantiatedClasses.add(inst);
                        violations.push({
                            line: i,
                            type: 'constructor_instantiation',
                            code: line.trim(),
                            className: inst
                        });
                    }
                }
            }
        }
        
        for (const method of classInfo.methods) {
            for (let i = method.startLine; i <= method.endLine; i++) {
                const line = lines[i];
                const instantiations = detectTypeScriptInstantiations(line);
                for (const inst of instantiations) {
                    if (!isExcludedClass(inst, languageId)) {
                        methodInstantiations++;
                        instantiatedClasses.add(inst);
                        violations.push({
                            line: i,
                            type: 'method_instantiation',
                            code: line.trim(),
                            className: inst
                        });
                    }
                }
            }
        }
    }
    
    const injectedDependencies = classInfo.constructorParams.length;
    const totalDependencies = injectedDependencies + instantiatedClasses.size;
    const dii = totalDependencies > 0 ? injectedDependencies / totalDependencies : 1;
    
    const dipScore = (constructorInstantiations * 2.0) + (methodInstantiations * 1.5);
    
    return {
        className: classInfo.name,
        startLine: classInfo.startLine,
        constructorInstantiations,
        methodInstantiations,
        injectedDependencies,
        totalDependencies,
        dii,
        dipScore,
        violations,
        suggestion: generateDIPSuggestion(constructorInstantiations, methodInstantiations, dii)
    };
}

function detectPythonInstantiations(line: string): string[] {
    const results: string[] = [];
    const pattern = /([A-Z][a-zA-Z0-9_]*)\s*\(/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
        if (!line.includes(`def ${match[1]}`) && !line.includes(`class ${match[1]}`)) {
            results.push(match[1]);
        }
    }
    return results;
}

function detectTypeScriptInstantiations(line: string): string[] {
    const results: string[] = [];
    const pattern = /new\s+([A-Z][a-zA-Z0-9_]*)\s*\(/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
        results.push(match[1]);
    }
    return results;
}

function isExcludedClass(className: string, languageId: string): boolean {
    const pythonExclusions = ['Exception', 'Error', 'ValueError', 'TypeError', 'RuntimeError', 'KeyError', 'AttributeError', 'IndexError', 'StopIteration', 'Dict', 'List', 'Set', 'Tuple', 'Optional', 'Union', 'Any', 'Callable', 'Type', 'Literal'];
    const tsExclusions = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'Array', 'Object', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Date', 'RegExp', 'URL', 'URLSearchParams', 'FormData', 'Headers', 'Request', 'Response', 'Event', 'CustomEvent', 'EventEmitter'];
    
    if (languageId === 'python') {
        return pythonExclusions.includes(className);
    } else {
        return tsExclusions.includes(className);
    }
}

function generateDIPSuggestion(constructorInst: number, methodInst: number, dii: number): string {
    if (constructorInst === 0 && methodInst === 0) {
        return 'Class follows Dependency Inversion Principle.';
    }
    
    const suggestions: string[] = [];
    
    if (constructorInst > 0) {
        suggestions.push(`Inject ${constructorInst} dependency(ies) via constructor parameters instead of instantiating directly`);
    }
    
    if (methodInst > 0) {
        suggestions.push(`Consider injecting ${methodInst} dependency(ies) or using factory pattern`);
    }
    
    if (dii < 0.5) {
        suggestions.push('Low DII indicates most dependencies are created internally');
    }
    
    return suggestions.join('. ') + '.';
}

function generateDIPPrompt(violations: DIPResult[], filePath: string): string {
    const fileName = path.basename(filePath);
    
    let prompt = `# Dependency Inversion Principle Violation Analysis\n\n`;
    prompt += `**File:** ${fileName}\n\n`;
    prompt += `The following class(es) may violate the Dependency Inversion Principle:\n\n`;
    
    for (const violation of violations) {
        prompt += `## Class: ${violation.className}\n`;
        prompt += `- **DIP Score:** ${violation.dipScore.toFixed(1)} (threshold exceeded)\n`;
        prompt += `- **Dependency Injection Index (DII):** ${(violation.dii * 100).toFixed(0)}% (100% = all injected)\n`;
        prompt += `- **Constructor Instantiations:** ${violation.constructorInstantiations}\n`;
        prompt += `- **Method Instantiations:** ${violation.methodInstantiations}\n`;
        prompt += `- **Injected Dependencies:** ${violation.injectedDependencies}\n\n`;
        
        if (violation.violations.length > 0) {
            prompt += `### Direct Instantiations Found:\n`;
            const ctorViolations = violation.violations.filter(v => v.type === 'constructor_instantiation');
            const methodViolations = violation.violations.filter(v => v.type === 'method_instantiation');
            
            if (ctorViolations.length > 0) {
                prompt += `\n**In Constructor:**\n`;
                for (const v of ctorViolations.slice(0, 5)) {
                    prompt += `- Line ${v.line + 1}: \`${v.className}\` - \`${v.code}\`\n`;
                }
                if (ctorViolations.length > 5) {
                    prompt += `- ... and ${ctorViolations.length - 5} more\n`;
                }
            }
            
            if (methodViolations.length > 0) {
                prompt += `\n**In Methods:**\n`;
                for (const v of methodViolations.slice(0, 5)) {
                    prompt += `- Line ${v.line + 1}: \`${v.className}\` - \`${v.code}\`\n`;
                }
                if (methodViolations.length > 5) {
                    prompt += `- ... and ${methodViolations.length - 5} more\n`;
                }
            }
        }
        
        prompt += `\n### Recommended Refactoring:\n`;
        prompt += `${violation.suggestion}\n\n`;
        prompt += `**Steps to fix:**\n`;
        prompt += `1. Create abstractions (interfaces/protocols) for each concrete dependency\n`;
        prompt += `2. Add constructor parameters to receive dependencies\n`;
        prompt += `3. Have concrete classes implement the abstractions\n`;
        prompt += `4. Inject dependencies from calling code or use a DI container\n\n`;
    }
    
    prompt += `---\n`;
    prompt += `**Action Required:** Refactor to inject dependencies instead of creating them internally. `;
    prompt += `High-level modules should depend on abstractions, not concrete implementations.\n`;
    
    return prompt;
}

async function checkInterfaceSegregation(document: vscode.TextDocument, silent: boolean = false): Promise<void> {
    const config = vscode.workspace.getConfiguration('semgrepOffline');
    const fatInterfaceThreshold = config.get<number>('ispFatInterfaceThreshold') || 5;
    const sirThreshold = config.get<number>('ispSirThreshold') || 0.3;
    
    const text = document.getText();
    const results: ISPResult[] = [];
    const diagnostics: vscode.Diagnostic[] = [];
    
    const interfaces = parseInterfaces(text, document.languageId);
    for (const iface of interfaces) {
        if (iface.abstractMethodCount > fatInterfaceThreshold) {
            const result: ISPResult = {
                className: iface.name,
                startLine: iface.startLine,
                isInterface: true,
                abstractMethodCount: iface.abstractMethodCount,
                emptyImplementations: 0,
                notImplementedErrors: 0,
                ifs: iface.abstractMethodCount,
                sir: 0,
                ispScore: iface.abstractMethodCount,
                violations: [{
                    line: iface.startLine,
                    type: 'fat_interface',
                    methodName: '',
                    code: `Interface has ${iface.abstractMethodCount} abstract methods`
                }],
                suggestion: `Consider splitting into ${Math.ceil(iface.abstractMethodCount / 3)} smaller interfaces with ~3 methods each.`
            };
            results.push(result);
            
            const range = new vscode.Range(iface.startLine, 0, iface.startLine, 100);
            const prompt = generateISPPrompt([result], document.uri.fsPath);
            
            const diagnostic = new vscode.Diagnostic(
                range,
                `ISP Violation: Interface '${iface.name}' has ${iface.abstractMethodCount} abstract methods (fat interface). ${result.suggestion}\n\n--- Agent Prompt ---\n${prompt}`,
                vscode.DiagnosticSeverity.Warning
            );
            diagnostic.source = 'solid-isp';
            diagnostic.code = 'ISP-FAT';
            diagnostics.push(diagnostic);
        }
    }
    
    const implementations = parseImplementations(text, document.languageId);
    for (const impl of implementations) {
        if (impl.emptyMethods.length > 0 || impl.notImplementedMethods.length > 0) {
            const totalMethods = impl.totalMethods;
            const stubMethods = impl.emptyMethods.length + impl.notImplementedMethods.length;
            const sir = totalMethods > 0 ? stubMethods / totalMethods : 0;
            
            if (sir >= sirThreshold || stubMethods >= 2) {
                const violations: ISPViolation[] = [];
                
                for (const m of impl.emptyMethods) {
                    violations.push({
                        line: m.line,
                        type: 'empty_implementation',
                        methodName: m.name,
                        code: m.code
                    });
                }
                
                for (const m of impl.notImplementedMethods) {
                    violations.push({
                        line: m.line,
                        type: 'not_implemented_error',
                        methodName: m.name,
                        code: m.code
                    });
                }
                
                const result: ISPResult = {
                    className: impl.name,
                    startLine: impl.startLine,
                    isInterface: false,
                    abstractMethodCount: 0,
                    emptyImplementations: impl.emptyMethods.length,
                    notImplementedErrors: impl.notImplementedMethods.length,
                    ifs: 0,
                    sir,
                    ispScore: stubMethods * 1.5,
                    violations,
                    suggestion: generateISPSuggestion(impl.emptyMethods.length, impl.notImplementedMethods.length, sir)
                };
                results.push(result);
                
                const range = new vscode.Range(impl.startLine, 0, impl.startLine, 100);
                const prompt = generateISPPrompt([result], document.uri.fsPath);
                
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `ISP Violation: Class '${impl.name}' has ${stubMethods} stub method(s) (SIR=${(sir * 100).toFixed(0)}%). ${result.suggestion}\n\n--- Agent Prompt ---\n${prompt}`,
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.source = 'solid-isp';
                diagnostic.code = 'ISP-STUB';
                diagnostics.push(diagnostic);
            }
        }
    }
    
    const existingDiagnostics = diagnosticCollection.get(document.uri) || [];
    const nonIspDiagnostics = existingDiagnostics.filter(d => d.source !== 'solid-isp');
    diagnosticCollection.set(document.uri, [...nonIspDiagnostics, ...diagnostics]);
    
    if (!silent) {
        if (results.length > 0) {
            const prompt = generateISPPrompt(results, document.uri.fsPath);
            outputChannel.appendLine('\n=== ISP Analysis Result ===');
            outputChannel.appendLine(prompt);
            outputChannel.show();
            
            const action = await vscode.window.showWarningMessage(
                `Found ${results.length} potential Interface Segregation Principle violation(s).`,
                'View Details',
                'Copy Prompt'
            );
            
            if (action === 'Copy Prompt') {
                await vscode.env.clipboard.writeText(prompt);
                vscode.window.showInformationMessage('ISP analysis prompt copied to clipboard.');
            } else if (action === 'View Details') {
                outputChannel.show();
            }
        } else {
            vscode.window.showInformationMessage('All classes pass the Interface Segregation Principle check.');
        }
    } else if (results.length > 0) {
        outputChannel.appendLine(`ISP: Found ${results.length} violation(s) in ${path.basename(document.uri.fsPath)}`);
    }
}

interface InterfaceInfo {
    name: string;
    startLine: number;
    abstractMethodCount: number;
    methods: string[];
}

interface ImplementationInfo {
    name: string;
    startLine: number;
    totalMethods: number;
    emptyMethods: { name: string; line: number; code: string }[];
    notImplementedMethods: { name: string; line: number; code: string }[];
}

function parseInterfaces(text: string, languageId: string): InterfaceInfo[] {
    const interfaces: InterfaceInfo[] = [];
    const lines = text.split('\n');
    
    if (languageId === 'python') {
        let currentInterface: InterfaceInfo | null = null;
        let classIndent = 0;
        let isAbcClass = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trimStart();
            const indent = line.length - trimmed.length;
            
            const classMatch = trimmed.match(/^class\s+(\w+)\s*\(([^)]*)\)/);
            if (classMatch) {
                if (currentInterface && currentInterface.abstractMethodCount > 0) {
                    interfaces.push(currentInterface);
                }
                
                const parentClasses = classMatch[2];
                isAbcClass = /ABC|Protocol/.test(parentClasses);
                
                if (isAbcClass) {
                    currentInterface = {
                        name: classMatch[1],
                        startLine: i,
                        abstractMethodCount: 0,
                        methods: []
                    };
                    classIndent = indent;
                } else {
                    currentInterface = null;
                }
                continue;
            }
            
            if (currentInterface && indent <= classIndent && trimmed.length > 0 && !classMatch) {
                if (currentInterface.abstractMethodCount > 0) {
                    interfaces.push(currentInterface);
                }
                currentInterface = null;
                continue;
            }
            
            if (currentInterface) {
                if (trimmed.includes('@abstractmethod')) {
                    const nextLine = lines[i + 1] || '';
                    const methodMatch = nextLine.trimStart().match(/^def\s+(\w+)/);
                    if (methodMatch) {
                        currentInterface.abstractMethodCount++;
                        currentInterface.methods.push(methodMatch[1]);
                    }
                }
            }
        }
        
        if (currentInterface && currentInterface.abstractMethodCount > 0) {
            interfaces.push(currentInterface);
        }
    } else if (languageId === 'typescript' || languageId === 'typescriptreact') {
        let braceCount = 0;
        let currentInterface: InterfaceInfo | null = null;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            
            const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
            if (interfaceMatch && braceCount === 0) {
                currentInterface = {
                    name: interfaceMatch[1],
                    startLine: i,
                    abstractMethodCount: 0,
                    methods: []
                };
            }
            
            const abstractClassMatch = trimmed.match(/^(?:export\s+)?abstract\s+class\s+(\w+)/);
            if (abstractClassMatch && braceCount === 0) {
                currentInterface = {
                    name: abstractClassMatch[1],
                    startLine: i,
                    abstractMethodCount: 0,
                    methods: []
                };
            }
            
            const openBraces = (line.match(/{/g) || []).length;
            const closeBraces = (line.match(/}/g) || []).length;
            braceCount += openBraces - closeBraces;
            
            if (currentInterface) {
                const methodMatch = trimmed.match(/^(?:abstract\s+)?(\w+)\s*\([^)]*\)\s*[:{]/);
                if (methodMatch && !trimmed.startsWith('constructor')) {
                    currentInterface.abstractMethodCount++;
                    currentInterface.methods.push(methodMatch[1]);
                }
                
                const propMethodMatch = trimmed.match(/^(\w+)\s*\([^)]*\)\s*:/);
                if (propMethodMatch) {
                    currentInterface.abstractMethodCount++;
                    currentInterface.methods.push(propMethodMatch[1]);
                }
                
                if (braceCount === 0 && closeBraces > 0) {
                    if (currentInterface.abstractMethodCount > 0) {
                        interfaces.push(currentInterface);
                    }
                    currentInterface = null;
                }
            }
        }
    }
    
    return interfaces;
}

function parseImplementations(text: string, languageId: string): ImplementationInfo[] {
    const implementations: ImplementationInfo[] = [];
    const lines = text.split('\n');
    
    if (languageId === 'python') {
        let currentClass: ImplementationInfo | null = null;
        let classIndent = 0;
        let methodIndent = 0;
        let currentMethodName = '';
        let currentMethodLine = 0;
        let methodBody: string[] = [];
        let inMethod = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trimStart();
            const indent = line.length - trimmed.length;
            
            const classMatch = trimmed.match(/^class\s+(\w+)/);
            if (classMatch) {
                if (currentClass && inMethod) {
                    checkPythonMethodBody(currentClass, currentMethodName, currentMethodLine, methodBody);
                }
                if (currentClass) {
                    implementations.push(currentClass);
                }
                
                currentClass = {
                    name: classMatch[1],
                    startLine: i,
                    totalMethods: 0,
                    emptyMethods: [],
                    notImplementedMethods: []
                };
                classIndent = indent;
                inMethod = false;
                continue;
            }
            
            if (currentClass && indent <= classIndent && trimmed.length > 0 && !classMatch) {
                if (inMethod) {
                    checkPythonMethodBody(currentClass, currentMethodName, currentMethodLine, methodBody);
                }
                implementations.push(currentClass);
                currentClass = null;
                inMethod = false;
                continue;
            }
            
            if (currentClass) {
                const methodMatch = trimmed.match(/^def\s+(\w+)\s*\(/);
                if (methodMatch) {
                    if (inMethod) {
                        checkPythonMethodBody(currentClass, currentMethodName, currentMethodLine, methodBody);
                    }
                    
                    currentMethodName = methodMatch[1];
                    currentMethodLine = i;
                    methodIndent = indent;
                    methodBody = [];
                    inMethod = true;
                    currentClass.totalMethods++;
                    continue;
                }
                
                if (inMethod && indent > methodIndent) {
                    methodBody.push(trimmed);
                } else if (inMethod && indent <= methodIndent && trimmed.length > 0) {
                    checkPythonMethodBody(currentClass, currentMethodName, currentMethodLine, methodBody);
                    inMethod = false;
                }
            }
        }
        
        if (currentClass) {
            if (inMethod) {
                checkPythonMethodBody(currentClass, currentMethodName, currentMethodLine, methodBody);
            }
            implementations.push(currentClass);
        }
    } else if (languageId === 'typescript' || languageId === 'javascript' || languageId === 'typescriptreact' || languageId === 'javascriptreact') {
        let currentClass: ImplementationInfo | null = null;
        let braceCount = 0;
        let classStartBrace = 0;
        let methodStartBrace = 0;
        let currentMethodName = '';
        let currentMethodLine = 0;
        let methodBody: string[] = [];
        let inMethod = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            
            const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
            if (classMatch && braceCount === 0) {
                if (currentClass) {
                    implementations.push(currentClass);
                }
                currentClass = {
                    name: classMatch[1],
                    startLine: i,
                    totalMethods: 0,
                    emptyMethods: [],
                    notImplementedMethods: []
                };
                classStartBrace = 0;
                inMethod = false;
            }
            
            const openBraces = (line.match(/{/g) || []).length;
            const closeBraces = (line.match(/}/g) || []).length;
            
            if (currentClass) {
                if (braceCount === classStartBrace + 1 || (braceCount === 0 && openBraces > 0)) {
                    const methodMatch = trimmed.match(/^(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(/);
                    if (methodMatch && !trimmed.startsWith('constructor')) {
                        if (inMethod) {
                            checkTSMethodBody(currentClass, currentMethodName, currentMethodLine, methodBody);
                        }
                        currentMethodName = methodMatch[1];
                        currentMethodLine = i;
                        methodStartBrace = braceCount;
                        methodBody = [];
                        inMethod = true;
                        currentClass.totalMethods++;
                    }
                }
                
                if (inMethod) {
                    methodBody.push(trimmed);
                }
            }
            
            braceCount += openBraces - closeBraces;
            
            if (currentClass && inMethod && braceCount <= methodStartBrace && closeBraces > 0) {
                checkTSMethodBody(currentClass, currentMethodName, currentMethodLine, methodBody);
                inMethod = false;
            }
            
            if (currentClass && braceCount === 0 && closeBraces > 0) {
                implementations.push(currentClass);
                currentClass = null;
            }
        }
    }
    
    return implementations;
}

function checkPythonMethodBody(impl: ImplementationInfo, methodName: string, methodLine: number, body: string[]): void {
    if (methodName.startsWith('__') && methodName.endsWith('__') && methodName !== '__init__') {
        return;
    }
    
    const bodyText = body.join('\n').trim();
    
    if (bodyText === 'pass' || bodyText === '...' || bodyText === 'pass  ' || body.length === 1 && body[0].trim() === 'pass') {
        impl.emptyMethods.push({
            name: methodName,
            line: methodLine,
            code: `def ${methodName}(...): pass`
        });
        return;
    }
    
    if (bodyText.includes('raise NotImplementedError') || bodyText.includes('raise NotImplemented')) {
        impl.notImplementedMethods.push({
            name: methodName,
            line: methodLine,
            code: `def ${methodName}(...): raise NotImplementedError`
        });
    }
}

function checkTSMethodBody(impl: ImplementationInfo, methodName: string, methodLine: number, body: string[]): void {
    const bodyText = body.join(' ').replace(/[{}]/g, '').trim();
    
    if (bodyText === '' || bodyText === methodName + '()' || /^\w+\s*\([^)]*\)\s*$/.test(bodyText)) {
        impl.emptyMethods.push({
            name: methodName,
            line: methodLine,
            code: `${methodName}() { }`
        });
        return;
    }
    
    if (bodyText.includes('throw new Error') && (bodyText.includes('not implemented') || bodyText.includes('Not implemented') || bodyText.includes('NotImplemented'))) {
        impl.notImplementedMethods.push({
            name: methodName,
            line: methodLine,
            code: `${methodName}() { throw new Error(...) }`
        });
    }
}

function generateISPSuggestion(emptyCount: number, notImplCount: number, sir: number): string {
    const suggestions: string[] = [];
    
    if (emptyCount > 0) {
        suggestions.push(`${emptyCount} empty method(s) indicate unused interface requirements`);
    }
    
    if (notImplCount > 0) {
        suggestions.push(`${notImplCount} NotImplementedError method(s) indicate forced interface compliance`);
    }
    
    if (sir > 0.5) {
        suggestions.push('High stub ratio suggests the interface is too broad for this class');
    }
    
    suggestions.push('Consider using smaller, more focused interfaces');
    
    return suggestions.join('. ') + '.';
}

function generateISPPrompt(violations: ISPResult[], filePath: string): string {
    const fileName = path.basename(filePath);
    
    let prompt = `# Interface Segregation Principle Violation Analysis\n\n`;
    prompt += `**File:** ${fileName}\n\n`;
    prompt += `The following class(es)/interface(s) may violate the Interface Segregation Principle:\n\n`;
    
    for (const violation of violations) {
        if (violation.isInterface) {
            prompt += `## Interface: ${violation.className} (Fat Interface)\n`;
            prompt += `- **Abstract Method Count (IFS):** ${violation.abstractMethodCount}\n`;
            prompt += `- **Recommended:** Split into smaller interfaces with 3-5 methods each\n\n`;
        } else {
            prompt += `## Class: ${violation.className} (Forced Implementation)\n`;
            prompt += `- **Stub Implementation Ratio (SIR):** ${(violation.sir * 100).toFixed(0)}%\n`;
            prompt += `- **Empty Implementations:** ${violation.emptyImplementations}\n`;
            prompt += `- **NotImplementedError Methods:** ${violation.notImplementedErrors}\n\n`;
        }
        
        if (violation.violations.length > 0) {
            prompt += `### Detected Issues:\n`;
            for (const v of violation.violations.slice(0, 10)) {
                const typeLabel = v.type === 'fat_interface' ? 'Fat Interface' :
                                 v.type === 'empty_implementation' ? 'Empty Method' : 'NotImplementedError';
                if (v.methodName) {
                    prompt += `- **${typeLabel}:** \`${v.methodName}\` at line ${v.line + 1}\n`;
                } else {
                    prompt += `- **${typeLabel}:** ${v.code}\n`;
                }
            }
            if (violation.violations.length > 10) {
                prompt += `- ... and ${violation.violations.length - 10} more\n`;
            }
        }
        
        prompt += `\n### Recommended Refactoring:\n`;
        prompt += `${violation.suggestion}\n\n`;
    }
    
    prompt += `---\n`;
    prompt += `**Action Required:** Split large interfaces into smaller, role-specific interfaces. `;
    prompt += `Classes should only implement interfaces whose methods they actually use.\n`;
    
    return prompt;
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
