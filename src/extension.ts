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

    context.subscriptions.push(scanFileCommand, scanWorkspaceCommand, clearCommand, srpCheckCommand);

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            const config = vscode.workspace.getConfiguration('semgrepOffline');
            const supportedLanguages = config.get<string[]>('languages') || ['python'];
            if (config.get<boolean>('scanOnSave') && shouldScanDocument(document, supportedLanguages)) {
                scanFile(document, true);
                if (config.get<boolean>('enableSRP')) {
                    checkSingleResponsibility(document, true);
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
